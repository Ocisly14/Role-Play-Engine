/**
 * Module loading API — three-step pipeline.
 * loadModule() → createSession() → initRuntime()
 */

import type { PrismaClient } from "@prisma/client";
import type { EmbeddingClient } from "../../rag/embedding.js";
import { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { DynamicGameState } from "./DynamicGameState.js";
import { buildTopology } from "./topologyTypes.js";
import type {
  JunctionNode,
  RoadNode,
  TownTopology,
  TransportEdge,
} from "./topologyTypes.js";
import type {
  DynamicNPCProfile,
  DynamicScene,
  ModuleSetup,
  ScenarioOutline,
} from "./types.js";

export interface ModuleData {
  moduleId: string;
  moduleName: string;
  setup: ModuleSetup | null;
  npcs: DynamicNPCProfile[];
  scenes: Map<string, DynamicScene>;
  junctions: Map<string, JunctionNode>;
  roads: Map<string, RoadNode>;
  scenarioOutlines: ScenarioOutline[];
  transportEdges: TransportEdge[];
}

/**
 * Step 1: Load module data from DB. Pure data, no side effects.
 */
export async function loadModule(
  prisma: PrismaClient,
  moduleId: string
): Promise<ModuleData | null> {
  const mod = await prisma.module.findUnique({
    where: { moduleId },
    select: { moduleId: true, moduleName: true },
  });
  if (!mod) return null;

  // Load setup
  const setupRow = await prisma.moduleSetup.findUnique({
    where: { moduleId },
  });
  const setup = (setupRow?.data as ModuleSetup) ?? null;

  // Load all scene entries
  const sceneRows = await prisma.moduleScene.findMany({
    where: { moduleId },
  });

  const scenes = new Map<string, DynamicScene>();
  const junctions = new Map<string, JunctionNode>();
  const roads = new Map<string, RoadNode>();
  let scenarioOutlines: ScenarioOutline[] = [];
  let transportEdges: TransportEdge[] = [];

  for (const row of sceneRows) {
    const data = row.data as any;
    if (row.entryId === "__scenarios_outline__") {
      scenarioOutlines = Array.isArray(data)
        ? data
        : Array.isArray(data?.scenarios)
          ? data.scenarios
          : [];
    } else if (row.entryId === "__transport_edges__") {
      transportEdges = Array.isArray(data)
        ? data
        : (data?.transportEdges ?? []);
    } else if (row.entryId.startsWith("JUNC_")) {
      junctions.set(row.entryId, data as JunctionNode);
    } else if (row.entryId.startsWith("ROAD_")) {
      roads.set(row.entryId, data as RoadNode);
    } else {
      scenes.set(row.entryId, data as DynamicScene);
    }
  }

  // Load NPCs
  const npcRows = await prisma.moduleNpc.findMany({
    where: { moduleId },
  });
  const npcs = npcRows.map((row) => row.data as unknown as DynamicNPCProfile);

  return {
    moduleId: mod.moduleId,
    moduleName: mod.moduleName,
    setup,
    npcs,
    scenes,
    junctions,
    roads,
    scenarioOutlines,
    transportEdges,
  };
}

/**
 * Step 2: Create session and bootstrap NPC memory.
 */
export async function createSession(
  prisma: PrismaClient,
  params: {
    sessionId: string;
    moduleId: string;
    moduleData: ModuleData;
    embedClient: EmbeddingClient;
    emailId?: string;
  }
): Promise<void> {
  const { sessionId, moduleId, moduleData, embedClient, emailId } = params;

  // Upsert session
  await prisma.session.upsert({
    where: { sessionId },
    create: {
      sessionId,
      moduleId,
      emailId: emailId || null,
      modName: moduleData.moduleName || undefined,
      status: "active",
      metadata: {},
    },
    update: {
      lastActivityAt: new Date(),
      moduleId,
      emailId: emailId || null,
      modName: moduleData.moduleName || undefined,
    },
  });

  // Bootstrap NPC memory from profile.memory[]
  const memoryManager = new NpcMemoryManager(prisma, embedClient);

  for (const npc of moduleData.npcs) {
    if (!npc.memory || npc.memory.length === 0) continue;

    // Idempotent: skip if NPC already has memories
    const existing = await prisma.npcMemory.count({
      where: { npcId: npc.id, sessionId },
    });
    if (existing > 0) continue;

    for (const entry of npc.memory) {
      if (!entry.content || entry.content.trim() === "") continue;
      await memoryManager.add({
        npcId: npc.id,
        sessionId,
        moduleId,
        type: entry.type as any,
        content: entry.content.trim(),
        gameDay: 1,
        gameTime: "00:00",
        metadata: entry.metadata,
      });
    }
  }
}

/**
 * Step 3: Build DynamicGameState with runtime fields. Pure, no DB access.
 */
export function initRuntime(params: {
  sessionId: string;
  moduleData: ModuleData;
  gameDay: number;
  timeOfDay: string;
}): DynamicGameState {
  const { sessionId, moduleData, gameDay, timeOfDay } = params;

  // Build topology
  const topology: TownTopology | null =
    moduleData.junctions.size > 0 || moduleData.roads.size > 0
      ? buildTopology(moduleData.junctions, moduleData.roads)
      : null;

  // Determine default starting scene
  const defaultSceneId =
    moduleData.scenarioOutlines?.[0]?.entrySceneId ??
    moduleData.scenarioOutlines?.[0]?.id ??
    "unknown";

  // Initialize runtime NPC state
  const npcLocations: Record<string, string> = {};
  const npcStats: Record<string, { hp: number; san: number }> = {};
  const npcInventories: Record<string, any[]> = {};
  const npcRelationshipGraph: Record<
    string,
    Record<string, { score: number; note: string }>
  > = {};
  const npcResidences: Record<string, string> = {};
  const characterPositions: Record<string, any> = {};

  // Build residence lookup from scenarioOutlines
  const residentToLocation: Record<string, string> = {};
  for (const outline of moduleData.scenarioOutlines) {
    if (outline.residents) {
      for (const residentId of outline.residents as string[]) {
        residentToLocation[residentId] = outline.id;
      }
    }
  }

  // Build macro location → entry scene lookup
  const macroToEntry: Record<string, string> = {};
  for (const outline of moduleData.scenarioOutlines) {
    if (outline.entrySceneId) {
      macroToEntry[outline.id] = outline.entrySceneId;
    }
  }

  for (const npc of moduleData.npcs) {
    // Location: resolve macro location to entry scene
    const residence = npc.residence ?? residentToLocation[npc.id];
    const resolvedLocation = residence
      ? (macroToEntry[residence] ?? residence)
      : defaultSceneId;
    npcLocations[npc.id] = resolvedLocation;
    if (residence) npcResidences[npc.id] = residence;

    // Stats
    npcStats[npc.id] = {
      hp: npc.status?.hp ?? npc.attributes?.CON ?? 10,
      san: npc.status?.sanity ?? npc.attributes?.POW ?? 50,
    };

    // Inventory
    npcInventories[npc.id] = Array.isArray(npc.inventory)
      ? npc.inventory.map((item: any) => {
          if (typeof item === "string") return { id: item, name: item };
          return {
            id: item.name ?? String(item),
            name: item.name ?? String(item),
            ...(item.properties ?? {}),
          };
        })
      : [];

    // Relationships
    const rels: Record<string, { score: number; note: string }> = {};
    for (const rel of npc.relationships ?? []) {
      if (rel.targetId) {
        rels[rel.targetId] = {
          score: (rel as any).score ?? rel.attitude ?? 0,
          note: (rel as any).note ?? "",
        };
      }
    }
    npcRelationshipGraph[npc.id] = rels;
  }

  // Build scenarioConditions from scenes, junctions, and roads
  const scenarioConditions: Record<string, any[]> = {};
  for (const [sceneId, scene] of moduleData.scenes) {
    if (scene.conditions && scene.conditions.length > 0) {
      scenarioConditions[sceneId] = scene.conditions;
    }
  }
  for (const [id, junc] of moduleData.junctions) {
    if (junc.conditions && junc.conditions.length > 0) {
      scenarioConditions[id] = junc.conditions;
    }
  }
  for (const [id, road] of moduleData.roads) {
    if (road.conditions && road.conditions.length > 0) {
      scenarioConditions[id] = road.conditions;
    }
  }

  return {
    sessionId,
    scenes: moduleData.scenes,
    junctions: moduleData.junctions,
    roads: moduleData.roads,
    gameDay,
    timeOfDay,
    npcCharacters: moduleData.npcs,
    moduleName: moduleData.moduleName,
    moduleSetup: moduleData.setup,
    scenarioOutlines: moduleData.scenarioOutlines,
    featureState: {},
    npcLocations,
    npcStats,
    npcInventories,
    npcRelationshipGraph,
    scenarioConditions,
    blockedConnections: new Map(),
    npcResidences,
    transportEdges: moduleData.transportEdges,
    topology,
    characterPositions,
    loadedAt: new Date(),
    lastUpdated: new Date(),
  };
}
