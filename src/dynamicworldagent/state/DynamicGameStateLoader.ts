/**
 * Dynamic Game State Loader
 * Loads DynamicWorld data from database or files into DynamicGameState
 */

import path from "path";
import type { CoCDatabase } from "../../coc_multiagents_system/agents/memory/database/index.js";
import { WorldModuleLoader } from "../world_builder/worldModuleLoader.js";
import type {
  DynamicGameState,
} from "./DynamicGameState.js";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "./DynamicGameState.js";
import type { NPCProfile } from "../../coc_multiagents_system/agents/models/gameTypes.js";
import type { DynamicCharacterProfile, DynamicNPCProfile } from "../world_builder/types.js";
import type { DynamicScenarioSnapshot } from "../world_builder/types.js";
import { NPCLoader } from "../../coc_multiagents_system/agents/character/npcloader/index.js";

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
function convertCharacterProfileToDynamic(character: any): DynamicCharacterProfile {
  const { currentLocation, ...rest } = character;
  return rest as DynamicCharacterProfile;
}

/**
 * Load DynamicGameState from database
 */
export async function loadDynamicGameStateFromDatabase(
  db: CoCDatabase,
  moduleName: string
): Promise<DynamicGameState | null> {
  const database = db.getDatabase();
  
  // Check if module exists in database
  const moduleData = database.prepare(`
    SELECT
      module_id,
      title,
      keeper_guidance,
      module_limitations,
      module_notes,
      introduction,
      global_trigger,
      macro_scene_structure,
      truth_timeline,
      knowledge_matrix,
      red_herrings,
      historical_mythos,
      end_state_definition
    FROM module_backgrounds
    WHERE title = ?
  `).get(moduleName) as any;

  if (!moduleData) {
    console.warn(`[DynamicGameState] Module "${moduleName}" not found in database`);
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
      attributes: { STR: 50, CON: 50, DEX: 50, APP: 50, POW: 50, SIZ: 50, INT: 50, EDU: 50 },
      status: { hp: 10, maxHp: 10, sanity: 60, maxSanity: 99, luck: 50, mp: 10, conditions: [] },
      skills: {},
      inventory: [],
      notes: "",
      actionLog: [],
    },
  });
  const manager = new DynamicGameStateManager(state);

  try {
    // Load module digest
    if (moduleData.keeper_guidance || moduleData.module_limitations || moduleData.module_notes || moduleData.introduction) {
      const moduleDigest: any = {
        moduleNotes: moduleData.module_notes || "",
        keeperGuidance: moduleData.keeper_guidance || "",
        moduleLimitations: moduleData.module_limitations || "",
        introduction: moduleData.introduction || "",
      };

      // Parse globalTrigger if present
      if (moduleData.global_trigger) {
        try {
          moduleDigest.globalTrigger = JSON.parse(moduleData.global_trigger);
        } catch (e) {
          console.warn(`[DynamicGameState] Failed to parse global_trigger:`, e);
        }
      }

      manager.loadWorldData({
        moduleDigest,
      });
    }

    // Load macro scene
    if (moduleData.macro_scene_structure) {
      const macroScene = JSON.parse(moduleData.macro_scene_structure);
      manager.loadWorldData({ macroScene });
    }

    // Load truth timeline
    if (moduleData.truth_timeline) {
      const truthTimeline = JSON.parse(moduleData.truth_timeline);
      manager.loadWorldData({ truthTimeline });
    }

    // Load knowledge matrix
    if (moduleData.knowledge_matrix) {
      const knowledgeMatrix = JSON.parse(moduleData.knowledge_matrix);
      manager.loadWorldData({ knowledgeMatrix });
    }

    // Load red herrings
    if (moduleData.red_herrings) {
      const redHerrings = JSON.parse(moduleData.red_herrings);
      manager.loadWorldData({ redHerrings });
    }

    // Load mythos events
    if (moduleData.historical_mythos) {
      const mythosEvents = JSON.parse(moduleData.historical_mythos);
      manager.loadWorldData({ mythosEvents });
    }

    // Load end state
    if (moduleData.end_state_definition) {
      const endState = JSON.parse(moduleData.end_state_definition);
      manager.loadWorldData({ endState });
    }

    // Load scenario outlines from database (including connections)
    const scenarioRows = database.prepare(`
      SELECT scenario_id, name, description, tags, connections, source_place_id
      FROM scenarios
    `).all() as any[];

    // Get knowledge matrix to look up sourcePlaceName
    const knowledgeMatrix = manager.getState().knowledgeMatrix || [];

    const scenarioOutlines = scenarioRows.map(row => {
      let connections: any[] = [];
      try {
        if (row.connections) {
          connections = JSON.parse(row.connections);
        }
      } catch (e) {
        console.warn(`[DynamicGameState] Failed to parse connections for scenario ${row.scenario_id}:`, e);
      }

      // Find sourcePlaceName from knowledgeMatrix if sourcePlaceId exists
      let sourcePlaceName: string | undefined = undefined;
      if (row.source_place_id) {
        const knowledgeHolder = knowledgeMatrix.find(
          holder => holder.id === row.source_place_id && holder.holderType === "PLACE"
        );
        if (knowledgeHolder) {
          sourcePlaceName = knowledgeHolder.holderName;
        }
      }

      // Convert database format to ScenarioOutline format
      return {
        id: row.scenario_id,
        name: row.name,
        description: row.description || "",
        sourcePlaceId: row.source_place_id || undefined,
        sourcePlaceName: sourcePlaceName,
        tags: row.tags ? JSON.parse(row.tags) : [],
        evidence: [], // Database doesn't store evidence, set to empty array
        clues: [], // Database doesn't store clues, set to empty array
        connections: connections.map((conn: any) => {
          // Find target scenario to resolve name and id
          const targetScenario = scenarioRows.find(
            s => s.name === conn.scenarioName ||
                 s.scenario_id === conn.scenarioName ||
                 s.scenario_id === conn.scenarioId ||
                 s.name === conn.scenarioId
          );
          return {
            scenarioName: targetScenario?.name || conn.scenarioName || conn.scenarioId,
            scenarioId: targetScenario?.scenario_id || conn.scenarioId || conn.scenarioName,
            relationshipType: conn.relationshipType,
            description: conn.description,
            blocked: conn.blocked,
            blockReason: conn.blockReason
          };
        })
      };
    });

    if (scenarioOutlines.length > 0) {
      manager.loadWorldData({ scenarioOutlines });
      console.log(`[DynamicGameState] Loaded ${scenarioOutlines.length} scenario outlines from database`);
    }

    console.log(`[DynamicGameState] Loaded state for module "${moduleName}"`);
    return manager.getState();
  } catch (error) {
    console.error(`[DynamicGameState] Failed to load state for module "${moduleName}":`, error);
    return null;
  }
}

