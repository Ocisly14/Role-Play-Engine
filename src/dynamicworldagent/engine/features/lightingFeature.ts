import type {
  WorldFeature,
  TickRuntimeContext,
} from "../types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { getTopologyNeighbors } from "../shared/topologyHelpers.js";

// ===== Types =====

export interface LightingSceneState {
  lightLevel: number;
  sources: string[];
}

// ===== Constants =====

const FEATURE_ID = "lighting";

const LIGHT_LEVEL_LABELS = ["", "Pitch black", "Dark", "Normal lighting", "Bright", "Blinding light"];

// ===== Sun Curve =====

function computeSunLevel(timeStr: string): number {
  const [hStr, mStr] = timeStr.split(":");
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  const t = h + m / 60;

  if (t < 4) return 1;
  if (t < 6) return lerp(1, 3, (t - 4) / 2);
  if (t < 7) return lerp(3, 4, (t - 6) / 1);
  if (t < 12) return lerp(4, 5, (t - 7) / 5);
  if (t < 13) return 5;
  if (t < 17) return lerp(5, 4, (t - 13) / 4);
  if (t < 18) return lerp(4, 3, (t - 17) / 1);
  if (t < 20) return lerp(3, 1, (t - 18) / 2);
  return 1;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}

// ===== Weather Modifier =====

function getWeatherLightModifier(dgsm: DynamicGameStateManager, regionId: string): number {
  const weatherState = dgsm.getFeatureSceneState("weather", regionId) as
    | { weatherType: string; intensity: number }
    | undefined;
  if (!weatherState) return 0;

  const { weatherType, intensity } = weatherState;

  if (weatherType === "fog") {
    if (intensity >= 5) return -2;
    if (intensity >= 3) return -1;
  }
  if (weatherType === "storm") {
    if (intensity >= 4) return -2;
    if (intensity >= 2) return -1;
  }
  if (weatherType === "rain") {
    if (intensity >= 4) return -1;
  }
  return 0;
}

// ===== Fire to Light Mapping =====

interface FireLightContribution {
  sceneId: string;
  lightLevel: number;
}

function getFireLightContributions(dgsm: DynamicGameStateManager): FireLightContribution[] {
  const contributions: FireLightContribution[] = [];
  const fireStates = dgsm.getFeatureState("fire");
  const topology = dgsm.getTopology();

  for (const [locationId, state] of Object.entries(fireStates)) {
    const fs = state as { intensity: number } | undefined;
    if (!fs || fs.intensity <= 0) continue;

    const fireLightLevel = Math.min(fs.intensity + 1, 5);
    contributions.push({ sceneId: locationId, lightLevel: fireLightLevel });

    // Spread fire light to neighbors
    if (fs.intensity >= 3) {
      const adjacentLevel = fireLightLevel - 1;

      if (topology) {
        // Topology-aware: use topology neighbors
        const neighbors = getTopologyNeighbors(locationId, topology);
        for (const neighborId of neighbors) {
          contributions.push({ sceneId: neighborId, lightLevel: adjacentLevel });
        }
      } else {
        // Fallback: use scene.connections
        const scene = dgsm.getScene(locationId);
        if (scene) {
          for (const connId of scene.connections) {
            contributions.push({ sceneId: connId, lightLevel: adjacentLevel });
          }
        }
      }
    }
  }

  return contributions;
}

// ===== Skill Penalties =====

interface LightPenaltyEntry {
  skill: string;
  delta: number;
}

const LIGHT_LEVEL_PENALTIES: Record<number, LightPenaltyEntry[]> = {
  1: [
    { skill: "Perception", delta: -40 },
    { skill: "Navigate", delta: -30 },
    { skill: "Track", delta: -40 },
    { skill: "Pistol", delta: -40 },
    { skill: "Rifle", delta: -40 },
    { skill: "Submachine Gun", delta: -40 },
    { skill: "Bow", delta: -40 },
    { skill: "Climb", delta: -20 },
    { skill: "Drive Auto", delta: -30 },
    { skill: "Research", delta: -50 },
  ],
  2: [
    { skill: "Perception", delta: -20 },
    { skill: "Navigate", delta: -15 },
    { skill: "Track", delta: -20 },
    { skill: "Pistol", delta: -20 },
    { skill: "Rifle", delta: -20 },
    { skill: "Submachine Gun", delta: -20 },
    { skill: "Bow", delta: -20 },
    { skill: "Climb", delta: -10 },
    { skill: "Drive Auto", delta: -15 },
    { skill: "Research", delta: -20 },
  ],
  3: [],
  4: [],
  5: [
    { skill: "Perception", delta: -15 },
    { skill: "Track", delta: -10 },
    { skill: "Pistol", delta: -15 },
    { skill: "Rifle", delta: -15 },
    { skill: "Submachine Gun", delta: -15 },
    { skill: "Bow", delta: -15 },
  ],
};

// ===== Scene Condition Helpers =====

function writeLightingCondition(dgsm: DynamicGameStateManager, sceneId: string, lightLevel: number): void {
  clearLightingConditions(dgsm, sceneId);

  if (lightLevel === 3 || lightLevel === 4) return;

  const label = LIGHT_LEVEL_LABELS[lightLevel] ?? LIGHT_LEVEL_LABELS[1];
  const penalties = LIGHT_LEVEL_PENALTIES[lightLevel] ?? [];

  dgsm.appendSceneCondition(sceneId, {
    description: `[Lighting] ${label}`,
    mechanicalEffect: penalties.length > 0 ? { skillPenalty: penalties } : undefined,
  });
}

