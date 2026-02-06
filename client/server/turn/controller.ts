/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { GraphManager } from "../core/GraphManager.js";
import { ServerState } from "../core/ServerState.js";
import { TurnManager as DynamicTurnManager } from "../../../src/dynamicworldagent/dynamicBasicAgent/memory/turnManager.js";
import type { DynamicGameState } from "../../../src/dynamicworldagent/state/index.js";
import { HumanMessage } from "@langchain/core/messages";
import { WebSocketManager } from "../websocket/WebSocketManager.js";
import { notifyClients } from "../websocket/notifier.js";
import {
  runWithTokenContext,
  getCurrentUsageTotals,
} from "../../../src/models/index.js";
import type { DiceRollInfo } from "../../../src/shared/state/index.js";

type NarrativeStreamHandlers = {
  onDiceRolls?: (diceRolls: DiceRollInfo[]) => void;
  onSceneImage?: (payload: {
    imagePath: string;
    mimeType: string;
    sceneName: string;
    location: string;
    gameDay?: number | null;
    gameTime?: string | null;
    timestamp?: string;
  }) => void;
  onSceneChangeStart?: () => void;
  onSceneChangeEnd?: () => void;
  onNarrativeStart?: () => void;
  onNarrativeDelta?: (delta: string) => void;
  onNarrativeEnd?: () => void;
};

/**
 * Create a new turn and start processing
 * POST /api/turns
 */
