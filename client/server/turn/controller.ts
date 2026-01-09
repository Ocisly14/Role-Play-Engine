import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { GraphManager } from "../core/GraphManager.js";
import { ServerState } from "../core/ServerState.js";
import type { GameState } from "../../../src/state.js";
import { HumanMessage } from "@langchain/core/messages";

/**
 * Create a new turn and start processing
 * POST /api/turns
 */
export async function createTurn(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const persistentGameState = ServerState.getInstance().getGameState(userId);

    if (!persistentGameState) {
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

    const turnManager = graphManager.getTurnManager();
    if (!turnManager) {
      res.status(500).json({ error: "Turn manager not initialized" });
      return;
    }

    const { message } = req.body;

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "Message is required" });
      return;
    }

    // Create turn record in database
    const turnId = turnManager.createTurnFromGameState(
      persistentGameState.sessionId,
      message,
      persistentGameState
    );

    console.log(`[${new Date().toISOString()}] Turn created: ${turnId} for message: ${message}`);

    // Start async processing (don't wait for it)
    processGameTurnAsync(turnId, message, persistentGameState, userId)
      .catch((error) => {
        console.error(`Error processing turn ${turnId}:`, error);
        if (turnManager) {
          turnManager.markError(turnId, error);
        }
      });

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

/**
 * Helper function to process a game turn asynchronously
 */
async function processGameTurnAsync(
  turnId: string,
  userInput: string,
  gameState: GameState,
  userId: string
) {
  try {
    console.log(`[${new Date().toISOString()}] Processing turn ${turnId}...`);

    const graph = GraphManager.getInstance().getGraph();
    const initialMessages = [new HumanMessage(userInput)];

    // Invoke the graph with turnId in state
    const result = await graph.invoke({
      messages: initialMessages,
      gameState: gameState,
      turnId: turnId,
    });

    // Update the persistent state
    ServerState.getInstance().setGameState(userId, result.gameState);

    console.log(`[${new Date().toISOString()}] Turn ${turnId} completed successfully`);
  } catch (error) {
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
    const turnManager = GraphManager.getInstance().getTurnManager();

    if (!turnManager) {
      res.status(400).json({ error: "Game not initialized" });
      return;
    }

    const { turnId } = req.params;
    const userId = req.user!.userId;
    const db = DatabaseManager.getInstance().getDatabase().getDatabase();

    if (!isTurnOwnedByUser(turnId, userId, db)) {
      res.status(404).json({ error: "Turn not found" });
      return;
    }
    const waitForCompletion = req.query.wait === 'true';
    const maxWaitTime = 60000; // 60 seconds
    const checkInterval = 500; // 500ms
    const startTime = Date.now();

    // Long polling
    if (waitForCompletion) {
      while (Date.now() - startTime < maxWaitTime) {
        const turn = turnManager.getTurn(turnId);

        if (!turn) {
          res.status(404).json({ error: "Turn not found" });
          return;
        }

        if (turn.status === 'completed' || turn.status === 'error') {
          res.json({ success: true, turn: turn });
          return;
        }

        await new Promise(resolve => setTimeout(resolve, checkInterval));
      }
    }

    // Immediate return
    const turn = turnManager.getTurn(turnId);

    if (!turn) {
      res.status(404).json({ error: "Turn not found" });
      return;
    }

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
export function getConversation(req: Request, res: Response): void {
  try {
    const turnManager = GraphManager.getInstance().getTurnManager();

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
export function getTurnHistory(req: Request, res: Response): void {
  try {
    const turnManager = GraphManager.getInstance().getTurnManager();

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
