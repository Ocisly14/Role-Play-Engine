import type { PlanNode } from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type {
  PropagationResult,
  TickRuntimeContext,
  WorldFeature,
} from "../types.js";

// ===== Internal types =====

interface FireSceneState {
  intensity: number;
  maxIntensity: number; // fixed 5
  growthRate: number; // default 1 (applied every 10 minutes)
  decayRate: number; // default 1 (applied every 10 minutes)
  spreadThreshold: number; // fixed 3 = ceil(5/2)
  phase: "growing" | "decaying";
  minutesInPhase: number;
  totalBurnMinutes: number;
}

interface FireRoadState extends FireSceneState {
  /** Burning segment on road: 0.0–1.0 */
  burnRange: { start: number; end: number };
}

/** Minutes of road-distance fire spreads per in-game minute (base rate, before weather). */
const ROAD_SPREAD_TRAVEL_MINUTES_PER_MINUTE = 0.4;

function isFireRoadState(state: FireSceneState): state is FireRoadState {
  return "burnRange" in state;
}

// ===== Constants =====

const DEFAULT_MAX_INTENSITY = 5;
const DEFAULT_SPREAD_THRESHOLD = 3; // ceil(5/2)
const DEFAULT_GROWTH_RATE = 1;
const DEFAULT_DECAY_RATE = 1;
const INTENSITY_CHANGE_INTERVAL_MINUTES = 10;
const BLOCK_THRESHOLD = 3; // same as spread threshold
const FEATURE_ID = "fire";
const MINOR_AFTERMATH_THRESHOLD_MINUTES = 20;
const PARTIAL_AFTERMATH_THRESHOLD_MINUTES = 50;
const SEVERE_AFTERMATH_THRESHOLD_MINUTES = 100;

// ===== Helper functions =====

function getFireState(
  dgsm: DynamicGameStateManager,
  sceneId: string
): FireSceneState | undefined {
  return dgsm.getFeatureSceneState(FEATURE_ID, sceneId) as
    | FireSceneState
    | undefined;
}

function setFireState(
  dgsm: DynamicGameStateManager,
  sceneId: string,
  state: FireSceneState
): void {
  dgsm.setFeatureSceneState(FEATURE_ID, sceneId, state);
}

function removeFireState(dgsm: DynamicGameStateManager, sceneId: string): void {
  dgsm.removeFeatureSceneState(FEATURE_ID, sceneId);
}

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

const INTENSITY_LABELS = [
  "",
  "Light smoke",
  "Thickening smoke",
  "Heavy smoke and flames",
  "Intense fire",
  "Raging inferno",
];

function getSkillPenalties(
  intensity: number
): Array<{ skill: string; delta: number }> {
  const penalties: Array<{ skill: string; delta: number }> = [];
  // Always: Spot Hidden
  penalties.push({ skill: "Perception", delta: -10 * intensity });
  // At intensity >= 2: Listen
  if (intensity >= 2) {
    penalties.push({ skill: "Listen", delta: -10 * (intensity - 1) });
  }
  return penalties;
}

function writeFireCondition(
  dgsm: DynamicGameStateManager,
  sceneId: string,
  intensity: number
): void {
  // Clear existing fire conditions first
  clearFireConditions(dgsm, sceneId);

  const label =
    INTENSITY_LABELS[intensity] ??
    INTENSITY_LABELS[INTENSITY_LABELS.length - 1];
  const penalties = getSkillPenalties(intensity);

  dgsm.appendSceneCondition(sceneId, {
    description: `[Fire] ${label}`,
    mechanicalEffect: {
      skillPenalty: penalties,
    },
  });
}

function clearFireConditions(
  dgsm: DynamicGameStateManager,
  sceneId: string
): void {
  const state = dgsm.getState();
  const conditions = state.scenarioConditions[sceneId];
  if (!conditions) return;
  const nonFire = conditions.filter((c) => !c.description.startsWith("[Fire]"));
  dgsm.replaceSceneConditions(sceneId, nonFire);
}

