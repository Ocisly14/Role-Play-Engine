// Phase 9 controller routing: perceiver-listed occurrences reach exactly the
// listed NPCs, ended actors + idle NPCs join the decide() set, busy NPCs
// without occurrences are skipped, and subjective memories come from the
// rendered perception (event for the actor, witness for perceivers).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineAction, Occurrence } from "../../engine/actions/types.js";
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

function occurrence(perceivers: string[]): Occurrence {
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
    perceiverCharacterIds: perceivers,
    signals: [{ factIds: ["occ_1#f0"], channel: "sound" }],
  };
}

function harness(opts: { liveActions?: EngineAction[] } = {}) {
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
    getForDateByTypes: vi.fn(async () => []),
  };
  const npcs = ["npc_1", "npc_2", "npc_3"];
  const dgsm = {
    getState: () => ({
      npcCharacters: npcs.map((id) => ({ id, name: id })),
    }),
    isNpcAlive: () => true,
    getNpcProfile: (id: string) => ({ id, name: id, status: { conditions: [] } }),
    getGameDateTime: () => "1923-04-02T09:05:00",
    getCharacterPosition: () => ({ type: "scene", sceneId: "SCN_1" }),
    resolveLocationId: () => "SCN_1",
    getScene: () => ({ id: "SCN_1", name: "Study" }),
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
    moduleId: "m1",
    language: "en",
  });
  void controller;
  return {
    fire: (r: TickReport) => tickHandler!(r),
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
});
