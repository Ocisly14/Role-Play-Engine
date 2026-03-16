import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { TickRuntimeContext, WorldFeature } from "../types.js";

// ===== Types =====

export type WeatherType =
  | "clear"
  | "rain"
  | "fog"
  | "storm"
  | "snow"
  | "extreme_heat"
  | "extreme_cold";

export interface WeatherRegionState {
  weatherType: WeatherType;
  intensity: number;
  ticksInState: number;
  affectedSceneIds: string[];
}

// ===== Constants =====

const FEATURE_ID = "weather";
const TICKS_PER_TRANSITION_CHECK = 6;
const MAX_INTENSITY = 5;
const BLOCKING_INTENSITY_THRESHOLD = 4;

const WEATHER_TYPES: WeatherType[] = [
  "clear",
  "rain",
  "fog",
  "storm",
  "snow",
  "extreme_heat",
  "extreme_cold",
];

const TRANSITION_MATRIX: number[][] = [
  [0.65, 0.1, 0.1, 0.02, 0.03, 0.05, 0.05],
  [0.1, 0.45, 0.1, 0.2, 0.05, 0.0, 0.1],
  [0.25, 0.15, 0.55, 0.0, 0.03, 0.02, 0.0],
  [0.05, 0.35, 0.0, 0.5, 0.05, 0.0, 0.05],
  [0.05, 0.05, 0.05, 0.05, 0.55, 0.0, 0.25],
  [0.25, 0.0, 0.05, 0.03, 0.0, 0.67, 0.0],
  [0.1, 0.0, 0.05, 0.05, 0.2, 0.0, 0.6],
];

const INTENSITY_NO_CHANGE = 0.6;
const INTENSITY_UP = 0.2;

// ===== Skill Penalty Definitions =====

interface SkillPenaltyRule {
  skill: string;
  triggerIntensity: number;
  deltaPerLevel: number;
}

const WEATHER_SKILL_PENALTIES: Partial<
  Record<WeatherType, SkillPenaltyRule[]>
