import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { ActionStep, SceneCondition, StateChange } from "../core/types.js";
import type { WorldFeature } from "../core/worldFeature.js";

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
    Math.min(initialIntensity, DEFAULT_MAX_INTENSITY),
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
  };
}

function createRoadFireState(
  initialIntensity: number,
  position: number,
): FireRoadState {
  const base = createFireState(initialIntensity);
  return {
    ...base,
    burnRange: { start: position, end: position },
  };
}

function intensityLabel(intensity: number): string {
  return (
    INTENSITY_LABELS[intensity] ??
    INTENSITY_LABELS[INTENSITY_LABELS.length - 1]
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
 * Mirrors weatherFeature's connectionIdFor — single id per logical edge so
 * the Applier's (featureId, reason) refcount table can match additions and
 * withdrawals across intensity changes.
 */
function fireConnectionIdFor(a: string, b: string): string {
  return a <= b ? `fire:${a}|${b}` : `fire:${b}|${a}`;
}

/**
 * Enumerate the location IDs that fire at `locationId` should consider for
 * connection.setBlock votes. Uses topology when available (so road-fires can
 * vote on their endpoint junctions and along-road scenes), falls back to
 * scene.connections otherwise.
 */
function getBlockableNeighbors(
  locationId: string,
  ctx: FeatureReadContext,
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
  intensity: number,
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
  totalBurnMinutes: number,
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

// ===== Exported feature =====

export const fireFeature: WorldFeature = {
  id: FEATURE_ID,
  description:
    "Fire system — spreads between scenes, contributes temperature/illumination/smoke to env, applies skill penalties, blocks connections at high intensity",
  stateScope: "scene",
  affectedKinds: [
    "feature.setState",
    "feature.removeState",
    "scene.addCondition",
    "scene.removeCondition",
    "environment.contribute",
    "environment.hazard",
    "connection.setBlock",
  ],
  effectSummary:
    "Per-scene fire with growing/decaying lifecycle; contributes temperature & smoke to env, blocks connections at intensity >= 3.",
  priority: 200,
  propagation: {
    tickInterval: 10,
    maxHops: 3,
  },
  planningPrompt: `## Fire
- Starting a fire: add \`"fireIntensity"\` to the node. Choose initial intensity based on the action:
  - 1: Small fire (candle knocked over, match, small arson)
  - 2: Moderate fire (deliberate arson with accelerant, oil lamp explosion)
  - 3: Large fire (building-scale arson, explosive ignition)
- Putting out a fire: add \`"fireExtinguish": true\` to the node.
- Do NOT add fire fields to nodes that merely observe or react to fire.`,

  planNodeSchema: {
    requiredFields: [
      {
        field: "fireIntensity",
        type: "number",
        description: "Initial fire intensity (typically 1)",
      },
    ],
    optionalFields: [
      {
        field: "fireExtinguish",
        type: "boolean",
        description:
          "Set to true to attempt to extinguish fire at this location",
      },
    ],
    exampleNode: {
      type: "action",
      action: "Set fire to the old warehouse",
      fireIntensity: 1,
    },
  },

  stateDescription(ctx: FeatureReadContext): string {
    const states = ctx.getAllFeatureStates<FireSceneState>();
    if (states.length === 0) return "";
    const lines: string[] = [];
    for (const { key, state } of states) {
      lines.push(
        `- ${key}: intensity ${state.intensity}/5 (${intensityLabel(
          state.intensity,
        )}), phase: ${state.phase}`,
      );
    }
    return lines.length > 0 ? `Active fires:\n${lines.join("\n")}` : "";
  },

  onActionCommit(step: ActionStep, _outcome, ctx): StateChange[] {
    const overlay = step.overlayFields ?? {};
    const sceneId = step.executionSceneId;
    if (!sceneId) return [];

    // ----- Extinguish path -----
    if (overlay.fireExtinguish === true) {
      const existing = ctx.getFeatureState<FireSceneState>(sceneId);
      if (!existing) return []; // nothing to extinguish

      const next: FireSceneState = { ...existing, intensity: existing.intensity - 2 };
      if (next.intensity <= 0) {
        return emitFireExtinguish(sceneId, existing.totalBurnMinutes);
      }
      return [
        {
          kind: "feature.setState",
          featureId: FEATURE_ID,
          key: sceneId,
          state: next,
        },
        ...emitFireConditionRefresh(sceneId, next.intensity),
      ];
    }

    // ----- Ignite / boost path -----
    const requested = overlay.fireIntensity;
    if (typeof requested !== "number") return [];

    const existing = ctx.getFeatureState<FireSceneState>(sceneId);
    if (existing) {
      // Boost only if requested intensity strictly greater than current.
      if (requested <= existing.intensity) return [];
      const boosted: FireSceneState = {
        ...existing,
        intensity: Math.min(requested, existing.maxIntensity),
      };
      return [
        {
          kind: "feature.setState",
          featureId: FEATURE_ID,
          key: sceneId,
          state: boosted,
        },
        ...emitFireConditionRefresh(sceneId, boosted.intensity),
      ];
    }

    // Fresh ignition.
    const fresh = createFireState(requested);
    return [
      {
        kind: "feature.setState",
        featureId: FEATURE_ID,
        key: sceneId,
        state: fresh,
      },
      {
        kind: "scene.addCondition",
        sceneId,
        condition: buildFireCondition(fresh.intensity),
      },
    ];
  },

  onTick(ctx: FeatureReadContext): StateChange[] {
    const out: StateChange[] = [];
    const fires = ctx.getAllFeatureStates<FireSceneState>();
    const elapsedMinutes = Math.max(1, ctx.tickDurationMinutes);

    for (const { key: locationId, state } of fires) {
      // Work on a shallow copy so we never observe mid-tick mutations of the
      // DGSM-stored state via ctx (though in practice the read-context returns
      // a reference — defensive copy keeps the loop semantics clean).
      const next: FireSceneState = isFireRoadState(state)
        ? { ...state, burnRange: { ...state.burnRange } }
        : { ...state };

      next.totalBurnMinutes += elapsedMinutes;
      next.minutesInPhase += elapsedMinutes;

      // Cold-rain decay acceleration: while decaying and ambient temperature
      // is below the threshold, advance phase time at 2x. (Implemented as an
      // additional `elapsedMinutes` bump applied just-in-time so it feeds the
      // existing while-loop.)
      if (next.phase === "decaying") {
        const reading = ctx.getEnvironmentReading(locationId);
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
            out.push(...emitFireExtinguish(locationId, next.totalBurnMinutes));
            // Also withdraw any blocking votes we may have placed.
            const neighbors = getBlockableNeighbors(locationId, ctx);
            for (const nId of neighbors) {
              out.push({
                kind: "connection.setBlock",
                connectionId: fireConnectionIdFor(locationId, nId),
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

      if (extinguishedThisTick) continue;

      // Persist updated lifecycle bookkeeping.
      out.push({
        kind: "feature.setState",
        featureId: FEATURE_ID,
        key: locationId,
        state: next,
      });

      if (intensityChanged && next.intensity !== intensityAtStart) {
        out.push(...emitFireConditionRefresh(locationId, next.intensity));
      }

      // Re-contribute env quantities every tick (Applier requires it —
      // unvisited locations retain prior readings).
      out.push({
        kind: "environment.contribute",
        locationId,
        quantity: "temperature",
        value: next.intensity * 100,
        sourceFeatureId: FEATURE_ID,
      });
      out.push({
        kind: "environment.contribute",
        locationId,
        quantity: "illumination",
        value: Math.min(next.intensity + 1, 5),
        sourceFeatureId: FEATURE_ID,
      });
      out.push({
        kind: "environment.contribute",
        locationId,
        quantity: "oxygen",
        value: -next.intensity * 0.1,
        sourceFeatureId: FEATURE_ID,
      });
      if (next.intensity >= 2) {
        out.push({
          kind: "environment.hazard",
          locationId,
          add: ["smoke"],
          sourceFeatureId: FEATURE_ID,
        });
      }

      // Connection blocking: vote on every adjacent edge with the stable
      // FIRE_BLOCK_REASON so the Applier's refcount can withdraw cleanly when
      // intensity drops below threshold.
      const blocked = next.intensity >= BLOCK_THRESHOLD;
      const neighbors = getBlockableNeighbors(locationId, ctx);
      for (const nId of neighbors) {
        out.push({
          kind: "connection.setBlock",
          connectionId: fireConnectionIdFor(locationId, nId),
          blocked,
          sourceFeatureId: FEATURE_ID,
          reason: FIRE_BLOCK_REASON,
        });
      }
    }

    return out;
  },

  onPropagate(
    source: { sceneId: string; hop: number },
    ctx: FeatureReadContext,
  ): { spreadToSceneIds: string[]; changes: StateChange[] } {
    const sourceState = ctx.getFeatureState<FireSceneState>(source.sceneId);
    if (
      !sourceState ||
      sourceState.intensity < sourceState.spreadThreshold
    ) {
      return { spreadToSceneIds: [], changes: [] };
    }

    const spreadToSceneIds: string[] = [];
    const changes: StateChange[] = [];

    const ignite = (
      targetId: string,
      newState: FireSceneState | FireRoadState,
    ): void => {
      // Don't overwrite an already-burning location.
      if (ctx.getFeatureState<FireSceneState>(targetId)) return;
      changes.push({
        kind: "feature.setState",
        featureId: FEATURE_ID,
        key: targetId,
        state: newState,
      });
      changes.push({
        kind: "scene.addCondition",
        sceneId: targetId,
        condition: buildFireCondition(newState.intensity),
      });
      spreadToSceneIds.push(targetId);
    };

    const topology = ctx.getTopology();
    const sourceId = source.sceneId;

    if (topology) {
      const road = topology.roads.get(sourceId);
      const junction = topology.junctions.get(sourceId);

      if (road && isFireRoadState(sourceState)) {
        // Road fire → spread to endpoint junctions when burnRange reaches end.
        if (sourceState.burnRange.start <= 0.05) {
          ignite(road.endpointA, createFireState(1));
        }
        if (sourceState.burnRange.end >= 0.95) {
          ignite(road.endpointB, createFireState(1));
        }
        return { spreadToSceneIds, changes };
      }

      if (junction) {
        const connectedRoads = topology.junctionToRoads.get(sourceId) ?? [];
        for (const r of connectedRoads) {
          const startPos = r.endpointA === sourceId ? 0.0 : 1.0;
          ignite(r.id, createRoadFireState(1, startPos));
        }
        for (const sceneId of junction.connectedSceneIds) {
          ignite(sceneId, createFireState(1));
        }
        return { spreadToSceneIds, changes };
      }

      const parent = topology.sceneToParent.get(sourceId);
      if (parent) {
        if (parent.type === "road") {
          ignite(parent.roadId, createRoadFireState(1, parent.position));
        } else {
          ignite(parent.junctionId, createFireState(1));
        }
        return { spreadToSceneIds, changes };
      }
      // Topology exists but source isn't indexed — fall through to scene-graph.
    }

    // Fallback: scene.connections only (legacy / pure-scene worlds).
    const scene = ctx.getScene(sourceId);
    if (scene) {
      for (const conn of scene.connections ?? []) {
        ignite(conn.targetId, createFireState(1));
      }
    }

    return { spreadToSceneIds, changes };
  },
};

// Re-export for tests / future composition.
export { ROAD_SPREAD_TRAVEL_MINUTES_PER_MINUTE, INTENSITY_LABELS };
