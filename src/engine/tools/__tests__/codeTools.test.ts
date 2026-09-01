// Code-tool tests: registry invocation recording and trusted dice.
//
// The session offers only dice tools now. `pathfinding`, `movementCost` and
// `inventoryValidation` were removed — the first two answered from the World
// Graph the request already carries, and the third was replaced by putting
// the named person's pockets into the request itself. Their tests went with
// them; the route planner they delegated to is covered by the movement
// subsystem's own tests.
import { describe, expect, it } from "vitest";
import type { CodeToolContext, EngineCodeTool } from "../codeTool.js";
import { CodeToolRegistry } from "../codeTool.js";
import { clampValue, damageRollTool, sanityCheckTool } from "../diceTools.js";

function makeDgsm(overrides: Record<string, unknown> = {}) {
  return {
    getState: () => ({
      scenes: new Map(),
      npcInventories: {},
      npcCharacters: [],
    }),
    getCharacterPosition: () => ({ type: "scene", sceneId: "SCN_1" }),
    resolveLocationId: () => "SCN_1",
    getNpcProfile: () => ({ skills: {} }),
    getSceneConditions: () => [],
    ...overrides,
  } as never;
}

const ctx = (dgsm = makeDgsm(), actionId?: string): CodeToolContext => ({
  dgsm,
  ...(actionId !== undefined ? { actionId } : {}),
});

describe("CodeToolRegistry", () => {
  it("records every invocation with actionId, input and output", async () => {
    const reg = new CodeToolRegistry();
    const echo: EngineCodeTool<{ v: number }, { doubled: number }> = {
      name: "echo",
      description: "test",
      execute: (input) => ({ doubled: input.v * 2 }),
    };
    reg.register(echo);

    const out = await reg.run<{ doubled: number }>(
      "echo",
      { v: 21 },
      ctx(makeDgsm(), "action_1")
    );
    expect(out).toEqual({ doubled: 42 });

    const log = reg.drainInvocations();
    expect(log).toEqual([
      {
        toolName: "echo",
        actionId: "action_1",
        input: { v: 21 },
        output: { doubled: 42 },
      },
    ]);
    expect(reg.drainInvocations()).toEqual([]);
  });

  it("records failures and rethrows", async () => {
    const reg = new CodeToolRegistry();
    reg.register({
      name: "boom",
      description: "test",
      execute: () => {
        throw new Error("kaput");
      },
    });

    await expect(reg.run("boom", {}, ctx())).rejects.toThrow("kaput");
    expect(reg.drainInvocations()).toMatchObject([
      { toolName: "boom", error: "kaput" },
    ]);
  });

  it("rejects unknown tools and duplicate registration", async () => {
    const reg = new CodeToolRegistry();
    await expect(reg.run("nope", {}, ctx())).rejects.toThrow(
      'unknown code tool "nope"'
    );
    reg.register({ name: "t", description: "", execute: () => 1 });
    expect(() =>
      reg.register({ name: "t", description: "", execute: () => 2 })
    ).toThrow("already registered");
  });
});

describe("damageRollTool", () => {
  it("rolls NdM+K with pinned dice", async () => {
    const out = await damageRollTool.execute(
      { formula: "2d6+1", fixedRolls: [3, 5] },
      ctx()
    );
    expect(out).toEqual({
      ok: true,
      total: 9,
      rolls: [3, 5],
      formulaTotal: 9,
      bonusTotal: 0,
    });
  });

  it("adds a dice damage bonus after the formula dice", async () => {
    const out = await damageRollTool.execute(
      { formula: "1d6", damageBonus: "+1d4", fixedRolls: [4, 2] },
      ctx()
    );
    expect(out).toEqual({
      ok: true,
      total: 6,
      rolls: [4, 2],
      formulaTotal: 4,
      bonusTotal: 2,
    });
  });

  it("supports flat formulas and negative flat bonuses", async () => {
    const out = await damageRollTool.execute(
      { formula: "3", damageBonus: "-1" },
      ctx()
    );
    expect(out).toEqual({
      ok: true,
      total: 2,
      rolls: [],
      formulaTotal: 3,
      bonusTotal: -1,
    });
  });

  it.each(["", "d6", "2x6", "1d", "abc"])(
    "rejects malformed formula %j",
    async (formula) => {
      expect(await damageRollTool.execute({ formula }, ctx())).toEqual({
        ok: false,
        reason: "invalid_formula",
      });
    }
  );
});

describe("sanityCheckTool", () => {
  const saneCharacter = makeDgsm({
    getNpcProfile: (id: string) =>
      id === "npc_1"
        ? { status: { san: 60, maxSan: 80 }, skills: {} }
        : undefined,
  });

  it("uses the success formula when d100 is at or below current SAN", () => {
    expect(
      sanityCheckTool.execute(
        {
          actionId: "action_1",
          characterId: "npc_1",
          successLoss: "0",
          failureLoss: "1d6",
          fixedRoll: 60,
        },
        ctx(saneCharacter, "action_1")
      )
    ).toEqual({
      ok: true,
      actionId: "action_1",
      characterId: "npc_1",
      currentSan: 60,
      roll: 60,
      passed: true,
      lossFormula: "0",
      lossRolls: [],
      loss: 0,
    });
  });

  it("rolls the failure loss without letting the model choose the result", () => {
    expect(
      sanityCheckTool.execute(
        {
          actionId: "action_2",
          characterId: "npc_1",
          successLoss: "1",
          failureLoss: "1d6",
          fixedRoll: 61,
          fixedLossRolls: [4],
        },
        ctx(saneCharacter, "action_2")
      )
    ).toMatchObject({
      ok: true,
      passed: false,
      lossFormula: "1d6",
      lossRolls: [4],
      loss: 4,
    });
  });

  it("rejects unknown or non-sanity-bearing characters and bad formulas", () => {
    expect(
      sanityCheckTool.execute(
        {
          actionId: "action_1",
          characterId: "missing",
          successLoss: "0",
          failureLoss: "1",
        },
        ctx(saneCharacter)
      )
    ).toEqual({ ok: false, reason: "unknown_character" });

    expect(
      sanityCheckTool.execute(
        {
          actionId: "action_1",
          characterId: "entity",
          successLoss: "0",
          failureLoss: "1",
        },
        ctx(
          makeDgsm({
            getNpcProfile: () => ({
              status: { san: 0, maxSan: 0 },
              skills: {},
            }),
          })
        )
      )
    ).toEqual({ ok: false, reason: "sanity_not_applicable" });

    expect(
      sanityCheckTool.execute(
        {
          actionId: "action_1",
          characterId: "npc_1",
          successLoss: "-1",
          failureLoss: "terror",
        },
        ctx(saneCharacter)
      )
    ).toEqual({ ok: false, reason: "invalid_loss_formula" });
  });
});

describe("clampValue", () => {
  it("clamps into the inclusive range", async () => {
    expect(clampValue(5, 0, 10)).toBe(5);
    expect(clampValue(-1, 0, 10)).toBe(0);
    expect(clampValue(11, 0, 10)).toBe(10);
  });
});
