import { describe, expect, it, vi } from "vitest";
import type { ActionDefinitionSkillCheck } from "../../types.js";
import { executeSkillCheck } from "../skillCheckTool.js";

// Mock dice to control randomness
vi.mock("../../shared/dice.js", () => ({
  rollD100: vi.fn(() => 30),
  getSuccessLevel: vi.fn(() => "regular"),
  getSuccessLevelWithDifficulty: vi.fn(() => "regular"),
  SUCCESS_RANK: { fumble: 0, fail: 1, regular: 2, hard: 3, critical: 4 },
  getDamageBonus: vi.fn(() => "+0"),
  rollDamageBonus: vi.fn(() => 0),
}));

describe("executeSkillCheck", () => {
  const makeDgsm = (npcs: any[]) =>
    ({
      getState: () => ({
        npcCharacters: npcs,
      }),
      getScene: () => null,
      resolveLocationId: () => "scene_1",
      getCharacterPosition: () => ({ type: "scene", sceneId: "scene_1" }),
      getSceneConditions: () => [],
    }) as any;

  it("returns success for single skill check", () => {
    const skillCheck: ActionDefinitionSkillCheck = {
      skill: "Spot Hidden",
      difficulty: "regular",
      type: "single",
      failBehavior: "partial",
    };
    const dgsm = makeDgsm([
      { id: "npc_1", skills: { "Spot Hidden": 60 }, attributes: {} },
    ]);

    const result = executeSkillCheck(
      skillCheck,
      "npc_1",
      undefined,
      dgsm,
      "scene_1"
    );
    expect(result.status).toBe("completed");
    expect(result.done).toBe(true);
  });

  it("returns no-op when no skill check defined", () => {
    const result = executeSkillCheck(
      undefined,
      "npc_1",
      undefined,
      {} as any,
      "scene_1"
    );
    expect(result.status).toBe("completed");
    expect(result.done).toBe(true);
    expect(result.successLevel).toBe("regular");
  });
});
