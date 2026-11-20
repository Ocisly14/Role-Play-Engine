// The controller's player branch: manual mode pauses when the wake classifier
// says the player is needed and otherwise lets the current action run on —
// it never decides or submits for the player; delegated mode decides like an
// NPC and pauses only on `askFriend`. NPCs are untouched (occurrenceRouting / decideConcurrency
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
import type { PlayerPort } from "../../player/playerPort.js";
import {
  type PlayerPending,
  type PlayerState,
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

const ACT: Extract<RoleSimDecision, { tool: "act" }> = {
  tool: "act",
  description: "walk to the library",
  objectRefs: [],
  proposedDurationTicks: 5,
};

function harness(opts: {
  state: Partial<PlayerState>;
  actions?: EngineAction[];
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
    getTopology: () => undefined,
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
  it("shows a spoken reply in the speech minute while submitting physical work separately", async () => {
    const speech = occurrence(
      ["action_say"],
      [
        { characterId: "p1", sight: "clear", hearing: "clear" },
        { characterId: "npc_1", sight: "clear", hearing: "clear" },
      ]
    );
    const words = "Could I get ten tarts?";
    speech.facts[0] = {
      id: "occ_1#f0",
      type: "utterance",
      content: words,
      entityRefs: [{ kind: "character", id: "p1" }],
    };
    speech.participants = [
      { characterId: "p1", role: "actor" },
      { characterId: "npc_1", role: "target" },
    ];
    const heard = "Of course. Give me a moment.";
    const h = harness({
      state: {
        dialogue: [
          {
            id: "action_say",
            gameDateTime: NOW,
            location: "SCN_1",
            words,
            status: "waiting",
            replies: [],
          },
        ],
      },
      actions: [action("action_say", "p1", "completed")],
      npcDecision: () => ({
        ...ACT,
        description: "I count ten tarts into a paper box.",
        replyNow: heard,
        utterance: heard,
      }),
    });

    await h.fire(
      makeReport({
        occurrences: [speech],
        transitions: [transition("action_say", "completed")],
      })
    );

    expect(h.agentCallsFor("npc_1")[0]?.manualSpeech).toBe(words);
    expect(h.state().dialogue).toEqual([
      expect.objectContaining({
        status: "complete",
        spokenAt: NOW,
        replies: [expect.objectContaining({ words: heard })],
      }),
    ]);
    expect(h.submittedBy("npc_1")).toEqual([
      expect.objectContaining({
        description: "I count ten tarts into a paper box.",
        proposedDurationTicks: 5,
      }),
    ]);
    expect(h.submittedBy("npc_1")[0]?.utterance).toBeUndefined();
    expect(buildPerceivedBundle).toHaveBeenCalledWith(
      expect.objectContaining({ npcId: "p1", occurrencesForNpc: undefined })
    );
    expect(h.onPerception).toHaveBeenCalledWith(
      expect.objectContaining({
        npcId: "p1",
        dialogueOnly: true,
        narrative: expect.stringContaining(heard),
      })
    );
    expect(h.pauses).toEqual([
      { kind: "decision", since: NOW, reason: "idle" },
    ]);
  });

  it("marks a failed opening line as unspoken and does not ask for a reply", async () => {
    const h = harness({
      state: {
        dialogue: [
          {
            id: "action_say",
            gameDateTime: NOW,
            location: "SCN_1",
            words: "Hello.",
            status: "waiting",
            replies: [],
          },
        ],
      },
      actions: [action("action_say", "p1", "failed")],
    });
    await h.fire(
      makeReport({ transitions: [transition("action_say", "failed")] })
    );
    expect(h.agentCallsFor("npc_1")[0]?.manualSpeech).toBeUndefined();
    expect(h.state().dialogue.at(-1)?.status).toBe("unspoken");
  });

  it("submits a sleep as the replacement for a live action and keeps only one queued start", async () => {
    const h = harness({
      state: {},
      actions: [action("action_old", "p1", "active")],
    });
    const raw = {
      description: "I lie down to sleep.",
      objectRefs: [],
      proposedDurationTicks: 1,
      sleep: true,
    };
    await expect(h.controller.submitPlayerCommand(raw)).resolves.toMatchObject({
      ok: true,
    });
    expect(h.submittedBy("p1")).toEqual([
      expect.objectContaining({ replacesActionId: "action_old", sleep: true }),
    ]);
    await expect(h.controller.submitPlayerCommand(raw)).resolves.toEqual({
      ok: false,
      reason: "your previous command is waiting to start",
    });
    expect(h.submittedBy("p1")).toHaveLength(1);
    expect(h.agentCallsFor("p1")).toEqual([]);
  });

  it("returns a rejection from the shared command boundary without asking an agent", async () => {
    const h = harness({ state: {} });
    await expect(
      h.controller.submitPlayerCommand({
        description: "I try the handle.",
        objectRefs: [],
        proposedDurationTicks: 1,
        skillId: "unavailable-fake-skill",
      })
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining("not an available skill"),
    });
    expect(h.submittedBy("p1")).toEqual([]);
    expect(h.agentCallsFor("p1")).toEqual([]);
  });

  it("an own action completed with nothing from others pauses (idle) and submits nothing", async () => {
    const h = harness({
      state: {},
      actions: [action("action_old", "p1", "completed")],
    });
    await h.fire(
      makeReport({ transitions: [transition("action_old", "completed")] })
    );

    expect(h.pauses).toEqual([
      { kind: "decision", since: NOW, reason: "idle" },
    ]);
    expect(h.agentCallsFor("p1")).toEqual([]);
    expect(h.submittedBy("p1")).toEqual([]);
  });

  it("a clearly perceived occurrence caused by someone else pauses (woken)", async () => {
    const h = harness({
      state: {},
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
            [{ characterId: "p1", sight: "clear", hearing: "clear" }]
          ),
        ],
      })
    );

    expect(h.pauses).toEqual([
      { kind: "decision", since: NOW, reason: "woken" },
    ]);
    expect(h.agentCallsFor("p1")).toEqual([]);
    expect(h.submittedBy("p1")).toEqual([]);
  });

  it("a trace-only occurrence while busy is recorded but does not pause", async () => {
    const h = harness({
      state: {},
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
            [{ characterId: "p1", sight: "none", hearing: "faint" }]
          ),
        ],
      })
    );

    expect(h.pauses).toEqual([]);
    expect(h.agentCallsFor("p1")).toEqual([]);
    expect(h.submittedBy("p1")).toEqual([]);
    const forPlayer = h.onPerception.mock.calls.filter(
      (c) => (c[0] as { npcId: string }).npcId === "p1"
    );
    expect(forPlayer).toHaveLength(1);
  });

  it("idle with nothing running pauses (idle)", async () => {
    const h = harness({ state: {} });
    await h.fire(makeReport());
    expect(h.pauses).toEqual([
      { kind: "decision", since: NOW, reason: "idle" },
    ]);
    expect(h.submittedBy("p1")).toEqual([]);
  });

  it("the player's action failing pauses (failed)", async () => {
    const h = harness({
      state: {},
      actions: [action("action_p1", "p1", "failed")],
    });
    await h.fire(
      makeReport({ transitions: [transition("action_p1", "failed")] })
    );

    expect(h.pauses).toEqual([
      { kind: "decision", since: NOW, reason: "failed" },
    ]);
    expect(h.submittedBy("p1")).toEqual([]);
  });

  it("the player's own replacement interrupting their old action is not a failure", async () => {
    const h = harness({
      state: {},
      actions: [
        action("action_old", "p1", "interrupted"),
        action("action_new", "p1", "active", "action_old"),
      ],
    });
    await h.fire(
      makeReport({
        transitions: [transition("action_old", "interrupted")],
        occurrences: [
          occurrence(
            ["action_old"],
            [{ characterId: "p1", sight: "clear", hearing: "clear" }]
          ),
        ],
      })
    );

    expect(h.pauses).toEqual([]);
    expect(h.submittedBy("p1")).toEqual([]);
  });
});

describe("delegated mode", () => {
  const friendLog = [
    { gameDateTime: "1923-04-02T09:00:00", answer: "Watch the door." },
  ];

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

  it.each([
    ["busy", [action("action_p1", "p1", "active")]],
    ["idle", []],
  ] as Array<[string, EngineAction[]]>)(
    "manual continue while %s submits nothing and renders nothing",
    async (_label, actions) => {
      const h = harness({ state: {}, actions });
      h.controller.restorePerceptionHistory(history);
      await h.controller.resolvePlayer({ kind: "continue" });

      expect(render).not.toHaveBeenCalled();
      expect(h.agentCallsFor("p1")).toEqual([]);
      expect(h.submittedBy("p1")).toEqual([]);
      expect(h.pauses).toEqual([]);
    }
  );

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
