import type { CoCDatabase } from "../../../src/coc_multiagents_system/agents/memory/database/index.js";
import type { GameState } from "../../../src/state.js";
import { initialGameState } from "../../../src/state.js";
import { ModuleLoader } from "../../../src/coc_multiagents_system/agents/memory/moduleloader/index.js";
import { ScenarioLoader } from "../../../src/coc_multiagents_system/agents/memory/scenarioloader/index.js";
import { NPCLoader } from "../../../src/coc_multiagents_system/agents/character/npcloader/index.js";
import { isNameSimilar } from "../utils/stringUtils.js";
import path from "path";
import fs from "fs";

/**
 * Initialize game state with character and optional mod
 */
export async function initializeGameState(
  db: CoCDatabase,
  characterId: string | undefined,
  sessionId: string,
  modName?: string
): Promise<{ gameState: GameState; moduleIntroduction: any }> {
  let gameState: GameState;

  if (characterId) {
    // Load character from database
    const database = db.getDatabase();
    const character = database.prepare(`
      SELECT character_id, name, attributes, status, skills, inventory, notes,
             occupation, age, gender, appearance, personality, background
      FROM characters
      WHERE character_id = ? AND is_npc = 0
    `).get(characterId);

    if (!character) {
      throw new Error("Character not found");
    }

    // Parse character data
    const parsedAttributes = JSON.parse((character as any).attributes);
    const parsedStatus = JSON.parse((character as any).status);
    const parsedSkillsRaw = JSON.parse((character as any).skills);
    const parsedInventory = JSON.parse((character as any).inventory);

    // Parse notes JSON to extract additional character fields
    let parsedNotes: any = {};
    try {
      parsedNotes = typeof (character as any).notes === 'string'
        ? JSON.parse((character as any).notes)
        : {};
    } catch (e) {
      parsedNotes = {};
    }

    // Convert skills to simple number format
    const parsedSkills: Record<string, number> = {};
    for (const [skillName, skillData] of Object.entries(parsedSkillsRaw)) {
      if (typeof skillData === 'object' && skillData !== null && 'value' in skillData) {
        parsedSkills[skillName] = (skillData as any).value;
      } else {
        parsedSkills[skillName] = typeof skillData === 'number' ? skillData : 0;
      }
    }

    gameState = {
      ...JSON.parse(JSON.stringify(initialGameState)),
      sessionId: sessionId,
      playerCharacter: {
        id: (character as any).character_id,
        name: (character as any).name,
        attributes: parsedAttributes,
        status: parsedStatus,
        skills: parsedSkills,
        inventory: parsedInventory,
        notes: (character as any).notes || "",
        actionLog: [],
        // Additional character info for display
        occupation: (character as any).occupation || undefined,
        age: (character as any).age || undefined,
        gender: (character as any).gender || parsedNotes.gender || undefined,
        appearance: (character as any).appearance || parsedNotes.appearance || undefined,
        personality: (character as any).personality || undefined,
        backstory: (character as any).background || parsedNotes.backstory || undefined,
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
          ARMOR: undefined, // Not stored in status
        },
      },
    };
  } else {
    // Use default character
    gameState = {
      ...JSON.parse(JSON.stringify(initialGameState)),
      sessionId: sessionId,
    };
  }

  // Load module data if available
  let moduleIntroduction: any = null;
  const moduleLoader = new ModuleLoader(db);
  const modules = moduleLoader.getAllModules();

  if (modules.length > 0) {
    const module = modules[0];

    if (module.keeperGuidance) {
      gameState.keeperGuidance = module.keeperGuidance;
    }

    if (module.moduleLimitations) {
      gameState.moduleLimitations = module.moduleLimitations;
    }

    if (module.initialGameTime) {
      const parsedInitialTime = parseInitialGameTime(module.initialGameTime);
      if (parsedInitialTime) {
        if (parsedInitialTime.gameDay !== undefined) {
          gameState.gameDay = parsedInitialTime.gameDay;
        }
        gameState.timeOfDay = parsedInitialTime.timeOfDay;
        gameState.scenarioTimeState.sceneStartTime = parsedInitialTime.timeOfDay;
      }
    }

    if (module.introduction) {
      moduleIntroduction = {
        introduction: module.introduction,
        moduleNotes: module.moduleNotes || ""
      };
    }

    // Load initial scenario if modName is provided
    if (modName) {
      const scenarioLoader = new ScenarioLoader(db);
      const modsDir = path.join(process.cwd(), "data", "Mods");
      const modPath = path.join(modsDir, modName);

      if (fs.existsSync(modPath)) {
        const subdirs = fs.readdirSync(modPath, { withFileTypes: true })
          .filter(dirent => dirent.isDirectory())
          .map(dirent => dirent.name);

        const scenarioDirs = subdirs.filter(name =>
          name.toLowerCase().includes("scenario")
        );

        if (scenarioDirs.length > 0) {
          const scenariosDir = path.join(modPath, scenarioDirs[0]);
          const initialScenario = scenarioLoader.findInitialScenarioByFileName(scenariosDir);

          if (initialScenario) {
            gameState.currentScenario = {
              ...initialScenario.snapshot,
              characters: initialScenario.snapshot.characters || []
            };

            // Inject NPCs if scenario has location
            if (initialScenario.snapshot.location) {
              await injectNPCsToGameState(
                db,
                gameState,
                initialScenario,
                module
              );
            }
          }
        }
      }
    }
  }

  return { gameState, moduleIntroduction };
}

