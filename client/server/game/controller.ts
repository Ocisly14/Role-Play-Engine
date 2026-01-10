import type { Request, Response } from "express";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { GraphManager } from "../core/GraphManager.js";
import { ServerState } from "../core/ServerState.js";
import { getClientIp, generateSessionIdFromIp } from "../utils/sessionUtils.js";
import { initializeGameState } from "./service.js";

/**
 * Start game with character
 * POST /api/game/start
 */
export async function startGame(req: Request, res: Response): Promise<void> {
  try {
    const { characterId, modName } = req.body;
    const userId = req.user!.userId;

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
      WHERE character_id = ? AND user_id = ? AND is_npc = 0
    `).get(characterId, userId);

    if (!ownedCharacter) {
      res.status(403).json({ error: "Character not found" });
      return;
    }

    // Generate session
    const clientIp = getClientIp(req);
    const sessionId = generateSessionIdFromIp(clientIp);

    // Initialize game state (simplified version)
    const { gameState, moduleIntroduction } = await initializeGameState(
      db,
      characterId,
      sessionId,
      modName
    );

    // Store in server state
    ServerState.getInstance().setGameState(userId, gameState);

    // Create introduction turn if module introduction is available
    if (moduleIntroduction && moduleIntroduction.introduction) {
      try {
        const turnManager = graphManager.getTurnManager();
        if (turnManager) {
          // Check if introduction turn already exists for this session
          const database = db.getDatabase();
          const existingIntro = database.prepare(`
            SELECT turn_id FROM game_turns
            WHERE session_id = ? AND turn_number = 0 AND character_input = ''
          `).get(gameState.sessionId);

          if (!existingIntro) {
            // Generate unique turn ID
            const { randomUUID } = await import("crypto");
            const introTurnId = `turn-intro-${Date.now()}-${randomUUID().slice(0, 8)}`;

            // Get initial game time from gameState (set from module initialGameTime)
            const initialGameDay = gameState.gameDay ?? null;
            const initialGameTime = gameState.timeOfDay ?? null;

            // Create a special turn with turnNumber 0 for introduction
            // Save initial game time from module's initialGameTime
            database.prepare(`
              INSERT INTO game_turns (
                turn_id, session_id, turn_number, character_input, character_id, character_name,
                keeper_narrative, status, started_at, completed_at, created_at, game_day, game_time
              ) VALUES (?, ?, 0, '', ?, ?, ?, 'completed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)
            `).run(
              introTurnId,
              gameState.sessionId,
              gameState.playerCharacter.id,
              gameState.playerCharacter.name,
              moduleIntroduction.introduction,
              initialGameDay,
              initialGameTime
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

    res.json({
      success: true,
      message: `游戏已开始！`,
      sessionId: gameState.sessionId,
      characterId: gameState.playerCharacter.id,
      characterName: gameState.playerCharacter.name,
      moduleIntroduction: moduleIntroduction,
      gameState: {
        phase: gameState.phase,
        playerCharacter: gameState.playerCharacter,
        timeOfDay: gameState.timeOfDay,
        tension: gameState.tension,
        currentScenario: gameState.currentScenario,
      },
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
 * Get current game state
 * GET /api/gamestate
 */
export function getGameState(req: Request, res: Response): void {
  try {
    const userId = req.user!.userId;
    const gameState = ServerState.getInstance().getGameState(userId);

    if (!gameState) {
      res.json({
        success: true,
        gameState: null,
        initialized: false,
        message: "Game not started yet",
      });
      return;
    }

    res.json({
      success: true,
      gameState: gameState,
      initialized: true,
    });
  } catch (error) {
    console.error("Error fetching game state:", error);
    res.status(500).json({ error: "Failed to fetch game state" });
  }
}
