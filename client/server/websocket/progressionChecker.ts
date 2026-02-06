import type { WSClient } from "./WebSocketManager.js";
import { WebSocket } from "ws";
import { ServerState } from "../core/ServerState.js";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { notifyClients } from "./notifier.js";
import {
  runWithTokenContext,
  getCurrentUsageTotals,
} from "../../../src/models/index.js";

const CHECK_INTERVAL_MS = 60000; // Check every 60 seconds
const IDLE_MINUTES_BEFORE_SIMULATE = 5; // Trigger virtual query after this many minutes idle
let progressionCheckInterval: NodeJS.Timeout | null = null;

/**
 * Check if simulate should be triggered based on TIME threshold only (5 minutes idle)
 * Uses DynamicWorld stuck-hint narrative to process simulate queries
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
    const row = db
      .prepare(`
      SELECT c.email_id
      FROM game_turns gt
      JOIN characters c ON c.character_id = gt.character_id
      WHERE gt.session_id = ? AND c.email_id IS NOT NULL
      LIMIT 1
    `)
      .get(sessionId) as { email_id?: string } | undefined;
    return row?.email_id;
  };

  const email = resolveEmail();
  const runner = async () => {
    const serverState = ServerState.getInstance();
    const dbManager = DatabaseManager.getInstance();

    const dynamicGameState =
      serverState.getDynamicGameStateBySession(sessionId);
    const db = dbManager.isInitialized() ? dbManager.getDatabase() : null;

    if (!dynamicGameState || !db) {
      return false;
    }

    // Check session ID match
    const sessionIdMatch = dynamicGameState.sessionId === sessionId;
    if (!sessionIdMatch) {
      return false;
    }

    try {
      const { DynamicGameStateManager } = await import(
        "../../../src/dynamicworldagent/state/index.js"
      );
      const dgsm = new DynamicGameStateManager(dynamicGameState);
      const minutesSinceInput = dgsm.getMinutesSinceLastInput();

      // Only check time threshold (IDLE_MINUTES_BEFORE_SIMULATE), not turn count
      if (minutesSinceInput < IDLE_MINUTES_BEFORE_SIMULATE) {
        // Time threshold not met, no need to trigger
        return false;
      }

      console.log(
        `⏰ [WebSocket] Time threshold reached (${minutesSinceInput} min idle) for session ${sessionId}`
      );

      // DynamicWorld: use stuck-hint narrative instead of full listener pipeline (max 3 consecutive)
      const { DirectorAgent } = await import(
        "../../../src/dynamicworldagent/dynamicBasicAgent/director/directorAgent.js"
      );
      const { ScenarioLoader } = await import(
        "../../../src/shared/agents/memory/scenarioloader/index.js"
      );
      const { TurnManager: DynamicTurnManager } = await import(
        "../../../src/dynamicworldagent/dynamicBasicAgent/memory/turnManager.js"
      );

      const consecutive = dgsm.getState().consecutiveProgressionTriggers ?? 0;
      if (consecutive >= 3) {
        console.log(
          `⏰ [WebSocket] Stuck-hint skipped: max consecutive (3) reached for session ${sessionId}`
        );
        return false;
      }

      const scenarioLoader = new ScenarioLoader(db);
      const directorAgent = new DirectorAgent(scenarioLoader, db);
      const hintNarrative =
        await directorAgent.generateStuckHintNarrative(dgsm);

      if (!hintNarrative) {
        console.log(
          `⏰ [WebSocket] Stuck-hint generation returned no narrative for session ${sessionId}`
        );
        dgsm.touchIdleTimerOnly();
        serverState.setGameStateBySession(sessionId, dgsm.getState());
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
      serverState.setGameStateBySession(sessionId, dgsm.getState());
      console.log(`⏰ [WebSocket] Idle timer reset for session ${sessionId}`);
      console.log(
        `🔔 [WebSocket] Stuck-hint narrative sent for session ${sessionId}`
      );

      const completedTurn = dynamicTurnManager.getTurn(newTurnId);
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
    } catch (error) {
      console.error(
        `[WebSocket] Error checking progression for session ${sessionId}:`,
        error
      );
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
        checkAndTriggerSimulate(sessionId, clients).catch((error) => {
          console.error(
            `[WebSocket] Error in progression check for ${sessionId}:`,
            error
          );
        });
      }
    }
  }, CHECK_INTERVAL_MS);

  console.log(
    `🔄 [WebSocket] Progression checker started (interval: ${CHECK_INTERVAL_MS}ms)`
  );
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