> = {
  rain: [
    { skill: "Perception", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Track", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Drive Auto", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Listen", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Climb", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Pistol", triggerIntensity: 3, deltaPerLevel: -5 },
    { skill: "Rifle", triggerIntensity: 3, deltaPerLevel: -5 },
    { skill: "Submachine Gun", triggerIntensity: 3, deltaPerLevel: -5 },
    { skill: "Bow", triggerIntensity: 3, deltaPerLevel: -5 },
    { skill: "Electrical Repair", triggerIntensity: 3, deltaPerLevel: -5 },
  ],
  fog: [
    { skill: "Perception", triggerIntensity: 1, deltaPerLevel: -10 },
    { skill: "Navigate", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Drive Auto", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Track", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Pistol", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Rifle", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Submachine Gun", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Bow", triggerIntensity: 2, deltaPerLevel: -5 },
  ],
  storm: [
    { skill: "Perception", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Listen", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Drive Auto", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Navigate", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Climb", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Swim", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Pilot (Boat)", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Pistol", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Rifle", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Submachine Gun", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Bow", triggerIntensity: 2, deltaPerLevel: -5 },
  ],
  snow: [
    { skill: "Perception", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Drive Auto", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Climb", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Track", triggerIntensity: 3, deltaPerLevel: -5 },
    { skill: "Navigate", triggerIntensity: 3, deltaPerLevel: -5 },
  ],
  extreme_heat: [
    { skill: "Climb", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Stealth", triggerIntensity: 3, deltaPerLevel: -5 },
  ],
  extreme_cold: [
    { skill: "Locksmith", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Sleight of Hand", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Climb", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Mechanical Repair", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Electrical Repair", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Swim", triggerIntensity: 2, deltaPerLevel: -10 },
    { skill: "Pistol", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Rifle", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Submachine Gun", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Bow", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "First Aid", triggerIntensity: 3, deltaPerLevel: -5 },
  ],
};

// ===== Helper Functions =====

function getWeatherState(
  dgsm: DynamicGameStateManager,
  regionId: string
): WeatherRegionState | undefined {
  return dgsm.getFeatureSceneState(FEATURE_ID, regionId) as
    | WeatherRegionState
    | undefined;
}

function setWeatherState(
  dgsm: DynamicGameStateManager,
  regionId: string,
  state: WeatherRegionState
): void {
  dgsm.setFeatureSceneState(FEATURE_ID, regionId, state);
}

function getAllWeatherRegions(dgsm: DynamicGameStateManager): string[] {
  return Object.keys(dgsm.getFeatureState(FEATURE_ID));
}

function getOutdoorSceneIds(
  dgsm: DynamicGameStateManager,
  regionId: string
): string[] {
  const state = dgsm.getState();
  const sceneIds: string[] = [];
  state.scenes.forEach((scene, id) => {
    if (scene.parentLocationId === regionId && !scene.indoor) {
      sceneIds.push(id);
    }
  });
  for (const [id, junc] of state.junctions) {
    if (junc.parentLocationId === regionId) {
      sceneIds.push(id);
    }
  }
  for (const [id, road] of state.roads) {
    if (road.parentLocationId === regionId) {
      sceneIds.push(id);
    }
  }
  return sceneIds;
}

function createWeatherState(
  weatherType: WeatherType,
  intensity: number,
  affectedSceneIds: string[]
): WeatherRegionState {
  return {
    weatherType,
    intensity:
      weatherType === "clear"
        ? 0
        : Math.max(1, Math.min(intensity, MAX_INTENSITY)),
    ticksInState: 0,
    affectedSceneIds,
  };
}

function sampleTransition(currentType: WeatherType): WeatherType {
  const rowIndex = WEATHER_TYPES.indexOf(currentType);
  const row = TRANSITION_MATRIX[rowIndex];
  const r = Math.random();
  let cumulative = 0;
  for (let i = 0; i < row.length; i++) {
    cumulative += row[i];
    if (r < cumulative) return WEATHER_TYPES[i];
  }
  return WEATHER_TYPES[row.length - 1];
}

function evolveIntensity(current: number): number {
  const r = Math.random();
  if (r < INTENSITY_NO_CHANGE) return current;
  if (r < INTENSITY_NO_CHANGE + INTENSITY_UP)
    return Math.min(current + 1, MAX_INTENSITY);
  return current - 1;
}

function computeSkillPenalties(
  weatherType: WeatherType,
  intensity: number
): Array<{ skill: string; delta: number }> {
  const rules = WEATHER_SKILL_PENALTIES[weatherType];
  if (!rules || intensity <= 0) return [];

  const penalties: Array<{ skill: string; delta: number }> = [];
  for (const rule of rules) {
    if (intensity >= rule.triggerIntensity) {
      penalties.push({
        skill: rule.skill,
        delta: rule.deltaPerLevel * intensity,
      });
    }
  }
  return penalties;
}

const WEATHER_LABELS: Record<WeatherType, string[]> = {
  clear: ["Clear skies"],
  rain: [
    "",
    "Light drizzle",
    "Moderate rain",
    "Heavy rain",
    "Downpour",
    "Torrential rain",
  ],
  fog: [
    "",
    "Light mist",
    "Moderate fog",
    "Thick fog",
    "Dense fog",
    "Zero visibility fog",
  ],
  storm: [
    "",
    "Light winds",
    "Gusty winds",
    "Strong storm",
    "Severe storm",
    "Hurricane-force winds",
  ],
  snow: [
    "",
    "Light flurries",
    "Moderate snow",
    "Heavy snow",
    "Blizzard",
    "Severe blizzard",
  ],
  extreme_heat: ["", "Warm", "Hot", "Very hot", "Extreme heat", "Lethal heat"],
  extreme_cold: [
    "",
    "Chilly",
    "Cold",
    "Very cold",
    "Extreme cold",
    "Lethal cold",
  ],
};

function getWeatherLabel(weatherType: WeatherType, intensity: number): string {
  if (weatherType === "clear") return "Clear skies";
  const labels = WEATHER_LABELS[weatherType];
  return labels[intensity] ?? labels[labels.length - 1];
}

function writeWeatherConditions(
  dgsm: DynamicGameStateManager,
  regionState: WeatherRegionState
): void {
  const { weatherType, intensity, affectedSceneIds } = regionState;

  for (const sceneId of affectedSceneIds) {
    clearWeatherConditions(dgsm, sceneId);

    if (weatherType === "clear" || intensity <= 0) continue;

    const label = getWeatherLabel(weatherType, intensity);
    const penalties = computeSkillPenalties(weatherType, intensity);

    dgsm.appendSceneCondition(sceneId, {
      description: `[Weather] ${label}`,
      mechanicalEffect:
        penalties.length > 0 ? { skillPenalty: penalties } : undefined,
    });
  }
}

function clearWeatherConditions(
  dgsm: DynamicGameStateManager,
  sceneId: string
): void {
  const state = dgsm.getState();
  const conditions = state.scenarioConditions[sceneId];
  if (!conditions) return;
  (dgsm.getState() as any).scenarioConditions[sceneId] = conditions.filter(
    (c: any) => !c.description.startsWith("[Weather]")
  );
}

function updateWeatherBlocking(
  dgsm: DynamicGameStateManager,
  regionState: WeatherRegionState
): void {
  const { weatherType, intensity, affectedSceneIds } = regionState;
  const shouldBlock =
    (weatherType === "storm" || weatherType === "snow") &&
    intensity >= BLOCKING_INTENSITY_THRESHOLD;

  for (const sceneId of affectedSceneIds) {
    const scene = dgsm.getScene(sceneId);
    if (!scene) continue;

    for (const connId of scene.connections ?? []) {
      const connScene = dgsm.getScene(connId);
      if (!connScene || (connScene as any).indoor) continue;

      if (shouldBlock) {
        dgsm.setConnectionBlocked(
          connId,
          sceneId,
          true,
          `Blocked by ${weatherType} (intensity ${intensity})`
        );
      } else {
        const reason = dgsm.getConnectionBlockReason(connId, sceneId);
        if (
          reason &&
          (reason.startsWith("Blocked by storm") ||
            reason.startsWith("Blocked by snow"))
        ) {
          dgsm.setConnectionBlocked(sceneId, connId, false, "");
        }
      }
    }
  }
}

// ===== Initialization =====

function initWeatherFromPresets(dgsm: DynamicGameStateManager): void {
  const state = dgsm.getState();

  const regionIds = new Set<string>();
  state.scenes.forEach((scene) => {
    regionIds.add(scene.parentLocationId);
  });
  for (const [, junc] of state.junctions) {
    regionIds.add(junc.parentLocationId);
  }
  for (const [, road] of state.roads) {
    regionIds.add(road.parentLocationId);
  }

  const presets: Array<{
    regionId: string;
    weatherType: WeatherType;
    intensity: number;
  }> = (state as any).moduleSetup?.weatherPresets ?? [];

  const presetMap = new Map<
    string,
    { weatherType: WeatherType; intensity: number }
  >();
  for (const p of presets) {
    presetMap.set(p.regionId, {
      weatherType: p.weatherType,
      intensity: p.intensity,
    });
  }

  for (const regionId of regionIds) {
    const outdoorScenes = getOutdoorSceneIds(dgsm, regionId);
    if (outdoorScenes.length === 0) continue;

    const preset = presetMap.get(regionId);
    const weatherType = preset?.weatherType ?? "clear";
    const intensity = preset?.intensity ?? 0;

    const regionState = createWeatherState(
      weatherType,
      intensity,
      outdoorScenes
    );
    setWeatherState(dgsm, regionId, regionState);

    if (weatherType !== "clear" && intensity > 0) {
      writeWeatherConditions(dgsm, regionState);
      updateWeatherBlocking(dgsm, regionState);
    }
  }
}

// ===== Exported Feature =====

export const weatherFeature: WorldFeature = {
  id: FEATURE_ID,
  description:
    "Regional weather system — Markov chain evolution with skill penalties and connection blocking",

  planningPrompt: `## Weather
Current weather conditions are shown in the state description below.
Weather changes automatically — you do NOT need to set or control weather.
Weather affects outdoor scenes only (skill penalties, blocked paths in severe weather).`,

  stateDescription(dgsm: DynamicGameStateManager): string {
    const regionIds = getAllWeatherRegions(dgsm);
    if (regionIds.length === 0) return "";

    const lines: string[] = [];
    for (const regionId of regionIds) {
      const ws = getWeatherState(dgsm, regionId);
      if (!ws || ws.weatherType === "clear") continue;
      const label = getWeatherLabel(ws.weatherType, ws.intensity);
      lines.push(
        `- ${regionId}: ${ws.weatherType} intensity ${ws.intensity}/5 (${label})`
      );
    }

    if (lines.length === 0) return "Weather: Clear in all regions";
    return "Weather:\n" + lines.join("\n");
  },

  tick(dgsm: DynamicGameStateManager, _runtime: TickRuntimeContext): void {
    const regions = getAllWeatherRegions(dgsm);
    if (regions.length === 0) {
      initWeatherFromPresets(dgsm);
      return;
    }

    for (const regionId of regions) {
      const ws = getWeatherState(dgsm, regionId);
      if (!ws) continue;

      ws.ticksInState++;

      if (ws.ticksInState >= TICKS_PER_TRANSITION_CHECK) {
        ws.ticksInState = 0;

        const newType = sampleTransition(ws.weatherType);

        if (newType !== ws.weatherType) {
          ws.weatherType = newType;
          ws.intensity = newType === "clear" ? 0 : 1;
        } else if (ws.weatherType !== "clear") {
          ws.intensity = evolveIntensity(ws.intensity);
          if (ws.intensity <= 0) {
            ws.weatherType = "clear";
            ws.intensity = 0;
          }
        }

        writeWeatherConditions(dgsm, ws);
        updateWeatherBlocking(dgsm, ws);
      }

      setWeatherState(dgsm, regionId, ws);
    }
  },
};
