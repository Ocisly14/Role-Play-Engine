import type { FeatureReadContext } from "./featureReadContext.js";
import type { CharacterAction, StateChange } from "./types.js";
import type { ScriptedEvent } from "../scriptedEvents/types.js";

export interface RunInput {
  baseCtx: FeatureReadContext;
  committedActionsThisTick: CharacterAction[];
  accumulatedStateChanges: StateChange[];
}

/**
 * STUB — full implementation deferred until after Phase B.
 * Currently returns no state changes regardless of input. B5/B6 import this
 * class for wiring; the real logic (condition evaluation, effect expansion,
 * progress tracking, cascade cap, onFail) will be ported from
 * src/engine/features/eventTriggerFeature.ts later.
 */
export class ScriptedEventRunner {
  constructor(_events: ScriptedEvent[]) {
    // Intentionally empty; stub ignores events.
  }

  run(_input: RunInput): StateChange[] {
    return [];
  }
}
