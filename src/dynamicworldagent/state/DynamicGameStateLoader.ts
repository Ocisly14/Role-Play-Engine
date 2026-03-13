/**
 * Dynamic Game State Loader
 * Loads DynamicWorld data from database or files into DynamicGameState
 */

import fs from "fs";
import path from "path";
import { ModelProviderName } from "../../models/types.js";
import { EmbeddingClient } from "../../rag/embedding.js";
import { NPCLoader } from "../../shared/agents/character/npcloader/index.js";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../shared/agents/memory/database/index.js";
import {
  resolveModuleIdByName,
  scopeIdByModule,
  stripModuleScope,
} from "../../shared/agents/memory/database/moduleScope.js";
import { getPrismaClient } from "../../shared/agents/memory/database/prismaClient.js";
import { resolveEmailId } from "../../shared/agents/memory/database/userContext.js";
import type { SceneCondition } from "../dynamicBasicAgent/npcPlanning/types.js";
import { bootstrapNpcSecrets } from "../memory/bootstrapSecrets.js";
import type { DynamicGameState } from "./DynamicGameState.js";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "./DynamicGameState.js";
import { decodeSceneItemsPayload } from "./sceneItemContextPayload.js";
import type { DynamicNPCProfile, DynamicScene, ModuleSetup } from "./types.js";
import { WorldModuleLoader } from "./worldModuleLoader.js";

function normalizeIdToModuleScope(id: string, moduleId: string | null): string {
  if (!moduleId) return id;
  return scopeIdByModule(stripModuleScope(id), moduleId);
}

function loadModuleSetupFromFiles(moduleName: string): ModuleSetup | null {
  const moduleDir = path.join(process.cwd(), "data", "Mods", moduleName);
  const source = path.join(moduleDir, "module_setup.json");

  if (!fs.existsSync(source)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(source, "utf8")) as ModuleSetup;
    return parsed;
  } catch (error) {
    console.warn(
      `[DynamicGameState] Failed to load module setup for "${moduleName}":`,
      error
    );
    return null;
  }
}

/**
 * Load DynamicGameState from database
 */
export async function loadDynamicGameStateFromDatabase(
  db: CoCDatabase | CoCDatabaseAdapter,
  moduleName: string,
  emailId?: string
): Promise<DynamicGameState | null> {
  const prisma = getPrismaClient();
  const resolvedEmailId = resolveEmailId(emailId);
  const moduleId = await resolveModuleIdByName(moduleName, resolvedEmailId);
  if (!moduleId) {
    console.warn(
      `[DynamicGameState] Module "${moduleName}" not found in modules table`
    );
    return null;
  }

  // Check if module exists in database
  const moduleData = await prisma.moduleBackground.findUnique({
    where: { moduleId },
    select: {
      moduleId: true,
    },
  });

  if (!moduleData) {
    console.warn(
      `[DynamicGameState] Module "${moduleName}" not found in database`
    );
    return null;
  }

  // Initialize state with minimal params (will be populated by loadWorldData)
  // Note: This creates a partial state that will be merged with runtime data later
  const state = initialDynamicGameState({
    sessionId: "", // Will be set when creating complete state
    moduleName,
  });
  const manager = new DynamicGameStateManager(state);

  try {
    const moduleSetup = loadModuleSetupFromFiles(moduleName);
    if (moduleSetup) {
      manager.loadWorldData({
        moduleSetup,
      });
    }

    // Load scenario outlines from database
    const scenarioRows = await prisma.scenario.findMany({
      where: { moduleId },
      select: {
        scenarioId: true,
        name: true,
        description: true,
        sourcePlaceId: true,
        residents: true,
      },
    });

    // Count scenes per scenario for subSceneCount
    const sceneCountByScenario = new Map<string, number>();
    const sceneCounts = await prisma.scene.groupBy({
      by: ["scenarioId"],
      where: { ...(moduleId ? { moduleId } : {}) },
      _count: { sceneId: true },
    });
    for (const sc of sceneCounts) {
      sceneCountByScenario.set(sc.scenarioId, sc._count.sceneId);
    }

    const scenarioOutlines = scenarioRows.map((row) => ({
      id: row.scenarioId,
      name: row.name,
      description: row.description || "",
      sourcePlaceId: row.sourcePlaceId || undefined,
      residents: Array.isArray(row.residents)
        ? (row.residents as string[])
        : undefined,
      subSceneCount: sceneCountByScenario.get(row.scenarioId) ?? 0,
    }));

    if (scenarioOutlines.length > 0) {
      manager.loadWorldData({ scenarioOutlines });
      console.log(
        `[DynamicGameState] Loaded ${scenarioOutlines.length} scenario outlines from database`
      );
    }

    console.log(`[DynamicGameState] Loaded state for module "${moduleName}"`);
    return manager.getState();
  } catch (error) {
    console.error(
      `[DynamicGameState] Failed to load state for module "${moduleName}":`,
      error
    );
    return null;
  }
}

