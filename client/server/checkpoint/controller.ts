/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { GraphManager } from "../core/GraphManager.js";
import { ServerState } from "../core/ServerState.js";
import { saveDynamicGameStateCheckpoint } from "../../../src/dynamicworldagent/dynamicBasicAgent/memory/checkpoint.js";
import { TurnManager } from "../../../src/dynamicworldagent/dynamicBasicAgent/memory/turnManager.js";
import { randomUUID } from "crypto";

/**
 * Save current game state as checkpoint
 * POST /api/checkpoints/save
 */
export async function saveCheckpoint(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const serverState = ServerState.getInstance();
    const requestedType =
      typeof req.body?.checkpointType === "string"
        ? req.body.checkpointType
        : undefined;
    const checkpointType =
      requestedType === "auto" ||
      requestedType === "manual" ||
      requestedType === "scene_transition"
        ? requestedType
        : "manual";
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const descriptionOverride =
      typeof req.body?.description === "string"
        ? req.body.description
        : undefined;

    const dynamicGameState = serverState.getDynamicGameState(userId);
    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();

    console.log(
      `[${new Date().toISOString()}] [Checkpoint Save] User ${userId} requesting save`
    );

    if (!dynamicGameState) {
      console.log(
        `[${new Date().toISOString()}] [Checkpoint Save] ERROR: No game state found for user ${userId}`
      );
      res
        .status(400)
        .json({
          error: "DynamicWorld game not started. Please start the game first.",
        });
      return;
    }

    // Extract character info from the appropriate state type
    const characterId = dynamicGameState.playerCharacter?.id;
    const characterName = dynamicGameState.playerCharacter?.name;
    const sessionId = dynamicGameState.sessionId;

    console.log(
      `[${new Date().toISOString()}] [Checkpoint Save] Game state found - Type: DynamicWorld, Character: ${characterName} (ID: ${characterId}), Session: ${sessionId}`
    );

    if (!characterId) {
      console.log(
        `[${new Date().toISOString()}] [Checkpoint Save] ERROR: No character ID in game state. playerCharacter: ${JSON.stringify(dynamicGameState.playerCharacter)}`
      );
      res
        .status(400)
        .json({ error: "No character in game state. Cannot save checkpoint." });
      return;
    }

    const ownedCharacter = database
      .prepare(`
      SELECT character_id FROM characters
      WHERE character_id = ? AND email_id = ? AND is_npc = 0
    `)
      .get(characterId, req.user!.email);

    if (!ownedCharacter) {
      // If character exists but is unassigned (email_id is NULL), claim it for this user.
      const unassigned = database
        .prepare(`
        SELECT character_id FROM characters
        WHERE character_id = ? AND email_id IS NULL AND is_npc = 0
      `)
        .get(characterId);

      if (unassigned) {
        database
          .prepare(`
          UPDATE characters
          SET email_id = ?
          WHERE character_id = ? AND email_id IS NULL AND is_npc = 0
        `)
          .run(req.user!.email, characterId);
        console.log(
          `[${new Date().toISOString()}] [Checkpoint Save] Claimed unassigned character ${characterId} for user ${req.user!.email}`
        );
      } else {
        console.log(
          `[${new Date().toISOString()}] [Checkpoint Save] ERROR: Character ${characterId} not found in database for user ${req.user!.email}`
        );
        // Check if character exists at all
        const charExists = database
          .prepare(
            `SELECT character_id, email_id, name FROM characters WHERE character_id = ?`
          )
          .get(characterId);
        if (charExists) {
          console.log(
            `[${new Date().toISOString()}] [Checkpoint Save] Character exists but belongs to different user: ${JSON.stringify(charExists)}`
          );
          res
            .status(403)
            .json({
              error: `Character not found. Character ${characterName || characterId} may belong to a different user.`,
            });
        } else {
          console.log(
            `[${new Date().toISOString()}] [Checkpoint Save] Character does not exist in database at all`
          );
          res
            .status(403)
            .json({
              error: `Character not found. Character ${characterName || characterId} does not exist in database.`,
            });
        }
        return;
      }
    }

    console.log(
      `[${new Date().toISOString()}] [Checkpoint Save] Character verified, proceeding with save...`
    );

    let checkpointId: string;
    let checkpointName: string;
    let description: string;

    const currentScenario = dynamicGameState.currentScenario;
    if (!currentScenario) {
      res
        .status(400)
        .json({ error: "No current scenario. Cannot save checkpoint." });
      return;
    }

    if (checkpointType === "manual") {
      // Generate checkpoint name
      const currentDate = new Date().toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      checkpointName = `${currentScenario.name} - ${currentDate}`;
      description =
        descriptionOverride || `Manual save at ${currentScenario.location}`;

      // Save DynamicGameState checkpoint (includes all snapshots)
      const savedCheckpointId = saveDynamicGameStateCheckpoint(
        db,
        dynamicGameState,
        "manual",
        description
      );

      if (!savedCheckpointId) {
        res.status(500).json({ error: "Failed to save checkpoint" });
        return;
      }

      checkpointId = savedCheckpointId;
    } else {
      const gameDay = dynamicGameState.gameDay ?? 1;
      const timeOfDay = dynamicGameState.timeOfDay ?? "Unknown time";
      const timeLabel = timeOfDay
        ? ` (Day ${gameDay}, ${timeOfDay})`
        : ` (Day ${gameDay})`;
      checkpointName = `${checkpointType === "scene_transition" ? "Scene Transition" : "Auto Save"} - ${currentScenario.name}${timeLabel}`;
      description =
        descriptionOverride ||
        `Auto save${reason ? ` (${reason})` : ""} at ${currentScenario.location}`;

      const savedCheckpointId = saveDynamicGameStateCheckpoint(
        db,
        dynamicGameState,
        checkpointType,
        description
      );

      if (!savedCheckpointId) {
        res.status(500).json({ error: "Failed to save checkpoint" });
        return;
      }

      checkpointId = savedCheckpointId;

      if (checkpointType === "auto") {
        db.cleanupAutoCheckpoints(dynamicGameState.sessionId, 10);
      }
    }

    console.log(
      `[${new Date().toISOString()}] Checkpoint saved: ${checkpointName} (${checkpointId})`
    );

    res.json({
      success: true,
      checkpointId: checkpointId,
      checkpointName: checkpointName,
      message: checkpointType === "auto" ? "Auto save successful" : "Save successful",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error saving checkpoint:", error);
    res
      .status(500)
      .json({
        error: "Failed to save checkpoint: " + (error as Error).message,
      });
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
      const session = database
        .prepare(`
        SELECT s.session_id
        FROM sessions s
        JOIN characters c ON c.character_id = s.character_id
        WHERE s.session_id = ? AND c.email_id = ?
      `)
        .get(sessionId, req.user!.email);

      if (!session) {
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const stmt = database.prepare(`
        SELECT
          gc.checkpoint_id, gc.checkpoint_name, gc.checkpoint_type, gc.description,
          gc.game_day, gc.game_time, gc.current_scene_name, gc.current_location,
          gc.player_hp, gc.player_sanity, gc.created_at, gc.session_id,
          s.mod_name
        FROM game_checkpoints gc
        LEFT JOIN sessions s ON s.session_id = gc.session_id
        WHERE gc.session_id = ?
        ORDER BY gc.created_at DESC
        LIMIT ?
      `);
      checkpoints = stmt.all(sessionId, limit) as any[];
    } else {
      const stmt = database.prepare(`
        SELECT
          gc.checkpoint_id, gc.checkpoint_name, gc.checkpoint_type, gc.description,
          gc.game_day, gc.game_time, gc.current_scene_name, gc.current_location,
          gc.player_hp, gc.player_sanity, gc.created_at, gc.session_id,
          s.mod_name
        FROM game_checkpoints gc
        LEFT JOIN sessions s ON s.session_id = gc.session_id
        WHERE gc.session_id IN (
          SELECT s.session_id
          FROM sessions s
          JOIN characters c ON c.character_id = s.character_id
          WHERE c.email_id = ?
        )
        ORDER BY gc.created_at DESC
        LIMIT ?
      `);
      checkpoints = stmt.all(req.user!.email, limit) as any[];
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
      modName: cp.mod_name || cp.modName || "Unknown Module",
    }));

    res.json({
      success: true,
      checkpoints: normalizedCheckpoints,
    });
  } catch (error) {
    console.error("Error listing checkpoints:", error);
    res
      .status(500)
      .json({
        error: "Failed to list checkpoints: " + (error as Error).message,
      });
  }
}

