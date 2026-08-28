// src/engine/subsystem/fire.ts
//
// Phase I port of fireFeature → AnchorSubsystem (anchorKind="scene").
// All constants, types, and helpers are copied/adapted from
// src/engine/features/fireFeature.ts — no core logic changes except:
//   1. `propagationCountdown` added to FireSceneState (replaces onPropagate hook).
//   2. `shouldExist` reads scene conditions via ctx.getSceneConditions
//      (fromFeature "fire") — invariant per spec D6.
//   3. `onTick` operates on ONE scene (not iterating all) and inlines the
//      propagation countdown logic from the old onPropagate hook.
//   4. `initialState` seeds the DGSM bucket with default values.
// Task 11 will delete fireFeature.ts; until then both files coexist.

import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { SceneCondition, StateChange } from "../core/types.js";
import type { AnchorSubsystem } from "./types.js";

// ===== Internal types =====

export interface FireSceneState {
  intensity: number;
  maxIntensity: number; // fixed 5
  growthRate: number; // default 1 (applied every 10 minutes)
  decayRate: number; // default 1 (applied every 10 minutes)
  spreadThreshold: number; // fixed 3 = ceil(5/2)
  phase: "growing" | "decaying";
  minutesInPhase: number;
  totalBurnMinutes: number;
  /** Ticks remaining before next spread attempt. Reset to PROPAGATION_INTERVAL after each attempt. */
  propagationCountdown: number;
}

export interface FireRoadState extends FireSceneState {
  /** Burning segment on road: 0.0–1.0 */
  burnRange: { start: number; end: number };
}

function isFireRoadState(state: FireSceneState): state is FireRoadState {
  return "burnRange" in state;
}

// ===== Constants =====

const FEATURE_ID = "fire";
const DEFAULT_MAX_INTENSITY = 5;
const DEFAULT_SPREAD_THRESHOLD = 3; // ceil(5/2)
const DEFAULT_GROWTH_RATE = 1;
const DEFAULT_DECAY_RATE = 1;
const INTENSITY_CHANGE_INTERVAL_MINUTES = 10;
const BLOCK_THRESHOLD = 3;
const ROAD_SPREAD_TRAVEL_MINUTES_PER_MINUTE = 0.4; // reserved (road expansion is D7)
const MINOR_AFTERMATH_THRESHOLD_MINUTES = 20;
const PARTIAL_AFTERMATH_THRESHOLD_MINUTES = 50;
const SEVERE_AFTERMATH_THRESHOLD_MINUTES = 100;
const PROPAGATION_INTERVAL = 10; // ticks between spread attempts

// Stable vote id for Applier's connection.setBlock refcount table — every
// block emitted by fire must share this reason so a later "blocked: false"
// withdrawal matches the earlier "blocked: true" vote.
const FIRE_BLOCK_REASON = "fire-block";

// Cold-rain decay acceleration — when env.temperature drops below this, the
// fire's "minutes-in-decaying-phase" counter ticks at double speed.
const COLD_RAIN_TEMPERATURE_THRESHOLD_C = 5;

const INTENSITY_LABELS = [
  "",
  "Light smoke",
  "Thickening smoke",
  "Heavy smoke and flames",
  "Intense fire",
  "Raging inferno",
];

// ===== Pure helpers =====

function createFireState(initialIntensity: number): FireSceneState {
  const clamped = Math.max(
    1,
    Math.min(initialIntensity, DEFAULT_MAX_INTENSITY)
  );
  return {
    intensity: clamped,
    maxIntensity: DEFAULT_MAX_INTENSITY,
    growthRate: DEFAULT_GROWTH_RATE,
    decayRate: DEFAULT_DECAY_RATE,
    spreadThreshold: DEFAULT_SPREAD_THRESHOLD,
    phase: "growing",
    minutesInPhase: 0,
    totalBurnMinutes: 0,
    propagationCountdown: PROPAGATION_INTERVAL,
  };
}

