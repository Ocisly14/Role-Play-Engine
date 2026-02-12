/**
 * Dynamic Game State Loader
 * Loads DynamicWorld data from database or files into DynamicGameState
 */

import path from "path";
import type { CoCDatabase, CoCDatabaseAdapter } from "../../shared/agents/memory/database/index.js";
import { getPrismaClient } from "../../shared/agents/memory/database/prismaClient.js";
import { WorldModuleLoader } from "../world_builder/worldModuleLoader.js";
import type { DynamicGameState } from "./DynamicGameState.js";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "./DynamicGameState.js";
import type { NPCProfile } from "../../shared/agents/models/gameTypes.js";
import type {
  DynamicCharacterProfile,
  DynamicNPCProfile,
} from "../world_builder/types.js";
import type { DynamicScenarioSnapshot } from "../world_builder/types.js";
import { NPCLoader } from "../../shared/agents/character/npcloader/index.js";
import { resolveEmailId } from "../../shared/agents/memory/database/userContext.js";
import type { ScenarioClue, ScenarioCondition } from "../../shared/agents/models/scenarioTypes.js";

/**
 * Convert NPCProfile (from multiagent system) to DynamicNPCProfile (for DynamicWorld system)
 * Removes currentLocation field as it's tracked via actionLog in DynamicWorld
 */
function convertNPCProfileToDynamic(npc: NPCProfile): DynamicNPCProfile {
  const { currentLocation, ...rest } = npc;
  return rest as DynamicNPCProfile;
}

/**
 * Convert CharacterProfile (from multiagent system) to DynamicCharacterProfile (for DynamicWorld system)
 * Removes currentLocation field as it's tracked via actionLog in DynamicWorld
 */
