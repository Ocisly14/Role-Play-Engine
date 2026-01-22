import type { Request, Response } from "express";
import type Database from "better-sqlite3";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { GraphManager } from "../core/GraphManager.js";
import { ServerState } from "../core/ServerState.js";
import { TurnManager } from "../../../src/coc_multiagents_system/agents/memory/index.js";
import type { GameState } from "../../../src/state.js";
import { HumanMessage } from "@langchain/core/messages";
import { DynamicGameStateManager } from "../../../src/dynamicworldagent/state/index.js";

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

    const serverState = ServerState.getInstance();
    const graphManager = GraphManager.getInstance();

    // Check if this is a DynamicWorld module by checking if dynamicGameState exists
    const dynamicGameState = serverState.getDynamicGameState(userId);
    const useDynamic = dynamicGameState !== null;

    const graph = graphManager.getGraph(useDynamic);
    const initialMessages = [new HumanMessage(userInput)];

    // Prepare graph state
    let graphState: any;
    
    if (useDynamic && dynamicGameState) {
      // For DynamicWorld modules, use only DynamicGameState
      graphState = {
        messages: initialMessages,
        dynamicGameState: dynamicGameState,
        turnId: turnId,
      };
    } else {
      // For regular modules, use GameState (legacy support)
      graphState = {
        messages: initialMessages,
        gameState: gameState,
        turnId: turnId,
      };
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

    console.log(`[${new Date().toISOString()}] Turn ${turnId} completed successfully (${useDynamic ? 'DynamicWorld' : 'Standard'} graph)`);
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
