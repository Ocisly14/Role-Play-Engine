import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { SceneCondition, StateChange } from "../core/types.js";
import type { WorldFeature } from "../core/worldFeature.js";

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
  minutesInState: number;
  affectedSceneIds: string[];
}

export interface WeatherInitConfigEntry {
  regionId: string;
  weatherType: WeatherType;
  intensity: number;
}

// ===== Constants =====

const FEATURE_ID = "weather";
const TRANSITION_CHECK_INTERVAL_MINUTES = 120;
const MAX_INTENSITY = 5;
const BLOCKING_INTENSITY_THRESHOLD = 4;
// Stable vote id for Applier's connection.setBlock refcount table.
// A single logical vote per connection per feature — additions and withdrawals
// across weather transitions must match via identical (featureId, reason).
const WEATHER_BLOCK_REASON = "weather-block";

export const WEATHER_TYPES: readonly WeatherType[] = [
  "clear",
  "rain",
  "fog",
  "storm",
  "snow",
  "extreme_heat",
  "extreme_cold",
];

// Row-per-current-type transition probabilities indexed by WEATHER_TYPES order.
// Rows are expected to sum to ≈ 1.0 (see test).
export const TRANSITION_MATRIX: readonly (readonly number[])[] = [
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

// ===== Pure helpers (exported for testing) =====

export function getWeatherLabel(
  weatherType: WeatherType,
  intensity: number
): string {
  if (weatherType === "clear") return "Clear skies";
  const labels = WEATHER_LABELS[weatherType];
  return labels[intensity] ?? labels[labels.length - 1];
}

export function computeSkillPenalties(
  weatherType: WeatherType,
  intensity: number
): Array<{ skill: string; delta: number }> {
  const rules = WEATHER_SKILL_PENALTIES[weatherType];
  if (!rules || intensity <= 0) return [];
  const out: Array<{ skill: string; delta: number }> = [];
  for (const rule of rules) {
    if (intensity >= rule.triggerIntensity) {
      out.push({ skill: rule.skill, delta: rule.deltaPerLevel * intensity });
    }
  }
  return out;
}

export function sampleTransition(currentType: WeatherType): WeatherType {
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

export function evolveIntensity(current: number): number {
  const r = Math.random();
  if (r < INTENSITY_NO_CHANGE) return current;
  if (r < INTENSITY_NO_CHANGE + INTENSITY_UP)
    return Math.min(current + 1, MAX_INTENSITY);
  return current - 1;
}

// ===== Internal emit helpers =====

/**
 * Stable, order-independent connection vote id for a scene pair. Matches the
 * Applier's single-id vote table — reason strings are still attached so the
 * applier can deduplicate votes by (featureId, reason).
 */
function connectionIdFor(a: string, b: string): string {
  return a <= b ? `weather:${a}|${b}` : `weather:${b}|${a}`;
}

function buildWeatherSceneCondition(
  sceneId: string,
  state: WeatherRegionState
): StateChange {
  const label = getWeatherLabel(state.weatherType, state.intensity);
  const penaltyArr = computeSkillPenalties(state.weatherType, state.intensity);
  const skillPenalty: Record<string, number> = {};
  for (const { skill, delta } of penaltyArr) {
    skillPenalty[skill] = (skillPenalty[skill] ?? 0) + delta;
  }
  const condition: SceneCondition = {
    featureId: FEATURE_ID,
    description: `[Weather] ${label}`,
    mechanicalEffect: penaltyArr.length > 0 ? { skillPenalty } : undefined,
  };
  return { kind: "scene.addCondition", sceneId, condition };
}

/**
 * Emit environment contributions (temperature, illumination cap) for every
 * outdoor location affected by the given weather state. Called from both
 * init() and onTick() so every tick re-contributes (Applier requires this —
 * unvisited locations retain prior readings).
 */
function emitEnvContributions(state: WeatherRegionState): StateChange[] {
  if (state.weatherType === "clear" || state.intensity <= 0) return [];
  const { weatherType, intensity, affectedSceneIds } = state;
  const out: StateChange[] = [];

  for (const sceneId of affectedSceneIds) {
    let tempDelta = 0;
    if (weatherType === "rain") tempDelta = -10 * intensity * 0.2;
    else if (weatherType === "storm") tempDelta = -15;
    else if (weatherType === "snow") tempDelta = -20;
    else if (weatherType === "extreme_heat") tempDelta = +30;
    else if (weatherType === "extreme_cold") tempDelta = -30;
    if (tempDelta !== 0) {
      out.push({
        kind: "environment.contribute",
        locationId: sceneId,
        quantity: "temperature",
        value: tempDelta,
        sourceFeatureId: FEATURE_ID,
      });
    }
    if (weatherType === "fog") {
      const capValue = intensity >= 3 ? 1 : 2;
      out.push({
        kind: "environment.cap",
        locationId: sceneId,
        quantity: "illumination",
        value: capValue,
        sourceFeatureId: FEATURE_ID,
      });
    } else if (weatherType === "storm") {
      const capValue = intensity >= 4 ? 1 : 2;
      out.push({
        kind: "environment.cap",
        locationId: sceneId,
        quantity: "illumination",
        value: capValue,
        sourceFeatureId: FEATURE_ID,
      });
    }
  }
  return out;
}

/**
 * Emit connection.setBlock StateChanges for outdoor↔outdoor connections in a
 * region, given the current weather state. Needs ctx for neighbor iteration,
 * so this lives outside emitEnvContributions.
 */
function emitConnectionBlocks(
  state: WeatherRegionState,
  ctx: FeatureReadContext
): StateChange[] {
  const { weatherType, intensity, affectedSceneIds } = state;
  const shouldBlock =
    (weatherType === "storm" || weatherType === "snow") &&
    intensity >= BLOCKING_INTENSITY_THRESHOLD;
  const out: StateChange[] = [];
  // Constant reason so Applier's (featureId, reason) refcount table
  // matches additions and withdrawals across weather transitions.
  // Human-readable diagnostics can come from other channels (featureEvents
  // or scene conditions); this field is for vote dedup only.
  const reason = WEATHER_BLOCK_REASON;

  for (const sceneId of affectedSceneIds) {
    const scene = ctx.getScene(sceneId);
    if (!scene) continue;
    for (const conn of scene.connections ?? []) {
      const other = ctx.getScene(conn.targetId);
      // Only outdoor↔outdoor edges are weather-blockable.
      if (!other || other.indoor) continue;
      out.push({
        kind: "connection.setBlock",
        connectionId: connectionIdFor(sceneId, conn.targetId),
        blocked: shouldBlock,
        sourceFeatureId: FEATURE_ID,
        reason,
      });
    }
  }
  return out;
}

function makeRegionState(
  preset: WeatherInitConfigEntry,
  affectedSceneIds: string[]
): WeatherRegionState {
  const intensity =
    preset.weatherType === "clear"
      ? 0
      : Math.max(1, Math.min(preset.intensity, MAX_INTENSITY));
  return {
    weatherType: preset.weatherType,
    intensity,
    minutesInState: 0,
    affectedSceneIds,
  };
}

// ===== Exported Feature =====

export const weatherFeature: WorldFeature = {
  id: FEATURE_ID,
  description:
    "Regional weather — Markov evolution with env contributions and scene conditions",
  stateScope: "region",
  affectedKinds: [
    "feature.setState",
    "feature.removeState",
    "scene.addCondition",
    "scene.removeCondition",
    "environment.contribute",
    "environment.cap",
    "connection.setBlock",
  ],
  effectSummary:
    "Per-region weather contributing temperature/illumination cap to env and writing scene conditions with skill penalties.",
  priority: 100,
  planningPrompt: `## Weather
Current weather conditions are shown in the state description below.
Weather changes automatically — you do NOT need to set or control weather.
Weather affects outdoor scenes only (skill penalties, blocked paths in severe weather).`,

  init(ctx) {
    const presets =
      ctx.getFeatureInitConfig<WeatherInitConfigEntry[]>(FEATURE_ID);
    if (!presets || presets.length === 0) return [];
    const out: StateChange[] = [];
    for (const preset of presets) {
      const affectedSceneIds = ctx.getOutdoorLocationIdsInRegion(
        preset.regionId
      );
      if (affectedSceneIds.length === 0) continue;
      const regionState = makeRegionState(preset, affectedSceneIds);
      out.push({
        kind: "feature.setState",
        featureId: FEATURE_ID,
        key: preset.regionId,
        state: regionState,
      });
      out.push(...emitEnvContributions(regionState));
      if (regionState.weatherType !== "clear" && regionState.intensity > 0) {
        for (const sceneId of regionState.affectedSceneIds) {
          out.push(buildWeatherSceneCondition(sceneId, regionState));
        }
      }
      out.push(...emitConnectionBlocks(regionState, ctx));
    }
    return out;
  },

  onTick(ctx) {
    const out: StateChange[] = [];
    const states = ctx.getAllFeatureStates<WeatherRegionState>();
    for (const { key: regionId, state } of states) {
      const next: WeatherRegionState = {
        ...state,
        affectedSceneIds: [...state.affectedSceneIds],
        minutesInState: state.minutesInState + ctx.tickDurationMinutes,
      };
      let transitioned = false;
      while (next.minutesInState >= TRANSITION_CHECK_INTERVAL_MINUTES) {
        next.minutesInState -= TRANSITION_CHECK_INTERVAL_MINUTES;
        const newType = sampleTransition(next.weatherType);
        if (newType !== next.weatherType) {
          next.weatherType = newType;
          next.intensity = newType === "clear" ? 0 : 1;
          transitioned = true;
        } else if (next.weatherType !== "clear") {
          const newIntensity = evolveIntensity(next.intensity);
          if (newIntensity !== next.intensity) transitioned = true;
          next.intensity = newIntensity;
          if (next.intensity <= 0) {
            next.weatherType = "clear";
            next.intensity = 0;
          }
        }
      }

      out.push({
        kind: "feature.setState",
        featureId: FEATURE_ID,
        key: regionId,
        state: next,
      });

      // Re-contribute env quantities every tick so the Applier's fresh-per-tick
      // env reading stays populated. (Applier only writes readings for
      // locations visited in the current flush.)
      out.push(...emitEnvContributions(next));

      // Conditions and connection blocking only change on transitions — the
      // Applier doesn't dedupe scene conditions by featureId, so we first
      // remove stale `[Weather]` conditions, then add the current one.
      if (transitioned) {
        for (const sceneId of next.affectedSceneIds) {
          out.push({
            kind: "scene.removeCondition",
            sceneId,
            predicate: { featureId: FEATURE_ID },
          });
          if (next.weatherType !== "clear" && next.intensity > 0) {
            out.push(buildWeatherSceneCondition(sceneId, next));
          }
        }
        out.push(...emitConnectionBlocks(next, ctx));
      }
    }
    return out;
  },

  stateDescription(ctx) {
    const states = ctx.getAllFeatureStates<WeatherRegionState>();
    if (states.length === 0) return "";
    const lines: string[] = [];
    for (const { key: regionId, state } of states) {
      if (state.weatherType === "clear") continue;
      const label = getWeatherLabel(state.weatherType, state.intensity);
      lines.push(
        `- ${regionId}: ${state.weatherType} intensity ${state.intensity}/5 (${label})`
      );
    }
    if (lines.length === 0) return "Weather: Clear in all regions";
    return `Weather:\n${lines.join("\n")}`;
  },
};
