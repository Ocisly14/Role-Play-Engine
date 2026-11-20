// The controller's wiring of the wake gate (DECISIONS_WAKE_GATE), the
// pending-delivery buffer. The gate decides
// only WHEN someone is woken; what it lets sleep is held and delivered whole
// on the next wake.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineAction, Occurrence } from "../../engine/actions/types.js";
import type { TickReport } from "../../engine/core/types.js";

const render = vi.fn();
const buildPerceivedBundle = vi.fn((args: Record<string, unknown>) => ({
  scene: { id: "SCN_1", name: "Study", description: "", activeConditions: [] },
  ownAction: { kind: "idle" },
  charactersInScene: [],
  occurrences: (args.occurrencesForNpc as Occurrence[] | undefined) ?? [],
}));
vi.mock("../renderer/index.js", () => ({
  render: (...args: unknown[]) => render(...args),
  buildPerceivedBundle: (args: Record<string, unknown>) =>
    buildPerceivedBundle(args),
}));
vi.mock("../userPromptBuilder.js", () => ({
  buildUserPromptSegments: () => [{ text: "## Who you are\nme", cache: true }],
}));
const askDecisions = vi.fn();
vi.mock("../../models/decisions.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../models/decisions.js"
  );
  return { ...actual, decide: (...a: unknown[]) => askDecisions(...a) };
});

const { NpcActionController } = await import("../npcActionController.js");

const NOW = "1923-04-02T09:05:00";

