import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { CharacterCondition } from "../../core/types.js";
import { getCharacterConditionPenalties } from "../characterConditionPenalties.js";

function seedNpc(
  d: DynamicGameStateManager,
  id: string,
  conditions: CharacterCondition[]
): void {
  d.registerNpcProfile({
    id,
    name: id,
    attributes: {
      STR: 50,
      CON: 50,
      DEX: 50,
      APP: 50,
      POW: 50,
      SIZ: 50,
      INT: 50,
      EDU: 50,
    },
    status: {
      hp: 10,
      maxHp: 10,
      san: 50,
      maxSan: 50,
      fatigue: 0,
      maxFatigue: 100,
      luck: 50,
      conditions,
    },
    inventory: [],
    skills: {},
    longTermIntent: "",
    relationships: [],
  });
}

describe("getCharacterConditionPenalties", () => {
  it("returns an empty map when the character has no conditions", () => {
    const d = new DynamicGameStateManager();
    seedNpc(d, "npc1", []);

    const penalties = getCharacterConditionPenalties("npc1", d);

    expect(penalties.size).toBe(0);
  });

  it("sums globalSkillPenalty across multiple conditions into the '*' key", () => {
    const d = new DynamicGameStateManager();
    seedNpc(d, "npc1", [
      {
        id: "c1",
        featureId: "stamina",
        description: "tired",
        mechanicalEffect: { globalSkillPenalty: -10 },
      },
      {
        id: "c2",
        featureId: "sanity",
        description: "shaken",
        mechanicalEffect: { globalSkillPenalty: -10 },
      },
    ]);

    const penalties = getCharacterConditionPenalties("npc1", d);

    expect(penalties.size).toBe(1);
    expect(penalties.get("*")).toBe(-20);
  });

  it("merges per-skill penalties with globalSkillPenalty", () => {
    const d = new DynamicGameStateManager();
    seedNpc(d, "npc1", [
      {
        id: "c1",
        featureId: "lighting",
        description: "dim",
        mechanicalEffect: { skillPenalty: { Spot: -5, Listen: -10 } },
      },
      {
        id: "c2",
        featureId: "stamina",
        description: "exhausted",
        mechanicalEffect: { globalSkillPenalty: -20 },
      },
    ]);

    const penalties = getCharacterConditionPenalties("npc1", d);

    expect(penalties.get("*")).toBe(-20);
    expect(penalties.get("Spot")).toBe(-5);
    expect(penalties.get("Listen")).toBe(-10);
    expect(penalties.size).toBe(3);
  });

  it("returns an empty map when the profile is missing", () => {
    const d = new DynamicGameStateManager();
    const penalties = getCharacterConditionPenalties("unknown", d);
    expect(penalties.size).toBe(0);
  });
});
