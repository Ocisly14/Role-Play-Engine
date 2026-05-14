import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { CharacterAction } from "../engine/core/types.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import { timePart } from "../state/gameClock.js";
import type { SimulationEvent, SimulationEventType } from "./types.js";

/**
 * Adapts engine-core `CharacterAction` events into UI-facing
 * `SimulationEvent`s. After Phase E the engine-core action shape is
 * intentionally minimal (no `characterName`, `outcome` string, `successLevel`,
 * `discoveries`); this emitter derives the UI-facing fields from DGSM and
 * the engine `outcome` (`StateResolution`) at emit time.
 */
export class SimulationEventEmitter extends EventEmitter {
  private sessionId: string;
  private tick = 0;
  private dgsm?: DynamicGameStateManager;

  constructor(sessionId: string, dgsm?: DynamicGameStateManager) {
    super();
    this.sessionId = sessionId;
    this.dgsm = dgsm;
  }

  /** Late-bind the DGSM (SimulationRunner constructs the emitter before it
   *  has the engine wired up). Required before `actionsToEvents`. */
  setDgsm(dgsm: DynamicGameStateManager): void {
    this.dgsm = dgsm;
  }

  setTick(tick: number): void {
    this.tick = tick;
  }

  emitSimulationEvent(
    type: SimulationEventType,
    actorNpcId: string,
    location: string,
    gameDateTime: string,
    data: Record<string, unknown>,
    targetNpcId?: string
  ): SimulationEvent {
    const event: SimulationEvent = {
      id: randomUUID(),
      sessionId: this.sessionId,
      tick: this.tick,
      gameDateTime,
      type,
      actorNpcId,
      targetNpcId,
      location,
      data,
      timestamp: new Date(),
    };
    this.emit("simulation_event", event);
    return event;
  }

  /**
   * Convert a batch of engine-core `CharacterAction`s into UI events. Status is
   * an explicit param because the engine signals completion vs interruption vs
   * cancellation through separate event channels; the action shape itself
   * doesn't carry it.
   */
  actionsToEvents(
    actions: CharacterAction[],
    status: "completed" | "failed" | "interrupted"
  ): SimulationEvent[] {
    const events: SimulationEvent[] = [];
    const eventType: SimulationEventType =
      status === "completed"
        ? "action_executed"
        : status === "failed"
          ? "action_failed"
          : "action_interrupted";

    for (const action of actions) {
      const characterName =
        this.dgsm?.getNpcProfile(action.characterId)?.name ??
        action.characterId;
      const outcomeRecord = action.outcome as
        | Record<string, unknown>
        | undefined;
      const outcomeText =
        typeof outcomeRecord?.narrative === "string"
          ? outcomeRecord.narrative
          : "";

      events.push(
        this.emitSimulationEvent(
          eventType,
          action.characterId,
          action.sceneId,
          action.completedAt,
          {
            action: action.actionText,
            characterName,
            outcome: outcomeText,
            gameTime: timePart(action.completedAt),
          },
          action.referencedEntities.find((r) => r.kind === "character")?.id
        )
      );
    }
    return events;
  }
}
