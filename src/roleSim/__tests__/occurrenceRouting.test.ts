// Phase 9 controller routing: perceiver-listed occurrences reach exactly the
// listed NPCs, ended actors + idle NPCs join the decide() set, busy NPCs
// without occurrences are skipped, and subjective memories come from the
// rendered perception (event for the actor, witness for perceivers).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EngineAction,
  Occurrence,
  OccurrencePerceiver,
} from "../../engine/actions/types.js";
import type { TickReport } from "../../engine/core/types.js";

const render = vi.fn();
const buildPerceivedBundle = vi.fn((..._args: unknown[]) => ({ bundle: true }));
vi.mock("../renderer/index.js", () => ({
  render: (...args: unknown[]) => render(...args),
  buildPerceivedBundle: (...args: unknown[]) => buildPerceivedBundle(...args),
}));

const { NpcActionController } = await import("../npcActionController.js");

function makeReport(overrides: Partial<TickReport> = {}): TickReport {
  return {
    gameDateTime: "1923-04-02T09:05:00",
    transitions: [],
    occurrences: [],
    commits: [],
    cancellations: [],
    featureEvents: [],
    stateChanges: [],
    damageReports: [],
    ...overrides,
  };
}

/** A bare id is a `full` perceiver; pass an object to grade one. */
function occurrence(
  perceivers: ReadonlyArray<string | OccurrencePerceiver>
): Occurrence {
  return {
    id: "occ_1",
    tickId: "t",
    sourceActionIds: ["action_1"],
    locationId: "SCN_1",
    facts: [
      {
        id: "occ_1#f0",
        type: "speech",
        content: "npc_1 asks about the harbor",
        entityRefs: [],
      },
    ],
    participants: [{ characterId: "npc_1", role: "actor" }],
    perceivers: perceivers.map((p) =>
      typeof p === "string" ? { characterId: p, clarity: "full" } : p
    ),
    signals: [{ factIds: ["occ_1#f0"], channel: "sound" }],
  };
}

function harness(
  opts: {
    liveActions?: EngineAction[];
    /** Scene per NPC; anyone unlisted stands in SCN_1. */
    positions?: Record<string, string>;
  } = {}
) {
  let tickHandler: ((r: TickReport) => Promise<void>) | undefined;
  const engine = {
    on: (ev: string, cb: (r: TickReport) => Promise<void>) => {
      if (ev === "tickCompleted") tickHandler = cb;
      return () => {};
    },
    getActorActions: (actorId: string) =>
      (opts.liveActions ?? []).filter((a) => a.command.actorId === actorId),
    getAction: (id: string) =>
      (opts.liveActions ?? []).find((a) => a.id === id),
    submitCommand: vi.fn(async () => ({
      accepted: true,
      actionId: "a",
      status: "queued",
    })),
    requestInterruption: vi.fn(),
  };
  const memoryAdds: Array<Record<string, unknown>> = [];
  const memory = {
    add: vi.fn(async (entry: Record<string, unknown>) => {
      memoryAdds.push(entry);
    }),
    findLatestByType: vi.fn(async () => undefined),
    // Memory is injected whole now — the controller reads everything the
    // character holds, not just today.
    getAllByTypes: vi.fn(async () => []),
    ensureMapMemories: vi.fn(async () => 0),
  };
  const npcs = ["npc_1", "npc_2", "npc_3"];
  const dgsm = {
    getState: () => ({
      npcCharacters: npcs.map((id) => ({ id, name: id })),
    }),
    isNpcAlive: () => true,
    getNpcProfile: (id: string) => ({
      id,
      name: id,
      status: { conditions: [] },
    }),
    getGameDateTime: () => "1923-04-02T09:05:00",
    getCharacterPosition: (id: string) => ({
      type: "scene",
      sceneId: opts.positions?.[id] ?? "SCN_1",
    }),
    resolveLocationId: (pos: { sceneId: string }) => pos.sceneId,
    getScene: (id: string) => ({ id, name: id === "SCN_1" ? "Study" : id }),
  };
  const decisions: string[] = [];
  const agent = {
    decideNext: vi.fn(async (ctx: { npcId: string }) => {
      decisions.push(ctx.npcId);
      return { tool: "continue" as const };
    }),
  };
  const controller = new NpcActionController({
    engine: engine as never,
    agent: agent as never,
    memory: memory as never,
    dgsm: dgsm as never,
    sessionId: "s1",
    moduleId: "mod_1",
    language: "en",
    decideConcurrency: 3,
  });
  return {
    fire: (r: TickReport) => {
      if (!tickHandler) throw new Error("tickCompleted handler not registered");
      return tickHandler(r);
    },
    controller,
    decisions,
    memoryAdds,
    agent,
  };
}

function liveAction(actorId: string): EngineAction {
  return {
    id: `action_${actorId}`,
    command: {
      commandId: `c_${actorId}`,
      actorId,
      issuedAt: "t",
      issuedSceneId: "SCN_1",
      description: "busy doing something",
      objectRefs: [],
      proposedDurationTicks: 5,
    },
    status: "active",
    submittedAt: "t",
    progressMinutes: 1,
  };
}

