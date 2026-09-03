// src/engine/subsystem/stamina.ts
//
// Phase I port of staminaFeature → AnchorSubsystem (anchorKind="character").
// All constants, types, and helpers are copied verbatim from
// src/engine/features/staminaFeature.ts — no logic changes.
// Task 11 will delete the original; until then both files coexist.

import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { CharacterCondition, StateChange } from "../core/types.js";
import type { AnchorSubsystem } from "./types.js";

// ===== Internal types =====

export interface StaminaCharacterState {
  fatigue: number;
  fatigueLevel: 0 | 1 | 2; // 0 = rested, 1 = tired, 2 = exhausted
  exhaustedDrainTicks: number;
}

// ===== Constants =====

const FEATURE_ID = "stamina";
const TIRED_THRESHOLD = 480; // minutes → fatigue level 1
const EXHAUSTED_THRESHOLD = 960; // minutes → fatigue level 2
const DRAIN_TICK_INTERVAL = 6; // CON-check cadence at exhausted
const BASE_FAIL_CHANCE = 0.3;
const MAX_FAIL_CHANCE = 0.6;

// Acceleration thresholds — env.temperature is the single source of truth.
// Default baseline temperature (DEFAULT_ENVIRONMENT_READING) is 20 °C, comfortably
// inside [10, 30]. Outside that band counts as a hostile thermal environment
// (cold or hot) and adds +1x fatigue accumulation. Outside the more extreme
// [-10, 60] band (e.g. snow stacked on extreme_cold) adds another +1x,
// giving max 3x — read from the aggregated temperature rather than any one
// feature's internal state.
const TEMP_HOSTILE_LOW_C = 10;
const TEMP_HOSTILE_HIGH_C = 30;
const TEMP_EXTREME_LOW_C = -10;
const TEMP_EXTREME_HIGH_C = 60;

// ===== Condition definitions =====

const TIRED_CONDITION_ID = "stamina:tired";
const EXHAUSTED_CONDITION_ID = "stamina:exhausted";

const TIRED_DESCRIPTION =
  "Tired — eyes heavy, movements sluggish, concentration wavering. Needs rest soon.";
const EXHAUSTED_DESCRIPTION =
  "Exhausted — on the verge of collapse. Hands trembling, vision blurring, barely able to stay on feet.";

const FATIGUE_LABELS: Record<number, string> = {
  0: "rested",
  1: "tired",
  2: "exhausted",
};

// ===== Pure helpers =====

function computeFatigueLevel(fatigue: number): 0 | 1 | 2 {
  if (fatigue >= EXHAUSTED_THRESHOLD) return 2;
  if (fatigue >= TIRED_THRESHOLD) return 1;
  return 0;
}

function computeFatigueBarScore(fatigue: number): number {
  return Math.max(
    0,
    Math.min(100, Math.round((fatigue / EXHAUSTED_THRESHOLD) * 100))
  );
}

/**
 * Compute environmental fatigue acceleration from the per-location temperature.
 * Base 1x; +1x in hostile thermal range; +1x more in extreme range. Max 3x.
 */
function getAccelerationMultiplier(temperature: number): number {
  let accel = 1;
  if (temperature < TEMP_HOSTILE_LOW_C || temperature > TEMP_HOSTILE_HIGH_C) {
    accel += 1;
  }
  if (temperature < TEMP_EXTREME_LOW_C || temperature > TEMP_EXTREME_HIGH_C) {
    accel += 1;
  }
  return accel;
}

function rollD3(): number {
  return 1 + Math.floor(Math.random() * 3);
}

/**
 * CON-fail chance for an exhausted character, scaling with fatigue past the
 * exhausted threshold. min(0.6, 0.3 + (fatigue - 960) / 960 * 0.3)
 */
function computeFailChance(fatigue: number): number {
  const extra = ((fatigue - EXHAUSTED_THRESHOLD) / EXHAUSTED_THRESHOLD) * 0.3;
  return Math.min(MAX_FAIL_CHANCE, BASE_FAIL_CHANCE + extra);
}

function buildTiredCondition(): CharacterCondition {
  return {
    id: TIRED_CONDITION_ID,
    featureId: FEATURE_ID,
    description: TIRED_DESCRIPTION,
    mechanicalEffect: { globalSkillPenalty: -10 },
  };
}

function buildExhaustedCondition(): CharacterCondition {
  return {
    id: EXHAUSTED_CONDITION_ID,
    featureId: FEATURE_ID,
    description: EXHAUSTED_DESCRIPTION,
    mechanicalEffect: { globalSkillPenalty: -20 },
  };
}

/**
 * Emit the StateChanges that bring a character's fatigue conditions in sync
 * with `newLevel`. Always strips both stamina conditions first so transitions
 * are idempotent (Applier no-ops the remove if not present).
 */
function emitConditionTransition(
  characterId: string,
  newLevel: 0 | 1 | 2
): StateChange[] {
  const out: StateChange[] = [
    {
      kind: "character.removeCondition",
      characterId,
      conditionId: TIRED_CONDITION_ID,
    },
    {
      kind: "character.removeCondition",
      characterId,
      conditionId: EXHAUSTED_CONDITION_ID,
    },
  ];
  if (newLevel === 1) {
    out.push({
      kind: "character.addCondition",
      characterId,
      condition: buildTiredCondition(),
    });
  } else if (newLevel === 2) {
    out.push({
      kind: "character.addCondition",
      characterId,
      condition: buildExhaustedCondition(),
    });
  }
  return out;
}

// ===== Exported AnchorSubsystem =====

