// Phase 6 adjudication: deterministic check math over the immutable actor
// roll — required-level ladder, fumble/critical handling, opposed defender
// rolls via the injected tool (actor never re-rolled), rejected-applicability
// (roll kept, no benefit, no fabricated requirement fields).

import { describe, expect, it, vi } from "vitest";
import type { ActionCommand, SkillRollRecord } from "../../types.js";
import {
  adjudicateSkillAction,
  buildDirectJudgement,
  meetsRequiredLevel,
} from "../skillAdjudicator.js";
import type { RollDefenderFn, SkillAssessmentProposal } from "../types.js";

function record(overrides: Partial<SkillRollRecord> = {}): SkillRollRecord {
  return {
    rollId: "roll_1",
    skillId: "Locksmith",
    skillValue: 60,
    roll: 42,
    successLevel: "regular",
    ...overrides,
  };
}

function command(roll?: SkillRollRecord): ActionCommand {
  return {
    commandId: "cmd_1",
    actorId: "npc_1",
    issuedAt: "1923-04-02T09:15:00",
    issuedSceneId: "SCN_1",
    description: "I pick the lock.",
    objectRefs: [],
    proposedDurationTicks: 2,
    ...(roll ? { declaredSkillId: roll.skillId, skillRoll: roll } : {}),
  };
}

const singleProposal = (
  requiredLevel: "regular" | "hard" | "extreme"
): SkillAssessmentProposal => ({
  applicability: "accepted",
  applicabilityBasis: "picks used on a pin lock",
  requiredLevel,
  requiredLevelBasis: "common cabinet lock in good light",
  checkType: "single",
  targetIds: [],
});

const noDefender: RollDefenderFn = () => {
  throw new Error("must not be called");
};

describe("meetsRequiredLevel", () => {
  it("walks the six-level ladder against each requirement", () => {
    expect(meetsRequiredLevel("regular", "regular")).toBe(true);
    expect(meetsRequiredLevel("regular", "hard")).toBe(false);
    expect(meetsRequiredLevel("hard", "hard")).toBe(true);
    expect(meetsRequiredLevel("hard", "extreme")).toBe(false);
    expect(meetsRequiredLevel("extreme", "extreme")).toBe(true);
    expect(meetsRequiredLevel("critical", "extreme")).toBe(true);
    expect(meetsRequiredLevel("failure", "regular")).toBe(false);
    expect(meetsRequiredLevel("fumble", "regular")).toBe(false);
  });
});

describe("adjudicateSkillAction — invariants", () => {
  it("refuses a command without a skill roll", () => {
    const result = adjudicateSkillAction(
      command(),
      singleProposal("regular"),
      noDefender
    );
    expect(result.ok).toBe(false);
  });
});

describe("single checks", () => {
  it("succeeds when the roll meets the required level", () => {
    const result = adjudicateSkillAction(
      command(record({ successLevel: "hard" })),
      singleProposal("hard"),
      noDefender
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.judgement).toMatchObject({
      kind: "skill_assessed",
      applicability: "accepted",
      requiredLevel: "hard",
      checkType: "single",
      outcome: "success",
      rollId: "roll_1",
    });
    expect(result.checkResult).toEqual({ kind: "met", level: "hard" });
  });

  it("fails when the roll is below the required level", () => {
    const result = adjudicateSkillAction(
      command(record({ successLevel: "regular" })),
      singleProposal("extreme"),
      noDefender
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.judgement.outcome).toBe("failure");
    expect(result.checkResult).toEqual({ kind: "not_met", level: "regular" });
  });

  it("treats a fumble as failure whatever the requirement", () => {
    const result = adjudicateSkillAction(
      command(record({ successLevel: "fumble", roll: 100 })),
      singleProposal("regular"),
      noDefender
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.judgement.outcome).toBe("failure");
    expect(result.checkResult).toEqual({ kind: "fumble" });
  });
});