/**
 * Load DynamicGameState from WorldModuleLoader
 */
export async function loadDynamicGameStateFromModuleLoader(
  db: CoCDatabase | CoCDatabaseAdapter,
  moduleName: string,
  emailId?: string
): Promise<DynamicGameState | null> {
  const modsDir = path.join(process.cwd(), "data", "Mods");
  const moduleDir = path.join(modsDir, moduleName);

  const loader = new WorldModuleLoader(db, {
    emailId: resolveEmailId(emailId),
  });
  const loadedModule = await loader.loadWorldModule(moduleDir);

  if (!loadedModule) {
    console.warn(
      `[DynamicGameState] Failed to load module "${moduleName}" from files`
    );
    return null;
  }

  // Initialize state with minimal params (will be populated by loadWorldData)
  // Note: This creates a partial state that will be merged with runtime data later
  const state = initialDynamicGameState({
    sessionId: "", // Will be set when creating complete state
    moduleName,
  });
  const manager = new DynamicGameStateManager(state);

  // Load all world data
  manager.loadWorldData({
    moduleSetup: loadedModule.moduleSetup ?? undefined,
    scenarioOutlines: loadedModule.scenarios,
  });

  // Load transport edges from the module (file-based loader provides them)
  // Use type assertion to bypass Readonly — we are still in the initialization phase
  if (loadedModule.transportEdges && loadedModule.transportEdges.length > 0) {
    (manager.getState() as DynamicGameState).transportEdges =
      loadedModule.transportEdges;
  }

  // Load scenes from the module into state
  if (loadedModule.scenes && loadedModule.scenes.size > 0) {
    for (const [sceneId, scene] of loadedModule.scenes.entries()) {
      manager.updateScene(sceneId, scene);
    }
  }

  // Load topology if junctions/roads available
  if (loadedModule.junctions.size > 0 || loadedModule.roads.size > 0) {
    const { buildTopology } = await import("./topologyTypes.js");
    const topology = buildTopology(loadedModule.junctions, loadedModule.roads);
    manager.setTopology(topology);
    console.log(
      `[DynamicGameState] Built topology: ${loadedModule.junctions.size} junctions, ${loadedModule.roads.size} roads`
    );
  }

  console.log(
    `[DynamicGameState] Loaded state for module "${moduleName}" from files`
  );
  return manager.getState();
}

/**
 * Load DynamicGameState (tries database first, then files)
 * Only loads DynamicWorld-specific data, not runtime data
 */
export async function loadDynamicGameState(
  db: CoCDatabase | CoCDatabaseAdapter,
  moduleName: string,
  emailId?: string
): Promise<DynamicGameState | null> {
  const resolvedEmailId = resolveEmailId(emailId);
  // Try database first
  const dbState = await loadDynamicGameStateFromDatabase(
    db,
    moduleName,
    resolvedEmailId
  );
  if (dbState) {
    const moduleSetup = loadModuleSetupFromFiles(moduleName);
    if (moduleSetup) {
      (dbState as DynamicGameState).moduleSetup = moduleSetup;
    }
    return dbState;
  }

  // Fall back to file loader
  return await loadDynamicGameStateFromModuleLoader(
    db,
    moduleName,
    resolvedEmailId
  );
}

/**
 * Initialize complete DynamicGameState with runtime data (scenarios, NPCs)
 * This creates a fully initialized NPC simulation state ready for gameplay
 */
