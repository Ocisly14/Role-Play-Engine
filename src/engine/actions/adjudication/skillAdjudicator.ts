// src/engine/actions/adjudication/skillAdjudicator.ts
//
// The deterministic half of "difficulty before dice".
//
// The Engine set the bar when the action STARTED, at a moment when no roll
// existed — it cannot have chosen a difficulty to reach a result it had
// already seen. This module is what happens at the other end: when the
// action's time is spent, code rolls the skill the actor declared against
// that stored bar, rolls whatever defenders the Engine named, and produces
// the verdict. The Engine is then told the verdict and writes only its
// consequences.
//
// Nothing here is semantic. It never chooses a skill, never chooses a
// difficulty, never decides what the outcome means in the world.

import type { ResolvedCheck, SkillRollRecord, SkillSuccessLevel } from "../types.js";
import type { RequiredLevel, RollDefenderFn } from "./types.js";

/** Six-level ladder ranking (higher wins). */
export const SKILL_SUCCESS_RANK: Record<SkillSuccessLevel, number> = {
  critical: 5,
  extreme: 4,
  hard: 3,
  regular: 2,
  failure: 1,
  fumble: 0,
};

const REQUIRED_MIN_RANK: Record<RequiredLevel, number> = {
  regular: SKILL_SUCCESS_RANK.regular,
  hard: SKILL_SUCCESS_RANK.hard,
  extreme: SKILL_SUCCESS_RANK.extreme,
};

/** Does an achieved success level satisfy the required level? A fumble never
 *  does, whatever the requirement. */
export function meetsRequiredLevel(
  level: SkillSuccessLevel,
  required: RequiredLevel
): boolean {
  if (level === "fumble") return false;
  return SKILL_SUCCESS_RANK[level] >= REQUIRED_MIN_RANK[required];
}

export interface ResolveCheckParams {
  /** The actor's roll, already made by the caller from the real skill value. */
  actorRoll: SkillRollRecord;
  requiredLevel: RequiredLevel;
  /** Defenders the Engine named when it set the bar. */
  opposedBy?: Array<{ characterId: string; skillId: string }>;
  /** Rolls one defender. Injected so dice stay pinnable in tests and every
   *  roll goes through the same deterministic path. */
  rollDefender?: RollDefenderFn;
}

export type ResolveCheckOutput =
  | { ok: true; check: ResolvedCheck }
  | { ok: false; error: string };

/**
 * Roll the check the Engine declared and say whether it was met.
 *
 * Unopposed: the actor's level must reach the required level.
 * Opposed: it must also beat every defender — strictly higher rank wins, the
 * defender takes ties.
 */
export function resolveCheck(params: ResolveCheckParams): ResolveCheckOutput {
  const { actorRoll, requiredLevel, opposedBy } = params;
  const level = actorRoll.successLevel;
  const fumble = level === "fumble";
  const clearedBar = meetsRequiredLevel(level, requiredLevel);

  if (!opposedBy || opposedBy.length === 0) {
    return {
      ok: true,
      check: { actor: actorRoll, requiredLevel, met: clearedBar, fumble },
    };
  }

  if (!params.rollDefender) {
    return { ok: false, error: "opposed check needs a defender roller" };
  }

  const defenders: NonNullable<ResolvedCheck["defenders"]> = [];
  for (const defender of opposedBy) {
    const rolled = params.rollDefender(defender.characterId, defender.skillId);
    if (!rolled.ok) {
      return {
        ok: false,
        error: `defender ${defender.characterId} (${defender.skillId}): ${rolled.reason}`,
      };
    }
    defenders.push({
      characterId: defender.characterId,
      record: rolled.record,
      actorWon:
        SKILL_SUCCESS_RANK[level] >
        SKILL_SUCCESS_RANK[rolled.record.successLevel],
    });
  }

  return {
    ok: true,
    check: {
      actor: actorRoll,
      requiredLevel,
      defenders,
      met: clearedBar && defenders.every((d) => d.actorWon),
      fumble,
    },
  };
}