export async function createTurn(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const userEmail = req.user!.email;
    const serverState = ServerState.getInstance();

    const dynamicGameState = serverState.getDynamicGameState(userId);

    if (!dynamicGameState) {
      res.status(400).json({
        error:
          "DynamicWorld game not started. Please start the game first by calling /api/game/start",
      });
      return;
    }

    const graphManager = GraphManager.getInstance();

    // Initialize graph if needed
    if (!graphManager.isInitialized()) {
      const db = DatabaseManager.getInstance().getDatabase();
      await graphManager.initialize(db);
    }

    const {
      message,
      selectedSkill: rawSelectedSkill,
      skillSelectionMode: rawSkillSelectionMode,
      language: rawLanguage,
    } = req.body ?? {};
    const selectedSkill =
      typeof rawSelectedSkill === "string" ? rawSelectedSkill.trim() : null;
    const normalizedSkill =
      selectedSkill && selectedSkill.length > 0 ? selectedSkill : null;
    const normalizedSkillSelectionMode =
      typeof rawSkillSelectionMode === "string"
        ? rawSkillSelectionMode.trim().toLowerCase()
        : null;
    const skillSelectionMode =
      normalizedSkillSelectionMode === "auto" ||
      normalizedSkillSelectionMode === "manual"
        ? normalizedSkillSelectionMode
        : null;
    const effectiveSkillSelectionMode = normalizedSkill
      ? "manual"
      : skillSelectionMode === "auto"
        ? "auto"
        : "manual";
    const language =
      rawLanguage === "en" || rawLanguage === "zh" ? rawLanguage : "zh";

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "Message is required" });
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();
    const dynamicTurnManager = new DynamicTurnManager(db);

    // Check if this is resuming an interrupted turn (skill selection)
    let turnId: string | undefined;
    let isResumingTurn = false;

    if (normalizedSkill) {
      // Look for a recent turn with requires_skill_selection status for this session
      const skillSelectionTurn = database
        .prepare(`
        SELECT * FROM game_turns
        WHERE session_id = ? AND status = 'requires_skill_selection'
        ORDER BY turn_number DESC
        LIMIT 1
      `)
        .get(dynamicGameState.sessionId) as any;

      if (skillSelectionTurn) {
        console.log(
          `🔄 [${new Date().toISOString()}] Resuming interrupted turn ${skillSelectionTurn.turn_id} with selected skill: ${normalizedSkill}`
        );
        isResumingTurn = true;
        turnId = skillSelectionTurn.turn_id;

        // Move the interrupted turn back to processing before resuming graph execution.
        database
          .prepare(`
          UPDATE game_turns
          SET status = 'processing',
              error_message = NULL
          WHERE turn_id = ?
        `)
          .run(turnId);
      }
    }

    // Create new turn if not resuming
    if (!turnId) {
      turnId = dynamicTurnManager.createTurnFromGameState(
        dynamicGameState.sessionId,
        message,
        dynamicGameState
      );
      console.log(
        `[${new Date().toISOString()}] Turn created: ${turnId} for message: ${message} (DynamicWorld)`
      );
    }

    if (normalizedSkill) {
      console.log(
        `[${new Date().toISOString()}] Selected skill: ${normalizedSkill}`
      );
    }
    if (effectiveSkillSelectionMode === "auto") {
      console.log(`[${new Date().toISOString()}] Skill selection mode: auto`);
    }

    // Start async processing (don't wait for it)
    // Pass the appropriate state type to processGameTurnAsync
    const stateToProcess = dynamicGameState;
    runWithTokenContext(
      {
        email: userEmail,
        turnId,
        usageTotals: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
      () => {
        processGameTurnAsync(
          turnId,
          message,
          stateToProcess,
          userId,
          normalizedSkill,
          effectiveSkillSelectionMode,
          language,
          isResumingTurn
        ).catch((error) => {
          console.error(`Error processing turn ${turnId}:`, error);
          const dynamicTurnManager = new DynamicTurnManager(db);
          dynamicTurnManager.markError(turnId, error);
        });
      }
    );

    // Immediately return the turnId
    res.json({
      success: true,
      turnId: turnId,
      status: "processing",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error creating turn:", error);
    res
      .status(500)
      .json({ error: "Failed to create turn: " + (error as Error).message });
  }
}

function buildNarrativeStreamHandlers(params: {
  sessionId: string;
  turnId: string;
  turnNumber?: number | null;
  isSimulated?: boolean | null;
  gameDay?: number | null;
  gameTime?: string | null;
  timestamp?: string | null;
}): NarrativeStreamHandlers | null {
  const modelProvider = (process.env.MODEL_PROVIDER || "").toLowerCase();
  const enableStreaming = modelProvider === "google";

  const wsManager = WebSocketManager.getInstance();
  if (!wsManager) {
    return null;
  }

  const clients = wsManager.getClients();
  if (!clients.has(params.sessionId)) {
    return null;
  }

  let started = false;
  let pending = "";
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (message: Record<string, unknown>) => {
    notifyClients(params.sessionId, clients, message);
  };

  const flush = () => {
    if (!pending) return;
    send({
      type: "keeper_stream_delta",
      turnId: params.turnId,
      delta: pending,
    });
    pending = "";
  };

  const start = () => {
    if (started) return;
    started = true;
    send({
      type: "keeper_stream_start",
      turnId: params.turnId,
      turnNumber: params.turnNumber ?? null,
      isSimulated: params.isSimulated ?? null,
      timestamp: params.timestamp || new Date().toISOString(),
      gameDay: params.gameDay ?? null,
      gameTime: params.gameTime ?? null,
    });
  };

  return {
    onDiceRolls: (diceRolls: DiceRollInfo[]) => {
      if (!Array.isArray(diceRolls) || diceRolls.length === 0) return;
      send({
        type: "keeper_dice_rolls",
        turnId: params.turnId,
        turnNumber: params.turnNumber ?? null,
        diceRolls,
        timestamp: params.timestamp || new Date().toISOString(),
        gameDay: params.gameDay ?? null,
        gameTime: params.gameTime ?? null,
      });
    },
    onSceneImage: (payload) => {
      send({
        type: "scene_image",
        turnId: params.turnId,
        turnNumber: params.turnNumber ?? null,
        timestamp: payload.timestamp || new Date().toISOString(),
        gameDay: payload.gameDay ?? params.gameDay ?? null,
        gameTime: payload.gameTime ?? params.gameTime ?? null,
        sceneName: payload.sceneName,
        location: payload.location,
        imagePath: payload.imagePath,
        mimeType: payload.mimeType,
      });
    },
    onSceneChangeStart: () => {
      send({
        type: "scene_change_start",
        turnId: params.turnId,
        timestamp: new Date().toISOString(),
      });
    },
    onSceneChangeEnd: () => {
      send({
        type: "scene_change_end",
        turnId: params.turnId,
        timestamp: new Date().toISOString(),
      });
    },
    onNarrativeStart: enableStreaming
      ? () => {
          start();
        }
      : undefined,
    onNarrativeDelta: enableStreaming
      ? (delta: string) => {
          if (!delta) return;
          start();
          pending += delta;

          if (pending.length >= 48) {
            flush();
            return;
          }

          if (!flushTimer) {
            flushTimer = setTimeout(() => {
              flush();
              flushTimer = null;
            }, 50);
          }
        }
      : undefined,
    onNarrativeEnd: enableStreaming
      ? () => {
          if (!started) return;
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          flush();
          send({
            type: "keeper_stream_end",
            turnId: params.turnId,
            timestamp: new Date().toISOString(),
          });
        }
      : undefined,
  };
}

/**
 * Helper function to process a game turn asynchronously
 */
async function processGameTurnAsync(
  turnId: string,
  userInput: string,
  gameState: DynamicGameState,
  userId: string,
  selectedSkill?: string | null,
  skillSelectionMode?: "auto" | "manual",
  language?: "en" | "zh",
  resumeFromInterrupt: boolean = false
) {
  try {
    console.log(`[${new Date().toISOString()}] Processing turn ${turnId}...`);

    const serverState = ServerState.getInstance();
    const graphManager = GraphManager.getInstance();

    const dynamicGameState = gameState;
    const graph = graphManager.getGraph(true);
    const initialMessages = [new HumanMessage(userInput)];
    const db = DatabaseManager.getInstance().getDatabase();
    let streamHandlers: NarrativeStreamHandlers | null = null;

    const dynamicTurnManager = new DynamicTurnManager(db);
    const turn = dynamicTurnManager.getTurn(turnId);
    streamHandlers = buildNarrativeStreamHandlers({
      sessionId: dynamicGameState.sessionId,
      turnId,
      turnNumber: turn?.turnNumber ?? null,
      isSimulated: turn?.isSimulated ?? null,
      gameDay: turn?.gameDay ?? dynamicGameState.gameDay ?? null,
      gameTime: turn?.gameTime ?? dynamicGameState.timeOfDay ?? null,
      timestamp: turn?.startedAt ?? null,
    });

    const isResumingTurn = resumeFromInterrupt;

    // Prepare graph state
    let graphState: any;

    graphState = {
      messages: initialMessages,
      dynamicGameState: dynamicGameState,
      turnId: turnId,
      stream: streamHandlers ?? undefined,
      language: language || "zh",
      selectedSkill: selectedSkill ?? null,
      skillSelectionMode,
      resumeFromInterrupt: isResumingTurn,
    };

    // Invoke the graph with checkpoint support
    // Use turnId as thread_id to enable resume functionality
    const graphConfig = {
      configurable: {
        thread_id: turnId,
      },
    };

    if (isResumingTurn) {
      console.log(
        `   🔄 Resuming graph execution from checkpoint (thread_id: ${turnId})`
      );
    } else {
      console.log(`   ▶️  Starting new graph execution (thread_id: ${turnId})`);
    }

    const result = await graph.invoke(graphState, graphConfig);

    // Update the persistent state
    // Note: Skill selection check is now handled inside the graph
    // If skill selection is required, the graph will mark the turn and end early
    // In that case, we should NOT update the game state
    const updatedTurn = dynamicTurnManager.getTurn(turnId);
    if (updatedTurn && updatedTurn.status === "requires_skill_selection") {
      console.log(
        `⏸️  [${new Date().toISOString()}] Turn ${turnId} requires skill selection - game state not updated`
      );
      // Don't update game state, wait for player to select skill
      return;
    }

    if (result.dynamicGameState) {
      serverState.setGameState(userId, result.dynamicGameState);
    }

    const totals = getCurrentUsageTotals();
    if (totals && totals.total_tokens > 0) {
      console.log(
        `🧮 [Token Usage] Turn ${turnId} total: ${totals.total_tokens} (input ${totals.input_tokens}, output ${totals.output_tokens})`
      );
    }

    console.log(
      `[${new Date().toISOString()}] Turn ${turnId} completed successfully (DynamicWorld graph)`
    );
  } catch (error) {
    const totals = getCurrentUsageTotals();
    if (totals && totals.total_tokens > 0) {
      console.warn(
        `🧮 [Token Usage] Turn ${turnId} partial: ${totals.total_tokens} (input ${totals.input_tokens}, output ${totals.output_tokens})`
      );
    }
    console.error(
      `[${new Date().toISOString()}] Turn ${turnId} failed:`,
      error
    );
    throw error;
  }
}

/**
 * Get turn status and result
 * GET /api/turns/:turnId
 */
export async function getTurnStatus(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { turnId } = req.params;
    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();

    if (!isTurnOwnedByUser(turnId, req.user!.email, database)) {
      res.status(404).json({ error: "Turn not found" });
      return;
    }

    const dynamicTurnManager = new DynamicTurnManager(db);
    let turn: any = dynamicTurnManager.getTurn(turnId);

    const waitForCompletion = req.query.wait === "true";
    const maxWaitTime = 60000; // 60 seconds
    const checkInterval = 500; // 500ms
    const startTime = Date.now();

    // Long polling
    if (waitForCompletion) {
      while (Date.now() - startTime < maxWaitTime) {
        // Re-fetch turn to get latest status
        const dynamicTurnManager = new DynamicTurnManager(db);
        turn = dynamicTurnManager.getTurn(turnId);

        if (!turn) {
          res.status(404).json({ error: "Turn not found" });
          return;
        }

        if (
          turn.status === "completed" ||
          turn.status === "error" ||
          turn.status === "requires_skill_selection"
        ) {
          console.log(`[getTurnStatus] Turn ${turnId} completed:`, {
            status: turn.status,
            hasKeeperNarrative: !!turn.keeperNarrative,
            keeperNarrativeLength: turn.keeperNarrative?.length || 0,
            hasActionResults: !!turn.actionResults,
            actionResultsCount: Array.isArray(turn.actionResults)
              ? turn.actionResults.length
              : 0,
            requiresSkillSelection: turn.status === "requires_skill_selection",
            hasActionAnalysis: !!turn.actionAnalysis,
          });
          res.json({ success: true, turn: turn });
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, checkInterval));
      }
    }

    // Immediate return or timeout
    if (!turn) {
      res.status(404).json({ error: "Turn not found" });
      return;
    }

    console.log(`[getTurnStatus] Returning turn ${turnId}:`, {
      status: turn.status,
      hasKeeperNarrative: !!turn.keeperNarrative,
      keeperNarrativeLength: turn.keeperNarrative?.length || 0,
      hasActionResults: !!turn.actionResults,
      actionResultsCount: Array.isArray(turn.actionResults)
        ? turn.actionResults.length
        : 0,
    });

    res.json({ success: true, turn: turn });
  } catch (error) {
    console.error("Error fetching turn:", error);
    res.status(500).json({ error: "Failed to fetch turn" });
  }
}

