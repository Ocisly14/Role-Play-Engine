import { actionOp } from "../actionOp.js";

describe("actionOp", () => {
  it("has correct id and schema", () => {
    expect(actionOp.id).toBe("action");
    expect(actionOp.schema.requiredParams.map((p) => p.name)).toEqual([
      "actorId",
      "action",
    ]);
    expect(actionOp.schema.optionalParams?.map((p) => p.name)).toEqual([
      "skill",
    ]);
  });

  it("execute with no skill returns auto-success and null sceneDelta", async () => {
    const dgsm = {
      getState: () => ({
        npcCharacters: [{ id: "npc_a", skills: {} }],
      }),
      getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
      resolveLocationId: () => "s1",
    };
    const ctx = {
      getScenePenalties: () => new Map(),
      getCharacterPenalties: () => new Map(),
      applyPenalties: (_s: Record<string, number>) => _s,
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const result = await actionOp.execute(
      { actorId: "npc_a", action: "Rest quietly" },
      dgsm as any,
      ctx as any
    );

    expect(result.delta.status).toBe("completed");
    expect(result.delta.actorId).toBe("npc_a");
    expect(result.delta.locationId).toBe("s1");
    expect(result.delta.sceneDelta).toBeNull();
    expect(result.narrative.outcome).toBe("Rest quietly");
  });

  it("execute with failed skill roll returns failed delta", async () => {
    const dgsm = {
      getState: () => ({
        npcCharacters: [{ id: "npc_a", skills: { "Spot Hidden": 40 } }],
      }),
      getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
      resolveLocationId: () => "s1",
    };
    const ctx = {
      getScenePenalties: () => new Map(),
      getCharacterPenalties: () => new Map(),
      applyPenalties: (_s: Record<string, number>) => _s,
      resolveSkillRoll: () => ({
        failed: true,
        successLevel: "fail" as const,
        reason: "Rolled 95 vs 40",
      }),
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const result = await actionOp.execute(
      { actorId: "npc_a", action: "Search the room", skill: "Spot Hidden" },
      dgsm as any,
      ctx as any
    );

    expect(result.delta.status).toBe("failed");
    expect(result.delta.failureReason).toBe("skill_roll_failed");
    expect(result.delta.successLevel).toBe("fail");
    expect(result.delta.rollDetail).toBe("Rolled 95 vs 40");
    expect(result.delta.sceneDelta).toBeNull();
  });

  it("applyDelta with sceneDelta calls applyActionSceneDelta", () => {
    const appendSceneCondition = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = {
      getSceneConditions: () => [],
      replaceSceneConditions: vi.fn(),
      appendSceneCondition,
      setConnectionBlocked: vi.fn(),
      setConnectionHidden: vi.fn(),
    } as any;

    actionOp.applyDelta(dgsm, {
      status: "completed",
      actorId: "npc_a",
      locationId: "s1",
      sceneDelta: {
        addSceneConditions: [{ description: "the door is barricaded" }],
        memory: "I barricaded the door.",
      },
    });

    expect(appendSceneCondition).toHaveBeenCalledWith("s1", {
      description: "the door is barricaded",
    });
  });

  it("applyDelta with null sceneDelta is a no-op", () => {
    const appendSceneCondition = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = {
      appendSceneCondition,
    } as any;

    actionOp.applyDelta(dgsm, {
      status: "completed",
      actorId: "npc_a",
      locationId: "s1",
      sceneDelta: null,
    });

    expect(appendSceneCondition).not.toHaveBeenCalled();
  });
});