/**
 * Load a checkpoint and restore game state
 * POST /api/checkpoints/load
 */
export async function loadCheckpointData(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();
    const userId = req.user!.userId;
    const { checkpointId } = req.body;

    if (!checkpointId) {
      res.status(400).json({ error: "checkpointId is required" });
      return;
    }

    const ownedCheckpoint = database
      .prepare(`
      SELECT gc.checkpoint_id
      FROM game_checkpoints gc
      JOIN sessions s ON s.session_id = gc.session_id
      JOIN characters c ON c.character_id = s.character_id
      WHERE gc.checkpoint_id = ? AND c.email_id = ?
    `)
      .get(checkpointId, req.user!.email);

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

    const gameStateAny = gameState as any;
    if (
      !gameStateAny.moduleName ||
      gameStateAny.updatedDynamicScenarioSnapshots === undefined
    ) {
      res
        .status(400)
        .json({ error: "Only DynamicWorld checkpoints are supported" });
      return;
    }

    // Extract conversation history and memos saved in the checkpoint
    const conversationHistory: any[] = gameStateAny.conversationHistory || [];
    const playerMemos: any[] = gameStateAny.playerMemos || [];

    // Generate new session ID — no parent/child relationship needed
    const newSessionId = `session-${randomUUID()}`;

    // Create session and populate with saved conversation + memos
    db.createSessionFromCheckpoint(
      newSessionId,
      gameState,
      conversationHistory,
      playerMemos
    );
    const restoredConversation = new TurnManager(db).getConversation(
      newSessionId
    );

    console.log(
      `[${new Date().toISOString()}] Created session ${newSessionId} from checkpoint ${checkpointId} (${conversationHistory.length} messages, ${playerMemos.length} memos)`
    );

    // Restore language from original session metadata
    let restoredLanguage: "en" | "zh" = "zh";
    try {
      const originalSession = database
        .prepare(`
        SELECT metadata FROM sessions WHERE session_id = ?
      `)
        .get(checkpoint.sessionId) as { metadata: string | null } | undefined;

      if (originalSession?.metadata) {
        const metadata = JSON.parse(originalSession.metadata);
        restoredLanguage =
          metadata.language === "en" || metadata.language === "zh"
            ? metadata.language
            : "zh";
      }

      // Save language to new session metadata
      const newMetadata = { language: restoredLanguage };
      database
        .prepare(`
        UPDATE sessions SET metadata = ? WHERE session_id = ?
      `)
        .run(JSON.stringify(newMetadata), newSessionId);

      console.log(
        `[${new Date().toISOString()}] Restored language setting: ${restoredLanguage}`
      );
    } catch (error) {
      console.error("Failed to restore language setting:", error);
      // Continue with default language
    }

    // Deserialize DynamicGameState with checkpoint gameTime to filter snapshots
    const { DynamicGameStateManager } = await import(
      "../../../src/dynamicworldagent/state/index.js"
    );
    const checkpointGameDay = checkpoint.metadata.gameDay;
    const checkpointTimeOfDay = checkpoint.metadata.gameTime;

    let restoredDynamicGameState: any;
    if (checkpointGameDay && checkpointTimeOfDay) {
      restoredDynamicGameState = DynamicGameStateManager.deserialize(
        gameStateAny,
        checkpointGameDay,
        checkpointTimeOfDay,
        db
      );
    } else {
      restoredDynamicGameState = DynamicGameStateManager.deserialize(
        gameStateAny,
        undefined,
        undefined,
        db
      );
    }

    // Set new session ID, clean up any stale fields from old checkpoints
    restoredDynamicGameState.sessionId = newSessionId;
    delete (restoredDynamicGameState as any).conversationHistory;
    delete (restoredDynamicGameState as any).playerMemos;
    delete (restoredDynamicGameState as any).parentSessionId;
    delete (restoredDynamicGameState as any).subId;

    // Restore game state
    ServerState.getInstance().setGameState(userId, restoredDynamicGameState);

    // Initialize GraphManager if needed
    const graphManager = GraphManager.getInstance();
    if (!graphManager.isInitialized()) {
      await graphManager.initialize(db);
    }

    console.log(
      `[${new Date().toISOString()}] Checkpoint loaded: ${checkpointId} → session ${newSessionId}`
    );

    res.json({
      success: true,
      sessionId: newSessionId,
      gameState: restoredDynamicGameState,
      conversationHistory: restoredConversation,
      language: restoredLanguage,
      message: "存档加载成功",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error loading checkpoint:", error);
    res
      .status(500)
      .json({
        error: "Failed to load checkpoint: " + (error as Error).message,
      });
  }
}

/**
 * Delete a checkpoint
 * DELETE /api/checkpoints/:checkpointId
 */
export function deleteCheckpoint(req: Request, res: Response): void {
  try {
    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();
    const userId = req.user!.userId;
    const { checkpointId } = req.params;

    if (!checkpointId) {
      res.status(400).json({ error: "checkpointId is required" });
      return;
    }

    // Verify checkpoint ownership
    const ownedCheckpoint = database
      .prepare(`
      SELECT gc.checkpoint_id
      FROM game_checkpoints gc
      JOIN sessions s ON s.session_id = gc.session_id
      JOIN characters c ON c.character_id = s.character_id
      WHERE gc.checkpoint_id = ? AND c.email_id = ?
    `)
      .get(checkpointId, req.user!.email);

    if (!ownedCheckpoint) {
      res
        .status(404)
        .json({
          error:
            "Checkpoint not found or you don't have permission to delete it",
        });
      return;
    }

    // Delete the checkpoint
    db.deleteCheckpoint(checkpointId);

    console.log(
      `[${new Date().toISOString()}] Checkpoint deleted: ${checkpointId} by user ${userId}`
    );

    res.json({
      success: true,
      message: "Checkpoint deleted successfully",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error deleting checkpoint:", error);
    res
      .status(500)
      .json({
        error: "Failed to delete checkpoint: " + (error as Error).message,
      });
  }
}
