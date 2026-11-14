// The controller's player branch: manual mode pauses when the wake classifier
// says the player is needed and advances the queue through the translator
// otherwise; delegated mode decides like an NPC and pauses only on
// `askFriend`. NPCs are untouched (occurrenceRouting / decideConcurrency
// cover them unmodified).

import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ActionCommand,
  ActionTransition,
  EngineAction,
  EngineActionStatus,
  Occurrence,
  OccurrencePerceiver,
} from "../../engine/actions/types.js";
import type { TickReport } from "../../engine/core/types.js";
import type {
  PlayerPort,
  PlayerStepTranslator,
} from "../../player/playerPort.js";
import {
  type PlayerPending,
  type PlayerState,
  type QueueStep,
  createPlayerState,
} from "../../player/playerState.js";
import type { RoleSimContext, RoleSimDecision } from "../agent.js";

const render = vi.fn();
const buildPerceivedBundle = vi.fn((..._args: unknown[]) => ({ bundle: true }));
vi.mock("../renderer/index.js", () => ({
  render: (...args: unknown[]) => render(...args),
  buildPerceivedBundle: (...args: unknown[]) => buildPerceivedBundle(...args),
}));

const { NpcActionController } = await import("../npcActionController.js");

const NOW = "1923-04-02T09:05:00";

