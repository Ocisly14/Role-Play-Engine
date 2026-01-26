import type { WSClient } from "./WebSocketManager.js";
import { WebSocket } from "ws";
import { ServerState } from "../core/ServerState.js";
import { GraphManager } from "../core/GraphManager.js";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { GameStateManager } from "../../../src/coc_multiagents_system/state/gameState.js";
import { enrichMemoryContext } from "../../../src/coc_multiagents_system/agents/memory/memoryAgent.js";
import { notifyClients } from "./notifier.js";

const CHECK_INTERVAL_MS = 60000; // Check every 60 seconds
let progressionCheckInterval: NodeJS.Timeout | null = null;

/**
 * Check if simulate should be triggered based on TIME threshold only (3 minutes idle)
 * Uses the listener graph to check progression and process simulate queries
 * @param sessionId - Session ID to check
 * @param clients - Map of all WebSocket clients
 * @returns true if simulate was triggered, false otherwise
 */
export async function checkAndTriggerSimulate(
  sessionId: string,
  clients: Map<string, WSClient>
): Promise<boolean> {
  const serverState = ServerState.getInstance();
  const graphManager = GraphManager.getInstance();
  const dbManager = DatabaseManager.getInstance();

  const persistentGameState = serverState.getGameStateBySession(sessionId);
  const dynamicGameState = serverState.getDynamicGameStateBySession(sessionId);
  const useDynamic = dynamicGameState !== null;
  const listenerGraph = graphManager.getListenerGraph(useDynamic);
  const turnManager = graphManager.getTurnManager();
  const ragManager = graphManager.getRagManager();
  const db = dbManager.isInitialized() ? dbManager.getDatabase() : null;

  if ((!persistentGameState && !dynamicGameState) || !listenerGraph || !turnManager || !db) {
    return false;
  }

  // Check session ID match
  const sessionIdMatch = useDynamic && dynamicGameState
    ? dynamicGameState.sessionId === sessionId
    : persistentGameState?.sessionId === sessionId;
  if (!sessionIdMatch) {
    return false;
  }

  try {
    // Get state manager based on type
    let minutesSinceInput: number;
    if (useDynamic && dynamicGameState) {
      const { DynamicGameStateManager } = await import("../../../src/dynamicworldagent/state/index.js");
      const dgsm = new DynamicGameStateManager(dynamicGameState);
      minutesSinceInput = dgsm.getMinutesSinceLastInput();
    } else if (persistentGameState) {
      const gsm = new GameStateManager(persistentGameState);
      minutesSinceInput = gsm.getMinutesSinceLastInput();
    } else {
      return false;
    }

    // Only check time threshold (3 minutes), not turn count
    if (minutesSinceInput < 3) {
      // Time threshold not met, no need to trigger
      return false;
    }

    console.log(`⏰ [WebSocket] Time threshold reached (${minutesSinceInput} min idle) for session ${sessionId}`);

    // Prepare graph state
    let graphState: any;
    if (useDynamic && dynamicGameState) {
      // For DynamicWorld modules, use only DynamicGameState
      graphState = {
        messages: [],
        dynamicGameState: dynamicGameState,
        isSimulatedQuery: false,
        simulatedQueryCount: 0,
      };
    } else if (persistentGameState) {
      // For regular modules, enrich game state with conversation history
      const enrichedGameState = await enrichMemoryContext(
        persistentGameState,
        null, // No action analysis for progression check
        ragManager || undefined,
        db,
        undefined // No character input for progression check
      );
      graphState = {
        messages: [],
        gameState: enrichedGameState,
        isSimulatedQuery: false,
        simulatedQueryCount: 0,
      };
    } else {
      return false;
    }

    // Invoke listener graph - entry node will enrich again when simulate is triggered
    const result = await listenerGraph.invoke(graphState);

    // Check if simulate was triggered and processed
    if (result.turnId && result.messages.length > 0) {
      const keeperMessage = result.messages[result.messages.length - 1];
      const keeperNarrative = keeperMessage ? keeperMessage.content.toString() : null;

      console.log(`🔔 [WebSocket] Simulate processed for session ${sessionId}`);

      // Update persistent state
      if (useDynamic && result.dynamicGameState) {
        // For DynamicWorld, only store DynamicGameState
        const { DynamicGameStateManager } = await import("../../../src/dynamicworldagent/state/index.js");
        const dgsm = new DynamicGameStateManager(result.dynamicGameState);
        
        // Reset the idle timer
        dgsm.updatePlayerInputTime();
        serverState.setGameStateBySession(sessionId, null as any, dgsm.getState());
      } else if (result.gameState) {
        // For regular modules, update GameState only
        serverState.setGameStateBySession(sessionId, result.gameState, null);
        
        // Reset the idle timer
        const gsmReset = new GameStateManager(result.gameState);
        gsmReset.updatePlayerInputTime();
        serverState.setGameStateBySession(sessionId, gsmReset.getGameState(), null);
      }
      console.log(`⏰ [WebSocket] Idle timer reset for session ${sessionId}`);

      // Get the completed turn to send to client
      const completedTurn = turnManager.getTurn(result.turnId);

      // Notify WebSocket clients
      notifyClients(sessionId, clients, {
        type: 'simulate_triggered',
        turnId: result.turnId,
        simulatedQuery: result.messages[0]?.content.toString() || null,
        keeperNarrative: completedTurn?.keeperNarrative || keeperNarrative,
        timestamp: new Date().toISOString(),
        gameDay: completedTurn?.gameDay ?? result.gameState?.gameDay ?? null,
        gameTime: completedTurn?.gameTime ?? result.gameState?.timeOfDay ?? null,
      });

      return true;
    } else {
      // Listener executed but didn't trigger simulate (no event to advance story)
      // Still reset the timer to avoid immediate re-checking
      const gsmReset = new GameStateManager(result.gameState);
      gsmReset.updatePlayerInputTime();
      serverState.setGameStateBySession(sessionId, gsmReset.getGameState(), result.dynamicGameState || null);
      console.log(`⏰ [WebSocket] Idle timer reset for session ${sessionId} (no simulate triggered)`);
    }

    return false;
  } catch (error) {
    console.error(`[WebSocket] Error checking progression for session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Start periodic progression checker
 * Checks all active sessions at regular intervals
 * @param clients - Map of all WebSocket clients
 */
export function startProgressionChecker(clients: Map<string, WSClient>): void {
  if (progressionCheckInterval) {
    clearInterval(progressionCheckInterval);
  }

  progressionCheckInterval = setInterval(() => {
    // Check all active sessions
    for (const [sessionId, client] of clients.entries()) {
      if (client.ws.readyState === WebSocket.OPEN) {
        checkAndTriggerSimulate(sessionId, clients).catch(error => {
          console.error(`[WebSocket] Error in progression check for ${sessionId}:`, error);
        });
      }
    }
  }, CHECK_INTERVAL_MS);

  console.log(`🔄 [WebSocket] Progression checker started (interval: ${CHECK_INTERVAL_MS}ms)`);
}

/**
 * Stop progression checker
 */
export function stopProgressionChecker(): void {
  if (progressionCheckInterval) {
    clearInterval(progressionCheckInterval);
    progressionCheckInterval = null;
    console.log(`🛑 [WebSocket] Progression checker stopped`);
  }
}
