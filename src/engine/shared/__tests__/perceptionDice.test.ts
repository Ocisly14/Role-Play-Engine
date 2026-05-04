import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as dice from "../dice.js";
import { rollStealthForMovement, tryDetectHidden } from "../perceptionDice.js";

// Minimal fake DGSM exposing only the methods the perception helpers consult.
function makeFakeDgsm(
  npcs: Array<{ id: string; skills?: Record<string, number> }>
) {
  return {
    getState: () => ({
      npcCharacters: npcs.map((n) => ({ id: n.id, skills: n.skills })),
    }),
  } as unknown as import(
    "../../../state/DynamicGameState.js"
  ).DynamicGameStateManager;
}

describe("rollStealthForMovement", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the NPC's Stealth skill (case insensitive lookup) and treats success levels other than fail/fumble as success", () => {
    const dgsm = makeFakeDgsm([{ id: "npc1", skills: { stealth: 60 } }]);
    vi.spyOn(dice, "rollD100").mockReturnValue(40);
    expect(rollStealthForMovement(dgsm, "npc1")).toBe(true);
  });

  it("returns false when the roll fails the Stealth check", () => {
    const dgsm = makeFakeDgsm([{ id: "npc1", skills: { Stealth: 30 } }]);
    vi.spyOn(dice, "rollD100").mockReturnValue(80);
    expect(rollStealthForMovement(dgsm, "npc1")).toBe(false);
  });

  it("returns false on a fumble (>=98)", () => {
    const dgsm = makeFakeDgsm([{ id: "npc1", skills: { Stealth: 80 } }]);
    vi.spyOn(dice, "rollD100").mockReturnValue(99);
    expect(rollStealthForMovement(dgsm, "npc1")).toBe(false);
  });

  it("falls back to default Stealth=20 when the NPC has no Stealth skill", () => {
    const dgsm = makeFakeDgsm([{ id: "npc1", skills: {} }]);
    vi.spyOn(dice, "rollD100").mockReturnValue(15);
    expect(rollStealthForMovement(dgsm, "npc1")).toBe(true);
  });

  it("uses default 20 for an unknown NPC", () => {
    const dgsm = makeFakeDgsm([]);
    vi.spyOn(dice, "rollD100").mockReturnValue(50);
    expect(rollStealthForMovement(dgsm, "ghost")).toBe(false);
  });
});

describe("tryDetectHidden", () => {
  beforeEach(() => vi.spyOn(dice, "rollD100").mockReturnValue(50));
  afterEach(() => vi.restoreAllMocks());

  it("uses Spot Hidden when the observer has it", () => {
    const dgsm = makeFakeDgsm([
      { id: "observer", skills: { "Spot Hidden": 80 } },
      { id: "hidden", skills: { Stealth: 40 } },
    ]);
    // Observer roll 50 vs 80 = regular; stealth roll 50 vs 40 = fail -> observer wins.
    expect(tryDetectHidden(dgsm, "observer", "hidden")).toBe(true);
  });

  it("falls back to perception, then default 25", () => {
    const dgsm = makeFakeDgsm([
      { id: "observer", skills: { perception: 70 } },
      { id: "hidden", skills: { Stealth: 40 } },
    ]);
    // Observer roll 50 vs 70 = regular; stealth roll 50 vs 40 = fail.
    expect(tryDetectHidden(dgsm, "observer", "hidden")).toBe(true);

    const dgsm2 = makeFakeDgsm([
      { id: "observer", skills: {} },
      { id: "hidden", skills: { Stealth: 40 } },
    ]);
    // Observer roll 50 vs default 25 = fail; stealth roll 50 vs 40 = fail; tie -> observer does NOT win.
    expect(tryDetectHidden(dgsm2, "observer", "hidden")).toBe(false);
  });

  it("returns false when the hidden character outrolls the observer", () => {
    const dgsm = makeFakeDgsm([
      { id: "observer", skills: { "Spot Hidden": 30 } },
      { id: "hidden", skills: { Stealth: 80 } },
    ]);
    // Observer roll 50 vs 30 = fail; stealth roll 50 vs 80 = regular.
    expect(tryDetectHidden(dgsm, "observer", "hidden")).toBe(false);
  });
});