/**
 * Get conversation history
 * GET /api/sessions/:sessionId/conversation
 */
export async function getConversation(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const db = DatabaseManager.getInstance().getDatabase();
    const turnManager = new DynamicTurnManager(db);

    const { sessionId } = req.params;
    const userId = req.user!.userId;
    const database = db.getDatabase();
    const serverState = ServerState.getInstance();

    if (
      !isSessionOwnedByUser(
        sessionId,
        userId,
        req.user!.email,
        database,
        serverState
      )
    ) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 50;

    const conversation = turnManager.getConversation(sessionId, limit);

    res.json({ success: true, conversation: conversation });
  } catch (error) {
    console.error("Error fetching conversation:", error);
    res.status(500).json({ error: "Failed to fetch conversation" });
  }
}

/**
 * Get turn history
 * GET /api/sessions/:sessionId/turns
 */
export async function getTurnHistory(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const db = DatabaseManager.getInstance().getDatabase();
    const turnManager = new DynamicTurnManager(db);

    const { sessionId } = req.params;
    const userId = req.user!.userId;
    const database = db.getDatabase();
    const serverState = ServerState.getInstance();

    if (
      !isSessionOwnedByUser(
        sessionId,
        userId,
        req.user!.email,
        database,
        serverState
      )
    ) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 20;
    const after = req.query.after
      ? parseInt(req.query.after as string)
      : undefined;

    const turns = turnManager.getHistory(sessionId, limit, after);

    res.json({
      success: true,
      turns: turns,
      hasMore: turns.length === limit,
    });
  } catch (error) {
    console.error("Error fetching turns:", error);
    res.status(500).json({ error: "Failed to fetch turns" });
  }
}