function report(overrides: Partial<TickReport> = {}): TickReport {
  return {
    gameDateTime: NOW,
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

/** Something npc_2 did, perceived fully by npc_1 — a bystander's view. */
function bystander(id: string): Occurrence {
  return {
    id,
    tickId: NOW,
    sourceActionIds: ["action_x"],
    locationId: "SCN_1",
    facts: [
      { id: `${id}#f0`, type: "action_result", content: "x", entityRefs: [] },
    ],
    participants: [{ characterId: "npc_2", role: "actor" }],
    perceivers: [{ characterId: "npc_1", sight: "clear", hearing: "clear" }],
    signals: [],
  };
}

function live(
  actorId: string,
  extra: Partial<EngineAction> = {}
): EngineAction {
  return {
    id: `action_${actorId}`,
    command: {
      commandId: `c_${actorId}`,
      actorId,
      issuedAt: "t",
      issuedSceneId: "SCN_1",
      description: "reading",
      objectRefs: [],
      proposedDurationTicks: 30,
    },
    status: "active",
    submittedAt: "t",
    progressMinutes: 1,
    ...extra,
  };
}

function harness(liveActions: EngineAction[] = []) {
  let handler: ((r: TickReport) => Promise<void>) | undefined;
  const engine = {
    on: (ev: string, cb: (r: TickReport) => Promise<void>) => {
      if (ev === "tickCompleted") handler = cb;
      return () => {};
    },
    getActorActions: (actorId: string) =>
      liveActions.filter((a) => a.command.actorId === actorId),
    getAction: (id: string) => liveActions.find((a) => a.id === id),
    submitCommand: vi.fn(async () => ({
      accepted: true,
      actionId: "a",
      status: "queued",
    })),
    requestInterruption: vi.fn(),
  };
  const dgsm = {
    getState: () => ({
      npcCharacters: ["npc_1"].map((id) => ({ id, name: id })),
    }),
    isNpcAlive: () => true,
    getNpcProfile: (id: string) => ({
      id,
      name: id,
      status: { conditions: [] },
    }),
    getGameDateTime: () => NOW,
    getCharacterPosition: () => ({ type: "scene", sceneId: "SCN_1" }),
    resolveLocationId: (pos: { sceneId: string }) => pos.sceneId,
    getScene: (id: string) => ({ id, name: id }),
    getRelationship: () => undefined,
  };
  const agent = {
    decideNext: vi.fn(async () => ({ tool: "continue" as const })),
  };
  const controller = new NpcActionController({
    engine: engine as never,
    agent: agent as never,
    memory: { getAllByTypes: vi.fn(async () => []) } as never,
    dgsm: dgsm as never,
    sessionId: "s1",
    moduleId: "m1",
    language: "en",
    decideConcurrency: 1,
  });
  return {
    fire: (r: TickReport) => (handler as (r: TickReport) => Promise<void>)(r),
    controller,
    agent,
  };
}

/** Prime a perception history so the "no history yet" hard wake is off. */
async function primeHistory(h: ReturnType<typeof harness>) {
  h.controller.restorePerceptionHistory([
    {
      npcId: "npc_1",
      gameDateTime: "t0",
      location: "SCN_1",
      narrative: "earlier",
    },
  ]);
}

describe("wake gate wiring", () => {
  beforeEach(() => {
    render.mockReset();
    render.mockResolvedValue({ narrative: "now" });
    askDecisions.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("off: a busy bystander who perceived something is woken as before, no Decisions call", async () => {
    const h = harness([live("npc_1")]);
    await primeHistory(h);
    await h.fire(report({ occurrences: [bystander("o1")] }));
    expect(askDecisions).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("on: a confident 'will not act' skips the render and holds the occurrence", async () => {
    vi.stubEnv("DECISIONS_WAKE_GATE", "on");
    askDecisions.mockResolvedValue({
      ok: true,
      answers: new Map([
        ["acts", { name: "acts", type: "predicate", probability: 0.03 }],
      ]),
    });
    const h = harness([live("npc_1")]);
    await primeHistory(h);
    await h.fire(report({ occurrences: [bystander("o1")] }));
    expect(render).not.toHaveBeenCalled();
    expect(
      h.controller.serializePendingDelivery().npc_1?.map((o) => o.id)
    ).toEqual(["o1"]);
  });

  it("the held occurrence is delivered whole on the next wake", async () => {
    vi.stubEnv("DECISIONS_WAKE_GATE", "on");
    askDecisions.mockResolvedValueOnce({
      ok: true,
      answers: new Map([
        ["acts", { name: "acts", type: "predicate", probability: 0.03 }],
      ]),
    });
    const h = harness([live("npc_1")]);
    await primeHistory(h);
    await h.fire(report({ occurrences: [bystander("o1")] }));
    // Next minute their own action ends: a hard wake, never asked.
    await h.fire(
      report({
        occurrences: [bystander("o2")],
        transitions: [
          {
            actionId: "action_npc_1",
            actorId: "npc_1",
            from: "active",
            to: "completed",
            progressDeltaMinutes: 1,
          },
        ],
      })
    );
    expect(askDecisions).toHaveBeenCalledTimes(1);
    const delivered = (
      buildPerceivedBundle.mock.calls.at(-1)?.[0] as {
        occurrencesForNpc?: Occurrence[];
      }
    ).occurrencesForNpc?.map((o) => o.id);
    expect(delivered).toEqual(["o1", "o2"]);
    expect(h.controller.serializePendingDelivery().npc_1).toBeUndefined();
  });

  it("a failed Decisions call wakes them", async () => {
    vi.stubEnv("DECISIONS_WAKE_GATE", "on");
    askDecisions.mockResolvedValue({ ok: false, reason: "timeout" });
    const h = harness([live("npc_1")]);
    await primeHistory(h);
    await h.fire(report({ occurrences: [bystander("o1")] }));
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("pending delivery survives a save and restore", async () => {
    vi.stubEnv("DECISIONS_WAKE_GATE", "on");
    askDecisions.mockResolvedValue({
      ok: true,
      answers: new Map([
        ["acts", { name: "acts", type: "predicate", probability: 0.03 }],
      ]),
    });
    const a = harness([live("npc_1")]);
    await primeHistory(a);
    await a.fire(report({ occurrences: [bystander("o1")] }));
    const saved = JSON.parse(
      JSON.stringify(a.controller.serializePendingDelivery())
    );
    const b = harness([live("npc_1")]);
    b.controller.restorePendingDelivery(saved);
    expect(
      b.controller.serializePendingDelivery().npc_1?.map((o) => o.id)
    ).toEqual(["o1"]);
  });
});