/**
 * Load DynamicGameState from WorldModuleLoader
 */
export async function loadDynamicGameStateFromModuleLoader(
  db: CoCDatabase,
  moduleName: string
): Promise<DynamicGameState | null> {
  const modsDir = path.join(process.cwd(), "data", "Mods");
  const moduleDir = path.join(modsDir, moduleName);

  const loader = new WorldModuleLoader(db);
  const loadedModule = await loader.loadWorldModule(moduleDir);

  if (!loadedModule) {
    console.warn(`[DynamicGameState] Failed to load module "${moduleName}" from files`);
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
      attributes: { STR: 50, CON: 50, DEX: 50, APP: 50, POW: 50, SIZ: 50, INT: 50, EDU: 50 },
      status: { hp: 10, maxHp: 10, sanity: 60, maxSanity: 99, luck: 50, mp: 10, conditions: [] },
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

  console.log(`[DynamicGameState] Loaded state for module "${moduleName}" from files`);
  return manager.getState();
}

/**
 * Load DynamicGameState (tries database first, then files)
 * Only loads DynamicWorld-specific data, not runtime data
 */
export async function loadDynamicGameState(
  db: CoCDatabase,
  moduleName: string
): Promise<DynamicGameState | null> {
  // Try database first
  const dbState = await loadDynamicGameStateFromDatabase(db, moduleName);
  if (dbState) {
    return dbState;
  }

  // Fall back to file loader
  return await loadDynamicGameStateFromModuleLoader(db, moduleName);
}

/**
 * Initialize complete DynamicGameState with runtime data (character, scenario, NPCs)
 * This creates a fully initialized state ready for gameplay
 */
export async function initializeCompleteDynamicGameState(
  db: CoCDatabase,
  params: {
    sessionId: string;
    moduleName: string;
    characterId?: string;
  }
): Promise<DynamicGameState | null> {
  const database = db.getDatabase();

  // 1. Load player character
  let playerCharacter: DynamicCharacterProfile;
  if (params.characterId) {
    const character = database.prepare(`
      SELECT character_id, name, attributes, status, skills, inventory, notes,
             occupation, age, gender, appearance, personality, background
      FROM characters
      WHERE character_id = ? AND is_npc = 0
    `).get(params.characterId) as any;

    if (!character) {
      throw new Error("Character not found");
    }

    // Parse character data
    const parsedAttributes = JSON.parse(character.attributes);
    const parsedStatus = JSON.parse(character.status);
    const parsedSkillsRaw = JSON.parse(character.skills);
    const parsedInventory = JSON.parse(character.inventory);

    let parsedNotes: any = {};
    try {
      parsedNotes = typeof character.notes === 'string'
        ? JSON.parse(character.notes)
        : {};
    } catch (e) {
      parsedNotes = {};
    }

    const parsedSkills: Record<string, number> = {};
    for (const [skillName, skillData] of Object.entries(parsedSkillsRaw)) {
      if (typeof skillData === 'object' && skillData !== null && 'value' in skillData) {
        parsedSkills[skillName] = (skillData as any).value;
      } else {
        parsedSkills[skillName] = typeof skillData === 'number' ? skillData : 0;
      }
    }

    playerCharacter = {
      id: character.character_id,
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
        BUILD: parsedStatus.build !== undefined ? String(parsedStatus.build) : undefined,
        DB: parsedStatus.damageBonus || undefined,
        ARMOR: undefined,
      },
    };
  } else {
    // Use default character
    playerCharacter = {
      id: "investigator-1",
      name: "Investigator",
      attributes: {
        STR: 50, CON: 50, DEX: 50, APP: 50, POW: 50, SIZ: 50, INT: 50, EDU: 50,
      },
      status: {
        hp: 10, maxHp: 10, sanity: 60, maxSanity: 99, luck: 50, mp: 10, conditions: [],
      },
      inventory: [],
      skills: {
        "Spot Hidden": 25, Listen: 20, "Library Use": 20,
        "Fighting (Brawl)": 25, Dodge: 25, "Firearms (Handgun)": 20,
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

  // Helper function to build a snapshot from database row
  const buildSnapshotFromRow = (snapshotRow: any): DynamicScenarioSnapshot => {
    // Load snapshot characters
    const snapshotCharacters = database.prepare(`
      SELECT id, character_name, character_role, character_status,
             character_location, character_notes
      FROM scenario_characters
      WHERE snapshot_id = ?
    `).all(snapshotRow.snapshot_id);

    // Load snapshot clues
    const snapshotClues = database.prepare(`
      SELECT clue_id, clue_text, category, difficulty, clue_location,
             discovery_method, reveals, discovered, discovery_details
      FROM scenario_clues
      WHERE snapshot_id = ?
    `).all(snapshotRow.snapshot_id);

    // Load snapshot conditions
    const snapshotConditions = database.prepare(`
      SELECT condition_id, condition_type, description, mechanical_effect
      FROM scenario_conditions
      WHERE snapshot_id = ?
    `).all(snapshotRow.snapshot_id);

    return {
      id: snapshotRow.snapshot_id,
      name: snapshotRow.snapshot_name || snapshotRow.scenario_name,
      location: snapshotRow.location,
      description: snapshotRow.description,
      gameTime: snapshotRow.game_time || undefined,
      showMap: snapshotRow.show_map === 1,
      characters: (snapshotCharacters as any[]).map(char => ({
        id: char.id,
        name: char.character_name,
        role: char.character_role,
        status: char.character_status,
        location: char.character_location || undefined,
        notes: char.character_notes || undefined,
      })),
      clues: (snapshotClues as any[]).map(clue => ({
        id: clue.clue_id,
        clueText: clue.clue_text,
        category: clue.category,
        difficulty: clue.difficulty,
        location: clue.clue_location,
        discoveryMethod: clue.discovery_method || undefined,
        reveals: clue.reveals ? JSON.parse(clue.reveals) : [],
        discovered: clue.discovered === 1,
        discoveryDetails: clue.discovery_details ? JSON.parse(clue.discovery_details) : undefined,
      })),
      conditions: (snapshotConditions as any[]).map(cond => ({
        type: cond.condition_type,
        description: cond.description,
        mechanicalEffect: cond.mechanical_effect || undefined,
      })),
      keeperNotes: snapshotRow.keeper_notes || undefined,
      timeRestriction: snapshotRow.time_restriction || undefined,
    };
  };

  // Load all initial snapshots (one per scenario)
  const allInitialSnapshots = database.prepare(`
    SELECT
      ss.snapshot_id, ss.scenario_id, ss.snapshot_name, ss.location,
      ss.description, ss.events, ss.keeper_notes,
      ss.time_restriction, ss.show_map, ss.game_time,
      s.name as scenario_name
    FROM scenario_snapshots ss
    JOIN scenarios s ON ss.scenario_id = s.scenario_id
    WHERE ss.initial_snapshot = 1
    ORDER BY ss.scenario_id
  `).all() as any[];

  // Build snapshots and group by scenario_id
  for (const snapshotRow of allInitialSnapshots) {
    const snapshot = buildSnapshotFromRow(snapshotRow);
    
    // Store in map (one snapshot per scenario for initial snapshots)
    if (!initialSnapshotsMap.has(snapshotRow.scenario_id)) {
      initialSnapshotsMap.set(snapshotRow.scenario_id, []);
    }
    initialSnapshotsMap.get(snapshotRow.scenario_id)!.push(snapshot);
  }

  // Set the first initial snapshot as currentScenario (for player's starting scene)
  if (allInitialSnapshots.length > 0) {
    const firstInitialSnapshot = allInitialSnapshots[0];
    currentScenario = buildSnapshotFromRow(firstInitialSnapshot);
    
    console.log(`[DynamicGameState] Found initial snapshot: ${firstInitialSnapshot.snapshot_name || firstInitialSnapshot.scenario_name} (${firstInitialSnapshot.location})`);
    
    // Parse game time from snapshot
    if (firstInitialSnapshot.game_time) {
      console.log(`[DynamicGameState] Loading game time from snapshot: "${firstInitialSnapshot.game_time}"`);
      const parsedTime = parseInitialGameTime(firstInitialSnapshot.game_time);
      if (parsedTime) {
        if (parsedTime.gameDay !== undefined) {
          gameDay = parsedTime.gameDay;
          console.log(`[DynamicGameState] Set gameDay to: ${gameDay}`);
        }
        timeOfDay = parsedTime.timeOfDay;
        console.log(`[DynamicGameState] Set timeOfDay to: ${timeOfDay}`);
      } else {
        console.warn(`[DynamicGameState] Failed to parse game_time: "${firstInitialSnapshot.game_time}", using defaults: Day ${gameDay}, ${timeOfDay}`);
      }
    } else {
      console.log(`[DynamicGameState] No game_time in snapshot, using defaults: Day ${gameDay}, ${timeOfDay}`);
    }
  }

  console.log(`[DynamicGameState] Loaded ${initialSnapshotsMap.size} initial scenario snapshots`);

  // 3. Load all NPCs from database (not just current scenario)
  const npcLoader = new NPCLoader(db);
  const allNPCs = npcLoader.getAllNPCs();
  
  // Convert all NPCs to DynamicNPCProfile format
  const npcCharacters: DynamicNPCProfile[] = allNPCs.map(npc => 
    convertNPCProfileToDynamic(npc)
  );
  
  console.log(`[DynamicGameState] Loaded ${npcCharacters.length} NPCs from database`);

  // 4. Load DynamicWorld data
  const worldData = await loadDynamicGameState(db, params.moduleName);
  if (!worldData) {
    console.warn(`[DynamicGameState] Failed to load world data for module "${params.moduleName}"`);
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

  console.log(`[DynamicGameState] Initialized complete state for module "${params.moduleName}"`);
  return completeState;
}

/**
 * Parse initial game time from string format
 */
function parseInitialGameTime(value: string): { gameDay?: number; timeOfDay: string } | null {
  const trimmed = value.trim();
  
  // Match format: "Day X, HH:MM" or "Day X HH:MM" (case insensitive, comma optional)
  const dayMatchWithComma = /^day\s+(\d+),\s*(\d{1,2}):(\d{2})$/i.exec(trimmed);
  if (dayMatchWithComma) {
    const gameDay = Number(dayMatchWithComma[1]);
    const hours = dayMatchWithComma[2];
    const minutes = dayMatchWithComma[3];
    const timeOfDay = `${hours.padStart(2, '0')}:${minutes}`;
    if (Number.isFinite(gameDay) && gameDay > 0 && isValidTimeOfDay(timeOfDay)) {
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
    const timeOfDay = `${hours.padStart(2, '0')}:${minutes}`;
    if (Number.isFinite(gameDay) && gameDay > 0 && isValidTimeOfDay(timeOfDay)) {
      return { gameDay, timeOfDay };
    }
    return null;
  }

  // Match format: "HH:MM" only
  if (isValidTimeOfDay(trimmed)) {
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(trimmed);
    if (timeMatch) {
      const hours = timeMatch[1].padStart(2, '0');
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
  const normalize = (s: string) => s.toLowerCase().trim().replace(/\s+/g, ' ');
  return normalize(name1) === normalize(name2);
}
