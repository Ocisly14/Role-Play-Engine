/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { GraphManager } from "../core/GraphManager.js";
import { ServerState } from "../core/ServerState.js";
import { saveManualCheckpoint, loadCheckpoint, listAvailableCheckpoints } from "../../../src/coc_multiagents_system/agents/memory/memoryAgent.js";
import { saveDynamicGameStateCheckpoint } from "../../../src/dynamicworldagent/dynamicBasicAgent/memory/checkpoint.js";
import { RagManager } from "../../../src/coc_multiagents_system/agents/memory/RagManager.js";
import { ScenarioLoader } from "../../../src/coc_multiagents_system/agents/memory/scenarioloader/index.js";
import { NPCLoader } from "../../../src/coc_multiagents_system/agents/character/npcloader/index.js";

/**
 * Save current game state as checkpoint
 * POST /api/checkpoints/save
 */
export async function saveCheckpoint(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const serverState = ServerState.getInstance();
    
    // Check for both GameState and DynamicGameState (for DynamicWorld modules)
    const persistentGameState = serverState.getGameState(userId);
    const dynamicGameState = serverState.getDynamicGameState(userId);
    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();

    console.log(`[${new Date().toISOString()}] [Checkpoint Save] User ${userId} requesting save`);

    // Determine which type of game state we have
    const useDynamic = dynamicGameState !== null;
    const gameStateToUse = useDynamic ? dynamicGameState : persistentGameState;

    if (!persistentGameState && !dynamicGameState) {
      console.log(`[${new Date().toISOString()}] [Checkpoint Save] ERROR: No game state found for user ${userId}`);
      res.status(400).json({ error: "Game not started. Please start the game first." });
      return;
    }

    // Extract character info from the appropriate state type
    const characterId = gameStateToUse?.playerCharacter?.id;
    const characterName = gameStateToUse?.playerCharacter?.name;
    const sessionId = gameStateToUse?.sessionId;
    
    console.log(`[${new Date().toISOString()}] [Checkpoint Save] Game state found - Type: ${useDynamic ? 'DynamicWorld' : 'Standard'}, Character: ${characterName} (ID: ${characterId}), Session: ${sessionId}`);

    if (!characterId) {
      console.log(`[${new Date().toISOString()}] [Checkpoint Save] ERROR: No character ID in game state. playerCharacter: ${JSON.stringify(gameStateToUse?.playerCharacter)}`);
      res.status(400).json({ error: "No character in game state. Cannot save checkpoint." });
      return;
    }

    const ownedCharacter = database.prepare(`
      SELECT character_id FROM characters
      WHERE character_id = ? AND user_id = ? AND is_npc = 0
    `).get(characterId, userId);

    if (!ownedCharacter) {
      // If character exists but is unassigned (user_id is NULL), claim it for this user.
      const unassigned = database.prepare(`
        SELECT character_id FROM characters
        WHERE character_id = ? AND user_id IS NULL AND is_npc = 0
      `).get(characterId);

      if (unassigned) {
        database.prepare(`
          UPDATE characters
          SET user_id = ?
          WHERE character_id = ? AND user_id IS NULL AND is_npc = 0
        `).run(userId, characterId);
        console.log(`[${new Date().toISOString()}] [Checkpoint Save] Claimed unassigned character ${characterId} for user ${userId}`);
      } else {
        console.log(`[${new Date().toISOString()}] [Checkpoint Save] ERROR: Character ${characterId} not found in database for user ${userId}`);
        // Check if character exists at all
        const charExists = database.prepare(`SELECT character_id, user_id, name FROM characters WHERE character_id = ?`).get(characterId);
        if (charExists) {
          console.log(`[${new Date().toISOString()}] [Checkpoint Save] Character exists but belongs to different user: ${JSON.stringify(charExists)}`);
          res.status(403).json({ error: `Character not found. Character ${characterName || characterId} may belong to a different user.` });
        } else {
          console.log(`[${new Date().toISOString()}] [Checkpoint Save] Character does not exist in database at all`);
          res.status(403).json({ error: `Character not found. Character ${characterName || characterId} does not exist in database.` });
        }
        return;
      }
    }

    console.log(`[${new Date().toISOString()}] [Checkpoint Save] Character verified, proceeding with save...`);

    let checkpointId: string;
    let checkpointName: string;
    let description: string;

    if (useDynamic && dynamicGameState) {
      // For DynamicWorld modules, use DynamicGameState checkpoint
      const currentScenario = dynamicGameState.currentScenario;
      if (!currentScenario) {
        res.status(400).json({ error: "No current scenario. Cannot save checkpoint." });
        return;
      }

      // Generate checkpoint name
      const currentDate = new Date().toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      checkpointName = `${currentScenario.name} - ${currentDate}`;
      description = `Manual save at ${currentScenario.location}`;

      // Save DynamicGameState checkpoint (includes all snapshots)
      const savedCheckpointId = saveDynamicGameStateCheckpoint(
        db,
        dynamicGameState,
        'manual',
        description
      );

      if (!savedCheckpointId) {
        res.status(500).json({ error: "Failed to save checkpoint" });
        return;
      }

      checkpointId = savedCheckpointId;
    } else if (persistentGameState) {
      // For regular modules, use GameState checkpoint
      const currentScenario = persistentGameState.currentScenario;
      if (!currentScenario) {
        res.status(400).json({ error: "No current scenario. Cannot save checkpoint." });
        return;
      }

      // Generate checkpoint name
      const currentDate = new Date().toLocaleDateString('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      checkpointName = `${currentScenario.name} - ${currentDate}`;
      description = `Manual save at ${currentScenario.location}`;

      checkpointId = saveManualCheckpoint(
        persistentGameState,
        db,
        checkpointName,
        description
      );
    } else {
      // This should not happen as we checked earlier, but handle it just in case
      res.status(400).json({ error: "No game state available. Cannot save checkpoint." });
      return;
    }

    // Save RAG state if available
    const ragManager = GraphManager.getInstance().getRagManager();
    if (ragManager) {
      try {
        await ragManager.saveToCheckpoint(checkpointId);
        console.log(`[${new Date().toISOString()}] RAG state saved to checkpoint: ${checkpointId}`);
      } catch (error) {
        console.warn(`[${new Date().toISOString()}] Failed to save RAG state:`, error);
      }
    }

    console.log(`[${new Date().toISOString()}] Checkpoint saved: ${checkpointName} (${checkpointId})`);

    res.json({
      success: true,
      checkpointId: checkpointId,
      checkpointName: checkpointName,
      message: "存档成功",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error saving checkpoint:", error);
    res.status(500).json({ error: "Failed to save checkpoint: " + (error as Error).message });
  }
}

/**
 * List all available checkpoints
 * GET /api/checkpoints/list
 */
export function listCheckpoints(req: Request, res: Response): void {
  try {
    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();
    const userId = req.user!.userId;
    const sessionId = req.query.sessionId as string;
    const limit = parseInt(req.query.limit as string) || 50;

    let checkpoints: any[] = [];

    if (sessionId && sessionId !== "all") {
      const session = database.prepare(`
        SELECT s.session_id
        FROM sessions s
        JOIN characters c ON c.character_id = s.character_id
        WHERE s.session_id = ? AND c.user_id = ?
      `).get(sessionId, userId);

      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      checkpoints = listAvailableCheckpoints(sessionId, db, limit);
    } else {
      const stmt = database.prepare(`
        SELECT
          checkpoint_id, checkpoint_name, checkpoint_type, description,
          game_day, game_time, current_scene_name, current_location,
          player_hp, player_sanity, created_at, session_id
        FROM game_checkpoints
        WHERE session_id IN (
          SELECT s.session_id
          FROM sessions s
          JOIN characters c ON c.character_id = s.character_id
          WHERE c.user_id = ?
        )
        ORDER BY created_at DESC
        LIMIT ?
      `);
      checkpoints = stmt.all(userId, limit) as any[];
    }

    // Normalize field names to camelCase
    const normalizedCheckpoints = checkpoints.map((cp: any) => ({
      checkpointId: cp.checkpoint_id || cp.checkpointId,
      checkpointName: cp.checkpoint_name || cp.checkpointName,
      checkpointType: cp.checkpoint_type || cp.checkpointType,
      description: cp.description,
      gameDay: cp.game_day || cp.gameDay,
      gameTime: cp.game_time || cp.gameTime,
      currentSceneName: cp.current_scene_name || cp.currentSceneName,
      currentLocation: cp.current_location || cp.currentLocation,
      playerHp: cp.player_hp || cp.playerHp,
      playerSanity: cp.player_sanity || cp.playerSanity,
      createdAt: cp.created_at || cp.createdAt,
      sessionId: cp.session_id || cp.sessionId,
    }));

    res.json({
      success: true,
      checkpoints: normalizedCheckpoints,
    });
  } catch (error) {
    console.error("Error listing checkpoints:", error);
    res.status(500).json({ error: "Failed to list checkpoints: " + (error as Error).message });
  }
}

/**
 * Load a checkpoint and restore game state
 * POST /api/checkpoints/load
 */
export async function loadCheckpointData(req: Request, res: Response): Promise<void> {
  try {
    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();
    const userId = req.user!.userId;
    const { checkpointId } = req.body;

    if (!checkpointId) {
      res.status(400).json({ error: "checkpointId is required" });
      return;
    }

    const ownedCheckpoint = database.prepare(`
      SELECT gc.checkpoint_id
      FROM game_checkpoints gc
      JOIN sessions s ON s.session_id = gc.session_id
      JOIN characters c ON c.character_id = s.character_id
      WHERE gc.checkpoint_id = ? AND c.user_id = ?
    `).get(checkpointId, userId);

    if (!ownedCheckpoint) {
      res.status(404).json({ error: "Checkpoint not found" });
      return;
    }

    // Load checkpoint with metadata
    const checkpoint = db.loadCheckpoint(checkpointId);
    if (!checkpoint) {
      res.status(404).json({ error: "Checkpoint not found" });
      return;
    }

    const gameState = checkpoint.gameState;
    if (!gameState) {
      res.status(404).json({ error: "Checkpoint game state not found" });
      return;
    }

    // Check if this is a DynamicGameState and deserialize if needed
    const gameStateAny = gameState as any;
    let restoredGameState: any = gameState;
    let restoredDynamicGameState: any = null;
    
    if (gameStateAny.moduleName && gameStateAny.updatedDynamicScenarioSnapshots !== undefined) {
      // This is a DynamicGameState, deserialize it with checkpoint gameTime to filter snapshots
      const { DynamicGameStateManager } = await import("../../../src/dynamicworldagent/state/index.js");
      const checkpointGameDay = checkpoint.metadata.gameDay;
      const checkpointTimeOfDay = checkpoint.metadata.gameTime;
      
      if (checkpointGameDay && checkpointTimeOfDay) {
        restoredDynamicGameState = DynamicGameStateManager.deserialize(
          gameStateAny,
          checkpointGameDay,
          checkpointTimeOfDay,
          db
        );
        console.log(`[${new Date().toISOString()}] Deserialized DynamicGameState from checkpoint (Day ${checkpointGameDay}, ${checkpointTimeOfDay})`);
      } else {
        restoredDynamicGameState = DynamicGameStateManager.deserialize(gameStateAny, undefined, undefined, db);
        console.log(`[${new Date().toISOString()}] Deserialized DynamicGameState from checkpoint`);
      }
    }

    // Restore persistent game state
    ServerState.getInstance().setGameState(userId, restoredGameState, restoredDynamicGameState);

    // Initialize GraphManager if needed and try to restore RAG
    const graphManager = GraphManager.getInstance();
    if (!graphManager.isInitialized()) {
      try {
        const ragManager = await RagManager.restoreFromCheckpoint(db, checkpointId);
        console.log(`[${new Date().toISOString()}] RAG state restored from checkpoint`);
      } catch (error) {
        console.warn("Failed to restore RAG, using base:", error);
        // Default: skip RAG (true), unless explicitly set to 'false'
        await graphManager.initialize(db, process.env.SKIP_RAG !== 'false');
      }
    }

    // Fetch conversation history filtered by checkpoint gameTime
    const turnManager = graphManager.getTurnManager();
    let conversationHistory: any[] = [];

    if (turnManager) {
      try {
        const checkpointGameDay = checkpoint.metadata.gameDay;
        const checkpointTimeOfDay = checkpoint.metadata.gameTime;
        
        if (checkpointGameDay && checkpointTimeOfDay) {
          conversationHistory = turnManager.getConversation(
            checkpoint.sessionId,
            50,
            checkpointGameDay,
            checkpointTimeOfDay
          );
          console.log(`[${new Date().toISOString()}] Loaded ${conversationHistory.length} conversation messages (filtered by gameTime: Day ${checkpointGameDay}, ${checkpointTimeOfDay})`);
        } else {
          conversationHistory = turnManager.getConversation(checkpoint.sessionId, 50);
          console.log(`[${new Date().toISOString()}] Loaded ${conversationHistory.length} conversation messages (no gameTime filter)`);
        }
      } catch (error) {
        console.warn("Failed to load conversation history:", error);
      }
    }

    console.log(`[${new Date().toISOString()}] Checkpoint loaded: ${checkpointId}`);

    res.json({
      success: true,
      sessionId: checkpoint.sessionId,
      gameState: restoredGameState,
      conversationHistory: conversationHistory,
      message: "存档加载成功",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error loading checkpoint:", error);
    res.status(500).json({ error: "Failed to load checkpoint: " + (error as Error).message });
  }
}
