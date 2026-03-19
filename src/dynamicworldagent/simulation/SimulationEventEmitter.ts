import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { CharacterAction } from "../dynamicBasicAgent/npcPlanning/types.js";
import type { SimulationEvent, SimulationEventType } from "./types.js";

export class SimulationEventEmitter extends EventEmitter {
  private sessionId: string;
  private tick = 0;

  constructor(sessionId: string) {
    super();
    this.sessionId = sessionId;
  }

  setTick(tick: number): void {
    this.tick = tick;
  }

  emitSimulationEvent(
    type: SimulationEventType,
    actorNpcId: string,
    location: string,
    gameDay: number,
    gameTime: string,
    data: Record<string, unknown>,
    targetNpcId?: string
  ): SimulationEvent {
    const event: SimulationEvent = {
      id: randomUUID(),
      sessionId: this.sessionId,
      tick: this.tick,
      gameDay,
      gameTime,
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

  actionsToEvents(
    actions: CharacterAction[],
    gameDay: number
  ): SimulationEvent[] {
    const events: SimulationEvent[] = [];
    for (const action of actions) {
      const type: SimulationEventType =
        action.status === "completed" ? "action_executed" : "action_failed";

      events.push(
        this.emitSimulationEvent(
          type,
          action.characterId,
          action.location,
          gameDay,
          action.gameTime,
          {
            action: action.action,
            characterName: action.characterName,
            skill: action.skill,
            outcome: action.outcome,
            successLevel: action.successLevel,
            discoveries: action.discoveries,
          },
          action.targetCharacterIds?.[0]
        )
      );
    }
    return events;
  }
}