function convertCharacterProfileToDynamic(
  character: any
): DynamicCharacterProfile {
  const { currentLocation, ...rest } = character;
  return rest as DynamicCharacterProfile;
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

  // Check if module exists in database
  const moduleData = await prisma.moduleBackground.findFirst({
    where: {
      title: moduleName,
      ...(resolvedEmailId ? { emailId: resolvedEmailId } : {}),
    },
    select: {
      moduleId: true,
      title: true,
      keeperGuidance: true,
      moduleLimitations: true,
      moduleNotes: true,
      introduction: true,
      globalTrigger: true,
      macroSceneStructure: true,
      truthTimeline: true,
      knowledgeMatrix: true,
      redHerrings: true,
      historicalMythos: true,
      endStateDefinition: true,
      macroMapPath: true,
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
    playerCharacter: {
      id: "placeholder",
      name: "Placeholder",
      attributes: {
        STR: 50,
        CON: 50,
        DEX: 50,
        APP: 50,
        POW: 50,
        SIZ: 50,
        INT: 50,
        EDU: 50,
      },
      status: {
        hp: 10,
        maxHp: 10,
        sanity: 60,
        maxSanity: 99,
        luck: 50,
        mp: 10,
        conditions: [],
      },
      skills: {},
      inventory: [],
      notes: "",
      actionLog: [],
    },
  });
  const manager = new DynamicGameStateManager(state);

  try {
    // Load module digest
    if (
      moduleData.keeperGuidance ||
      moduleData.moduleLimitations ||
      moduleData.moduleNotes ||
      moduleData.introduction
    ) {
      const moduleDigest: any = {
        moduleNotes: moduleData.moduleNotes || "",
        keeperGuidance: moduleData.keeperGuidance || "",
        moduleLimitations: moduleData.moduleLimitations || "",
        introduction: moduleData.introduction || "",
      };

      // Add globalTrigger if present (already parsed as JSON by Prisma)
      if (moduleData.globalTrigger) {
        moduleDigest.globalTrigger = moduleData.globalTrigger;
      }

      // Add macroMapPath if present
      if (moduleData.macroMapPath) {
        moduleDigest.macroMapPath = moduleData.macroMapPath;
      }

      manager.loadWorldData({
        moduleDigest,
      });
    }

    // Load macro scene (already parsed as JSON by Prisma)
    if (moduleData.macroSceneStructure) {
      manager.loadWorldData({ macroScene: moduleData.macroSceneStructure as any });
    }

    // Load truth timeline (already parsed as JSON by Prisma)
    if (moduleData.truthTimeline) {
      manager.loadWorldData({ truthTimeline: moduleData.truthTimeline as any });
    }

    // Load knowledge matrix (already parsed as JSON by Prisma)
    if (moduleData.knowledgeMatrix) {
      manager.loadWorldData({ knowledgeMatrix: moduleData.knowledgeMatrix as any });
    }

    // Load red herrings (already parsed as JSON by Prisma)
    if (moduleData.redHerrings) {
      manager.loadWorldData({ redHerrings: moduleData.redHerrings as any });
    }

    // Load mythos events (already parsed as JSON by Prisma)
    if (moduleData.historicalMythos) {
      manager.loadWorldData({ mythosEvents: moduleData.historicalMythos as any });
    }

    // Load end state (already parsed as JSON by Prisma)
    if (moduleData.endStateDefinition) {
      manager.loadWorldData({ endState: moduleData.endStateDefinition as any });
    }

    // Load scenario outlines from database (including connections)
    const scenarioRows = await prisma.scenario.findMany({
      where: {
        ...(resolvedEmailId ? { emailId: resolvedEmailId } : {}),
      },
      select: {
        scenarioId: true,
        name: true,
        description: true,
        tags: true,
        connections: true,
        sourcePlaceId: true,
      },
    });

    // Get knowledge matrix to look up sourcePlaceName
    const knowledgeMatrix = manager.getState().knowledgeMatrix || [];

    const scenarioOutlines = scenarioRows.map((row) => {
      // Prisma returns JSON fields already parsed
      const connections: any[] = Array.isArray(row.connections) ? row.connections : [];

      // Find sourcePlaceName from knowledgeMatrix if sourcePlaceId exists
      let sourcePlaceName: string | undefined = undefined;
      if (row.sourcePlaceId) {
        const knowledgeHolder = knowledgeMatrix.find(
          (holder) =>
            holder.id === row.sourcePlaceId && holder.holderType === "PLACE"
        );
        if (knowledgeHolder) {
          sourcePlaceName = knowledgeHolder.holderName;
        }
      }

      // Convert database format to ScenarioOutline format
      return {
        id: row.scenarioId,
        name: row.name,
        description: row.description || "",
        sourcePlaceId: row.sourcePlaceId || undefined,
        sourcePlaceName: sourcePlaceName,
        tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
        evidence: [], // Database doesn't store evidence, set to empty array
        clues: [], // Database doesn't store clues, set to empty array
        connections: connections.map((conn: any) => {
          // Find target scenario to resolve name and id
          const targetScenario = scenarioRows.find(
            (s) =>
              s.name === conn.scenarioName ||
              s.scenarioId === conn.scenarioName ||
              s.scenarioId === conn.scenarioId ||
              s.name === conn.scenarioId
          );
          return {
            scenarioName:
              targetScenario?.name || conn.scenarioName || conn.scenarioId,
            scenarioId:
              targetScenario?.scenarioId ||
              conn.scenarioId ||
              conn.scenarioName,
            relationshipType: conn.relationshipType,
            description: conn.description,
            blocked: conn.blocked,
            blockReason: conn.blockReason,
          };
        }),
      };
    });

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
    playerCharacter: {
      id: "placeholder",
      name: "Placeholder",
      attributes: {
        STR: 50,
        CON: 50,
        DEX: 50,
        APP: 50,
        POW: 50,
        SIZ: 50,
        INT: 50,
        EDU: 50,
      },
      status: {
        hp: 10,
        maxHp: 10,
        sanity: 60,
        maxSanity: 99,
        luck: 50,
        mp: 10,
        conditions: [],
      },
      skills: {},
      inventory: [],
      notes: "",
      actionLog: [],
    },
  });
  const manager = new DynamicGameStateManager(state);

  // Load all world data
  manager.loadWorldData({
    moduleDigest: loadedModule.moduleDigest,
    macroScene: loadedModule.macroScene,
    truthTimeline: loadedModule.truthTimeline,
    knowledgeMatrix: loadedModule.knowledgeMatrix,
    redHerrings: loadedModule.redHerrings,
    mythosEvents: loadedModule.mythosEvents,
    endState: loadedModule.endState,
    scenarioOutlines: loadedModule.scenarios,
  });

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
 * Initialize complete DynamicGameState with runtime data (character, scenario, NPCs)
 * This creates a fully initialized state ready for gameplay
 */
export async function initializeCompleteDynamicGameState(
  db: CoCDatabase | CoCDatabaseAdapter,
  params: {
    sessionId: string;
    moduleName: string;
    characterId?: string;
    emailId?: string;
  }
): Promise<DynamicGameState | null> {
  const prisma = getPrismaClient();
  const resolvedEmailId = resolveEmailId(params.emailId);

  // 1. Load player character
  let playerCharacter: DynamicCharacterProfile;
  if (params.characterId) {
    const character = await prisma.character.findFirst({
      where: {
        characterId: params.characterId,
        isNpc: false,
      },
      select: {
        characterId: true,
        name: true,
        attributes: true,
        status: true,
        skills: true,
        inventory: true,
        notes: true,
        occupation: true,
        age: true,
        gender: true,
        appearance: true,
        personality: true,
        background: true,
      },
    });

    if (!character) {
      throw new Error("Character not found");
    }

    // Prisma returns JSON fields already parsed
    const parsedAttributes = character.attributes as any;
    const parsedStatus = character.status as any;
    const parsedSkillsRaw = (character.skills || {}) as any;
    const parsedInventory = (character.inventory || []) as any;

    let parsedNotes: any = {};
    try {
      parsedNotes =
        typeof character.notes === "string" ? JSON.parse(character.notes) : {};
    } catch (e) {
      parsedNotes = {};
    }

    const parsedSkills: Record<string, number> = {};
    for (const [skillName, skillData] of Object.entries(parsedSkillsRaw)) {
      if (
        typeof skillData === "object" &&
        skillData !== null &&
        "value" in skillData
      ) {
        parsedSkills[skillName] = (skillData as any).value;
      } else {
        parsedSkills[skillName] = typeof skillData === "number" ? skillData : 0;
      }
    }

    playerCharacter = {
      id: character.characterId,
      name: character.name,
      attributes: parsedAttributes,
      status: parsedStatus,
      skills: parsedSkills,
      inventory: parsedInventory,
      notes: character.notes || "",
      actionLog: [],
      occupation: character.occupation || undefined,
      age: character.age || undefined,
      gender: character.gender || parsedNotes.gender || undefined,
      appearance: character.appearance || parsedNotes.appearance || undefined,
      personality: character.personality || undefined,
      backstory: character.background || parsedNotes.backstory || undefined,
      era: parsedNotes.era || undefined,
      residence: parsedNotes.residence || undefined,
      birthplace: parsedNotes.birthplace || undefined,
      ideology: parsedNotes.ideology || undefined,
      significantPeople: parsedNotes.people || undefined,
      gear: parsedNotes.gear || undefined,
      weapons: parsedNotes.weapons || undefined,
      derivedAttributes: {
        MOV: parsedStatus.mov || undefined,
        BUILD:
          parsedStatus.build !== undefined
            ? String(parsedStatus.build)
            : undefined,
        DB: parsedStatus.damageBonus || undefined,
        ARMOR: undefined,
      },
    };
  } else {
    // Use default character
    playerCharacter = {
      id: "investigator-1",
      name: "Character",
      attributes: {
        STR: 50,
        CON: 50,
        DEX: 50,
        APP: 50,
        POW: 50,
        SIZ: 50,
        INT: 50,
        EDU: 50,
      },
      status: {
        hp: 10,
        maxHp: 10,
        sanity: 60,
        maxSanity: 99,
        luck: 50,
        mp: 10,
        conditions: [],
      },
      inventory: [],
      skills: {
        Perception: 25,
        Listen: 20,
        Research: 20,
        Brawling: 25,
        Dodge: 25,
        Pistol: 20,
      },
      notes: "Auto-generated placeholder character",
      actionLog: [],
    };
  }

  // 2. Load all initial snapshots for all scenarios
  let currentScenario: DynamicScenarioSnapshot | null = null;
  let gameDay = 1;
  let timeOfDay = "08:00";
  const initialSnapshotsMap = new Map<string, DynamicScenarioSnapshot[]>();

  // Helper function to build a snapshot from a Prisma result (async due to Prisma queries)
  const buildSnapshotFromRow = async (snapshotRow: any): Promise<DynamicScenarioSnapshot> => {
    // Load snapshot characters
    const snapshotCharacters = await prisma.scenarioCharacter.findMany({
      where: {
        snapshotId: snapshotRow.snapshotId,
        ...(resolvedEmailId ? { emailId: resolvedEmailId } : {}),
      },
      select: {
        id: true,
        characterName: true,
        characterRole: true,
        characterStatus: true,
        characterLocation: true,
        characterNotes: true,
      },
    });

    // Load snapshot clues
    const snapshotClues = await prisma.scenarioClue.findMany({
      where: {
        snapshotId: snapshotRow.snapshotId,
        ...(resolvedEmailId ? { emailId: resolvedEmailId } : {}),
      },
      select: {
        clueId: true,
        clueText: true,
        category: true,
        difficulty: true,
        clueLocation: true,
        discoveryMethod: true,
        reveals: true,
        discovered: true,
        discoveryDetails: true,
      },
    });

    // Load snapshot conditions
    const snapshotConditions = await prisma.scenarioCondition.findMany({
      where: {
        snapshotId: snapshotRow.snapshotId,
        ...(resolvedEmailId ? { emailId: resolvedEmailId } : {}),
      },
      select: {
        conditionId: true,
        conditionType: true,
        description: true,
        mechanicalEffect: true,
      },
    });

    const sceneImage =
      snapshotRow.sceneImagePath != null &&
      String(snapshotRow.sceneImagePath).trim() !== ""
        ? { path: String(snapshotRow.sceneImagePath).trim() }
        : undefined;

    return {
      id: snapshotRow.snapshotId,
      name: snapshotRow.snapshotName || snapshotRow.scenario?.name,
      location: snapshotRow.location,
      description: snapshotRow.description,
      gameTime: snapshotRow.gameTime || undefined,
      showMap: snapshotRow.showMap === true,
      sceneImage,
      characters: snapshotCharacters.map((char) => ({
        id: char.id,
        name: char.characterName,
        role: char.characterRole,
        status: char.characterStatus,
        location: char.characterLocation || undefined,
        notes: char.characterNotes || undefined,
      })),
      clues: snapshotClues.map((clue) => ({
        id: clue.clueId,
        clueText: clue.clueText,
        category: clue.category as ScenarioClue["category"],
        difficulty: clue.difficulty as ScenarioClue["difficulty"],
        location: clue.clueLocation,
        discoveryMethod: clue.discoveryMethod || undefined,
        // Prisma returns JSON fields already parsed
        reveals: clue.reveals ? (clue.reveals as any[]) : [],
        discovered: clue.discovered === true,
        discoveryDetails: clue.discoveryDetails
          ? (clue.discoveryDetails as any)
          : undefined,
      })),
      conditions: snapshotConditions.map((cond) => ({
        type: cond.conditionType as ScenarioCondition["type"],
        description: cond.description,
        mechanicalEffect: cond.mechanicalEffect || undefined,
      })),
      keeperNotes: snapshotRow.keeperNotes || undefined,
      timeRestriction: snapshotRow.timeRestriction || undefined,
    };
  };

  // Load all initial snapshots (one per scenario) with related scenario name
  const allInitialSnapshots = await prisma.scenarioSnapshot.findMany({
    where: {
      initialSnapshot: true,
      ...(resolvedEmailId
        ? {
            OR: [
              { emailId: resolvedEmailId },
              { scenario: { emailId: resolvedEmailId } },
            ],
          }
        : {}),
    },
    include: {
      scenario: {
        select: { name: true },
      },
    },
    orderBy: { scenarioId: "asc" },
  });

  // Build snapshots and group by scenario_id
  for (const snapshotRow of allInitialSnapshots) {
    const snapshot = await buildSnapshotFromRow(snapshotRow);

    // Store in map (one snapshot per scenario for initial snapshots)
    if (!initialSnapshotsMap.has(snapshotRow.scenarioId)) {
      initialSnapshotsMap.set(snapshotRow.scenarioId, []);
    }
    initialSnapshotsMap.get(snapshotRow.scenarioId)!.push(snapshot);
  }

  // Set the first initial snapshot as currentScenario (for player's starting scene)
  if (allInitialSnapshots.length > 0) {
    const firstInitialSnapshot = allInitialSnapshots[0];
    currentScenario = await buildSnapshotFromRow(firstInitialSnapshot);

    console.log(
      `[DynamicGameState] Found initial snapshot: ${firstInitialSnapshot.snapshotName || firstInitialSnapshot.scenario?.name} (${firstInitialSnapshot.location})`
    );

    // Parse game time from snapshot
    if (firstInitialSnapshot.gameTime) {
      console.log(
        `[DynamicGameState] Loading game time from snapshot: "${firstInitialSnapshot.gameTime}"`
      );
      const parsedTime = parseInitialGameTime(firstInitialSnapshot.gameTime);
      if (parsedTime) {
        if (parsedTime.gameDay !== undefined) {
          gameDay = parsedTime.gameDay;
          console.log(`[DynamicGameState] Set gameDay to: ${gameDay}`);
        }
        timeOfDay = parsedTime.timeOfDay;
        console.log(`[DynamicGameState] Set timeOfDay to: ${timeOfDay}`);
      } else {
        console.warn(
          `[DynamicGameState] Failed to parse game_time: "${firstInitialSnapshot.gameTime}", using defaults: Day ${gameDay}, ${timeOfDay}`
        );
      }
    } else {
      console.log(
        `[DynamicGameState] No game_time in snapshot, using defaults: Day ${gameDay}, ${timeOfDay}`
      );
    }
  }

  console.log(
    `[DynamicGameState] Loaded ${initialSnapshotsMap.size} initial scenario snapshots`
  );

  // 3. Load all NPCs from database (not just current scenario)
  const npcLoader = new NPCLoader(db as any, undefined, undefined, {
    emailId: resolvedEmailId,
  });
  const allNPCs = await npcLoader.getAllNPCs();

  // Convert all NPCs to DynamicNPCProfile format
  const npcCharacters: DynamicNPCProfile[] = allNPCs.map((npc) =>
    convertNPCProfileToDynamic(npc)
  );

  console.log(
    `[DynamicGameState] Loaded ${npcCharacters.length} NPCs from database`
  );

  // 4. Load DynamicWorld data
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

  // 5. Create complete state with runtime data
  // Merge initial snapshots with any existing snapshots from worldData
  const mergedSnapshots = new Map(worldData.updatedDynamicScenarioSnapshots);
  // Add initial snapshots (will not overwrite if already exists, but initial snapshots should be first)
  for (const [scenarioId, snapshots] of initialSnapshotsMap.entries()) {
    if (!mergedSnapshots.has(scenarioId)) {
      mergedSnapshots.set(scenarioId, snapshots);
    } else {
      // If scenario already has snapshots, prepend initial snapshot to the beginning
      const existing = mergedSnapshots.get(scenarioId)!;
      mergedSnapshots.set(scenarioId, [...snapshots, ...existing]);
    }
  }

  const completeState: DynamicGameState = {
    ...worldData,
    sessionId: params.sessionId,
    playerCharacter,
    npcCharacters,
    currentScenario,
    gameDay,
    timeOfDay,
    scenarioTimeState: {
      sceneStartTime: timeOfDay,
      playerTimeConsumption: {},
    },
    // Store all initial snapshots in updatedDynamicScenarioSnapshots
    // This allows Director Agent to access all scenario snapshots without querying database
    updatedDynamicScenarioSnapshots: mergedSnapshots,
  };

  // Create session record in database via Prisma upsert
  // This is required for checkpoint saves to work correctly
  const modName = completeState.moduleName || null;
  await prisma.session.upsert({
    where: { sessionId: params.sessionId },
    create: {
      sessionId: params.sessionId,
      modName,
      characterId: completeState.playerCharacter?.id || null,
      characterName: completeState.playerCharacter?.name || null,
      status: "active",
      metadata: {},
    },
    update: {
      lastActivityAt: new Date(),
      modName: modName || undefined,
    },
  });

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

function isNameSimilar(name1: string, name2: string): boolean {
  const normalize = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
  return normalize(name1) === normalize(name2);
}