function createRoadFireState(
  initialIntensity: number,
  position: number
): FireRoadState {
  const base = createFireState(initialIntensity);
  return {
    ...base,
    burnRange: { start: position, end: position },
  };
}

function intensityLabel(intensity: number): string {
  return (
    INTENSITY_LABELS[intensity] ?? INTENSITY_LABELS[INTENSITY_LABELS.length - 1]
  );
}

/**
 * Skill penalties at a given fire intensity:
 *   Perception: -10 * intensity (always)
 *   Listen:     -10 * (intensity - 1) (intensity >= 2)
 */
function getSkillPenalties(intensity: number): Record<string, number> {
  const out: Record<string, number> = {};
  out.Perception = -10 * intensity;
  if (intensity >= 2) {
    out.Listen = -10 * (intensity - 1);
  }
  return out;
}

function buildFireCondition(intensity: number): SceneCondition {
  return {
    featureId: FEATURE_ID,
    description: `[Fire] ${intensityLabel(intensity)}`,
    mechanicalEffect: { skillPenalty: getSkillPenalties(intensity) },
  };
}

function buildAftermathCondition(totalBurnMinutes: number): SceneCondition {
  let description: string;
  let skillPenalty: Record<string, number> | undefined;

  if (totalBurnMinutes <= MINOR_AFTERMATH_THRESHOLD_MINUTES) {
    description = "[Fire Aftermath] Minor smoke stains on walls and ceiling";
  } else if (totalBurnMinutes <= PARTIAL_AFTERMATH_THRESHOLD_MINUTES) {
    description =
      "[Fire Aftermath] Partial burn damage — some items destroyed, soot covers surfaces";
    skillPenalty = { Perception: -5 };
  } else if (totalBurnMinutes <= SEVERE_AFTERMATH_THRESHOLD_MINUTES) {
    description =
      "[Fire Aftermath] Severe burn damage — structural integrity compromised, many items destroyed";
    skillPenalty = { Perception: -10 };
  } else {
    description =
      "[Fire Aftermath] Scene nearly destroyed by fire — most items and clues unavailable, structure unsafe";
    skillPenalty = { Perception: -20 };
  }

  return {
    featureId: FEATURE_ID,
    description,
    mechanicalEffect: skillPenalty ? { skillPenalty } : undefined,
  };
}

/**
 * Stable, order-independent connection vote id for a scene/topology pair.
 */
function fireConnectionIdFor(a: string, b: string): string {
  return a <= b ? `fire:${a}|${b}` : `fire:${b}|${a}`;
}

/**
 * Enumerate the location IDs that fire at `locationId` should consider for
 * connection.setBlock votes.
 */
function getBlockableNeighbors(
  locationId: string,
  ctx: FeatureReadContext
): string[] {
  const neighbors: string[] = [];
  const scene = ctx.getScene(locationId);
  if (scene) {
    for (const conn of scene.connections ?? []) {
      neighbors.push(conn.targetId);
    }
    return neighbors;
  }

  const topology = ctx.getTopology();
  if (!topology) return neighbors;

  const junction = topology.junctions.get(locationId);
  if (junction) {
    const roads = topology.junctionToRoads.get(locationId) ?? [];
    for (const road of roads) neighbors.push(road.id);
    for (const sceneId of junction.connectedSceneIds) neighbors.push(sceneId);
    return neighbors;
  }

  const road = topology.roads.get(locationId);
  if (road) {
    neighbors.push(road.endpointA, road.endpointB);
    for (const along of road.alongConnections) neighbors.push(along.sceneId);
    return neighbors;
  }

  return neighbors;
}

