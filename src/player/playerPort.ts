// src/player/playerPort.ts
//
// The narrow seams between the decision controller and whoever owns the
// player's state (the runner). The controller never holds the player's state
// itself: it reads it, writes the next version back, and asks for a pause —
// the pause is recorded as data (`pending`) so it survives a save, never as a
// suspended promise.

import type { PlayerPending, PlayerState } from "./playerState.js";

export interface PlayerPort {
  /** The player's character id, or null when this session has no player. */
  playerId(): string | null;
  get(): PlayerState;
  set(next: PlayerState): void;
  /** Record what the player must answer and ask the runner to pause after
   *  this tick. */
  requestPause(pending: PlayerPending): void;
}