function writeAftermathCondition(
  dgsm: DynamicGameStateManager,
  sceneId: string,
  totalBurnMinutes: number
): void {
  let description: string;
  let penalties: Array<{ skill: string; delta: number }> | undefined;

  if (totalBurnMinutes <= MINOR_AFTERMATH_THRESHOLD_MINUTES) {
    description = "[Fire Aftermath] Minor smoke stains on walls and ceiling";
    // no penalties
  } else if (totalBurnMinutes <= PARTIAL_AFTERMATH_THRESHOLD_MINUTES) {
    description =
      "[Fire Aftermath] Partial burn damage \u2014 some items destroyed, soot covers surfaces";
    penalties = [{ skill: "Perception", delta: -5 }];
  } else if (totalBurnMinutes <= SEVERE_AFTERMATH_THRESHOLD_MINUTES) {
    description =
      "[Fire Aftermath] Severe burn damage \u2014 structural integrity compromised, many items destroyed";
    penalties = [{ skill: "Perception", delta: -10 }];
  } else {
    description =
      "[Fire Aftermath] Scene nearly destroyed by fire \u2014 most items and clues unavailable, structure unsafe";
    penalties = [{ skill: "Perception", delta: -20 }];
  }

  dgsm.appendSceneCondition(sceneId, {
    description,
    mechanicalEffect: penalties ? { skillPenalty: penalties } : undefined,
  });
}

function damageByFire(
  dgsm: DynamicGameStateManager,
  sceneId: string,
  intensity: number
): void {
  const scene = dgsm.getScene(sceneId);
  if (!scene) return;

  const now = new Date().toISOString();
  const reason = `Destroyed by fire (intensity ${intensity})`;

  // Damage 20% of undamaged items (evidence and mundane alike)
  const damageableItems = scene.items?.filter((item) => !item.damaged) ?? [];
  if (damageableItems.length > 0) {
    const itemCount = Math.round(damageableItems.length * 0.2);
    if (itemCount > 0) {
      const shuffled = [...damageableItems].sort(() => Math.random() - 0.5);
      for (let i = 0; i < itemCount; i++) {
        shuffled[i].damaged = true;
        shuffled[i].damageDetails = {
          damagedBy: "fire",
          damagedAt: now,
          reason,
        };
      }
    }
  }
}

function updateFireBlocking(
  dgsm: DynamicGameStateManager,
  locationId: string,
  intensity: number
): void {
  // Scene-based blocking (existing)
  const scene = dgsm.getScene(locationId);
  if (scene) {
    const connectedSceneIds = (scene.connections ?? []).map((c) => c.targetId);
    if (intensity >= BLOCK_THRESHOLD) {
      for (const connId of connectedSceneIds) {
        dgsm.setConnectionBlocked(
          connId,
          locationId,
          true,
          `Blocked by fire (intensity ${intensity})`
        );
      }
    } else {
      for (const connId of connectedSceneIds) {
        if (
          dgsm
            .getConnectionBlockReason(connId, locationId)
            ?.startsWith("Blocked by fire")
        ) {
          dgsm.setConnectionBlocked(connId, locationId, false, "");
        }
      }
    }
    return;
  }

  // Topology-based blocking (road/junction)
  const topology = dgsm.getTopology();
  if (!topology) return;

  const neighbors: string[] = [];
  const junction = topology.junctions.get(locationId);
  if (junction) {
    const roads = topology.junctionToRoads.get(locationId) ?? [];
    neighbors.push(
      ...roads.map((r: { id: string }) => r.id),
      ...junction.connectedSceneIds
    );
  }
  const road = topology.roads.get(locationId);
  if (road) {
    neighbors.push(road.endpointA, road.endpointB);
    neighbors.push(
      ...road.alongConnections.map((a: { sceneId: string }) => a.sceneId)
    );
  }

  if (intensity >= BLOCK_THRESHOLD) {
    for (const nId of neighbors) {
      dgsm.setConnectionBlocked(
        nId,
        locationId,
        true,
        `Blocked by fire (intensity ${intensity})`
      );
    }
  } else {
    for (const nId of neighbors) {
      if (
        dgsm
          .getConnectionBlockReason(nId, locationId)
          ?.startsWith("Blocked by fire")
      ) {
        dgsm.setConnectionBlocked(nId, locationId, false, "");
      }
    }
  }
}