export async function initializeCompleteDynamicGameState(
  db: CoCDatabase | CoCDatabaseAdapter,
  params: {
    sessionId: string;
    moduleName: string;
    emailId?: string;
  }
): Promise<DynamicGameState | null> {
  const prisma = getPrismaClient();
  const resolvedEmailId = resolveEmailId(params.emailId);
  const scopedModuleId =
    (await resolveModuleIdByName(params.moduleName, resolvedEmailId)) || null;

  // 1. Load all baseline scenes for this module's scenarios
  let startSceneId: string | null = null; // Used for NPC default location fallback
  let gameDay = 1;
  let timeOfDay = "08:00";
  const scenesMap = new Map<string, DynamicScene>();

  // Helper function to build a DynamicScene from a Prisma scene row
  const buildSceneFromRow = async (sceneRow: any): Promise<DynamicScene> => {
    // Load scene conditions
    const sceneConditions = await prisma.scenarioCondition.findMany({
      where: {
        sceneId: sceneRow.sceneId,
        ...(scopedModuleId ? { moduleId: scopedModuleId } : {}),
      },
      select: {
        conditionId: true,
        description: true,
        mechanicalEffect: true,
      },
    });

    const sceneImage =
      sceneRow.sceneImagePath != null &&
      String(sceneRow.sceneImagePath).trim() !== ""
        ? { path: String(sceneRow.sceneImagePath).trim() }
        : undefined;
    const { items, itemContexts } = decodeSceneItemsPayload(sceneRow.items);

    return {
      id: sceneRow.sceneId,
      name: sceneRow.name || sceneRow.scenario?.name,
      description: sceneRow.description,
      parentLocationId: sceneRow.parentLocationId || "",
      connections: Array.isArray(sceneRow.connections)
        ? sceneRow.connections
        : [],
      items,
      itemContexts,
      sceneImage,
      conditions: sceneConditions.map((cond) => ({
        description: cond.description,
        mechanicalEffect: cond.mechanicalEffect
          ? typeof cond.mechanicalEffect === "string"
            ? undefined
            : (cond.mechanicalEffect as SceneCondition["mechanicalEffect"])
          : undefined,
      })),
    };
  };

  // Load all scenes for this module.
  // initialScene only decides start scene.
  const allModuleScenes = await prisma.scene.findMany({
    where: {
      ...(scopedModuleId ? { moduleId: scopedModuleId } : {}),
    },
    include: {
      scenario: {
        select: { name: true },
      },
    },
    orderBy: [{ scenarioId: "asc" }, { createdAt: "asc" }],
  });

  // Determine starting scene (used for NPC default location fallback and game time):
  // 1) first initialScene=true (if present), otherwise
  // 2) first available module scene.
  const startSceneRow =
    allModuleScenes.find((row) => row.initialScene) ||
    allModuleScenes[0] ||
    null;

  // Build scenes — flat Map keyed by sceneId (one scene per ID)
  for (const sceneRow of allModuleScenes) {
    const sceneId = sceneRow.sceneId;
    // Only keep the first (baseline) scene per sceneId
    if (!scenesMap.has(sceneId)) {
      const scene = await buildSceneFromRow(sceneRow);
      scenesMap.set(sceneId, scene);
    }
  }

  // Extract start scene info for NPC defaults and game time
  if (startSceneRow) {
    startSceneId = startSceneRow.sceneId;

    console.log(
      `[DynamicGameState] Start scene: ${startSceneRow.name || startSceneRow.scenario?.name} (${startSceneRow.sceneId})`
    );

    // Parse game time from scene
    if (startSceneRow.gameTime) {
      console.log(
        `[DynamicGameState] Loading game time from scene: "${startSceneRow.gameTime}"`
      );
      const parsedTime = parseInitialGameTime(startSceneRow.gameTime);
      if (parsedTime) {
        if (parsedTime.gameDay !== undefined) {
          gameDay = parsedTime.gameDay;
          console.log(`[DynamicGameState] Set gameDay to: ${gameDay}`);
        }
        timeOfDay = parsedTime.timeOfDay;
        console.log(`[DynamicGameState] Set timeOfDay to: ${timeOfDay}`);
      } else {
        console.warn(
          `[DynamicGameState] Failed to parse game_time: "${startSceneRow.gameTime}", using defaults: Day ${gameDay}, ${timeOfDay}`
        );
      }
    } else {
      console.log(
        `[DynamicGameState] No game_time in scene, using defaults: Day ${gameDay}, ${timeOfDay}`
      );
    }
  }

  console.log(
    `[DynamicGameState] Loaded ${scenesMap.size} scenes from ${allModuleScenes.length} scene rows`
  );

  // 2. Load all NPCs and normalize legacy ids to module scope.
  const npcLoader = new NPCLoader(db as any, undefined, undefined, {
    emailId: resolvedEmailId,
  });
  const allNPCs = await npcLoader.getAllNPCs();

  const npcCharacters: DynamicNPCProfile[] = allNPCs.map((npc: any) => {
    const normalizedId = normalizeIdToModuleScope(npc.id, scopedModuleId);
    return {
      ...npc,
      id: normalizedId,
      longTermIntent: npc.longTermIntent ?? npc.background ?? "",
      knowledge: Array.isArray(npc.knowledge)
        ? npc.knowledge.map((k: any) => ({
            ...k,
            id: normalizeIdToModuleScope(k.id, scopedModuleId),
          }))
        : [],
      relationships: Array.isArray(npc.relationships)
        ? npc.relationships.map((rel: any) => ({
            ...rel,
            targetId: rel.targetId
              ? normalizeIdToModuleScope(rel.targetId, scopedModuleId)
              : rel.targetId,
          }))
        : [],
    } as DynamicNPCProfile;
  });

  console.log(
    `[DynamicGameState] Loaded ${npcCharacters.length} NPCs from database`
  );

  // 3. Load DynamicWorld data
  const worldData = await loadDynamicGameState(
    db,
    params.moduleName,
    resolvedEmailId
  );
  if (!worldData) {
    console.warn(
      `[DynamicGameState] Failed to load world data for module "${params.moduleName}"`
    );
    return null;
  }

  // 4. Create complete state with runtime data
  // Merge module baseline scenes with any existing in-memory scenes (flat map, one per ID)
  const mergedScenes = new Map(worldData.scenes);
  for (const [sceneId, scene] of scenesMap.entries()) {
    if (!mergedScenes.has(sceneId)) {
      mergedScenes.set(sceneId, scene);
    }
  }

  const completeState: DynamicGameState = {
    ...worldData,
    sessionId: params.sessionId,
    npcCharacters,
    gameDay,
    timeOfDay,
    // Store all module scenes in the flat scenes map.
    // This allows agents to read all module scenes directly from state.
    scenes: mergedScenes,
  };

  // Initialize NPC Planning runtime state from module data
  if (npcCharacters.length > 0) {
    const defaultScenarioId =
      startSceneId ?? completeState.scenarioOutlines?.[0]?.id ?? "unknown";

    for (const npc of npcCharacters) {
      // npcLocations: from NPC actionLog or default to starting scene
      if (!completeState.npcLocations[npc.id]) {
        const actionLog = npc.actionLog ?? [];
        let lastLog: { location?: string } | undefined;
        for (let i = actionLog.length - 1; i >= 0; i--) {
          if (actionLog[i].location) {
            lastLog = actionLog[i];
            break;
          }
        }
        completeState.npcLocations[npc.id] =
          lastLog?.location ?? defaultScenarioId;
      }

      // npcStats: from NPC profile status
      if (!completeState.npcStats[npc.id]) {
        completeState.npcStats[npc.id] = {
          hp: npc.status?.hp ?? npc.attributes?.con ?? 10,
          san: npc.status?.sanity ?? npc.attributes?.pow ?? 50,
        };
      }

      // npcInventories: from NPC profile inventory
      if (!completeState.npcInventories[npc.id]) {
        completeState.npcInventories[npc.id] = Array.isArray(npc.inventory)
          ? npc.inventory.map((item) => {
              if (typeof item === "string") {
                return { id: item, name: item };
              }
              return {
                id: item.name ?? String(item),
                name: item.name ?? String(item),
                ...(item.properties ?? {}),
              };
            })
          : [];
      }

      // npcDiscoveredKnowledge: start empty
      if (!completeState.npcDiscoveredKnowledge[npc.id]) {
        completeState.npcDiscoveredKnowledge[npc.id] = [];
      }

      // npcRelationshipGraph: from NPC profile relationships
      if (!completeState.npcRelationshipGraph[npc.id]) {
        const rels: Record<string, { score: number; note: string }> = {};
        for (const rel of npc.relationships ?? []) {
          if (rel.targetId) {
            rels[rel.targetId] = {
              score: (rel as any).score ?? 0,
              note: (rel as any).note ?? rel.attitude ?? "",
            };
          }
        }
        completeState.npcRelationshipGraph[npc.id] = rels;
      }
    }

    // blockedConnections: initially empty — all connections are open at game start
    // Static connections are defined on DynamicScene.connections

    // Populate scenarioConditions from scene.conditions so tick processor can read them
    for (const [sceneId, scene] of completeState.scenes) {
      if (scene.conditions && scene.conditions.length > 0) {
        completeState.scenarioConditions[sceneId] = scene.conditions
          .filter((c) => c.mechanicalEffect)
          .map((c) => ({
            description: c.description,
            mechanicalEffect: c.mechanicalEffect,
          }));
      }
    }

    // Build npcResidences from ScenarioOutline.residents
    for (const outline of completeState.scenarioOutlines ?? []) {
      if (outline.residents) {
        for (const npcId of outline.residents) {
          completeState.npcResidences[npcId] = outline.id;
        }
      }
    }

    console.log(
      `[DynamicGameState] Initialized NPC planning runtime state for ${npcCharacters.length} NPCs`
    );
  }

  // Create session record in database via Prisma upsert
  // This is required for checkpoint saves to work correctly
  const moduleId = scopedModuleId;

  const modName = completeState.moduleName || null;
  await prisma.session.upsert({
    where: { sessionId: params.sessionId },
    create: {
      sessionId: params.sessionId,
      moduleId,
      emailId: resolvedEmailId || null,
      modName,
      characterId: null,
      characterName: null,
      status: "active",
      metadata: {},
    },
    update: {
      lastActivityAt: new Date(),
      moduleId,
      emailId: resolvedEmailId || null,
      modName: modName || undefined,
    },
  });

  // Bootstrap NPC secrets into the unified NpcMemory system
  if (npcCharacters.length > 0 && scopedModuleId) {
    try {
      const embedClient = new EmbeddingClient(
        (process.env.MODEL_PROVIDER as ModelProviderName) ||
          ModelProviderName.OPENAI
      );
      await bootstrapNpcSecrets({
        prisma,
        embedClient,
        sessionId: params.sessionId,
        moduleId: scopedModuleId,
        npcs: npcCharacters,
        gameDay,
        gameTime: timeOfDay,
      });
    } catch (error) {
      // Non-fatal: secrets will be missing from memory but game can still run
      console.error(
        "[DynamicGameState] Failed to bootstrap NPC secrets:",
        error
      );
    }
  }

  console.log(
    `[DynamicGameState] Initialized complete state for module "${params.moduleName}" and created session record`
  );
  return completeState;
}

