// src/player/playerPort.ts
//
// The narrow seams between the decision controller and whoever owns the
// player's state (the runner). The controller never holds the player's state
// itself: it reads it, writes the next version back, and asks for a pause —
// the pause is recorded as data (`pending`) so it survives a save, never as a
// suspended promise.

import type { RoleSimContext, RoleSimDecision } from "../roleSim/agent.js";
import type { PlayerPending, PlayerState, QueueStep } from "./playerState.js";

export interface PlayerPort {
  /** The player's character id, or null when this session has no player. */
  playerId(): string | null;
  get(): PlayerState;
  set(next: PlayerState): void;
  /** Record what the player must answer and ask the runner to pause after
   *  this tick. */
  requestPause(pending: PlayerPending): void;
}

/** Turns one of the manual player's queued steps into a decision, at the
 *  moment the step comes up — the tags and the route depend on what the
 *  character can perceive then. On a retry the context carries
 *  `rejectionFeedback`. The design of the translation itself is deferred;
 *  without one, a step that comes up pauses for the player instead. */
export interface PlayerStepTranslator {
  translateStep(ctx: RoleSimContext, step: QueueStep): Promise<RoleSimDecision>;
}
