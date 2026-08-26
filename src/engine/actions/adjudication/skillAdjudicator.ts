// src/engine/actions/adjudication/skillAdjudicator.ts
//
// Deterministic half of "roll first, assess after" (plan Phase 6 / rules §6).
// The command arrives with its immutable actor SkillRollRecord (made at
// intake); the semantic Engine proposes applicability / required level /
// opposed configuration with factual bases; this module executes the check
// math and produces the persisted ActionJudgement. It never re-rolls the
// actor, never rolls anything itself (defender rolls go through the injected
// opposed-roll tool), and never fabricates requirement fields for a rejected
// skill.

import type {
  ActionCommand,
  ActionJudgement,
  SkillSuccessLevel,
} from "../types.js";
import type {
  DefenderRollResult,
  RequiredLevel,
  RollDefenderFn,
  SkillAssessmentProposal,
  SkillCheckResult,
} from "./types.js";

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

export type SkillAdjudication =
  | {
      ok: true;
      judgement: ActionJudgement & { kind: "skill_assessed" };
      checkResult: SkillCheckResult;
      defenderRolls: DefenderRollResult[];
    }
  | { ok: false; error: string };

/**
 * Adjudicate a skill-declared command against the semantic proposal.
 * Deterministic given the command's roll record and the injected defender
 * roller; the same inputs always produce the same judgement (replay-safe).
 */
export function adjudicateSkillAction(
  command: ActionCommand,
  proposal: SkillAssessmentProposal,
  rollDefender: RollDefenderFn
): SkillAdjudication {
  const roll = command.skillRoll;
  if (command.declaredSkillId === undefined || roll === undefined) {
    return {
      ok: false,
      error:
        "adjudicateSkillAction requires a command with declaredSkillId + skillRoll; use a direct judgement for skill-less actions",
    };
  }

  // ── Rejected applicability: roll stays in the trace, grants nothing. ──
  if (proposal.applicability === "rejected") {
    return {
      ok: true,
      judgement: {
        kind: "skill_assessed",
        skillId: roll.skillId,
        rollId: roll.rollId,
        applicability: "rejected",
        targetIds: proposal.targetIds,
        outcome: proposal.outcomeWithoutSkill,
        reason: `${proposal.applicabilityBasis} — ${proposal.outcomeReason}`,
      },
      checkResult: { kind: "no_benefit" },
      defenderRolls: [],
    };
  }

  // ── Accepted, single check: compare roll level to required level. ──
  if (proposal.checkType === "single") {
    const level = roll.successLevel;
    const met = meetsRequiredLevel(level, proposal.requiredLevel);
    const checkResult: SkillCheckResult =
      level === "fumble"
        ? { kind: "fumble" }
        : met
          ? { kind: "met", level }
          : { kind: "not_met", level };
    return {
      ok: true,
      judgement: {
        kind: "skill_assessed",
        skillId: roll.skillId,
        rollId: roll.rollId,
        applicability: "accepted",
        requiredLevel: proposal.requiredLevel,
        checkType: "single",
        targetIds: proposal.targetIds,
        outcome: met ? "success" : "failure",
        reason: `${proposal.applicabilityBasis}; required ${proposal.requiredLevel} (${proposal.requiredLevelBasis}); rolled ${roll.roll}/${roll.skillValue} (${level})`,
      },
      checkResult,
      defenderRolls: [],
    };
  }

  // ── Accepted, opposed check: roll each chosen defender via the tool. ──
  if (proposal.opposedDefense.length === 0) {
    return {
      ok: false,
      error: "opposed check proposal must name at least one defender",
    };
  }
  // The actor must clear the objective bar before opposition matters: on a
  // failed/fumbled actor roll no defender dice are thrown at all (no
  // pointless randomness in the replay trace) and the action simply fails.
  const actorLevel = roll.successLevel;
  if (!meetsRequiredLevel(actorLevel, proposal.requiredLevel)) {
    return {
      ok: true,
      judgement: {
        kind: "skill_assessed",
        skillId: roll.skillId,
        rollId: roll.rollId,
        applicability: "accepted",
        requiredLevel: proposal.requiredLevel,
        checkType: "opposed",
        targetIds: proposal.targetIds,
        opposedDefenseIds: proposal.opposedDefense.map((d) => d.characterId),
        outcome: "failure",
        reason: `${proposal.applicabilityBasis}; required ${proposal.requiredLevel} (${proposal.requiredLevelBasis}); actor ${roll.roll}/${roll.skillValue} (${actorLevel}) failed before opposition`,
      },
      checkResult:
        actorLevel === "fumble"
          ? { kind: "fumble" }
          : { kind: "not_met", level: actorLevel },
      defenderRolls: [],
    };
  }

  const defenderRolls: DefenderRollResult[] = [];
  for (const defense of proposal.opposedDefense) {
    const rolled = rollDefender(defense.characterId, defense.skillId);
    if (!rolled.ok) {
      return {
        ok: false,
        error: `defender roll failed for ${defense.characterId} (${defense.skillId}): ${rolled.reason}`,
      };
    }
    defenderRolls.push({
      characterId: defense.characterId,
      skillId: defense.skillId,
      record: rolled.record,
      // Higher rank wins; the defender wins ties (rules §Skill checks).
      actorWon:
        SKILL_SUCCESS_RANK[actorLevel] >
        SKILL_SUCCESS_RANK[rolled.record.successLevel],
    });
  }

  const anyDefeated = defenderRolls.some((d) => d.actorWon);
  const checkResult: SkillCheckResult = {
    kind: "opposed",
    level: actorLevel,
    defenders: defenderRolls,
    anyDefeated,
  };

  const defenderSummary = defenderRolls
    .map(
      (d) =>
        `${d.characterId} ${d.skillId} ${d.record.roll}/${d.record.skillValue} (${d.record.successLevel})${d.actorWon ? " beaten" : " held"}`
    )
    .join(", ");

  return {
    ok: true,
    judgement: {
      kind: "skill_assessed",
      skillId: roll.skillId,
      rollId: roll.rollId,
      applicability: "accepted",
      requiredLevel: proposal.requiredLevel,
      checkType: "opposed",
      targetIds: proposal.targetIds,
      opposedDefenseIds: proposal.opposedDefense.map((d) => d.characterId),
      outcome: anyDefeated ? "success" : "failure",
      reason: `${proposal.applicabilityBasis}; required ${proposal.requiredLevel} (${proposal.requiredLevelBasis}); actor ${roll.roll}/${roll.skillValue} (${actorLevel}) vs ${defenderSummary}`,
    },
    checkResult,
    defenderRolls,
  };
}

/** Direct judgement for skill-less commands — no roll exists and none is
 *  made. Thin, but kept here so Phase 7 has one entry point per path. */
export function buildDirectJudgement(
  outcome: "success" | "partial" | "failure" | "blocked" | "continue",
  reason: string
): ActionJudgement & { kind: "direct" } {
  return { kind: "direct", outcome, reason };
}