function parseInitialGameTime(value: string): { gameDay?: number; timeOfDay: string } | null {
  const trimmed = value.trim();
  // Match format: "Day X HH:MM" or "day X HH:MM" (case insensitive)
  // Also support formats like "Day 1 21:00" or "day 1 9:00"
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
    // Ensure format is HH:MM (2-digit hours)
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
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return Number.isFinite(hours)
    && Number.isFinite(minutes)
    && hours >= 0
    && hours <= 23
    && minutes >= 0
    && minutes <= 59;
}

/**
 * Inject NPCs from scenario into game state (simplified version)
 */
async function injectNPCsToGameState(
  db: CoCDatabase,
  gameState: GameState,
  initialScenario: any,
  module: any
): Promise<void> {
  const npcLoader = new NPCLoader(db);
  const allNPCs = npcLoader.getAllNPCs();
  const database = db.getDatabase();
  const scenarioLocation = initialScenario.snapshot.location;

  const npcNamesToProcess = new Set<string>();

  // Collect NPC names from scenario characters
  if (initialScenario.snapshot.characters) {
    initialScenario.snapshot.characters.forEach((c: any) => npcNamesToProcess.add(c.name));
  }

  // Collect NPCs from module config
  if (module.initialScenarioNPCs) {
    module.initialScenarioNPCs.forEach((name: string) => npcNamesToProcess.add(name));
  }

  const npcsToAdd: any[] = [];

  for (const charName of npcNamesToProcess) {
    const matchingNpc = allNPCs.find(npc => isNameSimilar(npc.name, charName));

    if (matchingNpc && !npcsToAdd.some(npc => npc.id === matchingNpc.id)) {
      const npcProfile = { ...matchingNpc, currentLocation: scenarioLocation };

      // Update NPC location in database
      database.prepare(`
        UPDATE characters
        SET current_location = ?
        WHERE character_id = ? AND is_npc = 1
      `).run(scenarioLocation, matchingNpc.id);

      npcsToAdd.push(npcProfile);
    }
  }

  if (npcsToAdd.length > 0) {
    gameState.npcCharacters = [...(gameState.npcCharacters || []), ...npcsToAdd];

    // Also update currentScenario.characters with NPC information
    if (gameState.currentScenario) {
      const scenarioCharacters = gameState.currentScenario.characters || [];
      const updatedCharacters = [...scenarioCharacters];

      for (const npc of npcsToAdd) {
        // Check if NPC already exists in scenario characters
        const existingIndex = updatedCharacters.findIndex(c =>
          c.id === npc.id || c.name.toLowerCase() === npc.name.toLowerCase()
        );

        if (existingIndex >= 0) {
          // Update existing character
          updatedCharacters[existingIndex] = {
            ...updatedCharacters[existingIndex],
            location: scenarioLocation,
            status: updatedCharacters[existingIndex].status || 'present'
          };
        } else {
          // Add new character to scenario
          updatedCharacters.push({
            id: npc.id,
            name: npc.name,
            role: (npc as any).occupation || 'npc',
            status: 'present',
            location: scenarioLocation,
            notes: (npc as any).background ? (npc as any).background.substring(0, 100) : undefined
          });
        }
      }

      gameState.currentScenario.characters = updatedCharacters;
    }
  }
}
