import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { SceneCondition, StateChange } from "../core/types.js";
import type { AnchorSubsystem } from "./types.js";

// ===== Constants =====

const FEATURE_ID = "sun";

// Default fallback when an item is declared as a light source but has no
// lightLevel set. Matches the implicit "normal lighting" baseline (3).
const DEFAULT_ITEM_LIGHT_LEVEL = 3;

// Night moonlight contribution — emitted in addition to the sun value when
// the sun curve is at its minimum. Reducer takes max across contributions,
// so this only becomes the winner when nothing brighter is present.
const MOONLIGHT_LEVEL = 2;

// Scene illumination levels at which no `[Lighting]` condition is emitted.
// Level 3 = "Normal lighting", level 4 = "Bright" — neither imposes penalties.
const NORMAL_ILLUM_MIN = 3;
const NORMAL_ILLUM_MAX = 4;

// ===== Light level labels (ported verbatim from lightingFeature) =====

const LIGHT_LEVEL_LABELS = [
  "",
  "Pitch black",
  "Dark",
  "Normal lighting",
  "Bright",
  "Blinding light",
];

// ===== Skill penalties (ported from lightingFeature, array form) =====

interface LightPenaltyEntry {
  skill: string;
  delta: number;
}

const LIGHT_LEVEL_PENALTIES: Record<number, LightPenaltyEntry[]> = {
  1: [
    { skill: "Investigation", delta: -40 },
    { skill: "Survival & Navigation", delta: -30 },
    { skill: "Ranged Combat", delta: -40 },
    { skill: "Athletics", delta: -20 },
    { skill: "Land Vehicle Operation", delta: -30 },
  ],
  2: [
    { skill: "Investigation", delta: -20 },
    { skill: "Survival & Navigation", delta: -15 },
    { skill: "Ranged Combat", delta: -20 },
    { skill: "Athletics", delta: -10 },
    { skill: "Land Vehicle Operation", delta: -15 },
  ],
  3: [],
  4: [],
  5: [
    { skill: "Investigation", delta: -15 },
    { skill: "Ranged Combat", delta: -15 },
  ],
};

// ===== Sun curve (ported verbatim from lightingFeature.computeSunLevel) =====

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}

/**
 * Compute sun level (1-5) for a given HH:MM tick time.
 * Dawn 4-7 rises 1→4, midday 12-13 peaks at 5, evening 17-20 falls 5→1, night 1.
 */
export function computeSunLevel(timeStr: string): number {
  const [hStr, mStr] = timeStr.split(":");
  const h = Number.parseInt(hStr, 10);
  const m = Number.parseInt(mStr, 10);
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

// ===== Emit helpers =====

function buildLightingCondition(illumination: number): SceneCondition {
  const label = LIGHT_LEVEL_LABELS[illumination] ?? LIGHT_LEVEL_LABELS[1];
  const penaltyArr = LIGHT_LEVEL_PENALTIES[illumination] ?? [];
  const skillPenalty: Record<string, number> = {};
  for (const { skill, delta } of penaltyArr) {
    skillPenalty[skill] = (skillPenalty[skill] ?? 0) + delta;
  }
  return {
    featureId: FEATURE_ID,
    description: `[Lighting] ${label}`,
    mechanicalEffect: penaltyArr.length > 0 ? { skillPenalty } : undefined,
  };
}

function contributeIllumination(
  locationId: string,
  value: number
): StateChange {
  return {
    kind: "environment.contribute",
    locationId,
    quantity: "illumination",
    value,
    sourceFeatureId: FEATURE_ID,
  };
}

// ===== Exported subsystem =====

export const sunSubsystem: AnchorSubsystem = {
  id: FEATURE_ID,
  kind: "anchor",
  anchorKind: "global",
  description:
    "Time-of-day illumination + scene-condition observer for dark/blinding light levels",
  affectedKinds: ["environment.contribute"],
  effectSummary:
    "Time-of-day sun curve + item light source contributions; writes [Lighting] scene conditions for non-normal levels",
  priority: 150,
  planningPrompt: `## Lighting
Current lighting conditions are shown in the state description below.
Lighting changes automatically with time of day, weather, and light-source items.
Dark environments impose skill penalties; blinding light also impairs vision.`,

  shouldExist(_anchorId: string, _ctx: FeatureReadContext): boolean {
    return true;
  },

  initialState(_anchorId: string, _ctx: FeatureReadContext): StateChange[] {
    return [];
  },

  onTick(_anchorId: string, ctx: FeatureReadContext): StateChange[] {
    const out: StateChange[] = [];
    const sunLevel = computeSunLevel(ctx.tickTime);
    const isNight = sunLevel === 1;

    // ----- Step B: sun contribution to outdoor scenes + outdoor topology -----
    for (const sceneId of ctx.getSceneIds()) {
      const scene = ctx.getScene(sceneId);
      if (!scene) continue;
      if (scene.indoor === true) continue;
      out.push(contributeIllumination(sceneId, sunLevel));
      if (isNight) {
        out.push(contributeIllumination(sceneId, MOONLIGHT_LEVEL));
      }
    }

    // Roads are always outdoor — contribute unconditionally.
    for (const roadId of ctx.getRoadIds()) {
      out.push(contributeIllumination(roadId, sunLevel));
      if (isNight) {
        out.push(contributeIllumination(roadId, MOONLIGHT_LEVEL));
      }
    }

    // ----- Step C: item light sources (indoor & outdoor scenes) -----
    for (const sceneId of ctx.getSceneIds()) {
      const scene = ctx.getScene(sceneId);
      if (!scene?.items) continue;
      for (const item of scene.items) {
        // A lamp that stops working stops being a light source: there is no
        // separate damaged flag any more, so breaking one clears this.
        if (!item.isLightSource) continue;
        const level = item.lightLevel ?? DEFAULT_ITEM_LIGHT_LEVEL;
        out.push(contributeIllumination(sceneId, level));
      }
    }

    // ----- Step D: scene-condition observer (1-tick lag) -----
    // The env reading we read here reflects the PREVIOUS tick's aggregation —
    // this tick's `environment.contribute` emissions haven't been flushed yet.
    // On the very first tick, env.illumination returns the default baseline (3),
    // so no scene conditions are written; conditions appear from tick 2 onward.
    // This matches the documented D2 1-tick-lag pattern.
    const observerTargets = [...ctx.getSceneIds(), ...ctx.getRoadIds()];
    for (const locationId of observerTargets) {
      const reading = ctx.getEnvironmentReading(locationId);
      const illum = reading.illumination;

      if (illum >= NORMAL_ILLUM_MIN && illum <= NORMAL_ILLUM_MAX) {
        // Normal range: make sure no stale [Lighting] condition lingers.
        out.push({
          kind: "scene.removeCondition",
          sceneId: locationId,
          predicate: { featureId: FEATURE_ID },
        });
        continue;
      }

      // Abnormal: only levels 1, 2, 5 produce labelled conditions.
      if (illum !== 1 && illum !== 2 && illum !== 5) continue;

      out.push({
        kind: "scene.removeCondition",
        sceneId: locationId,
        predicate: { featureId: FEATURE_ID },
      });
      out.push({
        kind: "scene.addCondition",
        sceneId: locationId,
        condition: buildLightingCondition(illum),
      });
    }

    return out;
  },
};