function getAllBurningScenes(dgsm: DynamicGameStateManager): string[] {
  return Object.keys(dgsm.getFeatureState(FEATURE_ID));
}

/**
 * Get weather-based multiplier for fire spread rate on outdoor fire.
 * Rain reduces spread, dry/heat increases spread.
 */
function getWeatherSpreadMultiplier(
  dgsm: DynamicGameStateManager,
  parentLocationId: string
): number {
  const weatherState = dgsm.getFeatureSceneState("weather", parentLocationId) as
    | { weatherType: string; intensity: number }
    | undefined;
  if (!weatherState) return 1.0;

  const { weatherType, intensity } = weatherState;

  if (weatherType === "rain") {
    if (intensity >= 4) return 0; // heavy rain extinguishes
    if (intensity >= 3) return 0.1; // near-extinguish
    if (intensity >= 2) return 0.5; // significantly slower
    return 0.8; // light rain, slightly slower
  }
  if (weatherType === "storm") {
    if (intensity >= 3) return 0; // storm extinguishes
    if (intensity >= 2) return 0.3;
    return 0.7;
  }
  if (weatherType === "extreme_heat") {
    if (intensity >= 3) return 1.5; // heat accelerates fire
    return 1.2;
  }
  return 1.0;
}

/**
 * Check if a location is an outdoor topology node (road or junction).
 * Outdoor fire is affected by weather; scene (building interior) fire is not.
 */
function isOutdoorTopologyNode(
  dgsm: DynamicGameStateManager,
  locationId: string
): { isOutdoor: boolean; parentLocationId: string | null } {
  const topology = dgsm.getTopology();
  if (!topology) return { isOutdoor: false, parentLocationId: null };
  const road = topology.roads.get(locationId);
  if (road) return { isOutdoor: true, parentLocationId: road.parentLocationId };
  const junction = topology.junctions.get(locationId);
  if (junction)
    return { isOutdoor: true, parentLocationId: junction.parentLocationId };
  return { isOutdoor: false, parentLocationId: null };
}

// ===== Exported feature =====