describe("occurrence routing", () => {
  beforeEach(() => {
    render.mockReset();
    buildPerceivedBundle.mockClear();
    render.mockResolvedValue({ narrative: "Something happens." });
  });

  it("wakes exactly the listed perceivers (plus idle NPCs) and hands them their occurrences", async () => {
    // npc_3 is busy and NOT a perceiver — must be skipped.
    const h = harness({ liveActions: [liveAction("npc_3")] });
    await h.fire(makeReport({ occurrences: [occurrence(["npc_1", "npc_2"])] }));

    expect(h.decisions.sort()).toEqual(["npc_1", "npc_2"]);
    const bundleCalls = buildPerceivedBundle.mock.calls.map(
      (c) => c[0] as { npcId: string; occurrencesForNpc?: Occurrence[] }
    );
    for (const call of bundleCalls) {
      expect(call.occurrencesForNpc).toHaveLength(1);
    }
  });

  it("runs co-located NPC pipelines concurrently from the same tick", async () => {
    const h = harness();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    render.mockImplementation(async ({ npcId }: { npcId: string }) => {
      started.push(npcId);
      await gate;
      return { narrative: "Something happens." };
    });

    const pending = h.fire(makeReport());
    await vi.waitFor(() => expect(started).toHaveLength(3));
    release();
    await pending;
  });

  it("runs the initial bootstrap with the same bounded concurrency", async () => {
    const h = harness();
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    render.mockImplementation(async ({ npcId }: { npcId: string }) => {
      started.push(npcId);
      await gate;
      return { narrative: "The room around me." };
    });

    const pending = h.controller.bootstrap();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    release();
    await pending;
  });

  it("a perceiver graded `trace` is still woken, with the same shared row", async () => {
    // The grade is the renderer's business; routing asks only whether the
    // character is listed. One row object reaches every perceiver — the
    // Engine writes no per-viewer copies.
    const h = harness({ liveActions: [liveAction("npc_3")] });
    const occ = occurrence([
      "npc_1",
      { characterId: "npc_2", clarity: "trace" },
    ]);
    await h.fire(makeReport({ occurrences: [occ] }));

    expect(h.decisions.sort()).toEqual(["npc_1", "npc_2"]);
    const forNpc2 = buildPerceivedBundle.mock.calls
      .map((c) => c[0] as { npcId: string; occurrencesForNpc?: Occurrence[] })
      .find((c) => c.npcId === "npc_2");
    expect(forNpc2?.occurrencesForNpc?.[0]).toBe(occ);
  });

  it("a busy NPC listed as perceiver IS woken (chance to replace its action)", async () => {
    const h = harness({ liveActions: [liveAction("npc_3")] });
    await h.fire(makeReport({ occurrences: [occurrence(["npc_3"])] }));
    expect(h.decisions).toContain("npc_3");
  });

  it("writes NO memory itself — the character records its own via writeMemory", async () => {
    // Perception is injected raw and fades; nothing is persisted on the
    // character's behalf, whether they merely perceived something or their
    // own action just ended.
    const h = harness({ liveActions: [liveAction("npc_3")] });
    await h.fire(
      makeReport({
        transitions: [
          {
            actionId: "action_npc_1",
            actorId: "npc_1",
            from: "active",
            to: "completed",
            progressDeltaMinutes: 3,
          },
        ],
        occurrences: [occurrence(["npc_1", "npc_2"])],
      })
    );

    expect(h.decisions.length).toBeGreaterThan(0);
    expect(h.memoryAdds).toEqual([]);
  });

  it("adapts FeatureEvents into occurrence-shaped wake-ups (migration shim)", async () => {
    const h = harness({ liveActions: [liveAction("npc_3")] });
    // impact-5 global event propagates to everyone via findAffectedCharacters.
    await h.fire(
      makeReport({
        featureEvents: [
          {
            type: "character.died",
            impact: 5,
            description: "npc_2 died",
            characterId: "npc_2",
          },
        ],
      })
    );
    // Every NPC (including the busy one) received an occurrence-form event.
    expect(h.decisions.length).toBeGreaterThan(0);
    const bundleCalls = buildPerceivedBundle.mock.calls.map(
      (c) => c[0] as { occurrencesForNpc?: Occurrence[] }
    );
    const withOcc = bundleCalls.filter(
      (c) => (c.occurrencesForNpc?.length ?? 0) > 0
    );
    expect(withOcc.length).toBeGreaterThan(0);
    expect(withOcc[0].occurrencesForNpc?.[0].facts[0].content).toBe(
      "npc_2 died"
    );
  });

  it("shim grades a co-located NPC `full` and a remote one `trace`", async () => {
    // npc_3 is in another scene; a global (impact 5) event still reaches
    // them, but only as a trace. npc_1 shares the room with the event's
    // character and gets it whole.
    const h = harness({ positions: { npc_3: "SCN_far" } });
    await h.fire(
      makeReport({
        featureEvents: [
          {
            type: "character.died",
            impact: 5,
            description: "npc_2 died",
            characterId: "npc_2",
            sceneId: "SCN_1",
          },
        ],
      })
    );
    const withOcc = buildPerceivedBundle.mock.calls
      .map((c) => c[0] as { npcId: string; occurrencesForNpc?: Occurrence[] })
      .filter((c) => (c.occurrencesForNpc?.length ?? 0) > 0);
    expect(withOcc.map((c) => c.npcId).sort()).toEqual(["npc_1", "npc_3"]);
    const perceivers = withOcc[0].occurrencesForNpc?.[0].perceivers ?? [];
    expect(perceivers).toContainEqual({
      characterId: "npc_1",
      clarity: "full",
    });
    expect(perceivers).toContainEqual({
      characterId: "npc_3",
      clarity: "trace",
    });
    // The shim has no `limited` to offer — that is the Engine's judgement.
    expect(perceivers.some((p) => p.clarity === "limited")).toBe(false);
  });
});