/**
 * Get the latest session for the current user
 * GET /api/sessions/latest
 */
export async function getLatestSession(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const serverState = ServerState.getInstance();
    const activeState = serverState.getDynamicGameState(userId);

    if (activeState?.sessionId) {
      res.json({
        success: true,
        session: {
          sessionId: activeState.sessionId,
          characterId: activeState.playerCharacter?.id ?? null,
          characterName: activeState.playerCharacter?.name ?? null,
        },
      });
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase().getDatabase();
    const row = db
      .prepare(`
      SELECT
        gt.session_id AS sessionId,
        gt.character_id AS characterId,
        gt.character_name AS characterName,
        MAX(gt.created_at) AS lastTurnAt
      FROM game_turns gt
      JOIN characters c ON c.character_id = gt.character_id
      WHERE c.email_id = ?
      GROUP BY gt.session_id
      ORDER BY MAX(gt.created_at) DESC
      LIMIT 1
    `)
      .get(req.user!.email) as
      | {
          sessionId: string;
          characterId: string | null;
          characterName: string | null;
          lastTurnAt: string;
        }
      | undefined;

    res.json({
      success: true,
      session: row ?? null,
    });
  } catch (error) {
    console.error("Error fetching latest session:", error);
    res.status(500).json({ error: "Failed to fetch latest session" });
  }
}

function isTurnOwnedByUser(
  turnId: string,
  email: string,
  db: Database.Database
): boolean {
  const row = db
    .prepare(`
    SELECT 1
    FROM game_turns gt
    JOIN characters c ON c.character_id = gt.character_id
    WHERE gt.turn_id = ? AND c.email_id = ?
    LIMIT 1
  `)
    .get(turnId, email);

  return Boolean(row);
}

function isSessionOwnedByUser(
  sessionId: string,
  userId: string,
  email: string,
  db: Database.Database,
  serverState: ServerState
): boolean {
  const active = serverState.getDynamicGameState(userId);
  if (active?.sessionId === sessionId) {
    return true;
  }

  const row = db
    .prepare(`
    SELECT 1
    FROM game_turns gt
    JOIN characters c ON c.character_id = gt.character_id
    WHERE gt.session_id = ? AND c.email_id = ?
    LIMIT 1
  `)
    .get(sessionId, email);

  return Boolean(row);
}