export const fireFeature: WorldFeature = {
  id: FEATURE_ID,
  description:
    "Fire system \u2014 spreads between scenes, causes skill penalties and blocks connections",

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

  propagation: {
    tickInterval: 10,
    maxHops: 3,
  },

  stateDescription(dgsm: DynamicGameStateManager): string {
    const burningScenes = getAllBurningScenes(dgsm);
    if (burningScenes.length === 0) return "";

    const lines: string[] = [];
    for (const sceneId of burningScenes) {
      const fs = getFireState(dgsm, sceneId);
      if (!fs) continue;
      const label =
        INTENSITY_LABELS[fs.intensity] ??
        INTENSITY_LABELS[INTENSITY_LABELS.length - 1];
      lines.push(
        `- ${sceneId}: intensity ${fs.intensity}/5 (${label}), phase: ${fs.phase}`
      );
    }
    return lines.length > 0 ? "Active fires:\n" + lines.join("\n") : "";
  },

  activate(node: PlanNode, dgsm: DynamicGameStateManager): void {
    const sceneId =
      node.type === "movement"
        ? node.destination
        : (typeof (node as Record<string, unknown>).location === "string"
            ? ((node as Record<string, unknown>).location as string)
            : (() => {
                const pos = dgsm.getCharacterPosition(node.characterId);
                return pos ? dgsm.resolveLocationId(pos) : undefined;
              })());
    if (!sceneId) return;

    // Handle extinguish
    if ((node as Record<string, unknown>).fireExtinguish === true) {
      const existing = getFireState(dgsm, sceneId);
      if (!existing) return; // nothing to extinguish

      existing.intensity -= 2;
      if (existing.intensity <= 0) {
        // Fire is fully extinguished
        writeAftermathCondition(dgsm, sceneId, existing.totalBurnMinutes);
        clearFireConditions(dgsm, sceneId);
        updateFireBlocking(dgsm, sceneId, 0);
        removeFireState(dgsm, sceneId);
      } else {
        setFireState(dgsm, sceneId, existing);
        writeFireCondition(dgsm, sceneId, existing.intensity);
        updateFireBlocking(dgsm, sceneId, existing.intensity);
      }
      return;
    }

    // Handle fire start / boost
    const requestedIntensity = (node as Record<string, unknown>)
      .fireIntensity as number | undefined;
    if (requestedIntensity === undefined) return;

    const existing = getFireState(dgsm, sceneId);
    if (existing) {
      // Boost existing fire only if requested intensity is higher
      if (requestedIntensity > existing.intensity) {
        existing.intensity = Math.min(
          requestedIntensity,
          existing.maxIntensity
        );
        setFireState(dgsm, sceneId, existing);
        writeFireCondition(dgsm, sceneId, existing.intensity);
        updateFireBlocking(dgsm, sceneId, existing.intensity);
      }
    } else {
      // Create new fire
      const newState = createFireState(requestedIntensity);
      setFireState(dgsm, sceneId, newState);
      writeFireCondition(dgsm, sceneId, newState.intensity);
      updateFireBlocking(dgsm, sceneId, newState.intensity);
    }
  },

  tick(dgsm: DynamicGameStateManager, runtime: TickRuntimeContext): void {
    const burningScenes = getAllBurningScenes(dgsm);
    const elapsedMinutes = Math.max(1, runtime.tickDurationMinutes);

    for (const sceneId of burningScenes) {
      const fs = getFireState(dgsm, sceneId);
      if (!fs) continue;

      fs.totalBurnMinutes += elapsedMinutes;
      fs.minutesInPhase += elapsedMinutes;

      while (fs.minutesInPhase >= INTENSITY_CHANGE_INTERVAL_MINUTES) {
        fs.minutesInPhase -= INTENSITY_CHANGE_INTERVAL_MINUTES;

        if (fs.phase === "growing") {
          fs.intensity += fs.growthRate;
          if (fs.intensity > 2) {
            damageByFire(dgsm, sceneId, fs.intensity);
          }
          if (fs.intensity >= fs.maxIntensity) {
            fs.intensity = fs.maxIntensity;
            fs.phase = "decaying";
            fs.minutesInPhase = 0;
          }
        } else {
          // decaying
          fs.intensity -= fs.decayRate;
          if (fs.intensity <= 0) {
            // Fire burns out
            writeAftermathCondition(dgsm, sceneId, fs.totalBurnMinutes);
            clearFireConditions(dgsm, sceneId);
            updateFireBlocking(dgsm, sceneId, 0);
            removeFireState(dgsm, sceneId);
            continue;
          }
        }

        // Intensity changed — update condition and blocking
        writeFireCondition(dgsm, sceneId, fs.intensity);
        updateFireBlocking(dgsm, sceneId, fs.intensity);
      }

      // Weather affects outdoor fire (road + junction)
      const outdoor = isOutdoorTopologyNode(dgsm, sceneId);
      if (outdoor.isOutdoor && outdoor.parentLocationId) {
        const weatherMult = getWeatherSpreadMultiplier(
          dgsm,
          outdoor.parentLocationId
        );

        // Heavy rain/storm extinguishes outdoor fire
        if (weatherMult <= 0) {
          writeAftermathCondition(dgsm, sceneId, fs.totalBurnMinutes);
          clearFireConditions(dgsm, sceneId);
          updateFireBlocking(dgsm, sceneId, 0);
          removeFireState(dgsm, sceneId);
          continue;
        }

        // Road fire: expand burn range
        if (isFireRoadState(fs)) {
          const road = dgsm.getTopology()!.roads.get(sceneId)!;
          const spreadDelta =
            ((ROAD_SPREAD_TRAVEL_MINUTES_PER_MINUTE * elapsedMinutes) /
              road.travelTimeMinutes) *
            weatherMult;
          fs.burnRange.start = Math.max(0, fs.burnRange.start - spreadDelta);
          fs.burnRange.end = Math.min(1, fs.burnRange.end + spreadDelta);

          // Damage along-road scenes within burn range
          for (const along of road.alongConnections) {
            if (
              along.position >= fs.burnRange.start &&
              along.position <= fs.burnRange.end
            ) {
              if (fs.intensity > 2) {
                damageByFire(dgsm, along.sceneId, fs.intensity);
              }
              writeFireCondition(
                dgsm,
                along.sceneId,
                Math.max(1, fs.intensity - 1)
              );
            }
          }
        }

        // Junction fire: weather slows growth (modify growth rate effectively)
        // Already handled: if weatherMult < 1 the fire grows normally but can't spread as fast
        // The main effect is the extinguishing at weatherMult <= 0 above
      }

      // Only persist if not removed above
      if (getFireState(dgsm, sceneId) !== undefined) {
        setFireState(dgsm, sceneId, fs);
      }
    }
  },

  async propagate(
    sourceId: string,
    _currentHop: number,
    dgsm: DynamicGameStateManager,
    _runtime: TickRuntimeContext
  ): Promise<PropagationResult> {
    const sourceState = getFireState(dgsm, sourceId);
    if (!sourceState || sourceState.intensity < sourceState.spreadThreshold) {
      return { spreadTo: [] };
    }

    const topology = dgsm.getTopology();
    const newIds: string[] = [];

    // Helper: check if connection is blocked by non-fire reason
    const isNonFireBlocked = (a: string, b: string): boolean => {
      const reason = dgsm.getConnectionBlockReason(a, b);
      return !!reason && !reason.startsWith("Blocked by fire");
    };

    // Helper: ignite a new location
    const ignite = (targetId: string, position?: number) => {
      if (getFireState(dgsm, targetId)) return; // already burning
      if (isNonFireBlocked(sourceId, targetId)) return;

      if (position !== undefined) {
        // Road fire with position
        const newState = createRoadFireState(1, position);
        setFireState(dgsm, targetId, newState);
      } else {
        const newState = createFireState(1);
        setFireState(dgsm, targetId, newState);
      }
      writeFireCondition(dgsm, targetId, 1);
      newIds.push(targetId);
    };

    if (topology) {
      // Topology-aware propagation
      const road = topology.roads.get(sourceId);
      const junction = topology.junctions.get(sourceId);

      if (road && isFireRoadState(sourceState)) {
        // Road fire → spread to endpoint junctions when burnRange reaches endpoint
        if (sourceState.burnRange.start <= 0.05) ignite(road.endpointA);
        if (sourceState.burnRange.end >= 0.95) ignite(road.endpointB);
      } else if (junction) {
        // Junction fire → spread to connected roads (start fire at junction end)
        const connectedRoads = topology.junctionToRoads.get(sourceId) ?? [];
        for (const connRoad of connectedRoads) {
          const startPos = connRoad.endpointA === sourceId ? 0.0 : 1.0;
          ignite(connRoad.id, startPos);
        }
        // Also spread to directly connected scenes
        for (const sceneId of junction.connectedSceneIds) {
          ignite(sceneId);
        }
      } else {
        // Scene fire → spread to parent road/junction
        const parent = topology.sceneToParent.get(sourceId);
        if (parent) {
          if (parent.type === "road") {
            ignite(parent.roadId, parent.position);
          } else {
            ignite(parent.junctionId);
          }
        }
      }
    }

    // Fallback: also spread via scene.connections for scenes without topology
    if (
      !topology ||
      (!topology.roads.has(sourceId) &&
        !topology.junctions.has(sourceId) &&
        !topology.sceneToParent.has(sourceId))
    ) {
      const scene = dgsm.getScene(sourceId);
      if (scene) {
        for (const connId of (scene.connections ?? []).map((c) => c.targetId)) {
          if (getFireState(dgsm, connId)) continue;
          if (isNonFireBlocked(sourceId, connId)) continue;
          const newState = createFireState(1);
          setFireState(dgsm, connId, newState);
          writeFireCondition(dgsm, connId, 1);
          newIds.push(connId);
        }
      }
    }

    return { spreadTo: newIds };
  },
};