/** Helper: emit `removeCondition + addCondition(intensity)` for a fire scene. */
function emitFireConditionRefresh(
  sceneId: string,
  intensity: number
): StateChange[] {
  return [
    {
      kind: "scene.removeCondition",
      sceneId,
      predicate: { featureId: FEATURE_ID },
    },
    {
      kind: "scene.addCondition",
      sceneId,
      condition: buildFireCondition(intensity),
    },
  ];
}

/** Helper: tear down fire at `locationId` — remove state, swap conditions for aftermath. */
function emitFireExtinguish(
  locationId: string,
  totalBurnMinutes: number
): StateChange[] {
  return [
    { kind: "feature.removeState", featureId: FEATURE_ID, key: locationId },
    {
      kind: "scene.removeCondition",
      sceneId: locationId,
      predicate: { featureId: FEATURE_ID },
    },
    {
      kind: "scene.addCondition",
      sceneId: locationId,
      condition: buildAftermathCondition(totalBurnMinutes),
    },
  ];
}

/**
 * Enumerate adjacent scene/road/junction IDs to attempt ignition spread,
 * mirroring the old onPropagate logic (scene-connections fallback + topology).
 */
function getAdjacentIgnitionTargets(
  locationId: string,
  ctx: FeatureReadContext
): Array<{ targetId: string; newState: FireSceneState | FireRoadState }> {
  const targets: Array<{
    targetId: string;
    newState: FireSceneState | FireRoadState;
  }> = [];

  const topology = ctx.getTopology();
  if (topology) {
    const road = topology.roads.get(locationId);
    const junction = topology.junctions.get(locationId);

    if (road) {
      // Road fire → spread to endpoint junctions when burnRange reaches end.
      // (For scene fires on a road, fall through to generic road-fire handling.)
      const state = ctx.getFeatureState<FireSceneState>(locationId);
      if (state && isFireRoadState(state)) {
        if (state.burnRange.start <= 0.05) {
          targets.push({
            targetId: road.endpointA,
            newState: createFireState(1),
          });
        }
        if (state.burnRange.end >= 0.95) {
          targets.push({
            targetId: road.endpointB,
            newState: createFireState(1),
          });
        }
        return targets;
      }
    }

    if (junction) {
      const connectedRoads = topology.junctionToRoads.get(locationId) ?? [];
      for (const r of connectedRoads) {
        const startPos = r.endpointA === locationId ? 0.0 : 1.0;
        targets.push({
          targetId: r.id,
          newState: createRoadFireState(1, startPos),
        });
      }
      for (const sceneId of junction.connectedSceneIds) {
        targets.push({ targetId: sceneId, newState: createFireState(1) });
      }
      return targets;
    }

    const parent = topology.sceneToParent.get(locationId);
    if (parent) {
      if (parent.type === "road") {
        targets.push({
          targetId: parent.roadId,
          newState: createRoadFireState(1, parent.position),
        });
      } else {
        targets.push({
          targetId: parent.junctionId,
          newState: createFireState(1),
        });
      }
      return targets;
    }
    // Topology exists but source isn't indexed — fall through to scene-graph.
  }

  // Fallback: scene.connections only (legacy / pure-scene worlds).
  const scene = ctx.getScene(locationId);
  if (scene) {
    for (const conn of scene.connections ?? []) {
      targets.push({ targetId: conn.targetId, newState: createFireState(1) });
    }
  }

  return targets;
}

// ===== Exported subsystem =====

