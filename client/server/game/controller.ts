/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { GraphManager } from "../core/GraphManager.js";
import { ServerState } from "../core/ServerState.js";
import { getClientIp, generateSessionIdFromIp } from "../utils/sessionUtils.js";
import { initializeGameState, initializeWorldBuilderGameState } from "./service.js";
import { DynamicGameStateManager } from "../../../src/dynamicworldagent/state/index.js";
import type { DynamicGameState } from "../../../src/dynamicworldagent/state/index.js";
import type { GameState } from "../../../src/coc_multiagents_system/state/gameState.js";
import path from "path";
import fs from "fs";

/**
 * Check if a module is a world-builder generated module
 */
function isWorldBuilderModule(modName: string): boolean {
  const modsDir = path.join(process.cwd(), "data", "Mods");
  const modPath = path.join(modsDir, modName);

  const worldBuilderFiles = [
    "truth_timeline.json",
    "knowledge_matrix.json",
    "macro_scene.json"
  ];

  return worldBuilderFiles.every(file =>
    fs.existsSync(path.join(modPath, file))
  );
}

/**
 * Start game with character
 * POST /api/game/start
 */
export async function startGame(req: Request, res: Response): Promise<void> {
  try {
    const { characterId, modName } = req.body;
    const userId = req.user!.userId;
    const userEmail = req.user!.email;

    console.log(`[${new Date().toISOString()}] Starting game...`);

    const db = DatabaseManager.getInstance().getDatabase();
    const graphManager = GraphManager.getInstance();

    // Initialize multi-agent system if needed
    if (!graphManager.isInitialized()) {
      // Default: skip RAG (true), unless explicitly set to 'false'
      await graphManager.initialize(db, process.env.SKIP_RAG !== 'false');
    }

    // Ensure character belongs to user
    if (!characterId) {
      res.status(400).json({ error: "Character ID is required" });
      return;
    }

    const database = db.getDatabase();
    const ownedCharacter = database.prepare(`
      SELECT character_id FROM characters
      WHERE character_id = ? AND email_id = ? AND is_npc = 0
    `).get(characterId, userEmail);

    if (!ownedCharacter) {
      res.status(403).json({ error: "Character not found" });
      return;
    }

    // Generate session
    const clientIp = getClientIp(req);
    const sessionId = generateSessionIdFromIp(clientIp);

    // Check if this is a world-builder module
    const isWorldBuilder = modName && isWorldBuilderModule(modName);

    // Initialize game state using appropriate method
    let gameState: GameState | null = null;
    let dynamicGameState: DynamicGameState | null = null;
    let moduleIntroduction: any = null;

    if (isWorldBuilder) {
      // For WorldBuilder modules, only use DynamicGameState
      const initResult = await initializeWorldBuilderGameState(db, characterId, sessionId, modName, userEmail);
      dynamicGameState = initResult.dynamicGameState;
      moduleIntroduction = initResult.moduleIntroduction;
      
      // For DynamicWorld modules, GameState is not needed
      // Only DynamicGameState is used
      if (dynamicGameState) {
        gameState = null as any; // GameState not needed for DynamicWorld
      }
    } else {
      // For regular modules, use GameState
      const initResult = await initializeGameState(db, characterId, sessionId, modName, userEmail);
      gameState = initResult.gameState;
      moduleIntroduction = initResult.moduleIntroduction;
    }

    console.log(`[${new Date().toISOString()}] Game initialized using ${isWorldBuilder ? 'World Builder' : 'Regular'} loader`);

    // Store in server state
    if (isWorldBuilder && dynamicGameState) {
      // For WorldBuilder, only store DynamicGameState (no GameState needed)
      ServerState.getInstance().setGameState(userId, null as any, dynamicGameState);
    } else if (gameState) {
      // For regular modules, store GameState only
      ServerState.getInstance().setGameState(userId, gameState, null);
    }

    // Create introduction turn if module introduction is available
    if (moduleIntroduction && moduleIntroduction.introduction) {
      try {
        const turnManager = graphManager.getTurnManager();
        if (turnManager) {
          // Check if introduction turn already exists for this session
          const database = db.getDatabase();
          const sessionId = isWorldBuilder && dynamicGameState 
            ? dynamicGameState.sessionId 
            : (gameState?.sessionId || "");
          const existingIntro = database.prepare(`
            SELECT turn_id FROM game_turns
            WHERE session_id = ? AND turn_number = 0 AND character_input = ''
          `).get(sessionId);

          if (!existingIntro) {
            // Generate unique turn ID
            const { randomUUID } = await import("crypto");
            const introTurnId = `turn-intro-${Date.now()}-${randomUUID().slice(0, 8)}`;

            // Get initial game time from state (set from module initialGameTime)
            const initialGameDay = isWorldBuilder && dynamicGameState 
              ? dynamicGameState.gameDay 
              : (gameState?.gameDay ?? null);
            const initialGameTime = isWorldBuilder && dynamicGameState 
              ? dynamicGameState.timeOfDay 
              : (gameState?.timeOfDay ?? null);
            const playerCharacterId = isWorldBuilder && dynamicGameState 
              ? dynamicGameState.playerCharacter.id 
              : (gameState?.playerCharacter.id || "");
            const playerCharacterName = isWorldBuilder && dynamicGameState 
              ? dynamicGameState.playerCharacter.name 
              : (gameState?.playerCharacter.name || "");

            // Create a special turn with turnNumber 0 for introduction
            // Save initial game time from module's initialGameTime
            database.prepare(`
              INSERT INTO game_turns (
                turn_id, session_id, turn_number, character_input, character_id, character_name,
                keeper_narrative, status, started_at, completed_at, created_at, game_day, game_time
              ) VALUES (?, ?, 0, '', ?, ?, ?, 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)
            `).run(
              introTurnId,
              sessionId,
              playerCharacterId,
              playerCharacterName,
              moduleIntroduction.introduction,
              initialGameDay ?? null,
              initialGameTime ?? null
            );

            console.log(`[${new Date().toISOString()}] Introduction turn created: ${introTurnId} with game time: Day ${initialGameDay}, ${initialGameTime}`);
          } else {
            console.log(`[${new Date().toISOString()}] Introduction turn already exists for this session`);
          }
        }
      } catch (error) {
        console.error("Failed to create introduction turn:", error);
        // Don't fail the game start if introduction turn creation fails
      }
    }

    console.log(`[${new Date().toISOString()}] Game started successfully`);

    const finalSessionId = isWorldBuilder && dynamicGameState 
      ? dynamicGameState.sessionId 
      : (gameState?.sessionId || "");
    const finalCharacterId = isWorldBuilder && dynamicGameState 
      ? dynamicGameState.playerCharacter.id 
      : (gameState?.playerCharacter.id || "");
    const finalCharacterName = isWorldBuilder && dynamicGameState 
      ? dynamicGameState.playerCharacter.name 
      : (gameState?.playerCharacter.name || "");
    const finalTimeOfDay = isWorldBuilder && dynamicGameState 
      ? dynamicGameState.timeOfDay 
      : (gameState?.timeOfDay || "08:00");
    const finalTension = isWorldBuilder && dynamicGameState 
      ? dynamicGameState.tension 
      : (gameState?.tension || 1);
    const finalCurrentScenario = isWorldBuilder && dynamicGameState 
      ? dynamicGameState.currentScenario 
      : (gameState?.currentScenario || null);

    const gameStatePayload: Record<string, unknown> = {
      playerCharacter: isWorldBuilder && dynamicGameState 
        ? dynamicGameState.playerCharacter 
        : (gameState?.playerCharacter || {
          id: "",
          name: "",
          attributes: { STR: 50, CON: 50, DEX: 50, APP: 50, POW: 50, SIZ: 50, INT: 50, EDU: 50 },
          status: { hp: 10, maxHp: 10, sanity: 60, maxSanity: 99, luck: 50, mp: 10, conditions: [] },
          skills: {},
          inventory: [],
          notes: "",
          actionLog: [],
        }),
      timeOfDay: finalTimeOfDay,
      tension: finalTension,
      currentScenario: finalCurrentScenario,
    };

    if (!isWorldBuilder) {
      gameStatePayload.phase = gameState?.phase || "intro";
    }

    res.json({
      success: true,
      message: `游戏已开始！`,
      sessionId: finalSessionId,
      characterId: finalCharacterId,
      characterName: finalCharacterName,
      moduleIntroduction: moduleIntroduction,
      gameState: gameStatePayload,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error starting game:", error);
    res.status(500).json({ error: "Failed to start game: " + (error as Error).message });
  }
}

/**
 * Stop game and clear state
 * POST /api/game/stop
 */
export function stopGame(req: Request, res: Response): void {
  try {
    const userId = req.user!.userId;
    ServerState.getInstance().clearGameState(userId);

    console.log(`[${new Date().toISOString()}] Game stopped and state cleared`);

    res.json({
      success: true,
      message: "游戏已停止，状态已清空",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error stopping game:", error);
    res.status(500).json({ error: "Failed to stop game" });
  }
}

/**
 * Import game data (legacy endpoint)
 * POST /api/game/import-data
 *
 * Note: In the new architecture, data is loaded via /api/mod/load
 * This endpoint is kept for backward compatibility and returns success
 * if data has already been loaded through the mod system.
 */
export async function importGameData(req: Request, res: Response): Promise<void> {
  try {
    const db = DatabaseManager.getInstance().getDatabase();

    // Use loaders to get data counts (same as original code)
    const { ScenarioLoader } = await import("../../../src/coc_multiagents_system/agents/memory/scenarioloader/index.js");
    const { NPCLoader } = await import("../../../src/coc_multiagents_system/agents/character/npcloader/index.js");
    const { ModuleLoader } = await import("../../../src/coc_multiagents_system/agents/memory/moduleloader/index.js");

    const scenarioLoader = new ScenarioLoader(db);
    const npcLoader = new NPCLoader(db);
    const moduleLoader = new ModuleLoader(db);

    const scenarios = scenarioLoader.getAllScenarios();
    const npcs = npcLoader.getAllNPCs();
    const modules = moduleLoader.getAllModules();

    const scenariosLoaded = scenarios.length;
    const npcsLoaded = npcs.length;
    const modulesLoaded = modules.length;

    console.log(`[${new Date().toISOString()}] Data import check: ${scenariosLoaded} scenarios, ${npcsLoaded} NPCs, ${modulesLoaded} modules`);

    res.json({
      success: true,
      message: `Data already loaded: ${scenariosLoaded} scenarios, ${npcsLoaded} NPCs, ${modulesLoaded} modules`,
      scenariosLoaded,
      npcsLoaded,
      modulesLoaded,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error checking imported data:", error);
    res.status(500).json({ error: "Failed to check imported data: " + (error as Error).message });
  }
}

/**
 * Serialize DynamicGameState for JSON response
 * Converts Set and Map to arrays/objects for JSON compatibility
 */
function serializeDynamicGameState(state: any): any {
  if (!state) return null;
  
  // Create a deep copy and convert Set/Map to arrays/objects
  const serialized = { ...state };
  
  // Convert Sets to arrays
  if (serialized.revealedTruthEvents instanceof Set) {
    serialized.revealedTruthEvents = Array.from(serialized.revealedTruthEvents);
  }
  if (serialized.activatedKnowledgeHolders instanceof Set) {
    serialized.activatedKnowledgeHolders = Array.from(serialized.activatedKnowledgeHolders);
  }
  if (serialized.deployedRedHerrings instanceof Set) {
    serialized.deployedRedHerrings = Array.from(serialized.deployedRedHerrings);
  }
  if (serialized.mythosRevelations instanceof Set) {
    serialized.mythosRevelations = Array.from(serialized.mythosRevelations);
  }
  
  // Convert Map to object
  if (serialized.updatedDynamicScenarioSnapshots instanceof Map) {
    const snapshotsObj: Record<string, any[]> = {};
    serialized.updatedDynamicScenarioSnapshots.forEach((value, key) => {
      snapshotsObj[key] = value;
    });
    serialized.updatedDynamicScenarioSnapshots = snapshotsObj;
  }
  
  // Convert Date objects to ISO strings
  if (serialized.loadedAt instanceof Date) {
    serialized.loadedAt = serialized.loadedAt.toISOString();
  }
  if (serialized.lastUpdated instanceof Date) {
    serialized.lastUpdated = serialized.lastUpdated.toISOString();
  }
  if (serialized.lastPlayerInputTime instanceof Date) {
    serialized.lastPlayerInputTime = serialized.lastPlayerInputTime.toISOString();
  }
  
  return serialized;
}

/**
 * Get current game state
 * GET /api/gamestate
 */
export function getGameState(req: Request, res: Response): void {
  try {
    const userId = req.user!.userId;
    const serverState = ServerState.getInstance();
    
    // Check for DynamicGameState first (for DynamicWorld modules)
    const dynamicGameState = serverState.getDynamicGameState(userId);
    const gameState = serverState.getGameState(userId);

    // For DynamicWorld modules, use DynamicGameState (which is compatible with frontend)
    // For regular modules, use GameState
    const stateToReturn = dynamicGameState || gameState;

    if (!stateToReturn) {
      res.json({
        success: true,
        gameState: null,
        initialized: false,
        message: "Game not started yet",
      });
      return;
    }

    // Serialize DynamicGameState to handle Set/Map/Date conversion
    const serializedState = dynamicGameState 
      ? serializeDynamicGameState(stateToReturn)
      : stateToReturn;

    res.json({
      success: true,
      gameState: serializedState,
      initialized: true,
    });
  } catch (error) {
    console.error("Error fetching game state:", error);
    res.status(500).json({ error: "Failed to fetch game state" });
  }
}
