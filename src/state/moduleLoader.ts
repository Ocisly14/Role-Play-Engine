/**
 * Module loading API — three-step pipeline.
 * loadModule() → createSession() → initRuntime()
 */

import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import {
  type ScriptedEventFile,
  loadScriptedEvents,
} from "../engine/scriptedEvents/loader.js";
import type { ScriptedEvent } from "../engine/scriptedEvents/types.js";
import { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { EmbeddingClient } from "../rag/embedding.js";
import type { DynamicGameState } from "./DynamicGameState.js";
import { ISO_DATE_RE, makeDateTime } from "./gameClock.js";
import {
  buildTopology,
  enrichTopologyWithInteriorScenes,
} from "./topologyTypes.js";
import type {
  CharacterPosition,
  JunctionNode,
  RoadNode,
  TownTopology,
} from "./topologyTypes.js";
import type {
  DynamicNPCProfile,
  DynamicScene,
  ModuleSetup,
  ScenarioOutline,
  TransportEdge,
} from "./types.js";

/** Default disk location for module source files. */
const DEFAULT_MODS_DIR = "data/Mods";

export interface NpcInjectionPolicy {
  moduleId?: string;
  description?: string;
  tiers: {
    daily_sim?: string[];
    investigator_sim?: string[];
    limited_sim?: string[];
    scene_only?: string[];
    cosmic_not_sim?: string[];
    [key: string]: string[] | undefined;
  };
}

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
  npcInjectionPolicy: NpcInjectionPolicy | null;
  /** Loaded+validated scripted events (may be empty if module has no scripted-events/ dir). */
  scriptedEvents: ScriptedEvent[];
}

/**
 * Step 1: Load module data from DB. Pure data, no side effects.
 *
 * Also scans `<modsDir>/<moduleName>/scripted-events/*.json` from disk (if the
 * directory exists) and attaches the validated event list. Disk access here is
 * intentional: scripted-events are not (yet) persisted to the DB.
 */
export async function loadModule(
  prisma: PrismaClient,
  moduleId: string,
  options?: { modsDir?: string }
): Promise<ModuleData | null> {
  const modsDir = options?.modsDir ?? DEFAULT_MODS_DIR;
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
  validateModuleSetupStartDate(mod.moduleId, setup);

  // Load all scene entries
  const sceneRows = await prisma.moduleScene.findMany({
    where: { moduleId },
  });

  const scenes = new Map<string, DynamicScene>();
  const junctions = new Map<string, JunctionNode>();
  const roads = new Map<string, RoadNode>();
  let scenarioOutlines: ScenarioOutline[] = [];
  let transportEdges: TransportEdge[] = [];
  let npcInjectionPolicy: NpcInjectionPolicy | null = null;

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
    } else if (row.entryId === "__npc_injection_policy__") {
      npcInjectionPolicy = data as NpcInjectionPolicy;
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

  // Load scripted events from disk: `<modsDir>/<moduleName>/scripted-events/*.json`.
  // Missing directory → empty array (module is valid with no scripted events).
  // Files are sorted alphabetically for deterministic merge order across runs.
  const scriptedEvents = loadScriptedEventsFromDisk(modsDir, mod.moduleName);

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
    npcInjectionPolicy,
    scriptedEvents,
  };
}

/**
 * Scan a module's `scripted-events/` directory, parse every `*.json`, and
 * delegate to the loader for validation. Returns `[]` if the directory does
 * not exist. Throws `ScriptedEventLoadError` on validation failure.
 */
/**
 * Public entry point — load scripted events for `moduleName` from
 * `<DEFAULT_MODS_DIR>/<moduleName>/scripted-events/*.json`. Used by
 * `SimulationRunner` to feed the TickEngine without re-fetching DB-backed
 * module data when only the scripted-event list is needed.
 */
export function loadScriptedEventsForModule(
  moduleName: string
): ScriptedEvent[] {
  return loadScriptedEventsFromDisk(DEFAULT_MODS_DIR, moduleName);
}

function loadScriptedEventsFromDisk(
  modsDir: string,
  moduleName: string
): ScriptedEvent[] {
  const eventsDir = path.join(modsDir, moduleName, "scripted-events");
  if (!fs.existsSync(eventsDir)) return [];

  const files = fs
    .readdirSync(eventsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0) return [];

  const allRawFiles: ScriptedEventFile[] = [];
  for (const file of files) {
    const filePath = path.join(eventsDir, file);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    allRawFiles.push({ file, raw });
  }
  return loadScriptedEvents(allRawFiles);
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
  const startDate = moduleData.setup?.startDate;
  if (!startDate) {
    throw new Error(
      `Module "${moduleId}" missing required ModuleSetup.startDate. Add a "startDate": "YYYY-MM-DD" field (e.g. "1923-10-15") to the module's setup section.`
    );
  }

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

  // Bootstrap NPC memory from profile.memory[] (only simulated NPCs)
  const memoryManager = new NpcMemoryManager(prisma, embedClient);
  const simulatedNpcs = filterNpcsByPolicy(
    moduleData.npcs,
    moduleData.npcInjectionPolicy
  );

  for (const npc of simulatedNpcs) {
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
        gameDateTime: makeDateTime(startDate, "00:00"),
        metadata: entry.metadata,
      });
    }
  }
}