export const fireSubsystem: AnchorSubsystem = {
  id: FEATURE_ID,
  kind: "anchor",
  anchorKind: "scene",
  description:
    "Fire system — spreads between scenes, contributes temperature/illumination/smoke to env, applies skill penalties, blocks connections at high intensity",
  effectSummary:
    "Per-scene fire with growing/decaying lifecycle; contributes temperature & smoke to env, blocks connections at intensity >= 3.",
  affectedKinds: [
    "feature.setState",
    "feature.removeState",
    "scene.addCondition",
    "scene.removeCondition",
    "environment.contribute",
    "environment.hazard",
    "connection.setBlock",
  ],
  priority: 200,

  planningPrompt: `## Fire
- Starting a fire: add \`"fireIntensity"\` to the node. Choose initial intensity based on the action:
  - 1: Small fire (candle knocked over, match, small arson)
  - 2: Moderate fire (deliberate arson with accelerant, oil lamp explosion)
  - 3: Large fire (building-scale arson, explosive ignition)
- Putting out a fire: add \`"fireExtinguish": true\` to the node.
- Do NOT add fire fields to nodes that merely observe or react to fire.`,

  /**
   * shouldExist reads the scene's runtime conditions for a condition owned by
   * "fire" (featureId === "fire"). This is the invariant from spec D6: the
   * predicate reads external DGSM state (scene conditions), NOT the fire state
   * bucket, to avoid cyclic spawn-destroy oscillations.
   *
   * `ctx.getSceneConditions(sceneId)` delegates to `dgsm.getSceneConditions`,
   * which reads the place's own `conditions` — the same list the Applier
   * writes when it processes `scene.addCondition` StateChanges, so this
   * reflects conditions added at runtime by an ignite action.
   */
  shouldExist(sceneId: string, ctx: FeatureReadContext): boolean {
    return ctx
      .getSceneConditions(sceneId)
      .some((c) => c.featureId === FEATURE_ID);
  },

  /**
   * Seed initial fire state when the subsystem spawns (shouldExist: false→true).
   * Emits a single `feature.setState` with default values from `createFireState`.
   */
  initialState(sceneId: string, _ctx: FeatureReadContext): StateChange[] {
    const state = createFireState(1);
    return [
      {
        kind: "feature.setState",
        featureId: FEATURE_ID,
        key: sceneId,
        state,
      },
    ];
  },

  /**
   * Per-tick lifecycle update for ONE scene.
   * Ports the per-scene inner body of fireFeature.onTick + inlines the
   * propagation logic from fireFeature.onPropagate using the
   * `propagationCountdown` field.
   */
  onTick(sceneId: string, ctx: FeatureReadContext): StateChange[] {
    const state = ctx.getFeatureState<FireSceneState>(sceneId);
    if (!state) return [];

    const out: StateChange[] = [];
    const elapsedMinutes = Math.max(1, ctx.tickDurationMinutes);

    // Defensive copy so we never observe mid-tick mutations.
    const next: FireSceneState | FireRoadState = isFireRoadState(state)
      ? { ...state, burnRange: { ...state.burnRange } }
      : { ...state };

    next.totalBurnMinutes += elapsedMinutes;
    next.minutesInPhase += elapsedMinutes;

    // Cold-rain decay acceleration: while decaying and ambient temperature
    // is below the threshold, advance phase time at 2x.
    if (next.phase === "decaying") {
      const reading = ctx.getEnvironmentReading(sceneId);
      if (reading.temperature < COLD_RAIN_TEMPERATURE_THRESHOLD_C) {
        next.minutesInPhase += elapsedMinutes;
      }
    }

    let extinguishedThisTick = false;
    const intensityAtStart = state.intensity;
    let intensityChanged = false;

    while (next.minutesInPhase >= INTENSITY_CHANGE_INTERVAL_MINUTES) {
      next.minutesInPhase -= INTENSITY_CHANGE_INTERVAL_MINUTES;

      if (next.phase === "growing") {
        next.intensity += next.growthRate;
        if (next.intensity >= next.maxIntensity) {
          next.intensity = next.maxIntensity;
          next.phase = "decaying";
          next.minutesInPhase = 0;
        }
        intensityChanged = true;
      } else {
        // decaying
        next.intensity -= next.decayRate;
        if (next.intensity <= 0) {
          // Fire fully extinguished — emit teardown and stop processing.
          out.push(...emitFireExtinguish(sceneId, next.totalBurnMinutes));
          // Also withdraw any blocking votes we may have placed.
          const neighbors = getBlockableNeighbors(sceneId, ctx);
          for (const nId of neighbors) {
            out.push({
              kind: "connection.setBlock",
              connectionId: fireConnectionIdFor(sceneId, nId),
              blocked: false,
              sourceFeatureId: FEATURE_ID,
              reason: FIRE_BLOCK_REASON,
            });
          }
          extinguishedThisTick = true;
          break;
        }
        intensityChanged = true;
      }
    }

    if (extinguishedThisTick) return out;

    // ===== Propagation countdown =====
    next.propagationCountdown =
      (next.propagationCountdown ?? PROPAGATION_INTERVAL) - 1;

    if (
      next.propagationCountdown <= 0 &&
      next.intensity >= next.spreadThreshold
    ) {
      // Attempt to spread to adjacent scenes/roads/junctions.
      const adjacentTargets = getAdjacentIgnitionTargets(sceneId, ctx);
      for (const { targetId, newState } of adjacentTargets) {
        // Don't overwrite an already-burning location.
        if (ctx.getOtherFeatureState<FireSceneState>(FEATURE_ID, targetId))
          continue;
        out.push({
          kind: "feature.setState",
          featureId: FEATURE_ID,
          key: targetId,
          state: newState,
        });
        out.push({
          kind: "scene.addCondition",
          sceneId: targetId,
          condition: buildFireCondition(newState.intensity),
        });
      }
      next.propagationCountdown = PROPAGATION_INTERVAL;
    }

    // Persist updated lifecycle bookkeeping.
    out.push({
      kind: "feature.setState",
      featureId: FEATURE_ID,
      key: sceneId,
      state: next,
    });

    if (intensityChanged && next.intensity !== intensityAtStart) {
      out.push(...emitFireConditionRefresh(sceneId, next.intensity));
    }

    // Re-contribute env quantities every tick.
    out.push({
      kind: "environment.contribute",
      locationId: sceneId,
      quantity: "temperature",
      value: next.intensity * 100,
      sourceFeatureId: FEATURE_ID,
    });
    out.push({
      kind: "environment.contribute",
      locationId: sceneId,
      quantity: "illumination",
      value: Math.min(next.intensity + 1, 5),
      sourceFeatureId: FEATURE_ID,
    });
    out.push({
      kind: "environment.contribute",
      locationId: sceneId,
      quantity: "oxygen",
      value: -next.intensity * 0.1,
      sourceFeatureId: FEATURE_ID,
    });
    if (next.intensity >= 2) {
      out.push({
        kind: "environment.hazard",
        locationId: sceneId,
        add: ["smoke"],
        sourceFeatureId: FEATURE_ID,
      });
    }

    // Connection blocking: vote on every adjacent edge.
    const blocked = next.intensity >= BLOCK_THRESHOLD;
    const neighbors = getBlockableNeighbors(sceneId, ctx);
    for (const nId of neighbors) {
      out.push({
        kind: "connection.setBlock",
        connectionId: fireConnectionIdFor(sceneId, nId),
        blocked,
        sourceFeatureId: FEATURE_ID,
        reason: FIRE_BLOCK_REASON,
      });
    }

    return out;
  },

  stateDescription(ctx: FeatureReadContext): string {
    const states = ctx.getAllFeatureStates<FireSceneState>();
    if (states.length === 0) return "";
    const lines: string[] = [];
    for (const { key, state } of states) {
      lines.push(
        `- ${key}: intensity ${state.intensity}/5 (${intensityLabel(
          state.intensity
        )}), phase: ${state.phase}`
      );
    }
    return lines.length > 0 ? `Active fires:\n${lines.join("\n")}` : "";
  },
};

// Re-export constants/types for tests / future composition.
export {
  ROAD_SPREAD_TRAVEL_MINUTES_PER_MINUTE,
  INTENSITY_LABELS,
  PROPAGATION_INTERVAL,
};
