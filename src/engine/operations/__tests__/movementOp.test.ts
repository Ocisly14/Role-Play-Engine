import { movementOp } from "../movementOp.js";

describe("movementOp", () => {
  it("has correct id and schema", () => {
    expect(movementOp.id).toBe("movement");
    expect(movementOp.schema.requiredParams.map((p) => p.name)).toEqual([
      "actorId",
      "action",
      "destination",
    ]);
  });

  it("execute returns delta with newPosition on success", async () => {
    const dgsm = {
      getState: () => ({
        npcCharacters: [{ id: "npc_a", skills: { Stealth: 50 } }],
        blockedConnections: new Map(),
      }),
      getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
      resolveLocationId: () => "s1",
      getTopology: () => ({
        junctions: new Map(),
        roads: new Map(),
        junctionToRoads: new Map(),
        sceneToParent: new Map([
          ["s1", { type: "junction", junctionId: "j1" }],
          ["s2", { type: "junction", junctionId: "j1" }],
        ]),
      }),
      setCharacterPosition: vi.fn(),
    };
    const ctx = {
      getNodeDifficulty: () => "regular" as const,
      getScenePenalties: () => new Map(),
      getCharacterPenalties: () => new Map(),
      applyPenalties: (_s: Record<string, number>) => _s,
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const result = await movementOp.execute(
      { actorId: "npc_a", action: "Walk to s2", destination: "s2" },
      dgsm as any,
      ctx as any
    );

    expect(result.delta.status).toBe("completed");
    expect(result.narrative.outcome).toBeTruthy();
  });

  it("execute returns failed delta when no destination", async () => {
    const dgsm = {
      getState: () => ({
        npcCharacters: [{ id: "npc_a", skills: {} }],
        blockedConnections: new Map(),
      }),
      getCharacterPosition: () => ({ type: "scene", sceneId: "s1" }),
      resolveLocationId: () => "s1",
      getTopology: () => ({
        junctions: new Map(),
        roads: new Map(),
        junctionToRoads: new Map(),
        sceneToParent: new Map(),
      }),
    };
    const ctx = {
      getNodeDifficulty: () => "regular" as const,
      getScenePenalties: () => new Map(),
      getCharacterPenalties: () => new Map(),
      applyPenalties: (_s: Record<string, number>) => _s,
    };

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const result = await movementOp.execute(
      { actorId: "npc_a", action: "Walk", destination: "" },
      dgsm as any,
      ctx as any
    );

    expect(result.delta.status).toBe("failed");
  });

  it("applyDelta sets character position when completed", () => {
    const setPos = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = { setCharacterPosition: setPos } as any;

    movementOp.applyDelta(dgsm, {
      status: "completed",
      actorId: "npc_a",
      newPosition: { type: "scene", sceneId: "s2" },
      outcome: "Arrived",
    });

    expect(setPos).toHaveBeenCalledWith("npc_a", {
      type: "scene",
      sceneId: "s2",
    });
  });

  it("applyDelta does nothing when failed", () => {
    const setPos = vi.fn();
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = { setCharacterPosition: setPos } as any;

    movementOp.applyDelta(dgsm, {
      status: "failed",
      actorId: "npc_a",
      newPosition: null,
      outcome: "Blocked",
    });

    expect(setPos).not.toHaveBeenCalled();
  });
});
