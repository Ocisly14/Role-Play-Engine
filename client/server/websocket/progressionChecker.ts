import type { WSClient } from "./WebSocketManager.js";
import { WebSocket } from "ws";
import { ServerState } from "../core/ServerState.js";
import { GraphManager } from "../core/GraphManager.js";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { GameStateManager } from "../../../src/coc_multiagents_system/state/gameState.js";
import { enrichMemoryContext } from "../../../src/coc_multiagents_system/agents/memory/memoryAgent.js";
import { notifyClients } from "./notifier.js";
import { runWithTokenContext, getCurrentUsageTotals } from "../../../src/models/index.js";

const CHECK_INTERVAL_MS = 60000; // Check every 60 seconds
const IDLE_MINUTES_BEFORE_SIMULATE = 5; // Trigger virtual query after this many minutes idle
let progressionCheckInterval: NodeJS.Timeout | null = null;

/**
 * Check if simulate should be triggered based on TIME threshold only (5 minutes idle)
 * Uses the listener graph to check progression and process simulate queries
 * @param sessionId - Session ID to check
 * @param clients - Map of all WebSocket clients
 * @returns true if simulate was triggered, false otherwise
 */
export async function checkAndTriggerSimulate(
  sessionId: string,
  clients: Map<string, WSClient>
): Promise<boolean> {
  const resolveEmail = (): string | undefined => {
    const db = DatabaseManager.getInstance().getDatabase().getDatabase();
    const row = db.prepare(`
      SELECT c.email_id
      FROM game_turns gt
      JOIN characters c ON c.character_id = gt.character_id
      WHERE gt.session_id = ? AND c.email_id IS NOT NULL
      LIMIT 1
    `).get(sessionId) as { email_id?: string } | undefined;
    return row?.email_id;
  };

  const email = resolveEmail();
  const runner = async () => {
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

    if ((!persistentGameState && !dynamicGameState) || !turnManager || !db) {
      return false;
    }
    if (persistentGameState && !listenerGraph) {
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

      // Only check time threshold (IDLE_MINUTES_BEFORE_SIMULATE), not turn count
      if (minutesSinceInput < IDLE_MINUTES_BEFORE_SIMULATE) {
        // Time threshold not met, no need to trigger
        return false;
      }

      console.log(`⏰ [WebSocket] Time threshold reached (${minutesSinceInput} min idle) for session ${sessionId}`);

      // DynamicWorld: use stuck-hint narrative instead of full listener pipeline (max 3 consecutive)
      if (useDynamic && dynamicGameState) {
        const { DynamicGameStateManager } = await import("../../../src/dynamicworldagent/state/index.js");
        const { DirectorAgent } = await import("../../../src/dynamicworldagent/dynamicBasicAgent/director/directorAgent.js");
        const { ScenarioLoader } = await import("../../../src/coc_multiagents_system/agents/memory/scenarioloader/index.js");
        const { TurnManager: DynamicTurnManager } = await import("../../../src/dynamicworldagent/dynamicBasicAgent/memory/turnManager.js");

        const dgsm = new DynamicGameStateManager(dynamicGameState);
        const consecutive = dgsm.getState().consecutiveProgressionTriggers ?? 0;
        if (consecutive >= 3) {
          console.log(`⏰ [WebSocket] Stuck-hint skipped: max consecutive (3) reached for session ${sessionId}`);
          return false;
        }

        const scenarioLoader = new ScenarioLoader(db);
        const directorAgent = new DirectorAgent(scenarioLoader, db);
        const hintNarrative = await directorAgent.generateStuckHintNarrative(dgsm);

        if (!hintNarrative) {
          console.log(`⏰ [WebSocket] Stuck-hint generation returned no narrative for session ${sessionId}`);
          dgsm.touchIdleTimerOnly();
          serverState.setGameStateBySession(sessionId, null as any, dgsm.getState());
          return false;
        }

        const dynamicTurnManager = new DynamicTurnManager(db);
        const systemInput = "[系统] 调查员似乎陷入了僵局，守秘人给出了提示。";
        const newTurnId = dynamicTurnManager.createTurnFromGameState(
          sessionId,
          systemInput,
          dynamicGameState,
          true
        );
        dynamicTurnManager.completeTurn(newTurnId, {
          keeperNarrative: hintNarrative,
          clueRevelations: [],
          gameDay: dynamicGameState.gameDay ?? null,
          gameTime: dynamicGameState.timeOfDay ?? null,
        });

        dgsm.incrementConsecutiveTriggers();
        dgsm.touchIdleTimerOnly();
        serverState.setGameStateBySession(sessionId, null as any, dgsm.getState());
        console.log(`⏰ [WebSocket] Idle timer reset for session ${sessionId}`);
        console.log(`🔔 [WebSocket] Stuck-hint narrative sent for session ${sessionId}`);

        const completedTurn = turnManager.getTurn(newTurnId);
        notifyClients(sessionId, clients, {
          type: "simulate_triggered",
          turnId: newTurnId,
          simulatedQuery: systemInput,
          keeperNarrative: completedTurn?.keeperNarrative ?? hintNarrative,
          timestamp: new Date().toISOString(),
          gameDay: completedTurn?.gameDay ?? dynamicGameState.gameDay ?? null,
          gameTime: completedTurn?.gameTime ?? dynamicGameState.timeOfDay ?? null,
        });

        const totals = getCurrentUsageTotals();
        if (totals && totals.total_tokens > 0) {
          console.log(
            `🧮 [Token Usage] Stuck-hint turn ${newTurnId} total: ${totals.total_tokens} (input ${totals.input_tokens}, output ${totals.output_tokens})`
          );
        }
        return true;
      }

      // CoC (non-Dynamic) modules: prepare graph state and invoke listener
      let graphState: any;
      if (persistentGameState) {
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

      // CoC listener result: check if simulate was triggered and processed
      if (result.turnId && result.messages.length > 0) {
        const keeperMessage = result.messages[result.messages.length - 1];
        const keeperNarrative = keeperMessage ? keeperMessage.content.toString() : null;
        console.log(`🔔 [WebSocket] Simulate processed for session ${sessionId}`);

        const gsmReset = new GameStateManager(result.gameState);
        gsmReset.updatePlayerInputTime();
        serverState.setGameStateBySession(sessionId, gsmReset.getGameState(), null);
        console.log(`⏰ [WebSocket] Idle timer reset for session ${sessionId}`);

        const completedTurn = turnManager.getTurn(result.turnId);
        notifyClients(sessionId, clients, {
          type: "simulate_triggered",
          turnId: result.turnId,
          simulatedQuery: result.messages[0]?.content.toString() || null,
          keeperNarrative: completedTurn?.keeperNarrative || keeperNarrative,
          timestamp: new Date().toISOString(),
          gameDay: completedTurn?.gameDay ?? result.gameState?.gameDay ?? null,
          gameTime: completedTurn?.gameTime ?? result.gameState?.timeOfDay ?? null,
        });

        const totals = getCurrentUsageTotals();
        if (totals && totals.total_tokens > 0) {
          console.log(
            `🧮 [Token Usage] Turn ${result.turnId} total: ${totals.total_tokens} (input ${totals.input_tokens}, output ${totals.output_tokens})`
          );
        }
        return true;
      }

      const gsmReset = new GameStateManager(result.gameState);
      gsmReset.updatePlayerInputTime();
      serverState.setGameStateBySession(sessionId, gsmReset.getGameState(), null);
      console.log(`⏰ [WebSocket] Idle timer reset for session ${sessionId} (no simulate triggered)`);
      return false;
    } catch (error) {
      console.error(`[WebSocket] Error checking progression for session ${sessionId}:`, error);
      return false;
    }
  };

  if (email) {
    return runWithTokenContext(
      {
        email,
        usageTotals: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      },
      () => runner()
    );
  }
  return runner();
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
