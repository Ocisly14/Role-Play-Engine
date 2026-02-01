/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { GraphManager } from "../core/GraphManager.js";
import { ServerState } from "../core/ServerState.js";
import { TurnManager } from "../../../src/coc_multiagents_system/agents/memory/index.js";
import { TurnManager as DynamicTurnManager } from "../../../src/dynamicworldagent/dynamicBasicAgent/memory/turnManager.js";
import type { GameState } from "../../../src/coc_multiagents_system/state/gameState.js";
import type { DynamicGameState } from "../../../src/dynamicworldagent/state/index.js";
import { HumanMessage } from "@langchain/core/messages";
import { DynamicGameStateManager } from "../../../src/dynamicworldagent/state/index.js";
import { WebSocketManager } from "../websocket/WebSocketManager.js";
import { notifyClients } from "../websocket/notifier.js";
import { runWithTokenContext, getCurrentUsageTotals } from "../../../src/models/index.js";

type NarrativeStreamHandlers = {
  onDiceRolls?: (diceRolls: string[]) => void;
  onSceneImage?: (payload: {
    imagePath: string;
    mimeType: string;
    sceneName: string;
    location: string;
    gameDay?: number | null;
    gameTime?: string | null;
    timestamp?: string;
  }) => void;
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
    const serverState = ServerState.getInstance();
    
    // Check for both GameState and DynamicGameState (for DynamicWorld modules)
    const persistentGameState = serverState.getGameState(userId);
    const dynamicGameState = serverState.getDynamicGameState(userId);

    if (!persistentGameState && !dynamicGameState) {
      res.status(400).json({
        error: "Game not started. Please start the game first by calling /api/game/start"
      });
      return;
    }

    const graphManager = GraphManager.getInstance();

    // Initialize graph if needed
    if (!graphManager.isInitialized()) {
      const db = DatabaseManager.getInstance().getDatabase();
      // Default: skip RAG (true), unless explicitly set to 'false'
      await graphManager.initialize(db, process.env.SKIP_RAG !== 'false');
    }

    const { message, selectedSkill: rawSelectedSkill } = req.body ?? {};
    const selectedSkill = typeof rawSelectedSkill === "string"
      ? rawSelectedSkill.trim()
      : null;
    const normalizedSkill = selectedSkill && selectedSkill.length > 0 ? selectedSkill : null;

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "Message is required" });
      return;
    }

    // Determine which type of game state we have
    const useDynamic = dynamicGameState !== null;
    const db = DatabaseManager.getInstance().getDatabase();

    // Get appropriate turn manager based on game state type
    let turnId: string;
    if (useDynamic && dynamicGameState) {
      // For DynamicWorld modules, use DynamicTurnManager
      const dynamicTurnManager = new DynamicTurnManager(db);
      turnId = dynamicTurnManager.createTurnFromGameState(
        dynamicGameState.sessionId,
        message,
        dynamicGameState
      );
    } else if (persistentGameState) {
      // For regular modules, use standard TurnManager
      const turnManager = graphManager.getTurnManager();
      if (!turnManager) {
        res.status(500).json({ error: "Turn manager not initialized" });
        return;
      }
      turnId = turnManager.createTurnFromGameState(
        persistentGameState.sessionId,
        message,
        persistentGameState
      );
    } else {
      res.status(400).json({
        error: "Game not started. Please start the game first by calling /api/game/start"
      });
      return;
    }

    console.log(`[${new Date().toISOString()}] Turn created: ${turnId} for message: ${message} (${useDynamic ? 'DynamicWorld' : 'Standard'})`);
    if (normalizedSkill) {
      console.log(`[${new Date().toISOString()}] Selected skill: ${normalizedSkill}`);
    }

    // Start async processing (don't wait for it)
    // Pass the appropriate state type to processGameTurnAsync
    const stateToProcess = useDynamic ? dynamicGameState! : persistentGameState!;
    runWithTokenContext(
      {
        userId,
        turnId,
        usageTotals: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
      () => {
      processGameTurnAsync(turnId, message, stateToProcess, userId, normalizedSkill)
        .catch((error) => {
          console.error(`Error processing turn ${turnId}:`, error);
          // Mark error using appropriate turn manager
          if (useDynamic) {
            const dynamicTurnManager = new DynamicTurnManager(db);
            dynamicTurnManager.markError(turnId, error);
          } else {
            const turnManager = graphManager.getTurnManager();
            if (turnManager) {
              turnManager.markError(turnId, error);
            }
          }
        });
      }
    );

    // Immediately return the turnId
    res.json({
      success: true,
      turnId: turnId,
      status: 'processing',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error creating turn:", error);
    res.status(500).json({ error: "Failed to create turn: " + (error as Error).message });
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
    onDiceRolls: (diceRolls: string[]) => {
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
  gameState: GameState | DynamicGameState,
  userId: string,
  selectedSkill?: string | null
) {
  try {
    console.log(`[${new Date().toISOString()}] Processing turn ${turnId}...`);

    const serverState = ServerState.getInstance();
    const graphManager = GraphManager.getInstance();

    // Check if this is a DynamicWorld module by checking the state type
    // If gameState has 'moduleName' property, it's a DynamicGameState
    const useDynamic = 'moduleName' in gameState;
    const dynamicGameState = useDynamic ? (gameState as DynamicGameState) : null;
    const regularGameState = useDynamic ? null : (gameState as GameState);

    const graph = graphManager.getGraph(useDynamic);
    const initialMessages = [new HumanMessage(userInput)];
    const db = DatabaseManager.getInstance().getDatabase();
    let streamHandlers: NarrativeStreamHandlers | null = null;

    if (useDynamic && dynamicGameState) {
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
    }

    // Prepare graph state
    let graphState: any;
    
    if (useDynamic && dynamicGameState) {
      // For DynamicWorld modules, use only DynamicGameState
      graphState = {
        messages: initialMessages,
        dynamicGameState: dynamicGameState,
        turnId: turnId,
        stream: streamHandlers ?? undefined,
        selectedSkill: selectedSkill ?? null,
      };
    } else if (regularGameState) {
      // For regular modules, use GameState (legacy support)
      graphState = {
        messages: initialMessages,
        gameState: regularGameState,
        turnId: turnId,
      };
    } else {
      throw new Error("Invalid game state: neither DynamicGameState nor GameState");
    }

    // Invoke the graph
    const result = await graph.invoke(graphState);

    // Update the persistent state
    if (useDynamic && result.dynamicGameState) {
      // For DynamicWorld, only store DynamicGameState
      // Note: GameState is not needed for DynamicWorld modules
      serverState.setGameState(userId, null as any, result.dynamicGameState);
    } else if (result.gameState) {
      // For regular modules, update GameState only
      serverState.setGameState(userId, result.gameState, null);
    }

    const totals = getCurrentUsageTotals();
    if (totals && totals.total_tokens > 0) {
      console.log(
        `🧮 [Token Usage] Turn ${turnId} total: ${totals.total_tokens} (input ${totals.input_tokens}, output ${totals.output_tokens})`
      );
    }

    console.log(`[${new Date().toISOString()}] Turn ${turnId} completed successfully (${useDynamic ? 'DynamicWorld' : 'Standard'} graph)`);
  } catch (error) {
    const totals = getCurrentUsageTotals();
    if (totals && totals.total_tokens > 0) {
      console.warn(
        `🧮 [Token Usage] Turn ${turnId} partial: ${totals.total_tokens} (input ${totals.input_tokens}, output ${totals.output_tokens})`
      );
    }
    console.error(`[${new Date().toISOString()}] Turn ${turnId} failed:`, error);
    throw error;
  }
}

/**
 * Get turn status and result
 * GET /api/turns/:turnId
 */
export async function getTurnStatus(req: Request, res: Response): Promise<void> {
  try {
    const { turnId } = req.params;
    const userId = req.user!.userId;
    const db = DatabaseManager.getInstance().getDatabase();
    const database = db.getDatabase();

    if (!isTurnOwnedByUser(turnId, userId, database)) {
      res.status(404).json({ error: "Turn not found" });
      return;
    }

    // Try both TurnManagers - they both use the same database table
    // First try to determine which one to use based on user's game state
    const serverState = ServerState.getInstance();
    const dynamicGameState = serverState.getDynamicGameState(userId);
    const useDynamic = dynamicGameState !== null;

    // Use appropriate TurnManager
    let turn: any = null;
    if (useDynamic) {
      const dynamicTurnManager = new DynamicTurnManager(db);
      turn = dynamicTurnManager.getTurn(turnId);
    } else {
      const turnManager = GraphManager.getInstance().getTurnManager();
      if (turnManager) {
        turn = turnManager.getTurn(turnId);
      }
    }

    // If not found with specific manager, try the other one (fallback)
    if (!turn) {
      const dynamicTurnManager = new DynamicTurnManager(db);
      turn = dynamicTurnManager.getTurn(turnId);
      if (!turn) {
        const turnManager = GraphManager.getInstance().getTurnManager();
        if (turnManager) {
          turn = turnManager.getTurn(turnId);
        }
      }
    }

    const waitForCompletion = req.query.wait === 'true';
    const maxWaitTime = 60000; // 60 seconds
    const checkInterval = 500; // 500ms
    const startTime = Date.now();

    // Long polling
    if (waitForCompletion) {
      while (Date.now() - startTime < maxWaitTime) {
        // Re-fetch turn to get latest status
        if (useDynamic) {
          const dynamicTurnManager = new DynamicTurnManager(db);
          turn = dynamicTurnManager.getTurn(turnId);
        } else {
          const turnManager = GraphManager.getInstance().getTurnManager();
          if (turnManager) {
            turn = turnManager.getTurn(turnId);
          }
        }

        if (!turn) {
          res.status(404).json({ error: "Turn not found" });
          return;
        }

        if (turn.status === 'completed' || turn.status === 'error') {
          console.log(`[getTurnStatus] Turn ${turnId} completed:`, {
            status: turn.status,
            hasKeeperNarrative: !!turn.keeperNarrative,
            keeperNarrativeLength: turn.keeperNarrative?.length || 0,
            hasActionResults: !!turn.actionResults,
            actionResultsCount: Array.isArray(turn.actionResults) ? turn.actionResults.length : 0,
          });
          res.json({ success: true, turn: turn });
          return;
        }

        await new Promise(resolve => setTimeout(resolve, checkInterval));
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
      actionResultsCount: Array.isArray(turn.actionResults) ? turn.actionResults.length : 0,
    });

    res.json({ success: true, turn: turn });
  } catch (error) {
    console.error("Error fetching turn:", error);
    res.status(500).json({ error: "Failed to fetch turn" });
  }
}

async function ensureTurnManager(): Promise<TurnManager | null> {
  const graphManager = GraphManager.getInstance();

  if (!graphManager.isInitialized()) {
    const db = DatabaseManager.getInstance().getDatabase();
    // Default: skip RAG (true), unless explicitly set to 'false'
    await graphManager.initialize(db, process.env.SKIP_RAG !== 'false');
  }

  return graphManager.getTurnManager();
}

/**
 * Get conversation history
 * GET /api/sessions/:sessionId/conversation
 */
export async function getConversation(req: Request, res: Response): Promise<void> {
  try {
    const turnManager = await ensureTurnManager();

    if (!turnManager) {
      res.status(400).json({ error: "Game not initialized" });
      return;
    }

    const { sessionId } = req.params;
    const userId = req.user!.userId;
    const db = DatabaseManager.getInstance().getDatabase().getDatabase();
    const serverState = ServerState.getInstance();

    if (!isSessionOwnedByUser(sessionId, userId, db, serverState)) {
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
export async function getTurnHistory(req: Request, res: Response): Promise<void> {
  try {
    const turnManager = await ensureTurnManager();

    if (!turnManager) {
      res.status(400).json({ error: "Game not initialized" });
      return;
    }

    const { sessionId } = req.params;
    const userId = req.user!.userId;
    const db = DatabaseManager.getInstance().getDatabase().getDatabase();
    const serverState = ServerState.getInstance();

    if (!isSessionOwnedByUser(sessionId, userId, db, serverState)) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 20;
    const after = req.query.after ? parseInt(req.query.after as string) : undefined;

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
export async function getLatestSession(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const serverState = ServerState.getInstance();
    const activeState = serverState.getGameState(userId);

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
    const row = db.prepare(`
      SELECT
        gt.session_id AS sessionId,
        gt.character_id AS characterId,
        gt.character_name AS characterName,
        MAX(gt.created_at) AS lastTurnAt
      FROM game_turns gt
      JOIN characters c ON c.character_id = gt.character_id
      WHERE c.user_id = ?
      GROUP BY gt.session_id
      ORDER BY MAX(gt.created_at) DESC
      LIMIT 1
    `).get(userId) as {
      sessionId: string;
      characterId: string | null;
      characterName: string | null;
      lastTurnAt: string;
    } | undefined;

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
  userId: string,
  db: Database.Database
): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM game_turns gt
    JOIN characters c ON c.character_id = gt.character_id
    WHERE gt.turn_id = ? AND c.user_id = ?
    LIMIT 1
  `).get(turnId, userId);

  return Boolean(row);
}

function isSessionOwnedByUser(
  sessionId: string,
  userId: string,
  db: Database.Database,
  serverState: ServerState
): boolean {
  const active = serverState.getGameState(userId);
  if (active?.sessionId === sessionId) {
    return true;
  }

  const row = db.prepare(`
    SELECT 1
    FROM game_turns gt
    JOIN characters c ON c.character_id = gt.character_id
    WHERE gt.session_id = ? AND c.user_id = ?
    LIMIT 1
  `).get(sessionId, userId);

  return Boolean(row);
}
