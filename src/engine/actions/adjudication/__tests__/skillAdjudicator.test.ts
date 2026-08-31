// The check stage, after the bar was already set.
//
// The Engine chose `requiredLevel` when the action started, at a moment when
// no roll existed. Everything here is what code does with that bar once the
// action's time is spent: roll, compare, and say met or not. No semantics.

import { describe, expect, it } from "vitest";
import type { SkillRollRecord } from "../../types.js";
import { meetsRequiredLevel, resolveCheck } from "../skillAdjudicator.js";

function roll(
  successLevel: SkillRollRecord["successLevel"],
  overrides: Partial<SkillRollRecord> = {}
): SkillRollRecord {
  return {
    rollId: `roll_${successLevel}`,
    skillId: "Investigation",
    skillValue: 70,
    roll: 30,
    successLevel,
    ...overrides,
  };
}

describe("meetsRequiredLevel", () => {
  it("clears a bar at or above it", () => {
    expect(meetsRequiredLevel("regular", "regular")).toBe(true);
    expect(meetsRequiredLevel("extreme", "hard")).toBe(true);
    expect(meetsRequiredLevel("critical", "extreme")).toBe(true);
  });

  it("misses a bar above it", () => {
    expect(meetsRequiredLevel("regular", "hard")).toBe(false);
    expect(meetsRequiredLevel("hard", "extreme")).toBe(false);
    expect(meetsRequiredLevel("failure", "regular")).toBe(false);
  });

  it("never lets a fumble clear anything", () => {
    expect(meetsRequiredLevel("fumble", "regular")).toBe(false);
  });
});

describe("resolveCheck — unopposed", () => {
  it("is met when the roll reaches the bar the Engine set", () => {
    const out = resolveCheck({ actorRoll: roll("hard"), requiredLevel: "hard" });
    expect(out.ok && out.check.met).toBe(true);
    expect(out.ok && out.check.fumble).toBe(false);
  });

  it("is not met when it falls short", () => {
    const out = resolveCheck({
      actorRoll: roll("regular"),
      requiredLevel: "extreme",
    });
    expect(out.ok && out.check.met).toBe(false);
  });

  it("flags a fumble so the Engine can make it worse than a miss", () => {
    const out = resolveCheck({
      actorRoll: roll("fumble"),
      requiredLevel: "regular",
    });
    expect(out.ok && out.check.met).toBe(false);
    expect(out.ok && out.check.fumble).toBe(true);
  });
});

describe("resolveCheck — opposed", () => {
  const defenders = [{ characterId: "npc_2", skillId: "Athletics" }];

  it("needs to beat the bar AND every defender", () => {
    const out = resolveCheck({
      actorRoll: roll("extreme"),
      requiredLevel: "regular",
      opposedBy: defenders,
      rollDefender: () => ({ ok: true, record: roll("regular") }),
    });
    expect(out.ok && out.check.met).toBe(true);
    expect(out.ok && out.check.defenders?.[0].actorWon).toBe(true);
  });

  it("gives ties to the defender", () => {
    const out = resolveCheck({
      actorRoll: roll("hard"),
      requiredLevel: "regular",
      opposedBy: defenders,
      rollDefender: () => ({ ok: true, record: roll("hard") }),
    });
    expect(out.ok && out.check.met).toBe(false);
    expect(out.ok && out.check.defenders?.[0].actorWon).toBe(false);
  });

  it("fails loudly when a defender cannot be rolled", () => {
    const out = resolveCheck({
      actorRoll: roll("hard"),
      requiredLevel: "regular",
      opposedBy: defenders,
      rollDefender: () => ({ ok: false, reason: "no such skill" }),
    });
    expect(out.ok).toBe(false);
  });

  it("refuses an opposed check with no way to roll the defender", () => {
    const out = resolveCheck({
      actorRoll: roll("hard"),
      requiredLevel: "regular",
      opposedBy: defenders,
    });
    expect(out.ok).toBe(false);
  });
});
