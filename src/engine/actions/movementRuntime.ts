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
  /** The actor's stated waypoints (place ids, adjacent hops); the last one
   *  is the destination. Legs are planned lazily on arrival at each
   *  waypoint, so a mid-route block interrupts exactly where it stands. */
  route: string[];
  /** Index of the waypoint the CURRENT routeSnapshot walks toward. */
  currentLegIndex: number;
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

/** Are two places one stated hop apart? Adjacency is the grain of a spoken
 *  route: a door between scenes, a scene on a road (endpoint or access), or
 *  two node scenes joined by a road (the road ridden implicitly). */
function placesAdjacent(
  dgsm: DynamicGameStateManager,
  a: string,
  b: string
): boolean {
  const connected = (x: string, y: string): boolean =>
    (dgsm.getScene(x)?.connections ?? []).some((c) => c.targetId === y);
  if (connected(a, b) || connected(b, a)) return true;
  const topology = dgsm.getTopology();
  const roadTouches = (roadId: string, placeId: string): boolean => {
    const road = topology.roads.get(roadId);
    if (!road) return false;
    return (
      road.endpointA === placeId ||
      road.endpointB === placeId ||
      road.alongConnections.some((al) => al.sceneId === placeId)
    );
  };
  if (topology.roads.has(a) && roadTouches(a, b)) return true;
  if (topology.roads.has(b) && roadTouches(b, a)) return true;
  // Two node scenes joined by at least one road.
  for (const road of topology.sceneToRoads.get(a) ?? []) {
    if (road.endpointA === b || road.endpointB === b) return true;
  }
  return false;
}

/** Plan the FIRST leg and build the runtime state; later legs are planned on
 *  arrival at each waypoint. Called once when the Engine first resolves the
 *  action with a movement annotation. Adjacency of the whole stated route is
 *  checked up front so a bad route fails loudly at the start, with a reason
 *  the actor reads as feedback, not silently three legs in. */
export function initMovementRuntime(
  dgsm: DynamicGameStateManager,
  actorId: string,
  route: string[]
): MovementInitResult {
  if (route.length === 0) {
    return { ok: false, reason: "movement init failed: empty route" };
  }
  for (let i = 0; i + 1 < route.length; i += 1) {
    if (!placesAdjacent(dgsm, route[i], route[i + 1])) {
      return {
        ok: false,
        reason: `movement init failed: route hop "${route[i]}" → "${route[i + 1]}" is not a single stretch — the way between them was never stated`,
      };
    }
  }
  const planned = planMovementRoute(dgsm, actorId, route[0]);
  if (!planned.ok) {
    return { ok: false, reason: `movement init failed: ${planned.reason}` };
  }
  // ETA is the first leg's plan plus the stated hops beyond it; adjacent
  // hops ride single roads, so their travel times sum directly.
  let estimate = planned.totalMinutes;
  const topology = dgsm.getTopology();
  for (let i = 0; i + 1 < route.length; i += 1) {
    const viaRoad = (topology.sceneToRoads.get(route[i]) ?? []).find(
      (r) => r.endpointA === route[i + 1] || r.endpointB === route[i + 1]
    );
    if (viaRoad) {
      estimate += viaRoad.travelTimeMinutes;
    } else if (
      topology.roads.has(route[i]) ||
      topology.roads.has(route[i + 1])
    ) {
      const road =
        topology.roads.get(route[i]) ?? topology.roads.get(route[i + 1]);
      estimate += Math.ceil((road?.travelTimeMinutes ?? 1) / 2);
    } else {
      estimate += 1; // door-to-door interior hop
    }
  }
  return {
    ok: true,
    state: {
      route: [...route],
      currentLegIndex: 0,
      destinationId: route[route.length - 1],
      targetPosition: planned.targetPosition,
      routeSnapshot: planned.steps,
      currentStepIndex: 0,
      minutesIntoStep: 0,
    },
    totalMinutes: estimate,
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
/** When the current leg's steps are exhausted, plan the next stated leg from
 *  where the walker now stands. Returns "arrived" past the last waypoint,
 *  a blocked-shaped reason when the next leg cannot be planned, undefined
 *  when a fresh leg (or remaining steps) are ready to walk. */
function rolloverLeg(
  dgsm: DynamicGameStateManager,
  actorId: string,
  state: MovementRuntimeState
): "arrived" | string | undefined {
  while (state.routeSnapshot[state.currentStepIndex] === undefined) {
    if (state.currentLegIndex + 1 >= state.route.length) return "arrived";
    state.currentLegIndex += 1;
    const nextWaypoint = state.route[state.currentLegIndex];
    const planned = planMovementRoute(dgsm, actorId, nextWaypoint);
    if (!planned.ok) {
      return `blocked: no way onward to ${nextWaypoint} (${planned.reason})`;
    }
    state.targetPosition = planned.targetPosition;
    state.routeSnapshot = planned.steps;
    state.currentStepIndex = 0;
    state.minutesIntoStep = 0;
  }
  return undefined;
}

export function advanceMovement(
  dgsm: DynamicGameStateManager,
  actorId: string,
  state: MovementRuntimeState
): MovementAdvanceResult {
  const stateChanges: StateChange[] = [];

  let blocked = drainImmediate(dgsm, actorId, state, stateChanges);
  if (blocked)
    return { stateChanges, status: "blocked", blockedReason: blocked };

  const rolled = rolloverLeg(dgsm, actorId, state);
  if (rolled === "arrived") return { stateChanges, status: "arrived" };
  if (rolled !== undefined) {
    return { stateChanges, status: "blocked", blockedReason: rolled };
  }
  const stepEntry = state.routeSnapshot[state.currentStepIndex];
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
    const rolledAfter = rolloverLeg(dgsm, actorId, state);
    if (rolledAfter === "arrived") return { stateChanges, status: "arrived" };
    if (rolledAfter !== undefined) {
      return { stateChanges, status: "blocked", blockedReason: rolledAfter };
    }
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