function clearLightingConditions(dgsm: DynamicGameStateManager, sceneId: string): void {
  const state = dgsm.getState();
  const conditions = state.scenarioConditions[sceneId];
  if (!conditions) return;
  (dgsm.getState() as any).scenarioConditions[sceneId] = conditions.filter(
    (c: any) => !c.description.startsWith("[Lighting]"),
  );
}

// ===== State Helpers =====

function setLightingState(dgsm: DynamicGameStateManager, sceneId: string, state: LightingSceneState): void {
  dgsm.setFeatureSceneState(FEATURE_ID, sceneId, state);
}

// ===== Per-Scene Computation =====

function computeSceneLighting(
  dgsm: DynamicGameStateManager,
  sceneId: string,
  sunLevel: number,
  fireContributions: FireLightContribution[],
): LightingSceneState {
  const scene = dgsm.getScene(sceneId);
  if (!scene) return { lightLevel: 1, sources: [] };

  const isIndoor = (scene as any).indoor === true;
  const sources: Array<{ name: string; level: number }> = [];

  if (!isIndoor && sunLevel > 0) {
    const weatherMod = getWeatherLightModifier(dgsm, scene.parentLocationId);
    const adjustedSun = Math.max(1, sunLevel + weatherMod);
    sources.push({ name: "sun", level: adjustedSun });

    if (sunLevel === 1) {
      sources.push({ name: "moon", level: 2 });
    }
  }

  for (const fc of fireContributions) {
    if (fc.sceneId === sceneId) {
      sources.push({ name: "fire", level: fc.lightLevel });
    }
  }

  if (scene.items) {
    for (const item of scene.items) {
      if (item.isLightSource && item.lightLevel && !item.damaged) {
        sources.push({ name: `item:${item.id}`, level: item.lightLevel });
      }
    }
  }

  const maxLevel = sources.length > 0
    ? Math.min(5, Math.max(...sources.map(s => s.level)))
    : 1;

  return {
    lightLevel: maxLevel,
    sources: sources.filter(s => s.level === maxLevel).map(s => s.name),
  };
}

// ===== Outdoor (Road/Junction) Lighting =====

function computeOutdoorLighting(
  dgsm: DynamicGameStateManager,
  locationId: string,
  parentLocationId: string,
  sunLevel: number,
  fireContributions: FireLightContribution[],
): LightingSceneState {
  const sources: Array<{ name: string; level: number }> = [];

  // Outdoor: always get sun (with weather modifier)
  const weatherMod = getWeatherLightModifier(dgsm, parentLocationId);
  const adjustedSun = Math.max(1, sunLevel + weatherMod);
  sources.push({ name: "sun", level: adjustedSun });

  if (sunLevel === 1) {
    sources.push({ name: "moon", level: 2 });
  }

  // Fire light contributions
  for (const fc of fireContributions) {
    if (fc.sceneId === locationId) {
      sources.push({ name: "fire", level: fc.lightLevel });
    }
  }

  const maxLevel = sources.length > 0
    ? Math.min(5, Math.max(...sources.map(s => s.level)))
    : 1;

  return {
    lightLevel: maxLevel,
    sources: sources.filter(s => s.level === maxLevel).map(s => s.name),
  };
}

// ===== Exported Feature =====

export const lightingFeature: WorldFeature = {
  id: FEATURE_ID,
  description: "Unified lighting system — aggregates sun, moon, fire, and item light sources with skill penalties",

  planningPrompt: `## Lighting
Current lighting conditions are shown in the state description below.
Lighting changes automatically based on time of day, weather, fire, and light source items.
Dark environments impose skill penalties. Blinding light also impairs vision.`,

  stateDescription(dgsm: DynamicGameStateManager): string {
    const allStates = dgsm.getFeatureState(FEATURE_ID);
    const entries = Object.entries(allStates);
    if (entries.length === 0) return "";

    const abnormal: string[] = [];
    for (const [sceneId, state] of entries) {
      const ls = state as LightingSceneState;
      if (ls.lightLevel !== 3 && ls.lightLevel !== 4) {
        const label = LIGHT_LEVEL_LABELS[ls.lightLevel] ?? "Unknown";
        abnormal.push(`- ${sceneId}: ${label} (level ${ls.lightLevel}/5)`);
      }
    }

    if (abnormal.length === 0) return "Lighting: Normal in all scenes";
    return "Lighting:\n" + abnormal.join("\n");
  },

  tick(dgsm: DynamicGameStateManager, runtime: TickRuntimeContext): void {
    const sunLevel = computeSunLevel(runtime.tickTime);
    const fireContributions = getFireLightContributions(dgsm);

    const state = dgsm.getState();

    // Process all scenes
    state.scenes.forEach((_scene: any, sceneId: string) => {
      const lighting = computeSceneLighting(dgsm, sceneId, sunLevel, fireContributions);
      setLightingState(dgsm, sceneId, lighting);
      writeLightingCondition(dgsm, sceneId, lighting.lightLevel);
    });

    // Process roads and junctions (outdoor, always receive sun)
    const topology = dgsm.getTopology();
    if (topology) {
      for (const [roadId, road] of topology.roads) {
        const lighting = computeOutdoorLighting(dgsm, roadId, road.parentLocationId, sunLevel, fireContributions);
        setLightingState(dgsm, roadId, lighting);
        writeLightingCondition(dgsm, roadId, lighting.lightLevel);
      }
      for (const [juncId, junc] of topology.junctions) {
        const lighting = computeOutdoorLighting(dgsm, juncId, junc.parentLocationId, sunLevel, fireContributions);
        setLightingState(dgsm, juncId, lighting);
        writeLightingCondition(dgsm, juncId, lighting.lightLevel);
      }
    }
  },
};
