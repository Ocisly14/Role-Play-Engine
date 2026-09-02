// Condition penalties reaching the dice.
//
// These helpers existed with no caller at all until sanity conditions needed
// them, so the stamina penalties they aggregate had never once applied to a
// roll. Both halves are pinned here.

import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { CharacterCondition } from "../../core/types.js";
import {
  MAX_AGGREGATE_SKILL_PENALTY,
  effectiveSkillValue,
  getCharacterConditionPenalties,
} from "../characterConditionPenalties.js";

function dgsmWith(conditions: CharacterCondition[]): DynamicGameStateManager {
  return {
    getNpcProfile: (id: string) =>
      id === "npc_1" ? { status: { conditions } } : undefined,
  } as never;
}

const cond = (
  id: string,
  mechanicalEffect?: CharacterCondition["mechanicalEffect"]
): CharacterCondition => ({
  id,
  description: id,
  ...(mechanicalEffect ? { mechanicalEffect } : {}),
});

describe("getCharacterConditionPenalties", () => {
  it("sums global penalties across every condition", () => {
    const p = getCharacterConditionPenalties(
      "npc_1",
      dgsmWith([
        cond("stamina:exhausted", { globalSkillPenalty: -20 }),
        cond("sanity_tick_1_0", { globalSkillPenalty: -25 }),
      ])
    );
    expect(p.get("*")).toBe(-45);
  });

  it("keeps per-skill penalties under their canonical domain name", () => {
    const p = getCharacterConditionPenalties(
      "npc_1",
      dgsmWith([cond("c", { skillPenalty: { "stealth & security": -15 } })])
    );
    expect(p.get("Stealth & Security")).toBe(-15);
  });

  it("is empty for a character with no conditions, and for an unknown one", () => {
    expect(getCharacterConditionPenalties("npc_1", dgsmWith([])).size).toBe(0);
    expect(getCharacterConditionPenalties("nobody", dgsmWith([])).size).toBe(0);
  });
});

describe("effectiveSkillValue", () => {
  it("applies the wildcard and the named penalty together", () => {
    const p = new Map([
      ["*", -10],
      ["Athletics", -5],
    ]);
    expect(effectiveSkillValue("Athletics", 60, p)).toBe(45);
    expect(effectiveSkillValue("Social", 60, p)).toBe(50);
  });

  it("penalizes a value the skills record never held", () => {
    // The regression `applyPenalties` would have shipped: it only touches keys
    // present in the profile's skills, so an UNTRAINED domain — resolved from
    // SKILL_BASE_VALUES — and a Languages check, resolved from learned
    // tongues, would both have escaped the handicap entirely. This helper
    // takes the already-resolved value, so neither can.
    const p = new Map([["*", -20]]);
    expect(effectiveSkillValue("Occult", 5, p)).toBe(1);
    expect(effectiveSkillValue("Languages", 70, p)).toBe(50);
  });

  it("floors a stacked handicap at severe rather than impossible", () => {
    const p = new Map([["*", -45]]);
    expect(MAX_AGGREGATE_SKILL_PENALTY).toBe(-40);
    expect(effectiveSkillValue("Social", 60, p)).toBe(20);
  });

  it("never drops a skill below 1", () => {
    expect(effectiveSkillValue("Social", 10, new Map([["*", -40]]))).toBe(1);
  });

  it("returns the value untouched when nothing is wrong with the character", () => {
    expect(effectiveSkillValue("Social", 55, new Map())).toBe(55);
  });
});
