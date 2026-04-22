import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { CharacterCondition, StateChange } from "../core/types.js";
import type { WorldFeature } from "../core/worldFeature.js";

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
const FATIGUE_DELTA_UNIT = 60; // one LLM "fatigue step" ~= 60 minutes
const BASE_FAIL_CHANCE = 0.3;
const MAX_FAIL_CHANCE = 0.6;

// Acceleration thresholds — env.temperature is the single source of truth.
// Default baseline temperature (DEFAULT_ENVIRONMENT_READING) is 20 °C, comfortably
// inside [10, 30]. Outside that band counts as a hostile thermal environment
// (cold or hot) and adds +1x fatigue accumulation. Outside the more extreme
// [-10, 60] band (e.g. snow stacked on extreme_cold, or fire stacked on
// extreme_heat) adds another +1x, giving max 3x — matching the prior
// fire-AND-weather stacking behavior without coupling to either feature's
// internal state.
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
    Math.min(100, Math.round((fatigue / EXHAUSTED_THRESHOLD) * 100)),
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
  newLevel: 0 | 1 | 2,
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

// ===== Legacy applyFatigueDelta shim =====
//
// `applyFatigueDelta` is still required by the dynamic-require path in
// `engine/resolver/stateChangeAppliers.ts` (handles `character.fatigue`
// StateChange). The resolver code is scheduled for deletion in Phase E; until
// then this thin shim mutates DGSM directly so action-driven fatigue still
// flows through. New code should emit `character.fatigue` StateChanges
// instead of calling this function.
//
// Imported lazily by stateChangeAppliers via require() — kept here so the
// import path doesn't have to change.

export function applyFatigueDelta(
  dgsm: DynamicGameStateManager,
  characterId: string,
  fatigueDelta: number | undefined,
): void {
  if (fatigueDelta == null || !Number.isFinite(fatigueDelta)) return;
  const clampedUnits = Math.trunc(fatigueDelta);
  if (clampedUnits === 0) return;

  const prev = dgsm.getScopedFeatureState<StaminaCharacterState>(
    FEATURE_ID,
    "character",
    characterId,
  );
  const baseFatigue = prev?.fatigue ?? 0;
  const nextFatigue = Math.max(0, baseFatigue + clampedUnits * FATIGUE_DELTA_UNIT);
  const nextLevel = computeFatigueLevel(nextFatigue);

  const next: StaminaCharacterState = {
    fatigue: nextFatigue,
    fatigueLevel: nextLevel,
    exhaustedDrainTicks:
      nextLevel === 2 ? prev?.exhaustedDrainTicks ?? 0 : 0,
  };
  dgsm.setScopedFeatureState(FEATURE_ID, "character", characterId, next);

  const prevLevel = prev?.fatigueLevel ?? 0;
  if (prevLevel !== nextLevel) {
    // Mirror the StateChange-side condition swap directly into DGSM.
    dgsm.removeCharacterCondition(characterId, TIRED_CONDITION_ID);
    dgsm.removeCharacterCondition(characterId, EXHAUSTED_CONDITION_ID);
    if (nextLevel === 1) {
      dgsm.addCharacterCondition(characterId, buildTiredCondition());
    } else if (nextLevel === 2) {
      dgsm.addCharacterCondition(characterId, buildExhaustedCondition());
    }
  }
}

// ===== Exported feature =====

export const staminaFeature: WorldFeature = {
  id: FEATURE_ID,
  description:
    "Per-character fatigue and stamina — accumulates over time, accelerated by hostile temperatures, drains HP/SAN at exhausted level on CON failure.",
  stateScope: "character",
  affectedKinds: [
    "feature.setState",
    "character.addCondition",
    "character.removeCondition",
    "character.hp",
    "character.san",
  ],
  effectSummary:
    "Tracks per-character fatigue (480/960 min thresholds), emits Tired/Exhausted character conditions with global skill penalties, and rolls CON for HP+SAN drain at exhausted.",
  priority: 300,
  planningPrompt: `## Fatigue / Stamina
- Characters accumulate fatigue over time. After ~8 hours (480 min) they become tired; after ~16 hours (960 min) they become exhausted.
- Exhausted characters risk HP and SAN loss from failed CON checks.
- Hostile temperatures (cold or hot environments) accelerate fatigue accumulation.
- The simulation tick adds baseline fatigue automatically; action resolvers may also add or reduce fatigue based on what the character actually did.
- NPCs should consider resting when tired and urgently seek shelter when exhausted.
- Do not use special "rest mode" mechanics. Rest is just an action whose outcome may reduce fatigue.`,

  stateDescription(ctx: FeatureReadContext): string {
    const states =
      ctx.getAllFeatureStates<StaminaCharacterState>();
    if (states.length === 0) return "";
    const lines: string[] = [];
    for (const { key: characterId, state } of states) {
      if (!state || state.fatigueLevel === 0) continue;
      const score = computeFatigueBarScore(state.fatigue);
      const label = FATIGUE_LABELS[state.fatigueLevel] ?? "unknown";
      lines.push(`- ${characterId}: ${label} (${score}/100)`);
    }
    return lines.length > 0
      ? `Character fatigue:\n${lines.join("\n")}`
      : "";
  },

  onTick(ctx: FeatureReadContext): StateChange[] {
    const out: StateChange[] = [];
    const elapsedMinutes = Math.max(1, ctx.tickDurationMinutes);

    for (const characterId of ctx.getAllAliveCharacterIds()) {
      const locationId = ctx.getCharacterLocationId(characterId);

      // Default to baseline temperature when location is unknown — keeps
      // fatigue accumulating at 1x rather than skipping the character.
      const temperature = locationId
        ? ctx.getEnvironmentReading(locationId).temperature
        : 20;
      const accel = getAccelerationMultiplier(temperature);
      const effectiveMinutes = elapsedMinutes * accel;

      const prev = ctx.getFeatureState<StaminaCharacterState>(characterId) ?? {
        fatigue: 0,
        fatigueLevel: 0,
        exhaustedDrainTicks: 0,
      };
      const prevLevel = prev.fatigueLevel;

      const nextFatigue = prev.fatigue + effectiveMinutes;
      const nextLevel = computeFatigueLevel(nextFatigue);

      let exhaustedDrainTicks =
        nextLevel === 2 ? prev.exhaustedDrainTicks : 0;
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
        key: characterId,
        state: next,
      });

      if (nextLevel !== prevLevel) {
        out.push(...emitConditionTransition(characterId, nextLevel));
      }

      if (triggerDrain) {
        const failChance = computeFailChance(nextFatigue);
        if (Math.random() < failChance) {
          const sanLoss = rollD3();
          out.push({
            kind: "character.hp",
            characterId,
            delta: -1,
            sourceFeatureId: FEATURE_ID,
            reason: "exhaustion",
          });
          out.push({
            kind: "character.san",
            characterId,
            delta: -sanLoss,
            sourceFeatureId: FEATURE_ID,
            reason: "exhaustion",
          });
        }
      }
    }

    return out;
  },
};
