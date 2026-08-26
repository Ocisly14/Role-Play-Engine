// src/engine/actions/adjudication/types.ts
//
// Contracts of the post-roll skill adjudication stage (plan Phase 6). The
// semantic World Action Engine proposes WHAT applies (applicability, required
// level, opposed configuration) with factual bases; trusted code then
// executes the deterministic part — comparing the immutable actor roll
// against the requirement, rolling defenders via the opposed-roll tool, and
// computing the check result the final resolution must stay consistent with.

import type { SkillRollRecord, SkillSuccessLevel } from "../types.js";

export type RequiredLevel = "regular" | "hard" | "extreme";

/** Semantic proposal for a command that declared a skill. Produced by the
 *  World Action Engine AFTER seeing the roll (先骰后审); every judgement
 *  carries a factual basis so post-roll bar-bending is auditable. */
export type SkillAssessmentProposal =
  | {
      applicability: "accepted";
      /** Facts tying the skill to the action (tool, target, method). */
      applicabilityBasis: string;
      requiredLevel: RequiredLevel;
      /** Objective difficulty facts — stated independently of the roll. */
      requiredLevelBasis: string;
      checkType: "single";
      targetIds: string[];
    }
  | {
      applicability: "accepted";
      applicabilityBasis: string;
      requiredLevel: RequiredLevel;
      requiredLevelBasis: string;
      checkType: "opposed";
      targetIds: string[];
      /** Defender(s) and the defense skill the Engine chose for each. */
      opposedDefense: Array<{ characterId: string; skillId: string }>;
    }
  | {
      applicability: "rejected";
      /** Why the skill does not fit this action. */
      applicabilityBasis: string;
      targetIds: string[];
      /** The Engine's direct-style judgement of the action WITHOUT any skill
       *  benefit (the roll stays in the trace but grants nothing). */
      outcomeWithoutSkill: "success" | "partial" | "failure" | "blocked" | "continue";
      outcomeReason: string;
    };

/** Deterministic result of executing one defender's roll. */
export interface DefenderRollResult {
  characterId: string;
  skillId: string;
  record: SkillRollRecord;
  /** Actor wins strictly higher success rank; defender wins ties. */
  actorWon: boolean;
}

/** Code-computed verdict of the check itself. The semantic Engine's final
 *  WorldDeltas must be consistent with this (validated downstream). */
export type SkillCheckResult =
  | { kind: "met"; level: SkillSuccessLevel }
  | { kind: "not_met"; level: SkillSuccessLevel }
  | { kind: "fumble" }
  | {
      kind: "opposed";
      level: SkillSuccessLevel;
      defenders: DefenderRollResult[];
      anyDefeated: boolean;
    }
  | { kind: "no_benefit" };

/** Executes a defender roll deterministically (the opposed-roll code tool).
 *  Injected so the adjudicator never rolls the actor and tests can pin dice. */
export type RollDefenderFn = (
  characterId: string,
  skillId: string
) => { ok: true; record: SkillRollRecord } | { ok: false; reason: string };
