import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../../shared/agents/memory/database/index.js";
import type {
  HeartbeatActivatedNarrative,
  HeartbeatAction,
} from "../../state/index.js";
import { MultiplayerDynamicGameStateManager } from "../../multiplayerState/MultiplayerDynamicGameState.js";
import { toAbsoluteMinutes } from "../../utils/gameTime.js";

type HeartbeatDb = CoCDatabase | CoCDatabaseAdapter;

/**
 * Heartbeat Agent (Multiplayer Native)
 * - Checks scheduled heartbeat actions at turn start
 * - Marks actions as due/overdue
 * - Loads source turn narratives for keeper context injection
 */
export class HeartbeatAgent {
  private formatCurrentGameTime(manager: MultiplayerDynamicGameStateManager): string {
    const state = manager.getState();
    return `Day ${state.gameDay}, ${state.timeOfDay}`;
  }

  private async preloadSessionTurnsIfSupported(
    db: HeartbeatDb,
    sessionId: string
  ): Promise<void> {
    const candidate = db as {
      preloadSessionTurns?: (id: string) => Promise<void>;
    };
    if (!sessionId || typeof candidate.preloadSessionTurns !== "function") {
      return;
    }
    try {
      await candidate.preloadSessionTurns(sessionId);
    } catch (error) {
      console.warn(
        "[Heartbeat Agent] Failed to preload session turns, fallback to cache-only:",
        error
      );
    }
  }

  private resolveTurnById(
    db: HeartbeatDb,
    sessionId: string,
    turnId: string
  ): any | null {
    const dbLike = db as {
      getTurn?: (id: string) => any | null;
      getTurnHistory?: (sessionId: string, limit?: number) => any[];
    };
    if (typeof dbLike.getTurn === "function") {
      const direct = dbLike.getTurn(turnId);
      if (direct) return direct;
    }
    if (typeof dbLike.getTurnHistory === "function" && sessionId) {
      const history = dbLike.getTurnHistory(sessionId, 300);
      if (Array.isArray(history)) {
        return history.find((turn) => turn?.turnId === turnId) || null;
      }
    }
    return null;
  }

  async evaluateTurnStart(
    manager: MultiplayerDynamicGameStateManager,
    sceneRoomId: string,
    deps: { db: HeartbeatDb }
  ): Promise<{
    dueActions: HeartbeatAction[];
    activatedNarratives: HeartbeatActivatedNarrative[];
  }> {
    const state = manager.getState();
    const nowGameTime = this.formatCurrentGameTime(manager);
    const nowMinutes = toAbsoluteMinutes(nowGameTime);
    const originalActions = Array.isArray(state.heartbeatActions)
      ? state.heartbeatActions
      : [];
    const updatedActions: HeartbeatAction[] = originalActions.map((item) => ({
      ...item,
    }));
    const dueActions: HeartbeatAction[] = [];

    if (nowMinutes === null) {
      manager.setContextualData(sceneRoomId, "heartbeatDueActions", []);
      manager.setContextualData(sceneRoomId, "heartbeatActivatedNarratives", []);
      return { dueActions: [], activatedNarratives: [] };
    }

    for (const action of updatedActions) {
      if (!action) continue;
      if (action.status === "completed" || action.status === "cancelled") {
        continue;
      }

      const scheduledMinutes = toAbsoluteMinutes(action.scheduledGameTime);
      if (scheduledMinutes === null) continue;

      const deltaMinutes = scheduledMinutes - nowMinutes;
      let nextStatus: HeartbeatAction["status"] = action.status;
      if (deltaMinutes >= 0 && deltaMinutes <= 10) {
        nextStatus = "due";
      } else if (deltaMinutes < 0) {
        nextStatus = "overdue";
      }

      if (nextStatus !== action.status) {
        action.status = nextStatus;
        if (
          !action.triggeredAtGameTime &&
          (nextStatus === "due" || nextStatus === "overdue")
        ) {
          action.triggeredAtGameTime = nowGameTime;
        }
      }

      if (action.status === "due" || action.status === "overdue") {
        dueActions.push({ ...action });
      }
    }

    manager.setHeartbeatActions(updatedActions);

    const activatedNarratives: HeartbeatActivatedNarrative[] = [];
    const sourceTurnCache = new Map<string, any | null>();
    const sessionId = manager.getSessionId();
    await this.preloadSessionTurnsIfSupported(deps.db, sessionId);

    for (const action of dueActions) {
      const sourceTurnId = action.sourceTurnId?.trim();
      if (!sourceTurnId) continue;

      if (!sourceTurnCache.has(sourceTurnId)) {
        sourceTurnCache.set(
          sourceTurnId,
          this.resolveTurnById(deps.db, sessionId, sourceTurnId)
        );
      }

      const sourceTurn = sourceTurnCache.get(sourceTurnId);
      const sourceTurnNarrative =
        typeof sourceTurn?.keeperNarrative === "string"
          ? sourceTurn.keeperNarrative.trim()
          : "";
      if (!sourceTurnNarrative) continue;
      const activeStatus: "due" | "overdue" =
        action.status === "overdue" ? "overdue" : "due";

      activatedNarratives.push({
        heartbeatId: action.heartbeatId,
        sourceTurnId,
        sourceTurnNumber:
          typeof sourceTurn?.turnNumber === "number"
            ? sourceTurn.turnNumber
            : null,
        sourceTurnNarrative,
        scheduledGameTime: action.scheduledGameTime,
        status: activeStatus,
        npcId: action.npcId,
        npcName: action.npcName,
        task: action.task,
        location: action.location,
      });
    }

    manager.setContextualData(sceneRoomId, "heartbeatDueActions", dueActions);
    manager.setContextualData(
      sceneRoomId,
      "heartbeatActivatedNarratives",
      activatedNarratives
    );

    return {
      dueActions,
      activatedNarratives,
    };
  }
}
