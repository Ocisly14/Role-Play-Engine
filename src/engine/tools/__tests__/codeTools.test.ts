// Phase 5 code-tool tests: registry invocation recording, inventory
// location/uniqueness/reach facts, damage-formula parsing, opposed-roll
// penalty application, and the pathfinding/movementCost delegation to the
// movement subsystem's route planner (mocked — route mechanics themselves
// are covered by the movement subsystem's own tests).

import { describe, expect, it, vi } from "vitest";
import type { CodeToolContext, EngineCodeTool } from "../codeTool.js";
import { CodeToolRegistry } from "../codeTool.js";
import { clampValue, damageRollTool, opposedRollTool } from "../diceTools.js";
import { inventoryValidationTool } from "../inventoryValidationTool.js";

const planMovementRoute = vi.fn();
vi.mock("../../subsystem/movement.js", () => ({
  planMovementRoute: (...args: unknown[]) => planMovementRoute(...args),
}));

const { pathfindingTool } = await import("../pathfindingTool.js");
const { movementCostTool } = await import("../movementCostTool.js");

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

describe("inventoryValidationTool", () => {
  const dgsm = makeDgsm({
    getState: () => ({
      scenes: new Map([
        ["SCN_1", { id: "SCN_1", items: [{ id: "lamp" }] }],
        ["SCN_2", { id: "SCN_2", items: [{ id: "dup" }] }],
      ]),
      npcInventories: {
        npc_1: [{ id: "ledger" }],
        npc_2: [{ id: "dup" }],
      },
      npcCharacters: [],
    }),
  });

  it("locates a scene item and answers actor reach", () => {
    const out = inventoryValidationTool.execute(
      { itemId: "lamp", actorId: "npc_1" },
      ctx(dgsm)
    );
    expect(out).toEqual({
      exists: true,
      locations: [{ kind: "scene", id: "SCN_1" }],
      uniqueOwnership: true,
      actor: { holdsItem: false, canReach: true },
    });
  });

  it("locates an inventory item held by the actor", () => {
    const out = inventoryValidationTool.execute(
      { itemId: "ledger", actorId: "npc_1" },
      ctx(dgsm)
    );
    expect(out.actor).toEqual({ holdsItem: true, canReach: true });
  });

  it("flags duplicate ownership as a violation", () => {
    const out = inventoryValidationTool.execute({ itemId: "dup" }, ctx(dgsm));
    expect(out.exists).toBe(true);
    expect(out.uniqueOwnership).toBe(false);
    expect(out.locations).toHaveLength(2);
  });

  it("reports a nonexistent item", () => {
    const out = inventoryValidationTool.execute(
      { itemId: "ghost", actorId: "npc_1" },
      ctx(dgsm)
    );
    expect(out).toMatchObject({
      exists: false,
      locations: [],
      uniqueOwnership: true,
      actor: { holdsItem: false, canReach: false },
    });
  });
});

describe("damageRollTool", () => {
  it("rolls NdM+K with pinned dice", () => {
    const out = damageRollTool.execute(
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

  it("adds a dice damage bonus after the formula dice", () => {
    const out = damageRollTool.execute(
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

  it("supports flat formulas and negative flat bonuses", () => {
    const out = damageRollTool.execute(
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
    (formula) => {
      expect(damageRollTool.execute({ formula }, ctx())).toEqual({
        ok: false,
        reason: "invalid_formula",
      });
    }
  );
});

describe("opposedRollTool", () => {
  it("rolls the defender's penalty-adjusted trained value", () => {
    const dgsm = makeDgsm({
      getNpcProfile: () => ({
        skills: { Dodge: 50 },
        status: {
          conditions: [
            {
              id: "c1",
              description: "sprained ankle",
              mechanicalEffect: { skillPenalty: { Dodge: -20 } },
            },
          ],
        },
      }),
    });
    const out = opposedRollTool.execute(
      { characterId: "npc_1", skillId: "Dodge", fixedRoll: 30 },
      ctx(dgsm)
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record.skillValue).toBe(30);
    expect(out.record.roll).toBe(30);
    expect(out.record.successLevel).toBe("regular");
  });

  it("rejects an unknown defense skill", () => {
    expect(
      opposedRollTool.execute(
        { characterId: "npc_1", skillId: "Not A Skill" },
        ctx()
      )
    ).toEqual({ ok: false, reason: "unknown_skill" });
  });
});

describe("pathfinding/movementCost delegation", () => {
  it("summarizes a planned route", () => {
    planMovementRoute.mockReturnValue({
      ok: true,
      totalMinutes: 7,
      targetPosition: { type: "scene", sceneId: "SCN_2" },
      steps: [
        {
          kind: "to_junction",
          from: { type: "scene", sceneId: "SCN_1" },
          to: { type: "junction", junctionId: "J1" },
          durationMinutes: 2,
        },
        {
          kind: "along_road",
          from: { type: "junction", junctionId: "J1" },
          to: { type: "junction", junctionId: "J2" },
          durationMinutes: 5,
          roadId: "ROAD_1",
        },
      ],
    });

    const out = pathfindingTool.execute(
      { characterId: "npc_1", destinationId: "SCN_2" },
      ctx()
    );
    expect(out).toEqual({
      reachable: true,
      totalMinutes: 7,
      targetPosition: { type: "scene", sceneId: "SCN_2" },
      steps: [
        { kind: "to_junction", durationMinutes: 2 },
        { kind: "along_road", durationMinutes: 5, roadId: "ROAD_1" },
      ],
      alreadyThere: false,
    });
    expect(planMovementRoute).toHaveBeenCalledWith(
      expect.anything(),
      "npc_1",
      "SCN_2"
    );
  });

  it("propagates unreachability and converts minutes to ticks", () => {
    planMovementRoute.mockReturnValue({ ok: false, reason: "no_path" });
    expect(
      pathfindingTool.execute(
        { characterId: "npc_1", destinationId: "SCN_X" },
        ctx()
      )
    ).toEqual({ reachable: false, reason: "no_path" });

    planMovementRoute.mockReturnValue({
      ok: true,
      totalMinutes: 7.5,
      targetPosition: { type: "scene", sceneId: "SCN_2" },
      steps: [],
    });
    expect(
      movementCostTool.execute(
        { characterId: "npc_1", destinationId: "SCN_2" },
        ctx()
      )
    ).toEqual({ reachable: true, totalMinutes: 7.5, totalTicks: 8 });
  });
});

describe("clampValue", () => {
  it("clamps into the inclusive range", () => {
    expect(clampValue(5, 0, 10)).toBe(5);
    expect(clampValue(-1, 0, 10)).toBe(0);
    expect(clampValue(11, 0, 10)).toBe(10);
  });
});
