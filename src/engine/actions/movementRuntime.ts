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

/** Driving moves the vehicle; walking moves the walker. */
function positionChange(
  actorId: string,
  state: MovementRuntimeState,
  position: CharacterPosition
): StateChange {
  if (state.vehicleId !== undefined) {
    return {
      kind: "vehicle.position",
      vehicleId: state.vehicleId,
      position,
      sourceSubsystem: SOURCE,
    };
  }
  return {
    kind: "character.position",
    characterId: actorId,
    position,
    sourceSubsystem: SOURCE,
  };
}

/** JSON-safe route state persisted at `action.runtime.movement`. */
export interface MovementRuntimeState {
  /** Driving: the vehicle this movement advances. The actor sits in its
   *  interior scene and never changes position; only the vehicle moves. */
  vehicleId?: string;
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
  | {
      ok: false;
      reason: string;
      /**
       * Set when the route broke because two named places are not one stretch
       * apart. Carried as ids rather than as prose because the actor's own
       * account of it is written upstream, where the words a character reads
       * are chosen — this half only says WHICH two places failed to join.
       *
       * The distinction earned itself: a character whose remembered route
       * merged two real lanes into one ("north gate, then Holt Lane, then ten
       * minutes to the trailhead" — Holt Lane goes to the Holt gate) was told
       * only that his action "did not go on", read it as a dizzy spell, and
       * re-stated the SAME wrong route twice more with more conviction. Three
       * ticks and ~200k tokens on a mistake he could have corrected in one.
       */
      unstatedHop?: { fromId: string; toId: string };
    };

/** A place's name for a message a person will read, with the id kept for the
 *  log line beside it. Roads and scenes both answer. */
function placeLabel(dgsm: DynamicGameStateManager, id: string): string {
  const name =
    dgsm.getScene(id)?.name ?? dgsm.getTopology().roads.get(id)?.name;
  return name ? `${name} (${id})` : id;
}

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
/** Rescale a planned leg for driving: along-road steps ride the road's
 *  driveTimeMinutes; a road with none takes no vehicles and fails the leg. */
function toDrivenSteps(
  dgsm: DynamicGameStateManager,
  steps: MovementStep[]
): { ok: true; steps: MovementStep[] } | { ok: false; reason: string } {
  const topology = dgsm.getTopology();
  const out: MovementStep[] = [];
  for (const step of steps) {
    if (step.kind !== "along_road" || !step.roadId) {
      out.push(step);
      continue;
    }
    const road = topology.roads.get(step.roadId);
    if (!road) return { ok: false, reason: `unknown road ${step.roadId}` };
    if (road.driveTimeMinutes === undefined) {
      return {
        ok: false,
        reason: `${road.name ?? step.roadId} takes no vehicles`,
      };
    }
    out.push({
      ...step,
      durationMinutes: Math.max(
        1,
        Math.round(
          step.durationMinutes *
            (road.driveTimeMinutes / road.travelTimeMinutes)
        )
      ),
    });
  }
  return { ok: true, steps: out };
}

/** Plan one leg, from the moving subject's position (the vehicle's when
 *  driving), rescaled for driving when a vehicle is involved. */
function planLeg(
  dgsm: DynamicGameStateManager,
  actorId: string,
  waypoint: string,
  vehicleId: string | undefined
): ReturnType<typeof planMovementRoute> {
  const vehicle = vehicleId ? dgsm.getVehicle(vehicleId) : null;
  const planned = planMovementRoute(
    dgsm,
    actorId,
    waypoint,
    vehicle ? vehicle.position : undefined
  );
  if (!planned.ok || !vehicle) return planned;
  const driven = toDrivenSteps(dgsm, planned.steps);
  if (!driven.ok) return { ok: false, reason: driven.reason };
  return { ...planned, steps: driven.steps };
}

export function initMovementRuntime(
  dgsm: DynamicGameStateManager,
  actorId: string,
  routeInput: string[],
  vehicleId?: string
): MovementInitResult {
  let route = routeInput;
  if (route.length === 0) {
    return { ok: false, reason: "movement init failed: empty route" };
  }
  // A route often starts with the place the subject already stands in
  // ("from the gate, up the lane…") — that is prose, not a leg. Drop it,
  // unless it is the whole route.
  const subject = vehicleId !== undefined ? dgsm.getVehicle(vehicleId) : null;
  const startPos =
    subject?.position ?? dgsm.getCharacterPosition(actorId) ?? undefined;
  const startId =
    startPos === undefined
      ? undefined
      : startPos.type === "scene"
        ? startPos.sceneId
        : startPos.roadId;
  if (route.length > 1 && startId !== undefined && route[0] === startId) {
    route = route.slice(1);
  }
  // The FIRST leg obeys the same grain as every other: one stated stretch
  // from where the subject stands. Without this, a bare far destination
  // would fall through to unconstrained pathfinding — the omniscient router
  // the stated-route model exists to retire. (Same-place "routes" and
  // unknown starts fall through to the planner, which answers for them.)
  if (
    startId !== undefined &&
    route[0] !== startId &&
    !placesAdjacent(dgsm, startId, route[0])
  ) {
    return {
      ok: false,
      reason: `movement init failed: route hop "${placeLabel(dgsm, startId)}" → "${placeLabel(dgsm, route[0])}" is not a single stretch — the way between them was never stated`,
      unstatedHop: { fromId: startId, toId: route[0] },
    };
  }
  if (vehicleId !== undefined && dgsm.getVehicle(vehicleId) === null) {
    return {
      ok: false,
      reason: `movement init failed: no vehicle "${vehicleId}"`,
    };
  }
  // NOTE: whether the driver is sitting inside is checked at each advance,
  // not here — init runs before this tick's deltas flush, so a same-tick
  // "board and drive" resolution has not put them in the cab yet.
  for (let i = 0; i + 1 < route.length; i += 1) {
    if (!placesAdjacent(dgsm, route[i], route[i + 1])) {
      return {
        ok: false,
        reason: `movement init failed: route hop "${placeLabel(dgsm, route[i])}" → "${placeLabel(dgsm, route[i + 1])}" is not a single stretch — the way between them was never stated`,
        unstatedHop: { fromId: route[i], toId: route[i + 1] },
      };
    }
  }
  const planned = planLeg(dgsm, actorId, route[0], vehicleId);
  if (!planned.ok) {
    return { ok: false, reason: `movement init failed: ${planned.reason}` };
  }
  // ETA is the first leg's plan plus the stated hops beyond it; adjacent
  // hops ride single roads, so their travel times sum directly.
  let estimate = planned.steps.reduce((sum, s) => sum + s.durationMinutes, 0);
  const topology = dgsm.getTopology();
  for (let i = 0; i + 1 < route.length; i += 1) {
    const viaRoad = (topology.sceneToRoads.get(route[i]) ?? []).find(
      (r) => r.endpointA === route[i + 1] || r.endpointB === route[i + 1]
    );
    if (viaRoad) {
      estimate +=
        vehicleId !== undefined && viaRoad.driveTimeMinutes !== undefined
          ? viaRoad.driveTimeMinutes
          : viaRoad.travelTimeMinutes;
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
      ...(vehicleId !== undefined ? { vehicleId } : {}),
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
    const planned = planLeg(dgsm, actorId, nextWaypoint, state.vehicleId);
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

  // Driving is stateless binding: the wheel is held by being in the cab,
  // this minute. Checked every advance — a driver yanked out mid-route
  // stops the vehicle where it stands.
  if (state.vehicleId !== undefined) {
    const vehicle = dgsm.getVehicle(state.vehicleId);
    const actorPos = dgsm.getCharacterPosition(actorId);
    if (
      !vehicle ||
      actorPos?.type !== "scene" ||
      actorPos.sceneId !== vehicle.interiorSceneId
    ) {
      return {
        stateChanges,
        status: "blocked",
        blockedReason: `blocked: the driver is not inside ${
          vehicle?.name ?? state.vehicleId
        }`,
      };
    }
  }

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
  stateChanges.push(positionChange(actorId, state, nextPosition));

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

    stateChanges.push(positionChange(actorId, state, entry.to));
    state.currentStepIndex += 1;
    state.minutesIntoStep = 0;
  }
}
