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
import type { CharacterProfile, NPCProfile } from "../../coc_multiagents_system/agents/models/gameTypes.js";
import type { DynamicScenarioSnapshot } from "../world_builder/types.js";
import { NPCLoader } from "../../coc_multiagents_system/agents/character/npcloader/index.js";

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
      manager.loadWorldData({
        moduleDigest: {
          moduleNotes: moduleData.module_notes || "",
          keeperGuidance: moduleData.keeper_guidance || "",
          moduleLimitations: moduleData.module_limitations || "",
          introduction: moduleData.introduction || "",
        },
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
  let playerCharacter: CharacterProfile;
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

  // 2. Load initial snapshot
  let currentScenario: DynamicScenarioSnapshot | null = null;
  let gameDay = 1;
  let timeOfDay = "08:00";

  // Query initial snapshot (for DynamicWorld modules, there should be only one initial snapshot per module)
  // Note: scenarios table doesn't have direct module_id, but each module's scenarios are typically separate
  const initialSnapshot = database.prepare(`
    SELECT
      ss.snapshot_id, ss.scenario_id, ss.snapshot_name, ss.location,
      ss.description, ss.events, ss.keeper_notes,
      ss.time_restriction, ss.show_map, ss.game_time,
      s.name as scenario_name
    FROM scenario_snapshots ss
    JOIN scenarios s ON ss.scenario_id = s.scenario_id
    WHERE ss.initial_snapshot = 1
    LIMIT 1
  `).get() as any;

  if (initialSnapshot) {
    console.log(`[DynamicGameState] Found initial snapshot: ${initialSnapshot.snapshot_name || initialSnapshot.scenario_name} (${initialSnapshot.location})`);
    
    // Parse game time from snapshot
    if (initialSnapshot.game_time) {
      console.log(`[DynamicGameState] Loading game time from snapshot: "${initialSnapshot.game_time}"`);
      const parsedTime = parseInitialGameTime(initialSnapshot.game_time);
      if (parsedTime) {
        if (parsedTime.gameDay !== undefined) {
          gameDay = parsedTime.gameDay;
          console.log(`[DynamicGameState] Set gameDay to: ${gameDay}`);
        }
        timeOfDay = parsedTime.timeOfDay;
        console.log(`[DynamicGameState] Set timeOfDay to: ${timeOfDay}`);
      } else {
        console.warn(`[DynamicGameState] Failed to parse game_time: "${initialSnapshot.game_time}"`);
      }
    } else {
      console.log(`[DynamicGameState] No game_time in snapshot, using defaults: Day ${gameDay}, ${timeOfDay}`);
    }

    // Load snapshot characters
    const snapshotCharacters = database.prepare(`
      SELECT id, character_name, character_role, character_status,
             character_location, character_notes
      FROM scenario_characters
      WHERE snapshot_id = ?
    `).all(initialSnapshot.snapshot_id);

    // Load snapshot clues
    const snapshotClues = database.prepare(`
      SELECT clue_id, clue_text, category, difficulty, clue_location,
             discovery_method, reveals, discovered, discovery_details
      FROM scenario_clues
      WHERE snapshot_id = ?
    `).all(initialSnapshot.snapshot_id);

    // Load snapshot conditions
    const snapshotConditions = database.prepare(`
      SELECT condition_id, condition_type, description, mechanical_effect
      FROM scenario_conditions
      WHERE snapshot_id = ?
    `).all(initialSnapshot.snapshot_id);

    // Build current scenario
    currentScenario = {
      id: initialSnapshot.snapshot_id,
      name: initialSnapshot.snapshot_name || initialSnapshot.scenario_name,
      location: initialSnapshot.location,
      description: initialSnapshot.description,
      gameTime: initialSnapshot.game_time || undefined,
      showMap: initialSnapshot.show_map === 1,
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
      keeperNotes: initialSnapshot.keeper_notes || undefined,
      timeRestriction: initialSnapshot.time_restriction || undefined,
    };
  }

  // 3. Load NPCs from snapshot
  const npcCharacters: NPCProfile[] = [];
  if (currentScenario) {
    const npcLoader = new NPCLoader(db);
    const allNPCs = npcLoader.getAllNPCs();

    const npcNamesToProcess = new Set<string>();
    if (currentScenario.characters) {
      currentScenario.characters.forEach((char: any) => {
        if (char.name) npcNamesToProcess.add(char.name);
      });
    }

    for (const charName of npcNamesToProcess) {
      const matchingNpc = allNPCs.find(npc => isNameSimilar(npc.name, charName));
      if (matchingNpc && !npcCharacters.some(npc => npc.id === matchingNpc.id)) {
        const npcProfile = { ...matchingNpc, currentLocation: currentScenario!.location };
        npcCharacters.push(npcProfile);

        // Update NPC location in database
        database.prepare(`
          UPDATE characters
          SET current_location = ?
          WHERE character_id = ? AND is_npc = 1
        `).run(currentScenario.location, matchingNpc.id);
      }
    }
  }

  // 4. Load DynamicWorld data
  const worldData = await loadDynamicGameState(db, params.moduleName);
  if (!worldData) {
    console.warn(`[DynamicGameState] Failed to load world data for module "${params.moduleName}"`);
    return null;
  }

  // 5. Create complete state with runtime data
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
  };

  console.log(`[DynamicGameState] Initialized complete state for module "${params.moduleName}"`);
  return completeState;
}

/**
 * Parse initial game time from string format
 */
function parseInitialGameTime(value: string): { gameDay?: number; timeOfDay: string } | null {
  const trimmed = value.trim();
  // Match format: "Day X HH:MM" or "day X HH:MM" (case insensitive)
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