describe("opposed checks", () => {
  const opposedProposal: SkillAssessmentProposal = {
    applicability: "accepted",
    applicabilityBasis: "persuasion attempt on a listener",
    requiredLevel: "regular",
    requiredLevelBasis: "no unusual pressure",
    checkType: "opposed",
    targetIds: ["npc_2"],
    opposedDefense: [{ characterId: "npc_2", skillId: "Psychology" }],
  };

  const defenderAt =
    (successLevel: SkillRollRecord["successLevel"]): RollDefenderFn =>
    (characterId, skillId) => ({
      ok: true,
      record: record({
        rollId: "roll_def",
        skillId,
        skillValue: 40,
        roll: 35,
        successLevel,
      }),
    });

  it("actor wins with a strictly higher success level", () => {
    const result = adjudicateSkillAction(
      command(record({ successLevel: "hard" })),
      opposedProposal,
      defenderAt("regular")
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.judgement.outcome).toBe("success");
    expect(result.defenderRolls[0].actorWon).toBe(true);
    expect(result.judgement).toMatchObject({ opposedDefenseIds: ["npc_2"] });
  });

  it("defender wins ties", () => {
    const result = adjudicateSkillAction(
      command(record({ successLevel: "regular" })),
      opposedProposal,
      defenderAt("regular")
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.judgement.outcome).toBe("failure");
    expect(result.defenderRolls[0].actorWon).toBe(false);
  });

  it("succeeds if ANY of several defenders is beaten", () => {
    const rolls: Record<string, SkillRollRecord["successLevel"]> = {
      npc_2: "hard",
      npc_3: "failure",
    };
    const result = adjudicateSkillAction(
      command(record({ successLevel: "regular" })),
      {
        ...opposedProposal,
        targetIds: ["npc_2", "npc_3"],
        opposedDefense: [
          { characterId: "npc_2", skillId: "Psychology" },
          { characterId: "npc_3", skillId: "Psychology" },
        ],
      },
      (characterId, skillId) => ({
        ok: true,
        record: record({
          rollId: `roll_${characterId}`,
          skillId,
          successLevel: rolls[characterId],
        }),
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.judgement.outcome).toBe("success");
    expect(result.defenderRolls.map((d) => d.actorWon)).toEqual([false, true]);
  });

  it("skips defender dice entirely when the actor fails the bar", () => {
    const rollDefender = vi.fn();
    const result = adjudicateSkillAction(
      command(record({ successLevel: "failure", roll: 90 })),
      opposedProposal,
      rollDefender as never
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(rollDefender).not.toHaveBeenCalled();
    expect(result.judgement.outcome).toBe("failure");
    expect(result.checkResult).toEqual({ kind: "not_met", level: "failure" });
    expect(result.defenderRolls).toEqual([]);
  });

  it("errors on an opposed proposal without defenders", () => {
    const result = adjudicateSkillAction(
      command(record({ successLevel: "hard" })),
      { ...opposedProposal, opposedDefense: [] },
      noDefender
    );
    expect(result.ok).toBe(false);
  });

  it("propagates a defender-roll failure", () => {
    const result = adjudicateSkillAction(
      command(record({ successLevel: "hard" })),
      opposedProposal,
      () => ({ ok: false, reason: "unknown_skill" })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("npc_2");
  });
});

describe("rejected applicability", () => {
  it("keeps the roll in the trace but grants no benefit and no requirement fields", () => {
    const luckyRoll = record({ successLevel: "critical", roll: 1 });
    const result = adjudicateSkillAction(
      command(luckyRoll),
      {
        applicability: "rejected",
        applicabilityBasis: "Library Use does not open padlocks",
        targetIds: [],
        outcomeWithoutSkill: "failure",
        outcomeReason: "the hasp holds",
      },
      noDefender
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.judgement).toMatchObject({
      applicability: "rejected",
      outcome: "failure",
      rollId: "roll_1",
    });
    // No fabricated requirement fields on a rejected skill.
    expect(result.judgement.requiredLevel).toBeUndefined();
    expect(result.judgement.checkType).toBeUndefined();
    expect(result.checkResult).toEqual({ kind: "no_benefit" });
  });
});

describe("buildDirectJudgement", () => {
  it("wraps a direct outcome + reason", () => {
    expect(buildDirectJudgement("partial", "half the crates moved")).toEqual({
      kind: "direct",
      outcome: "partial",
      reason: "half the crates moved",
    });
  });
});
