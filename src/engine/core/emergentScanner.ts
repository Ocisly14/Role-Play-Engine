import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterAction, FeatureEvent, GameTime } from "./types.js";

/** Per-tick context handed to every scanner. Scanners keep their own per-scanner
 *  state (e.g., dedup caches, previous-signature sets) as instance fields. */
export interface ScannerContext {
  dgsm: DynamicGameStateManager;
  tickTime: GameTime;
  committedActionsThisTick: readonly CharacterAction[];
  lang: string;
}

/** Engine-internal passive observer. Runs in TickOrchestrator's Scan phase
 *  (phase 8) — after feature ticks, propagation, and scripted events, before
 *  Applier flush. Scanners must not mutate DGSM; they only produce events. */
export interface EmergentScanner {
  readonly id: string;
  scan(ctx: ScannerContext): FeatureEvent[];
}
