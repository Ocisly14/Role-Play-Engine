// src/engine/subsystem/weather.ts
//
// Regional weather: the state machine (type, intensity, the 120-minute
// transition check) and the numbers it contributes to the environment
// (temperature, an illumination cap). What the weather DOES to a region —
// which passages it closes, what each outdoor place is like under it — is
// not a rule here: on every change this subsystem emits a
// internal `weather.transition` signal, and the orchestrator asks the weather engine
// (src/engine/weather/) to judge it from the places' own prose.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  type FeatureReadContext,
  makeDGSMFeatureReadContext,
} from "../core/featureReadContext.js";
import type { StateChange } from "../core/types.js";
import type { AnchorSubsystem } from "./types.js";

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
  /** The weather-edge ids the weather engine closed at its last judgement
   *  for this region — the diff base for the next one: a passage it does not
   *  close again reopens. Absent before any judgement. */
  judgedBlockIds?: string[];
}

export interface WeatherInitConfigEntry {
  regionId: string;
  weatherType: WeatherType;
  intensity: number;
}

export interface WeatherTransitionEventData {
  regionId: string;
  state: WeatherRegionState;
}

// ===== Constants =====

export const WEATHER_FEATURE_ID = "weather";
const FEATURE_ID = WEATHER_FEATURE_ID;
/** Region-scoped state, so a read context for this subsystem must say so. */
const ANCHOR_KIND = "region" as const;
const TRANSITION_CHECK_INTERVAL_MINUTES = 120;
const MAX_INTENSITY = 5;
/** The tick's word to the orchestrator that a region's weather changed. */
export const WEATHER_TRANSITION_EVENT = "weather.transition";

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
    { skill: "Investigation", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Land Vehicle Operation", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Athletics", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Ranged Combat", triggerIntensity: 3, deltaPerLevel: -5 },
    { skill: "Repair & Engineering", triggerIntensity: 3, deltaPerLevel: -5 },
  ],
  fog: [
    { skill: "Investigation", triggerIntensity: 1, deltaPerLevel: -10 },
    { skill: "Survival & Navigation", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Land Vehicle Operation", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Ranged Combat", triggerIntensity: 2, deltaPerLevel: -5 },
  ],
  storm: [
    { skill: "Investigation", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Land Vehicle Operation", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Survival & Navigation", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Athletics", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Swimming", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Watercraft Operation", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Ranged Combat", triggerIntensity: 2, deltaPerLevel: -5 },
  ],
  snow: [
    { skill: "Investigation", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Land Vehicle Operation", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Athletics", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Survival & Navigation", triggerIntensity: 3, deltaPerLevel: -5 },
  ],
  extreme_heat: [
    { skill: "Athletics", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Stealth & Security", triggerIntensity: 3, deltaPerLevel: -5 },
  ],
  extreme_cold: [
    { skill: "Stealth & Security", triggerIntensity: 1, deltaPerLevel: -5 },
    { skill: "Athletics", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Repair & Engineering", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Swimming", triggerIntensity: 2, deltaPerLevel: -10 },
    { skill: "Ranged Combat", triggerIntensity: 2, deltaPerLevel: -5 },
    { skill: "Medicine & Psychology", triggerIntensity: 3, deltaPerLevel: -5 },
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
 * The orchestrator's cue that this region's weather changed and the weather
 * engine must judge what it does. A subsystem returns StateChanges and
 * nothing else, so the cue temporarily rides as a FeatureEvent-shaped change;
 * the orchestrator consumes it before the Applier/public event stream.
 */
function transitionEvent(
  regionId: string,
  state: WeatherRegionState
): StateChange {
  const data: WeatherTransitionEventData = { regionId, state };
  return {
    kind: "event.emit",
    event: {
      type: WEATHER_TRANSITION_EVENT,
      impact: 0,
      description: `weather in ${regionId}: ${getWeatherLabel(state.weatherType, state.intensity)}`,
      data: data as unknown as Record<string, unknown>,
    },
  };
}

/**
 * Emit environment contributions (temperature, illumination cap) for every
 * outdoor location affected by the given weather state. Called from both
 * initialState() and onTick() so every tick re-contributes (Applier requires
 * this — unvisited locations retain prior readings).
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

/**
 * The changes that put a region into a given weather, as a real transition
 * would leave it. Exported for the scripted-event effect `weather.set`.
 *
 * Setting the state bucket alone is not enough, and that is the whole reason
 * this exists: `onTick` emits the transition event that has the weather engine
 * re-judge the region ONLY when it decides a transition happened, and its
 * transition check runs every 120 in-world minutes. A script that wrote the
 * bucket by itself would leave "[Weather] 暴雪" hanging over a light snowfall,
 * and every road it had closed still closed, for up to two hours.
 *
 * Scripts keep the module contract and cannot invent a region no preset
 * created. An explicit external override may opt into seeding a real region;
 * a truly unknown/indoor-only region still returns [].
 */
export function buildWeatherSetChanges(
  regionId: string,
  weatherType: WeatherType,
  intensity: number,
  dgsm: DynamicGameStateManager,
  seedIfMissing = false
): StateChange[] {
  // Built here rather than handed in: the feature id and the region scope are
  // this subsystem's own facts, and a caller that had to know them would be a
  // second place to keep them right.
  const ctx = makeDGSMFeatureReadContext(dgsm, {
    callerFeatureId: FEATURE_ID,
    callerScope: ANCHOR_KIND,
  });
  const current = ctx.getFeatureState<WeatherRegionState>(regionId);
  if (!current && !seedIfMissing) return [];
  const affectedSceneIds =
    current?.affectedSceneIds ?? ctx.getOutdoorLocationIdsInRegion(regionId);
  if (affectedSceneIds.length === 0) return [];

  const clamped =
    weatherType === "clear"
      ? 0
      : Math.max(1, Math.min(Math.trunc(intensity), MAX_INTENSITY));
  // Everything else the region remembers — judgedBlockIds above all — survives
  // a script's change of weather, or the engine's next diff could not lift
  // what it closed.
  const next: WeatherRegionState = {
    ...(current ?? {
      weatherType: "clear" as const,
      intensity: 0,
      minutesInState: 0,
      affectedSceneIds,
    }),
    weatherType,
    intensity: clamped,
    // The clock on the next natural transition restarts here: the script has
    // just decided what the weather is, so the region has been in it 0 minutes.
    minutesInState: 0,
    affectedSceneIds: [...affectedSceneIds],
  };

  return [
    {
      kind: "feature.setState",
      featureId: FEATURE_ID,
      key: regionId,
      state: next,
    },
    transitionEvent(regionId, next),
    ...emitEnvContributions(next),
  ];
}

// ===== Exported AnchorSubsystem =====

export const weatherSubsystem: AnchorSubsystem = {
  id: FEATURE_ID,
  kind: "anchor",
  anchorKind: ANCHOR_KIND,
  description:
    "Regional weather — Markov evolution with env contributions; passages and conditions are judged by the weather engine",
  effectSummary:
    "Per-region weather contributing temperature/illumination cap to env; passages and conditions are judged by the weather engine on each change.",
  affectedKinds: [
    "feature.setState",
    "feature.removeState",
    "environment.contribute",
    "environment.cap",
    "event.emit",
  ],
  priority: 100,
  planningPrompt: `## Weather
Current weather conditions are shown in the state description below.
Weather changes automatically — you do NOT need to set or control weather.
Weather affects outdoor scenes only (skill penalties; in severe weather the weather engine closes exposed passages).`,

  /**
   * Weather exists wherever a region exists — always true.
   * (Actual state is only seeded when a preset config is present.)
   */
  shouldExist(_anchorId: string, _ctx: FeatureReadContext): boolean {
    return true;
  },

  /**
   * Seed initial weather state for a single region (anchorId). Mirrors the
   * per-region branch inside weatherFeature.init(ctx) — the outer loop over
   * presets is replaced by a lookup on the one preset matching anchorId.
   */
  initialState(anchorId: string, ctx: FeatureReadContext): StateChange[] {
    const presets =
      ctx.getFeatureInitConfig<WeatherInitConfigEntry[]>(FEATURE_ID);
    if (!presets || presets.length === 0) return [];
    const preset = presets.find((p) => p.regionId === anchorId);
    if (!preset) return [];

    const affectedSceneIds = ctx.getOutdoorLocationIdsInRegion(anchorId);
    if (affectedSceneIds.length === 0) return [];

    const regionState = makeRegionState(preset, affectedSceneIds);
    return [
      {
        kind: "feature.setState",
        featureId: FEATURE_ID,
        key: anchorId,
        state: regionState,
      },
      ...emitEnvContributions(regionState),
      transitionEvent(anchorId, regionState),
    ];
  },

  /**
   * Advance weather for a single region (anchorId) by one tick. Mirrors the
   * per-region branch inside weatherFeature.onTick(ctx) — the outer
   * getAllFeatureStates loop is replaced by reading the single bucket for
   * anchorId.
   */
  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[] {
    const state = ctx.getFeatureState<WeatherRegionState>(anchorId);
    if (!state) return [];

    const out: StateChange[] = [];
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
      key: anchorId,
      state: next,
    });

    // Re-contribute env quantities every tick so the Applier's fresh-per-tick
    // env reading stays populated. (Applier only writes readings for
    // locations visited in the current flush.)
    out.push(...emitEnvContributions(next));

    // What the change does to the region is the weather engine's judgement,
    // asked for once per change through this event.
    if (transitioned) out.push(transitionEvent(anchorId, next));
    return out;
  },

  /**
   * Render all region weather states as human-readable prose. Iterates all
   * region buckets via ctx.getAllFeatureStates() — no per-anchor scoping needed.
   */
  stateDescription(ctx: FeatureReadContext): string {
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