function makeReport(overrides: Partial<TickReport> = {}): TickReport {
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

function occurrence(
  sourceActionIds: string[],
  perceivers: OccurrencePerceiver[]
): Occurrence {
  return {
    id: "occ_1",
    tickId: "t",
    sourceActionIds,
    locationId: "SCN_1",
    facts: [
      { id: "occ_1#f0", type: "speech", content: "words", entityRefs: [] },
    ],
    participants: [],
    perceivers,
    signals: [{ factIds: ["occ_1#f0"], channel: "sound" }],
  };
}

function action(
  id: string,
  actorId: string,
  status: EngineActionStatus,
  replacesActionId?: string
): EngineAction {
  return {
    id,
    command: {
      commandId: `c_${id}`,
      actorId,
      issuedAt: "t",
      issuedSceneId: "SCN_1",
      description: "busy doing something",
      objectRefs: [],
      proposedDurationTicks: 5,
      ...(replacesActionId !== undefined ? { replacesActionId } : {}),
    },
    status,
    submittedAt: "t",
    progressMinutes: 1,
  };
}

function transition(
  actionId: string,
  to: EngineActionStatus,
  actorId = "p1"
): ActionTransition {
  return { actionId, actorId, from: "active", to, progressDeltaMinutes: 1 };
}

function step(
  id: string,
  text: string,
  status: QueueStep["status"],
  actionId?: string
): QueueStep {
  return { id, text, status, ...(actionId ? { actionId } : {}) };
}

const ACT: Extract<RoleSimDecision, { tool: "act" }> = {
  tool: "act",
  description: "walk to the library",
  objectRefs: [],
  proposedDurationTicks: 5,
};

function harness(opts: {
  state: Partial<PlayerState>;
  actions?: EngineAction[];
  /** null: no translator wired. */
  translate?: ((ctx: RoleSimContext, s: QueueStep) => RoleSimDecision) | null;
  playerDecision?: (ctx: RoleSimContext) => RoleSimDecision;
  npcDecision?: (ctx: RoleSimContext) => RoleSimDecision;
}) {
  const actions = opts.actions ?? [];
  let tickHandler: ((r: TickReport) => Promise<void>) | undefined;
  const submitted: ActionCommand[] = [];
  const engine = {
    on: (ev: string, cb: (r: TickReport) => Promise<void>) => {
      if (ev === "tickCompleted") tickHandler = cb;
      return () => {};
    },
    getActorActions: (actorId: string) =>
      actions.filter((a) => a.command.actorId === actorId),
    getAction: (id: string) => actions.find((a) => a.id === id),
    submitCommand: vi.fn(async (command: ActionCommand) => {
      submitted.push(command);
      const id = `action_${command.commandId}`;
      actions.push({ ...action(id, command.actorId, "queued"), command });
      return { accepted: true, actionId: id, status: "queued" as const };
    }),
    requestInterruption: vi.fn(),
  };
  const memory = {
    add: vi.fn(async () => {}),
    findLatestByType: vi.fn(async () => undefined),
    getAllByTypes: vi.fn(async () => []),
    ensureMapMemories: vi.fn(async () => 0),
  };
  const dgsm = {
    getState: () => ({
      npcCharacters: ["p1", "npc_1"].map((id) => ({ id, name: id })),
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
    getRoad: () => null,
    getRelationship: () => undefined,
  };

  let state: PlayerState = { ...createPlayerState("p1"), ...opts.state };
  const pauses: PlayerPending[] = [];
  const port: PlayerPort = {
    playerId: () => "p1",
    get: () => state,
    set: (next) => {
      state = next;
    },
    requestPause: (pending) => {
      pauses.push(pending);
    },
  };

  const translateStep = vi.fn(
    async (ctx: RoleSimContext, s: QueueStep): Promise<RoleSimDecision> =>
      opts.translate ? opts.translate(ctx, s) : ACT
  );
  const translator: PlayerStepTranslator = { translateStep };

  const agent = {
    decideNext: vi.fn(async (ctx: RoleSimContext) =>
      ctx.npcId === "p1"
        ? (opts.playerDecision?.(ctx) ?? { tool: "continue" as const })
        : (opts.npcDecision?.(ctx) ?? { tool: "continue" as const })
    ),
  };
  const onPerception = vi.fn();

  const controller = new NpcActionController({
    engine: engine as never,
    agent: agent as never,
    memory: memory as never,
    dgsm: dgsm as never,
    sessionId: "s1",
    moduleId: "mod_1",
    language: "en",
    decideConcurrency: 2,
    onPerception,
    player: port,
    ...(opts.translate === null ? {} : { playerTranslator: translator }),
  });

  const agentCallsFor = (id: string) =>
    agent.decideNext.mock.calls
      .map((c) => c[0] as RoleSimContext)
      .filter((ctx) => ctx.npcId === id);

  return {
    fire: (r: TickReport) => {
      if (!tickHandler) throw new Error("tickCompleted handler not registered");
      return tickHandler(r);
    },
    controller,
    state: () => state,
    setState: (next: PlayerState) => {
      state = next;
    },
    pauses,
    submitted,
    submittedBy: (id: string) => submitted.filter((c) => c.actorId === id),
    translateStep,
    agentCallsFor,
    onPerception,
  };
}

beforeEach(() => {
  render.mockReset();
  buildPerceivedBundle.mockClear();
  render.mockResolvedValue({ narrative: "Something happens." });
});

describe("manual mode", () => {
  it("a completed step with a next step queued advances without pausing", async () => {
    const h = harness({
      state: {
        queue: [
          step("s1", "go to the library", "running", "action_old"),
          step("s2", "read the old papers", "pending"),
        ],
      },
      actions: [action("action_old", "p1", "completed")],
    });
    await h.fire(
      makeReport({ transitions: [transition("action_old", "completed")] })
    );

    expect(h.pauses).toEqual([]);
    expect(h.agentCallsFor("p1")).toEqual([]);
    expect(h.translateStep).toHaveBeenCalledTimes(1);
    const [ctx, s] = h.translateStep.mock.calls[0];
    expect(ctx.player).toEqual({ mode: "manual" });
    expect(s.text).toBe("read the old papers");

    const commands = h.submittedBy("p1");
    expect(commands).toHaveLength(1);
    expect(commands[0].description).toBe("walk to the library");

    const queue = h.state().queue;
    expect(queue[0]).toMatchObject({ id: "s1", status: "done" });
    expect(queue[1]).toMatchObject({
      id: "s2",
      status: "running",
      actionId: `action_${commands[0].commandId}`,
    });
  });

  it("a clearly perceived occurrence caused by someone else pauses (woken)", async () => {
    const h = harness({
      state: { queue: [step("s1", "x", "running", "action_p1")] },
      actions: [
        action("action_p1", "p1", "active"),
        action("action_npc_1", "npc_1", "active"),
      ],
    });
    await h.fire(
      makeReport({
        occurrences: [
          occurrence(["action_npc_1"], [{ characterId: "p1", clarity: "full" }]),
        ],
      })
    );

    expect(h.pauses).toEqual([{ kind: "decision", since: NOW, reason: "woken" }]);
    expect(h.agentCallsFor("p1")).toEqual([]);
    expect(h.translateStep).not.toHaveBeenCalled();
  });

  it("a trace-only occurrence while busy is recorded but does not pause", async () => {
    const h = harness({
      state: { queue: [step("s1", "x", "running", "action_p1")] },
      actions: [
        action("action_p1", "p1", "active"),
        action("action_npc_1", "npc_1", "active"),
      ],
    });
    await h.fire(
      makeReport({
        occurrences: [
          occurrence(
            ["action_npc_1"],
            [{ characterId: "p1", clarity: "trace" }]
          ),
        ],
      })
    );

    expect(h.pauses).toEqual([]);
    expect(h.agentCallsFor("p1")).toEqual([]);
    expect(h.translateStep).not.toHaveBeenCalled();
    const forPlayer = h.onPerception.mock.calls.filter(
      (c) => (c[0] as { npcId: string }).npcId === "p1"
    );
    expect(forPlayer).toHaveLength(1);
  });

  it("a step rejected by the boundary twice pauses with the reason and is dropped", async () => {
    const h = harness({
      state: {
        queue: [
          step("s0", "earlier", "done", "action_0"),
          step("s1", "wait forever", "pending"),
        ],
      },
      // Out of the boundary's duration bounds, both times.
      translate: () => ({ ...ACT, proposedDurationTicks: 0 }),
    });
    await h.fire(makeReport());

    expect(h.translateStep).toHaveBeenCalledTimes(2);
    expect(h.submittedBy("p1")).toEqual([]);
    expect(h.pauses).toHaveLength(1);
    const pause = h.pauses[0];
    expect(pause).toMatchObject({ kind: "decision", reason: "rejected" });
    const rejection = pause.kind === "decision" ? pause.rejection : undefined;
    expect(rejection).toContain("proposedDurationTicks");
    // The retry was told why.
    expect(h.translateStep.mock.calls[1][0].rejectionFeedback).toBe(rejection);
    // The step is gone; nothing is left running.
    expect(h.state().queue.map((q) => q.id)).toEqual(["s0"]);
  });

  it("a step that translates to `continue` pauses as rejected", async () => {
    const h = harness({
      state: { queue: [step("s1", "think", "pending")] },
      translate: () => ({ tool: "continue" }),
    });
    await h.fire(makeReport());

    expect(h.submittedBy("p1")).toEqual([]);
    expect(h.pauses).toHaveLength(1);
    expect(h.pauses[0]).toMatchObject({ kind: "decision", reason: "rejected" });
  });

  it("without a translator, a step that comes up pauses as not implemented", async () => {
    const h = harness({
      state: { queue: [step("s1", "go home", "pending")] },
      translate: null,
    });
    await h.fire(makeReport());

    expect(h.submittedBy("p1")).toEqual([]);
    expect(h.pauses).toEqual([
      {
        kind: "decision",
        since: NOW,
        reason: "rejected",
        rejection: "player input translation is not implemented yet",
      },
    ]);
    // The step is not the problem: it stays queued.
    expect(h.state().queue).toEqual([step("s1", "go home", "pending")]);
  });

  it("idle with an empty queue pauses (idle)", async () => {
    const h = harness({ state: {} });
    await h.fire(makeReport());
    expect(h.pauses).toEqual([{ kind: "decision", since: NOW, reason: "idle" }]);
  });

  it("the running step's action failing drops it and pauses (failed)", async () => {
    const h = harness({
      state: {
        queue: [
          step("s1", "pick the lock", "running", "action_p1"),
          step("s2", "go in", "pending"),
        ],
      },
      actions: [action("action_p1", "p1", "failed")],
    });
    await h.fire(makeReport({ transitions: [transition("action_p1", "failed")] }));

    expect(h.state().queue.map((q) => q.id)).toEqual(["s2"]);
    expect(h.pauses).toEqual([
      { kind: "decision", since: NOW, reason: "failed" },
    ]);
    expect(h.translateStep).not.toHaveBeenCalled();
  });

  it("the player's own replacement interrupting their old action is not a failure", async () => {
    const h = harness({
      state: { queue: [step("s2", "new plan", "running", "action_new")] },
      actions: [
        action("action_old", "p1", "interrupted"),
        action("action_new", "p1", "active", "action_old"),
      ],
    });
    await h.fire(
      makeReport({
        transitions: [transition("action_old", "interrupted")],
        occurrences: [
          occurrence(["action_old"], [{ characterId: "p1", clarity: "full" }]),
        ],
      })
    );

    expect(h.pauses).toEqual([]);
    expect(h.state().queue).toEqual([
      step("s2", "new plan", "running", "action_new"),
    ]);
  });
});

describe("delegated mode", () => {
  const friendLog = [{ gameDateTime: "1923-04-02T09:00:00", answer: "Watch the door." }];

  it("askFriend pauses for a consult and submits nothing", async () => {
    const h = harness({
      state: { mode: "delegated", friendLog },
      playerDecision: () => ({ tool: "askFriend", question: "要告诉他吗？" }),
    });
    await h.fire(makeReport());

    const calls = h.agentCallsFor("p1");
    expect(calls).toHaveLength(1);
    expect(calls[0].player).toEqual({ mode: "delegated", friendLog });
    expect(h.pauses).toEqual([
      { kind: "consult", since: NOW, question: "要告诉他吗？" },
    ]);
    expect(h.submittedBy("p1")).toEqual([]);
  });

  it("an empty askFriend question is treated as continue", async () => {
    const h = harness({
      state: { mode: "delegated" },
      playerDecision: () => ({ tool: "askFriend", question: "   " }),
    });
    await h.fire(makeReport());
    expect(h.pauses).toEqual([]);
    expect(h.submittedBy("p1")).toEqual([]);
  });

  it("act goes through the shared submit path without pausing; sleep is forwarded for the player only", async () => {
    const h = harness({
      state: { mode: "delegated" },
      playerDecision: () => ({ ...ACT, sleep: true }),
      npcDecision: () => ({ ...ACT, sleep: true }),
    });
    await h.fire(makeReport());

    expect(h.pauses).toEqual([]);
    const [mine] = h.submittedBy("p1");
    expect(mine.description).toBe("walk to the library");
    expect(mine.sleep).toBe(true);
    // An NPC's command keeps the shape it always had.
    const [theirs] = h.submittedBy("npc_1");
    expect("sleep" in theirs).toBe(false);
  });

  it("forceWake decides a busy player with nothing perceived, then clears", async () => {
    const h = harness({
      state: { mode: "delegated", forceWake: true, friendLog },
      actions: [action("action_p1", "p1", "active")],
    });
    await h.fire(makeReport());

    expect(h.agentCallsFor("p1")).toHaveLength(1);
    expect(h.state().forceWake).toBe(false);
  });

  it("a busy delegated player without forceWake and nothing perceived is skipped", async () => {
    const h = harness({
      state: { mode: "delegated" },
      actions: [action("action_p1", "p1", "active")],
    });
    await h.fire(makeReport());
    expect(h.agentCallsFor("p1")).toEqual([]);
  });
});

describe("resolvePlayer", () => {
  const history = [
    {
      npcId: "p1",
      gameDateTime: "1923-04-02T09:03:00",
      location: "SCN_1",
      narrative: "first",
    },
    {
      npcId: "p1",
      gameDateTime: "1923-04-02T09:04:00",
      location: "SCN_1",
      narrative: "second",
    },
  ];

  it("steps: submits the first new step from the last rendered paragraph, without rendering", async () => {
    const h = harness({
      state: { queue: [step("s1", "go to the docks", "pending")] },
    });
    h.controller.restorePerceptionHistory(history);
    await h.controller.resolvePlayer({ kind: "steps" });

    expect(render).not.toHaveBeenCalled();
    const [ctx] = h.translateStep.mock.calls[0];
    expect(ctx.perception?.narrative).toBe("second");
    expect(ctx.recentPerceptions?.map((p) => p.narrative)).toEqual(["first"]);
    const [command] = h.submittedBy("p1");
    expect(h.state().queue[0]).toMatchObject({
      status: "running",
      actionId: `action_${command.commandId}`,
    });
  });

  it("continue while busy lets the current action run on", async () => {
    const h = harness({
      state: { queue: [step("s1", "next", "pending")] },
      actions: [action("action_p1", "p1", "active")],
    });
    h.controller.restorePerceptionHistory(history);
    await h.controller.resolvePlayer({ kind: "continue" });

    expect(h.translateStep).not.toHaveBeenCalled();
    expect(h.submittedBy("p1")).toEqual([]);
  });

  it("advice: the delegated agent decides again with the friend's words, without rendering", async () => {
    const friendLog = [
      {
        gameDateTime: "1923-04-02T09:05:00",
        question: "要告诉他吗？",
        answer: "Not yet.",
      },
    ];
    const h = harness({
      state: { mode: "delegated", friendLog },
      playerDecision: () => ACT,
    });
    h.controller.restorePerceptionHistory(history);
    await h.controller.resolvePlayer({ kind: "advice" });

    expect(render).not.toHaveBeenCalled();
    const [ctx] = h.agentCallsFor("p1");
    expect(ctx.player).toEqual({ mode: "delegated", friendLog });
    expect(ctx.perception?.narrative).toBe("second");
    expect(h.submittedBy("p1")).toHaveLength(1);
    expect(h.pauses).toEqual([]);
  });
});