/**
 * Parse initial game time from string format
 */
function parseInitialGameTime(
  value: string
): { gameDay?: number; timeOfDay: string } | null {
  const trimmed = value.trim();

  // Match format: "Day X, HH:MM" or "Day X HH:MM" (case insensitive, comma optional)
  const dayMatchWithComma = /^day\s+(\d+),\s*(\d{1,2}):(\d{2})$/i.exec(trimmed);
  if (dayMatchWithComma) {
    const gameDay = Number(dayMatchWithComma[1]);
    const hours = dayMatchWithComma[2];
    const minutes = dayMatchWithComma[3];
    const timeOfDay = `${hours.padStart(2, "0")}:${minutes}`;
    if (
      Number.isFinite(gameDay) &&
      gameDay > 0 &&
      isValidTimeOfDay(timeOfDay)
    ) {
      return { gameDay, timeOfDay };
    }
    return null;
  }

  // Match format: "Day X HH:MM" (without comma, case insensitive)
  const dayMatch = /^day\s+(\d+)\s+(\d{1,2}):(\d{2})$/i.exec(trimmed);
  if (dayMatch) {
    const gameDay = Number(dayMatch[1]);
    const hours = dayMatch[2];
    const minutes = dayMatch[3];
    const timeOfDay = `${hours.padStart(2, "0")}:${minutes}`;
    if (
      Number.isFinite(gameDay) &&
      gameDay > 0 &&
      isValidTimeOfDay(timeOfDay)
    ) {
      return { gameDay, timeOfDay };
    }
    return null;
  }

  // Match format: "HH:MM" only
  if (isValidTimeOfDay(trimmed)) {
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (timeMatch) {
      const hours = timeMatch[1].padStart(2, "0");
      const minutes = timeMatch[2];
      return { timeOfDay: `${hours}:${minutes}` };
    }
    return { timeOfDay: trimmed };
  }

  return null;
}

function isValidTimeOfDay(value: string): boolean {
  const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!timeMatch) return false;
  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}