/**
 * Filter NPCs by injection policy. Returns only NPCs in the specified tiers.
 * If no policy exists, returns all NPCs (backward compatible).
 */
export function filterNpcsByPolicy(
  npcs: DynamicNPCProfile[],
  policy: NpcInjectionPolicy | null,
  tiers: string[] = ["daily_sim", "investigator_sim"]
): DynamicNPCProfile[] {
  if (!policy) return npcs;
  const allowed = new Set<string>();
  for (const tier of tiers) {
    for (const name of policy.tiers[tier] ?? []) allowed.add(name);
  }
  const filtered = npcs.filter((n) => allowed.has(n.id) || allowed.has(n.name));
  console.log(
    `[moduleLoader] Injection policy: ${filtered.length}/${npcs.length} NPCs pass tiers [${tiers.join(", ")}]`
  );
  return filtered;
}

/**
 * Step 3: Build DynamicGameState with runtime fields. Pure, no DB access.
 */
export function initRuntime(params: {
  sessionId: string;
  moduleData: ModuleData;
  gameDateTime: string;
}): DynamicGameState {
  const { sessionId, moduleData, gameDateTime } = params;

  // Filter NPCs by injection policy (only daily_sim + investigator_sim)
  const simulatedNpcs = filterNpcsByPolicy(
    moduleData.npcs,
    moduleData.npcInjectionPolicy
  );

  // Build topology
  const topology: TownTopology | null =
    moduleData.junctions.size > 0 || moduleData.roads.size > 0
      ? buildTopology(moduleData.junctions, moduleData.roads)
      : null;

  if (!topology) {
    throw new Error(
      `Module ${moduleData.moduleId} has no topology. Topology is required.`
    );
  }

  // Enrich topology with interior sub-scenes
  if (moduleData.scenes.size > 0 || moduleData.scenarioOutlines?.length) {
    enrichTopologyWithInteriorScenes(
      topology,
      moduleData.scenes,
      moduleData.scenarioOutlines ?? []
    );
  }

  // Determine default starting scene
  const defaultSceneId =
    moduleData.scenarioOutlines?.[0]?.entrySceneId ??
    moduleData.scenarioOutlines?.[0]?.id ??
    moduleData.scenes.keys().next().value ??
    "unknown";

  // Initialize runtime NPC state
  const npcStats: Record<string, { hp: number; san: number }> = {};
  const npcInventories: Record<string, any[]> = {};
  const npcRelationshipGraph: Record<
    string,
    Record<string, { score: number; note: string }>
  > = {};
  const npcResidences: Record<string, string> = {};
  const characterPositions: Record<string, CharacterPosition> = {};

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

  for (const npc of simulatedNpcs) {
    // Location: prefer explicit currentLocation from NPC profile
    const residence = npc.residence ?? residentToLocation[npc.id];
    let resolvedLocation: string;
    if (
      npc.currentLocation &&
      (moduleData.scenes.has(npc.currentLocation) ||
        moduleData.junctions.has(npc.currentLocation) ||
        moduleData.roads.has(npc.currentLocation))
    ) {
      // NPC profile specifies a valid scene, junction, or road directly
      resolvedLocation = npc.currentLocation;
    } else if (residence) {
      resolvedLocation = macroToEntry[residence] ?? residence;
    } else {
      resolvedLocation = defaultSceneId;
    }
    // Validate: if resolvedLocation is a macro ID (not in scenes/junctions/roads), map to entry scene
    if (
      !moduleData.scenes.has(resolvedLocation) &&
      !moduleData.junctions.has(resolvedLocation) &&
      !moduleData.roads.has(resolvedLocation)
    ) {
      const fallback = macroToEntry[resolvedLocation];
      if (fallback) {
        console.warn(
          `[moduleLoader] NPC ${npc.id} resolved to macro location ${resolvedLocation}, mapping to entry scene ${fallback}`
        );
        resolvedLocation = fallback;
      } else {
        console.warn(
          `[moduleLoader] NPC ${npc.id} resolved to unknown location ${resolvedLocation}, using default ${defaultSceneId}`
        );
        resolvedLocation = defaultSceneId;
      }
    }
    if (residence) npcResidences[npc.id] = residence;

    // Stats
    npcStats[npc.id] = {
      hp: npc.status?.hp ?? npc.attributes?.CON ?? 10,
      san:
        npc.status?.san ??
        (npc.status as unknown as { sanity?: number })?.sanity ??
        npc.attributes?.POW ??
        50,
    };

    // Inventory — normalize once so both npcInventories (runtime Item[]) and
    // npc.inventory (profile InventoryItem[]) carry a stable `id`. The id is
    // the citation handle used by PerceivableDirectory + interpreter.
    const normalizedInventory = Array.isArray(npc.inventory)
      ? npc.inventory.map((item: any) => {
          if (typeof item === "string") return { id: item, name: item };
          const id = item.id ?? item.name ?? String(item);
          const name = item.name ?? id;
          return {
            id,
            name,
            ...(item.properties ?? {}),
          };
        })
      : [];
    npcInventories[npc.id] = normalizedInventory;
    npc.inventory = normalizedInventory;

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

    // Initialize characterPosition from resolved location
    if (moduleData.scenes.has(resolvedLocation)) {
      characterPositions[npc.id] = {
        type: "scene",
        sceneId: resolvedLocation,
      };
    } else if (moduleData.junctions.has(resolvedLocation)) {
      characterPositions[npc.id] = {
        type: "junction",
        junctionId: resolvedLocation,
      };
    } else if (moduleData.roads.has(resolvedLocation)) {
      characterPositions[npc.id] = {
        type: "road",
        roadId: resolvedLocation,
        position: 0.5,
      };
    } else {
      console.warn(
        `[moduleLoader] NPC ${npc.id} resolved to unsupported location ${resolvedLocation}, using default scene ${defaultSceneId}`
      );
      characterPositions[npc.id] = {
        type: "scene",
        sceneId: defaultSceneId,
      };
    }
  }

  // Build scenarioConditions from scenes, junctions, and roads
  const scenarioConditions: Record<string, any[]> = {};
  for (const [sceneId, scene] of moduleData.scenes) {
    if (scene.conditions && scene.conditions.length > 0) {
      scenarioConditions[sceneId] = [...scene.conditions];
    }
  }
  for (const [id, junc] of moduleData.junctions) {
    if (junc.conditions && junc.conditions.length > 0) {
      scenarioConditions[id] = [...junc.conditions];
    }
  }
  for (const [id, road] of moduleData.roads) {
    if (road.conditions && road.conditions.length > 0) {
      scenarioConditions[id] = [...road.conditions];
    }
  }

  // Passthrough: surface module-level feature init configs onto moduleSetup.
  // Loader stays "dumb" about feature internals — it just mirrors known blobs
  // (today: weatherPresets) under `featureInit[featureId]`. Features read via
  // FeatureReadContext.getFeatureInitConfig<T>(featureId) during Phase 0 init.
  let moduleSetupWithInit: ModuleSetup | null = moduleData.setup;
  if (moduleSetupWithInit) {
    const mergedInit: Record<string, unknown> = {
      ...(moduleSetupWithInit.featureInit ?? {}),
    };
    if (
      Array.isArray(moduleSetupWithInit.weatherPresets) &&
      moduleSetupWithInit.weatherPresets.length > 0
    ) {
      mergedInit.weather = moduleSetupWithInit.weatherPresets;
    }
    moduleSetupWithInit = {
      ...moduleSetupWithInit,
      featureInit: Object.keys(mergedInit).length > 0 ? mergedInit : undefined,
    };
  }

  return {
    sessionId,
    scenes: moduleData.scenes,
    junctions: moduleData.junctions,
    roads: moduleData.roads,
    gameDateTime,
    npcCharacters: simulatedNpcs,
    moduleName: moduleData.moduleName,
    moduleSetup: moduleSetupWithInit,
    scenarioOutlines: moduleData.scenarioOutlines,
    scopedFeatureStates: { scene: {}, region: {}, character: {}, global: {} },
    scriptedEventStates: {},
    environmentReadings: {},
    npcStats,
    npcInventories,
    npcRelationshipGraph,
    scenarioConditions,
    blockedConnections: new Map(),
    npcResidences,
    transportEdges: moduleData.transportEdges,
    topology,
    characterPositions,
    npcInjectionPolicy: moduleData.npcInjectionPolicy,
    loadedAt: new Date(),
    lastUpdated: new Date(),
  };
}

function validateModuleSetupStartDate(
  moduleId: string,
  setup: ModuleSetup | null
): void {
  if (!setup?.startDate) {
    throw new Error(
      `Module "${moduleId}" missing required ModuleSetup.startDate. Add a "startDate": "YYYY-MM-DD" field (e.g. "1923-10-15") to the module's setup section.`
    );
  }
  if (!ISO_DATE_RE.test(setup.startDate)) {
    throw new Error(
      `Module "${moduleId}" has invalid ModuleSetup.startDate "${setup.startDate}". Expected ISO date "YYYY-MM-DD" (e.g. "1923-10-15").`
    );
  }
}