export const staminaSubsystem: AnchorSubsystem = {
  id: FEATURE_ID,
  kind: "anchor",
  anchorKind: "character",
  description:
    "Per-character fatigue and stamina — accumulates over time, accelerated by hostile temperatures, drains HP/SAN at exhausted level on CON failure.",
  effectSummary:
    "Tracks per-character fatigue (480/960 min thresholds), emits Tired/Exhausted character conditions with global skill penalties, and rolls CON for HP+SAN drain at exhausted.",
  affectedKinds: [
    "feature.setState",
    "character.addCondition",
    "character.removeCondition",
    "character.hp",
    "character.san",
  ],
  priority: 300,
  planningPrompt: `## Fatigue / Stamina
- Characters accumulate fatigue over time. After ~8 hours (480 min) they become tired; after ~16 hours (960 min) they become exhausted.
- Exhausted characters risk HP and SAN loss from failed CON checks.
- Hostile temperatures (cold or hot environments) accelerate fatigue accumulation.
- The simulation tick adds baseline fatigue automatically; action resolvers may also add or reduce fatigue based on what the character actually did.
- NPCs should consider resting when tired and urgently seek shelter when exhausted.
- Do not use special "rest mode" mechanics. Rest is just an action whose outcome may reduce fatigue.`,

  /**
   * Character exists for stamina tracking whenever it is a known character.
   * The orchestrator's anchorIdsFor("character") already filters to alive
   * characters; this predicate is the defensive fallback.
   */
  shouldExist(anchorId: string, ctx: FeatureReadContext): boolean {
    return ctx.getCharacter(anchorId) !== undefined;
  },

  /**
   * Seed zero-fatigue state for a single character (anchorId). Called once
   * when shouldExist transitions false→true or (on rehydration) when no bucket
   * exists yet.
   */
  initialState(anchorId: string, _ctx: FeatureReadContext): StateChange[] {
    return [
      {
        kind: "feature.setState",
        featureId: FEATURE_ID,
        key: anchorId,
        state: {
          fatigue: 0,
          fatigueLevel: 0,
          exhaustedDrainTicks: 0,
        } satisfies StaminaCharacterState,
      },
    ];
  },

  /**
   * Advance fatigue for a single character (anchorId) by one tick. Extracted
   * from the inner per-character body of staminaFeature.onTick — the outer
   * getAllAliveCharacterIds loop is replaced by the orchestrator iterating
   * anchorIds and calling this method once per character.
   */
  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[] {
    const out: StateChange[] = [];
    const elapsedMinutes = Math.max(1, ctx.tickDurationMinutes);

    const locationId = ctx.getCharacterLocationId(anchorId);

    // Default to baseline temperature when location is unknown — keeps
    // fatigue accumulating at 1x rather than skipping the character.
    const temperature = locationId
      ? ctx.getEnvironmentReading(locationId).temperature
      : 20;
    const accel = getAccelerationMultiplier(temperature);
    const effectiveMinutes = elapsedMinutes * accel;

    const prev = ctx.getFeatureState<StaminaCharacterState>(anchorId) ?? {
      fatigue: 0,
      fatigueLevel: 0,
      exhaustedDrainTicks: 0,
    };
    const prevLevel = prev.fatigueLevel;

    const nextFatigue = prev.fatigue + effectiveMinutes;
    const nextLevel = computeFatigueLevel(nextFatigue);

    let exhaustedDrainTicks = nextLevel === 2 ? prev.exhaustedDrainTicks : 0;
    let triggerDrain = false;

    if (nextLevel === 2) {
      exhaustedDrainTicks += 1;
      if (exhaustedDrainTicks >= DRAIN_TICK_INTERVAL) {
        triggerDrain = true;
        exhaustedDrainTicks = 0;
      }
    }

    const next: StaminaCharacterState = {
      fatigue: nextFatigue,
      fatigueLevel: nextLevel,
      exhaustedDrainTicks,
    };

    out.push({
      kind: "feature.setState",
      featureId: FEATURE_ID,
      key: anchorId,
      state: next,
    });

    if (nextLevel !== prevLevel) {
      out.push(...emitConditionTransition(anchorId, nextLevel));
    }

    if (triggerDrain) {
      const failChance = computeFailChance(nextFatigue);
      if (Math.random() < failChance) {
        const sanLoss = rollD3();
        out.push({
          kind: "character.hp",
          characterId: anchorId,
          delta: -1,
          sourceFeatureId: FEATURE_ID,
          reason: "exhaustion",
        });
        out.push({
          kind: "character.san",
          characterId: anchorId,
          delta: -sanLoss,
          sourceFeatureId: FEATURE_ID,
          reason: "exhaustion",
        });
      }
    }

    return out;
  },

  /**
   * Render all character fatigue states as human-readable prose. Iterates all
   * character buckets via ctx.getAllFeatureStates() — no per-anchor scoping needed.
   */
  stateDescription(ctx: FeatureReadContext): string {
    const states = ctx.getAllFeatureStates<StaminaCharacterState>();
    if (states.length === 0) return "";
    const lines: string[] = [];
    for (const { key: characterId, state } of states) {
      if (!state || state.fatigueLevel === 0) continue;
      const score = computeFatigueBarScore(state.fatigue);
      const label = FATIGUE_LABELS[state.fatigueLevel] ?? "unknown";
      lines.push(`- ${characterId}: ${label} (${score}/100)`);
    }
    return lines.length > 0 ? `Character fatigue:\n${lines.join("\n")}` : "";
  },
};
