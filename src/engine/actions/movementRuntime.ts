// src/engine/actions/movementRuntime.ts
//
// Deterministic per-tick movement execution for EngineActions (plan Phase 8).
// When the World Action Engine resolves an action with a movement leg, it
// annotates the action with a destination; this module plans the route once
// (via the same planMovementRoute the pathfinding tool uses) and stores the
// route as JSON-safe state on `action.runtime.movement`, then advances it one
// minute per tick, emitting character.position StateChanges. Snapshot
// rehydration resumes mid-route — same route, same progress, no restart.
//
// No model calls ever happen here. Arrival coincides with the Engine-set
// nextWakeAt; a blocked connection raises an interruption signal that
// triggers the next resolution.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterPosition } from "../../state/topologyTypes.js";
import type { MovementStep, StateChange } from "../core/types.js";
import {
  interpolateMovementPosition,
  planMovementRoute,
} from "../subsystem/movement.js";
import type { EngineAction } from "./types.js";

const SOURCE = "movementRuntime";

/** JSON-safe route state persisted at `action.runtime.movement`. */
export interface MovementRuntimeState {
  destinationId: string;
  targetPosition: CharacterPosition;
  routeSnapshot: MovementStep[];
  currentStepIndex: number;
  minutesIntoStep: number;
}

export function getMovementRuntime(
  action: EngineAction
): MovementRuntimeState | undefined {
  const m = action.runtime?.movement;
  if (!m || typeof m !== "object") return undefined;
  return m as MovementRuntimeState;
}

export type MovementInitResult =
  | { ok: true; state: MovementRuntimeState; totalMinutes: number }
  | { ok: false; reason: string };

/** Plan the route and build the runtime state. Called once when the Engine
 *  first resolves the action with a movement annotation. */
export function initMovementRuntime(
  dgsm: DynamicGameStateManager,
  actorId: string,
  destinationId: string
): MovementInitResult {
  const planned = planMovementRoute(dgsm, actorId, destinationId);
  if (!planned.ok) {
    return { ok: false, reason: `movement init failed: ${planned.reason}` };
  }
  return {
    ok: true,
    state: {
      destinationId,
      targetPosition: planned.targetPosition,
      routeSnapshot: planned.steps,
      currentStepIndex: 0,
      minutesIntoStep: 0,
    },
    totalMinutes: planned.totalMinutes,
  };
}

export interface MovementAdvanceResult {
  stateChanges: StateChange[];
  status: "moving" | "arrived" | "blocked";
  blockedReason?: string;
}

/** Advance one in-flight movement by one minute. Mutates `state` in place
 *  (the caller persists it back onto action.runtime.movement). Mirrors the
 *  legacy subsystem's onTick semantics: immediate zero-duration transitions
 *  drain first, block checks run at each leg start, road positions
 *  interpolate per minute. */
export function advanceMovement(
  dgsm: DynamicGameStateManager,
  actorId: string,
  state: MovementRuntimeState
): MovementAdvanceResult {
  const stateChanges: StateChange[] = [];

  let blocked = drainImmediate(dgsm, actorId, state, stateChanges);
  if (blocked) return { stateChanges, status: "blocked", blockedReason: blocked };

  let stepEntry = state.routeSnapshot[state.currentStepIndex];
  if (!stepEntry) return { stateChanges, status: "arrived" };

  if (state.minutesIntoStep === 0 && stepEntry.blockCheck) {
    const reason = dgsm.getConnectionBlockReason(
      stepEntry.blockCheck.fromId,
      stepEntry.blockCheck.toId
    );
    if (reason) {
      return {
        stateChanges,
        status: "blocked",
        blockedReason: `blocked: ${reason}`,
      };
    }
  }

  const duration = Math.max(1, stepEntry.durationMinutes);
  state.minutesIntoStep += 1;
  const progress = Math.min(state.minutesIntoStep / duration, 1);
  const nextPosition = interpolateMovementPosition(
    stepEntry.from,
    stepEntry.to,
    progress
  );
  stateChanges.push({
    kind: "character.position",
    characterId: actorId,
    position: nextPosition,
    sourceSubsystem: SOURCE,
  });

  if (progress >= 1) {
    state.currentStepIndex += 1;
    state.minutesIntoStep = 0;
    blocked = drainImmediate(dgsm, actorId, state, stateChanges);
    if (blocked) {
      return { stateChanges, status: "blocked", blockedReason: blocked };
    }
    stepEntry = state.routeSnapshot[state.currentStepIndex];
    if (!stepEntry) return { stateChanges, status: "arrived" };
  }

  return { stateChanges, status: "moving" };
}

/** Drain zero-duration steps at the cursor, emitting a position change per
 *  drained step. Returns a reason string when a blocked connection halts. */
function drainImmediate(
  dgsm: DynamicGameStateManager,
  actorId: string,
  state: MovementRuntimeState,
  stateChanges: StateChange[]
): string | undefined {
  while (true) {
    const entry = state.routeSnapshot[state.currentStepIndex];
    if (!entry || entry.durationMinutes > 0) return undefined;

    if (entry.blockCheck) {
      const reason = dgsm.getConnectionBlockReason(
        entry.blockCheck.fromId,
        entry.blockCheck.toId
      );
      if (reason) return `blocked: ${reason}`;
    }

    stateChanges.push({
      kind: "character.position",
      characterId: actorId,
      position: entry.to,
      sourceSubsystem: SOURCE,
    });
    state.currentStepIndex += 1;
    state.minutesIntoStep = 0;
  }
}
