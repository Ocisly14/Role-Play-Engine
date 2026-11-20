// The runner's side of the player: the pause that waits on them is data that
// survives a save, answers land between two ticks, death stops the world, a
// sleep asks for an autosave, and the places they reach are recorded.
//
// The tick engine and the decision controller are stand-ins: no model is
// called, and each test scripts what "the controller" does on a tick or when
// the player answers. What is under test is only the runner.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionTransition, EngineAction } from "../../engine/actions/types.js";
import type { TickReport } from "../../engine/core/types.js";
import type { AddMemoryParams } from "../../memory/types.js";
import type { PlayerPending, PlayerState } from "../../player/playerState.js";
import {
  PLAYER_STATE_KEY,
  createPlayerState,
} from "../../player/playerState.js";
import type { NpcActionControllerDeps } from "../../roleSim/npcActionController.js";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../../state/DynamicGameState.js";
import { aliasFor } from "../../state/perceivableDirectory.js";
import type { RoadNode, TownTopology } from "../../state/topologyTypes.js";
import type { DynamicNPCProfile } from "../../state/types.js";
import { SimulationRunner } from "../SimulationRunner.js";
import type { SimulationEvent, SimulationState } from "../types.js";

type ResolveInput = { kind: "continue" } | { kind: "advice" };

const h = vi.hoisted(() => ({
  /** What the stand-in controller does when a tick completes. */
  onTick: null as
    | null
    | ((deps: NpcActionControllerDeps, report: TickReport) => Promise<void> | void),
  /** What the stand-in controller does when the player answers. */
  onResolve: null as
    | null
    | ((
        deps: NpcActionControllerDeps,
        input: ResolveInput
      ) => Promise<void> | void),
  command: vi.fn(
    async (
      _args: Record<string, unknown>
    ): Promise<
      { ok: true; actionId: string } | { ok: false; reason: string }
    > => ({ ok: true, actionId: "new-action" })
  ),
  resolveCalls: [] as Array<{
    input: ResolveInput;
    pendingAtCall: PlayerPending | null;
  }>,
  /** The engine's actions, by everyone. */
  actions: [] as EngineAction[],
  /** This tick's transitions. */
  transitions: [] as ActionTransition[],
  log: [] as string[],
}));

vi.mock("../../engine/core/tickEngine.js", () => ({
  createTickEngine: (opts: { dgsm: DynamicGameStateManager }) => {
    const listeners: Array<(r: TickReport) => Promise<void> | void> = [];
    return {
      on(ev: string, cb: (r: TickReport) => Promise<void> | void) {
        if (ev === "tickCompleted") listeners.push(cb);
        return () => undefined;
      },
      getActorActions: (actorId: string) =>
        h.actions.filter((a) => a.command.actorId === actorId),
      getAction: (actionId: string) => h.actions.find((a) => a.id === actionId),
      requestInterruption: () => undefined,
      submitCommand: async () => ({ accepted: true, status: "queued" as const }),
      serialize: () => ({ actionSchemaVersion: 0, inbox: [], actions: h.actions }),
      async tick() {
        const d = new Date(`${opts.dgsm.getGameDateTime()}Z`);
        d.setUTCMinutes(d.getUTCMinutes() + 1);
        opts.dgsm.setGameDateTime(d.toISOString().slice(0, 19));
        const report = {
          gameDateTime: opts.dgsm.getGameDateTime(),
          transitions: h.transitions,
          occurrences: [],
          commits: [],
          cancellations: [],
          featureEvents: [],
          stateChanges: [],
          damageReports: [],
        } as unknown as TickReport;
        for (const cb of listeners) await cb(report);
      },
    };
  },
}));

vi.mock("../../roleSim/npcActionController.js", () => ({
  NpcActionController: class {
    private readonly deps: NpcActionControllerDeps;
    constructor(deps: NpcActionControllerDeps) {
      this.deps = deps;
      deps.engine.on("tickCompleted", async (report: TickReport) => {
        await h.onTick?.(deps, report);
      });
    }
    async resolvePlayer(input: ResolveInput): Promise<void> {
      h.log.push(`resolve:${input.kind}`);
      h.resolveCalls.push({
        input,
        pendingAtCall: this.deps.player?.get().pending ?? null,
      });
      await h.onResolve?.(this.deps, input);
    }
    playerCitationScope() {
      return undefined;
    }
    submitPlayerCommand(args: Record<string, unknown>) {
      return h.command(args);
    }
    restorePerceptionHistory(): void {}
  },
}));

vi.mock("../../roleSim/llmAgent.js", () => ({
  LLMRoleSimAgent: class {},
}));

vi.mock("../../engine/registerDefaults.js", () => ({
  createDefaultSubsystemRegistry: () => ({}),
}));

vi.mock("../../state/moduleLoader.js", () => ({
  loadScriptedEventsForModule: () => [],
}));

// ── fixtures ──────────────────────────────────────────────────────────────

const PLAYER = "pc_1";
const START = "1923-10-17T08:00:00";

function profile(id: string, residence = "SCN_A"): DynamicNPCProfile {
  return {
    id,
    name: id,
    attributes: {} as DynamicNPCProfile["attributes"],
    skills: {},
    inventory: [],
    residence,
    status: {
      hp: 10,
      maxHp: 10,
      san: 50,
      maxSan: 99,
      fatigue: 0,
      maxFatigue: 100,
      luck: 50,
      conditions: [],
    } as DynamicNPCProfile["status"],
    longTermIntent: "",
    relationships: [],
  } as DynamicNPCProfile;
}

/** Two places joined by one road. */
function makeDgsm(): DynamicGameStateManager {
  const state = initialDynamicGameState(START);
  state.scenes.set("SCN_A", { id: "SCN_A", name: "A" } as never);
  state.scenes.set("SCN_B", { id: "SCN_B", name: "B" } as never);
  const road = {
    id: "ROAD_AB",
    name: "Main Road",
    endpointA: "SCN_A",
    endpointB: "SCN_B",
  } as RoadNode;
  state.topology = {
    nodeSceneIds: new Set(["SCN_A", "SCN_B"]),
    roads: new Map([["ROAD_AB", road]]),
    sceneToRoads: new Map([
      ["SCN_A", [road]],
      ["SCN_B", [road]],
    ]),
    sceneToParent: new Map(),
  } as unknown as TownTopology;
  return new DynamicGameStateManager(state);
}

function makePrisma() {
  const saved: Array<{
    simulationState: SimulationState;
    tick: number;
    gameState: Record<string, unknown>;
  }> = [];
  const rows: AddMemoryParams[] = [];
  const add = vi.fn(async (row: AddMemoryParams) => {
    rows.push(row);
  });
  const prisma = {
    simulationRuntime: {
      upsert: vi.fn(async (args: { update: (typeof saved)[number] }) => {
        // What a database would hand back: a copy, not the live objects.
        saved.push(JSON.parse(JSON.stringify(args.update)));
      }),
    },
    simulationEvent: {
      createMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    },
    npcMemory: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () =>
        rows.filter((row) => row.type === "relationship")
      ),
    },
  };
  return { prisma, saved, add };
}

interface Harness {
  runner: SimulationRunner;
  dgsm: DynamicGameStateManager;
  saved: ReturnType<typeof makePrisma>["saved"];
  events: SimulationEvent[];
  add: ReturnType<typeof makePrisma>["add"];
  autosaves: Array<{ info: { characterId: string; gameDateTime: string; sceneId: string }; lastSavedAt: string | undefined }>;
}

const live: SimulationRunner[] = [];

interface RunnerOpts {
  syncRealTime?: boolean;
  /** Default one hour: long enough that no scheduled tick fires inside a
   *  test. Short only where a test needs the timer to fire. */
  tickIntervalMs?: number;
}

function makeRunner(
  opts: RunnerOpts & { dgsm?: DynamicGameStateManager } = {}
): Harness {
  const dgsm = opts.dgsm ?? makeDgsm();
  const { prisma, saved, add } = makePrisma();
  const autosaves: Harness["autosaves"] = [];
  const runner = new SimulationRunner({
    config: {
      sessionId: "sess",
      moduleId: "mod",
      mode: "realtime",
      tickIntervalMs: opts.tickIntervalMs ?? 3_600_000,
      ...(opts.syncRealTime ? { syncRealTime: true } : {}),
    },
    dgsm,
    language: "en",
    prisma: prisma as never,
    memoryManager: { add } as never,
    onAutosaveRequested: async (info) => {
      autosaves.push({
        info,
        lastSavedAt: saved.at(-1)?.gameState.gameDateTime as string | undefined,
      });
    },
  });
  const events: SimulationEvent[] = [];
  runner.setBroadcastCallback((batch) => events.push(...batch));
  live.push(runner);
  return { runner, dgsm, saved, events, autosaves, add };
}

/** A runner whose session already has the player standing at SCN_A. */
function withPlayer(
  seed: Partial<PlayerState> = {},
  opts: RunnerOpts = {}
): Harness {
  const dgsm = makeDgsm();
  dgsm.updateNpcs([profile(PLAYER)]);
  dgsm.setCharacterPosition(PLAYER, { type: "scene", sceneId: "SCN_A" });
  const harness = makeRunner({ dgsm, ...opts });
  harness.runner.hydrateFromRuntime({
    state: "paused",
    ticksExecuted: 0,
    persistedPlayerState: { ...createPlayerState(PLAYER), ...seed },
  });
  return harness;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = () => r();
  });
  return { promise, resolve };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const types = (events: SimulationEvent[]): string[] => events.map((e) => e.type);

const decisionPause = (since: string): PlayerPending => ({
  kind: "decision",
  since,
  reason: "idle",
});

beforeEach(() => {
  h.onTick = null;
  h.onResolve = null;
  h.resolveCalls = [];
  h.command.mockClear();
  h.actions = [];
  h.transitions = [];
  h.log = [];
});

afterEach(async () => {
  for (const runner of live.splice(0)) await runner.stop();
  vi.restoreAllMocks();
});

// ── tests ─────────────────────────────────────────────────────────────────

describe("SimulationRunner — the player", () => {
  it("returns the exact line as a waiting exchange after accepting ordinary speech", async () => {
    const { runner, saved } = withPlayer();
    const speech = {
      kind: "say",
      to: [],
      words: "  Could I get some coffee?  ",
    } as const;
    await expect(
      runner.submitPlayerCommand({ ...speech, to: [] })
    ).resolves.toMatchObject({ ok: true });
    const turn = {
      id: "new-action",
      gameDateTime: START,
      location: "SCN_A",
      words: "Could I get some coffee?",
      status: "waiting",
      replies: [],
    };
    expect(runner.getPlayerView()?.state.dialogue).toEqual([turn]);
    expect(saved.at(-1)?.gameState[PLAYER_STATE_KEY]).toMatchObject({
      dialogue: [turn],
    });
    await expect(
      runner.submitPlayerCommand({ kind: "sleep" })
    ).resolves.toMatchObject({ ok: false });
    expect(h.command).toHaveBeenCalledOnce();
  });

  it("lists adjacent exits and exposes strangers only by handle and description", () => {
    const { runner, dgsm } = withPlayer();
    const id = "npc_unknown_identity";
    const name = "The Hidden Canonical Name";
    dgsm.updateNpcs([
      { ...profile(id), name, appearance: "person in a yellow coat" },
    ]);
    dgsm.setCharacterPosition(id, { type: "scene", sceneId: "SCN_A" });
    dgsm.createItem("Key", PLAYER, undefined, "item_key");
    dgsm.createItem("Distant object", "scene:SCN_B", undefined, "item_far", {
      placement: "on the floor",
    });

    const view = runner.getPlayerView();
    expect(view?.options.exits).toEqual([
      { handle: "ROAD_AB", label: "Main Road", kind: "scene" },
    ]);
    expect(view?.options.mentions).toEqual([
      {
        handle: aliasFor(PLAYER, id),
        label: "the person in a yellow coat",
        kind: "character",
      },
      { handle: "item_key", label: "Key", kind: "item" },
    ]);
    expect(JSON.stringify(view)).not.toContain(id);
    expect(JSON.stringify(view)).not.toContain(name);
  });

  it("keeps a refused command pending and resumes once a move is accepted", async () => {
    const pending = decisionPause(START);
    const { runner } = withPlayer({ pending });
    const rejected = await runner.submitPlayerCommand({
      kind: "act",
      text: "I reach for @[item_unseen].",
    });
    expect(rejected).toEqual({
      ok: false,
      reason: "unknown handle: item_unseen",
    });
    expect(h.command).not.toHaveBeenCalled();
    h.command.mockResolvedValueOnce({ ok: false, reason: "boundary refused" });
    const move = { kind: "move", to: "ROAD_AB" } as const;
    await expect(runner.submitPlayerCommand(move)).resolves.toEqual({
      ok: false,
      reason: "boundary refused",
    });
    expect(runner.getPlayerView()?.state.pending).toEqual(pending);
    expect(runner.getStatus().state).toBe("paused");
    expect(h.command).toHaveBeenCalledTimes(1);

    await expect(runner.submitPlayerCommand(move)).resolves.toEqual({
      ok: true,
      unknownHandles: [],
    });
    expect(h.command).toHaveBeenLastCalledWith(
      expect.objectContaining({
        objectRefs: [{ id: "ROAD_AB" }],
        proposedDurationTicks: 1,
      })
    );
    expect(runner.getPlayerView()?.state.pending).toBeNull();
    await flush();
    expect(runner.getStatus().state).toBe("running");
  });

  it("accepts sleep only in manual mode", async () => {
    const { runner } = withPlayer({ mode: "delegated" });
    await expect(runner.submitPlayerCommand({ kind: "sleep" })).rejects.toThrow(
      "commands are for manual mode"
    );
    expect(h.command).not.toHaveBeenCalled();
    await runner.setPlayerMode("manual");
    await runner.submitPlayerCommand({ kind: "sleep" });
    expect(h.command).toHaveBeenCalledWith(
      expect.objectContaining({ sleep: true })
    );
    expect(runner.getStatus().state).toBe("paused");
  });

  it("remembers first encounters, renames and private links without exposing stranger ids", async () => {
    const { runner, dgsm, saved, events, add } = withPlayer();
    const first = "npc_unknown_first";
    const second = "npc_unknown_second";
    const a = aliasFor(PLAYER, first);
    const b = aliasFor(PLAYER, second);
    for (const id of [first, second]) {
      dgsm.updateNpcs([profile(id)]);
      dgsm.setCharacterPosition(id, { type: "scene", sceneId: "SCN_A" });
    }
    h.onTick = (deps, report) => {
      deps.onPerception?.({
        npcId: PLAYER,
        location: "SCN_A",
        gameDateTime: report.gameDateTime,
        narrative: `I see [${a}] and [${b}].`,
      });
    };
    await runner.step(1);
    const firstMet = dgsm.getGameDateTime();
    await runner.step(1);
    const oldBoard = await runner.getPlayerBoard();
    expect(oldBoard?.people).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ handle: a, firstMet }),
        expect.objectContaining({ handle: b, firstMet }),
      ])
    );

    const { id } = await runner.linkPeople(a, b, "neighbors");
    expect(await runner.linkPeople(b, a, "neighbors")).toEqual({ id });
    const anonymous = {
      board: await runner.getPlayerBoard(),
      view: runner.getPlayerView(),
      events: events.filter((event) => event.type.startsWith("player_")),
    };
    expect(anonymous.board?.links).toEqual([{ id, a, b, label: "neighbors" }]);
    expect(JSON.stringify(anonymous)).not.toContain(first);
    expect(JSON.stringify(anonymous)).not.toContain(second);
    expect(add).not.toHaveBeenCalled();
    await expect(
      runner.namePerson(first, "An unseen identity")
    ).rejects.toThrow("person not found");
    await runner.namePerson(a, "Ada");
    await runner.namePerson(first, "A. Smith");
    expect(add).not.toHaveBeenCalled();
    expect(runner.getPlayerView()?.options.mentions).toContainEqual({
      handle: first,
      label: "A. Smith",
      kind: "character",
    });
    await runner.notePerson(first, "She waits by the gate.");
    expect(dgsm.getRelationship(PLAYER, first)?.knownAs).toBe("A. Smith");
    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "relationship",
        metadata: { targetId: first, targetName: "A. Smith" },
      })
    );
    const board = await runner.getPlayerBoard();
    expect(board?.people).toContainEqual({
      handle: first,
      label: "A. Smith",
      knownAs: "A. Smith",
      firstMet,
      notes: ["She waits by the gate."],
    });
    expect(board?.links).toEqual([{ id, a: first, b, label: "neighbors" }]);
    expect(saved.at(-1)?.gameState[PLAYER_STATE_KEY]).toMatchObject({
      met: { [first]: firstMet, [second]: firstMet },
      boardLinks: [{ id, a: first, b: second, label: "neighbors" }],
    });
    await runner.unlinkPeople(id);
    expect((await runner.getPlayerBoard())?.links).toEqual([]);
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("pending survives save/hydrate", async () => {
    const a = withPlayer({ mode: "delegated" });
    h.onTick = (deps, report) => {
      deps.player?.requestPause({
        kind: "consult",
        since: report.gameDateTime,
        question: "Should I follow him?",
      });
    };
    await a.runner.start();
    const pending = a.runner.getPlayerView()?.state.pending;
    expect(pending?.kind).toBe("consult");

    // A new process: the same world, the runtime row read back.
    const row = a.saved.at(-1);
    expect(row?.simulationState).toBe("paused");
    const b = makeRunner({ dgsm: a.dgsm });
    b.runner.hydrateFromRuntime({
      state: row?.simulationState ?? "running",
      ticksExecuted: row?.tick ?? 0,
      persistedPlayerState: row?.gameState[PLAYER_STATE_KEY],
    });

    expect(b.runner.getPlayerView()?.state.pending).toEqual(pending);
    expect(b.runner.getStatus().state).toBe("paused");

    // Still the player's question after the restart: answering resumes.
    h.onTick = null;
    await b.runner.answerFriend("Yes, but keep your distance.");
    expect(h.resolveCalls.map((c) => c.input.kind)).toEqual(["advice"]);
    expect(b.runner.getPlayerView()?.state.pending).toBeNull();
    // The resume is not awaited by the answer; it is under way.
    expect(["initializing", "running"]).toContain(b.runner.getStatus().state);
    await flush();
    expect(b.runner.getStatus().state).toBe("running");
  });

  it("a decision the controller asks for pauses the world after the tick", async () => {
    const { runner, events } = withPlayer();
    h.onTick = (deps, report) => {
      deps.onPerception?.({
        npcId: "npc_other",
        gameDateTime: report.gameDateTime,
        location: "SCN_A",
        narrative: "not mine",
      });
      deps.onPerception?.({
        npcId: PLAYER,
        gameDateTime: report.gameDateTime,
        location: "SCN_A",
        narrative: "The lobby is empty.",
      });
      deps.player?.requestPause(decisionPause(report.gameDateTime));
    };
    await runner.start();

    expect(runner.getStatus().state).toBe("paused");
    expect(types(events)).toContain("player_pending");
    // The player's paragraph is broadcast; nobody else's is.
    const perceived = events.filter((e) => e.type === "player_perceived");
    expect(perceived.map((e) => e.data.narrative)).toEqual([
      "The lobby is empty.",
    ]);
    expect(runner.getPlayerView()?.perceptions.map((p) => p.narrative)).toEqual([
      "The lobby is empty.",
    ]);
  });

  it("continuePlayer answers the decision and resumes the world", async () => {
    const { runner } = withPlayer();
    h.onTick = (deps, report) => {
      deps.player?.requestPause(decisionPause(report.gameDateTime));
      h.onTick = null;
    };
    await runner.start();
    expect(runner.getStatus().state).toBe("paused");

    await runner.continuePlayer();
    expect(h.resolveCalls).toHaveLength(1);
    expect(h.resolveCalls[0].input).toEqual({ kind: "continue" });
    // Cleared only after the controller returned.
    expect(h.resolveCalls[0].pendingAtCall?.kind).toBe("decision");
    expect(runner.getPlayerView()?.state.pending).toBeNull();
    expect(["initializing", "running"]).toContain(runner.getStatus().state);
    await flush();
    expect(runner.getStatus().state).toBe("running");
  });

  it("a world paused by hand stays paused after the player answers", async () => {
    const { runner } = withPlayer();
    h.onTick = async (deps, report) => {
      // Pause pressed while this tick ran, then the controller asked.
      await runner.pause();
      deps.player?.requestPause(decisionPause(report.gameDateTime));
      h.onTick = null;
    };
    await runner.start();
    expect(runner.getStatus().state).toBe("paused");

    await runner.continuePlayer();
    expect(runner.getPlayerView()?.state.pending).toBeNull();
    expect(runner.getStatus().state).toBe("paused");
  });

  it("stays paused when the controller asks again while resolving", async () => {
    const { runner } = withPlayer();
    h.onTick = (deps, report) => {
      deps.player?.requestPause(decisionPause(report.gameDateTime));
      h.onTick = null;
    };
    await runner.start();
    h.onResolve = (deps) => {
      deps.player?.requestPause({
        kind: "decision",
        since: START,
        reason: "woken",
      });
    };

    await runner.continuePlayer();
    const pending = runner.getPlayerView()?.state.pending;
    expect(pending).toMatchObject({ kind: "decision", reason: "woken" });
    expect(runner.getStatus().state).toBe("paused");
  });

  it("input during tick waits for tick end", async () => {
    const { runner } = withPlayer();
    const entered = deferred();
    const gate = deferred();
    h.onTick = async () => {
      h.log.push("tick:start");
      entered.resolve();
      await gate.promise;
      h.log.push("tick:end");
      h.onTick = null;
    };
    const started = runner.start();
    await entered.promise;

    const input = runner.continuePlayer();
    await flush();
    expect(h.resolveCalls).toHaveLength(0);

    gate.resolve();
    await started;
    await input;
    expect(h.log).toEqual(["tick:start", "tick:end", "resolve:continue"]);
    expect(h.resolveCalls).toHaveLength(1);
  });

  it("death blocks player operations", async () => {
    const { runner, dgsm, events } = withPlayer();
    h.onTick = () => {
      const pc = dgsm.getNpcProfile(PLAYER);
      if (pc) pc.status.hp = 0;
      h.onTick = null;
    };
    await runner.start();

    const view = runner.getPlayerView();
    expect(view?.state.pending?.kind).toBe("dead");
    expect(view?.alive).toBe(false);
    expect(types(events)).toContain("player_died");
    expect(runner.getStatus().state).toBe("paused");
    await expect(runner.continuePlayer()).rejects.toThrow("player is dead");
  });

  it("mode switch converts consult to decision", async () => {
    const { runner } = withPlayer({
      mode: "delegated",
      forceWake: true,
      pending: { kind: "consult", since: START, question: "Stay or go?" },
    });
    await runner.setPlayerMode("manual");

    const state = runner.getPlayerView()?.state;
    expect(state?.mode).toBe("manual");
    expect(state?.pending?.kind).toBe("decision");
    expect(state?.forceWake).toBe(false);
    expect(runner.getStatus().state).toBe("paused");
  });

  it("mode switch to delegated releases a pending decision", async () => {
    const { runner } = withPlayer({ pending: decisionPause(START) });
    expect(runner.getStatus().state).toBe("paused");

    await runner.setPlayerMode("delegated");
    const state = runner.getPlayerView()?.state;
    expect(state?.mode).toBe("delegated");
    expect(state?.pending).toBeNull();
    // The character decides next tick, woken as if the friend had spoken.
    expect(state?.forceWake).toBe(true);
    // Nothing was answered: the controller was not asked to resolve.
    expect(h.resolveCalls).toHaveLength(0);
    expect(["initializing", "running"]).toContain(runner.getStatus().state);
    await flush();
    expect(runner.getStatus().state).toBe("running");
  });

  it("resume is refused while a decision or question waits", async () => {
    const a = withPlayer({ pending: decisionPause(START) });
    await expect(a.runner.resume()).rejects.toThrow(
      "the player has not answered yet"
    );
    expect(a.runner.getStatus().state).toBe("paused");
    expect(a.runner.getStatus().ticksExecuted).toBe(0);

    const b = withPlayer({
      mode: "delegated",
      pending: { kind: "consult", since: START, question: "Stay or go?" },
    });
    await expect(b.runner.resume()).rejects.toThrow(
      "the player has not answered yet"
    );
    expect(b.runner.getStatus().state).toBe("paused");
  });

  it("resume is refused once the player is dead", async () => {
    const { runner } = withPlayer({ pending: { kind: "dead", since: START } });
    await expect(runner.resume()).rejects.toThrow("player is dead");
    expect(runner.getStatus().state).toBe("paused");
    expect(runner.getStatus().ticksExecuted).toBe(0);
  });

  it("letting a question go unanswered leaves a note in the friend log", async () => {
    const { runner } = withPlayer({
      mode: "delegated",
      pending: { kind: "consult", since: START, question: "Stay or go?" },
    });
    await runner.continuePlayer();

    const state = runner.getPlayerView()?.state;
    expect(state?.pending).toBeNull();
    expect(state?.friendLog).toEqual([
      { gameDateTime: START, question: "Stay or go?", answer: "(no answer)" },
    ]);
  });

  it("an answer whose decision throws leaves no note behind", async () => {
    const { runner } = withPlayer({
      mode: "delegated",
      pending: { kind: "consult", since: START, question: "Stay or go?" },
    });
    const seen: number[] = [];
    h.onResolve = (deps) => {
      // The controller reads the answer while it decides.
      seen.push(deps.player?.get().friendLog.length ?? -1);
      throw new Error("model unavailable");
    };
    await expect(runner.answerFriend("Stay.")).rejects.toThrow(
      "model unavailable"
    );
    expect(seen).toEqual([1]);
    let state = runner.getPlayerView()?.state;
    expect(state?.friendLog).toEqual([]);
    expect(state?.pending?.kind).toBe("consult");
    expect(runner.getStatus().state).toBe("paused");

    // The retry records the answer once.
    h.onResolve = null;
    await runner.answerFriend("Stay.");
    state = runner.getPlayerView()?.state;
    expect(state?.friendLog.map((n) => n.answer)).toEqual(["Stay."]);
    expect(state?.pending).toBeNull();
  });

  it("a sleep that starts asks for one autosave, after the save", async () => {
    const { runner, events, autosaves } = withPlayer();
    h.actions = [
      {
        id: "act_sleep",
        command: { actorId: PLAYER, description: "sleep", sleep: true },
        status: "active",
        submittedAt: START,
        progressMinutes: 0,
      } as unknown as EngineAction,
    ];
    h.transitions = [
      {
        actionId: "act_sleep",
        actorId: PLAYER,
        from: "queued",
        to: "active",
        progressDeltaMinutes: 0,
      },
    ];
    await runner.start();

    expect(autosaves).toHaveLength(1);
    expect(autosaves[0].info).toEqual({
      characterId: PLAYER,
      gameDateTime: "1923-10-17T08:01:00",
      sceneId: "SCN_A",
    });
    // The tick's own save already holds the minute the sleep began.
    expect(autosaves[0].lastSavedAt).toBe("1923-10-17T08:01:00");
    expect(types(events).filter((t) => t === "player_autosave_requested")).toHaveLength(1);
  });

  it("an action that starts without `sleep` asks for no autosave", async () => {
    const { runner, events, autosaves } = withPlayer();
    h.actions = [
      {
        id: "act_read",
        command: { actorId: PLAYER, description: "read" },
        status: "active",
        submittedAt: START,
        progressMinutes: 0,
      } as unknown as EngineAction,
    ];
    h.transitions = [
      {
        actionId: "act_read",
        actorId: PLAYER,
        from: "queued",
        to: "active",
        progressDeltaMinutes: 0,
      },
    ];
    await runner.start();

    expect(autosaves).toHaveLength(0);
    expect(types(events)).not.toContain("player_autosave_requested");
  });

  it("records the places the player reaches", async () => {
    const { runner, dgsm, events } = makeRunner();
    await runner.injectCharacter(profile(PLAYER), "find work");
    expect(Object.keys(runner.getPlayerView()?.state.visited.scenes ?? {})).toEqual([
      "SCN_A",
    ]);

    // Onto the road: nothing new on the map yet.
    h.onTick = () => {
      dgsm.setCharacterPosition(PLAYER, {
        type: "road",
        roadId: "ROAD_AB",
        position: 0.5,
      });
    };
    await runner.step(1);
    expect(types(events)).not.toContain("player_map_updated");

    // At the far end: the place and the whole road.
    h.onTick = () => {
      dgsm.setCharacterPosition(PLAYER, { type: "scene", sceneId: "SCN_B" });
    };
    await runner.step(1);
    const visited = runner.getPlayerView()?.state.visited;
    expect(Object.keys(visited?.scenes ?? {}).sort()).toEqual(["SCN_A", "SCN_B"]);
    expect(Object.keys(visited?.roads ?? {})).toEqual(["ROAD_AB"]);
    expect(types(events).filter((t) => t === "player_map_updated")).toHaveLength(1);

    // Standing still changes nothing.
    h.onTick = null;
    await runner.step(1);
    expect(types(events).filter((t) => t === "player_map_updated")).toHaveLength(1);
  });

  it("pause then resume does not jump the clock", async () => {
    const wall = Date.UTC(2026, 0, 1, 12, 0, 0, 1);
    const now = vi.spyOn(Date, "now").mockReturnValue(wall);
    const { runner, dgsm } = withPlayer({}, { syncRealTime: true });
    await runner.start();
    await runner.pause();
    const pausedAt = dgsm.getGameDateTime();

    // Ten real minutes pass while paused.
    now.mockReturnValue(wall + 10 * 60_000);
    await runner.resume();

    const minutes =
      (Date.parse(`${dgsm.getGameDateTime()}Z`) - Date.parse(`${pausedAt}Z`)) /
      60_000;
    expect(minutes).toBe(1);
  });

  it("one player per session; the first injected character is the player", async () => {
    const { runner } = makeRunner();
    await runner.injectCharacter(profile(PLAYER), "find work");

    const view = runner.getPlayerView();
    expect(view).not.toBeNull();
    expect(view?.state.mode).toBe("manual");
    await expect(
      runner.injectCharacter(profile("pc_2"), "find work")
    ).rejects.toThrow("a player character already exists");
  });

  it("a timer tick that waited behind an operation does not run once the operation paused the world", async () => {
    const { runner } = withPlayer({}, { tickIntervalMs: 20 });
    await runner.start();
    expect(runner.getStatus().state).toBe("running");
    expect(runner.getStatus().ticksExecuted).toBe(1);

    // The player acts while the world runs; the controller takes its time
    // and then asks again.
    const gate = deferred();
    h.onResolve = async (deps) => {
      await gate.promise;
      deps.player?.requestPause(decisionPause(START));
    };
    const input = runner.continuePlayer();
    // The scheduled tick comes due and waits behind the operation.
    await sleep(60);
    // Private, read only here: null means the timer fired and its cycle is
    // the one waiting.
    expect((runner as unknown as { intervalId: unknown }).intervalId).toBeNull();
    expect(runner.getStatus().ticksExecuted).toBe(1);

    gate.resolve();
    await input;
    await flush();
    expect(runner.getStatus().state).toBe("paused");
    expect(runner.getStatus().ticksExecuted).toBe(1);
    expect(runner.getPlayerView()?.state.pending?.kind).toBe("decision");
  });

  it("start() during an in-flight step ends running with a tick scheduled", async () => {
    const { runner } = withPlayer();
    const entered = deferred();
    const gate = deferred();
    h.onTick = async () => {
      h.onTick = null;
      entered.resolve();
      await gate.promise;
    };
    const stepping = runner.step(1);
    await entered.promise;

    const starting = runner.start();
    await flush();
    gate.resolve();
    await stepping;
    await starting;

    expect(runner.getStatus().state).toBe("running");
    // The step's tick, then start()'s own.
    expect(runner.getStatus().ticksExecuted).toBe(2);
    // Private, read only here: the next tick is on the clock.
    expect(
      (runner as unknown as { intervalId: unknown }).intervalId
    ).not.toBeNull();
  });

  it("a timer waiter and a resume pressed meanwhile tick once, one chain", async () => {
    const { runner } = withPlayer({}, { tickIntervalMs: 20 });
    await runner.start();
    expect(runner.getStatus().ticksExecuted).toBe(1);

    const gate = deferred();
    h.onResolve = async () => {
      await gate.promise; // slow, and asks nothing
    };
    const input = runner.continuePlayer();
    await sleep(60);
    const timer = (): unknown =>
      (runner as unknown as { intervalId: unknown }).intervalId;
    expect(timer()).toBeNull(); // the timer fired; its cycle waits
    // From here on, any timer that gets scheduled stays quiet.
    runner.updateTickInterval(3_600_000);

    // Pause, then resume while the operation still holds the world.
    await runner.pause();
    expect(runner.getStatus().state).toBe("paused");
    const resumed = runner.resume();
    await flush();

    gate.resolve();
    await input;
    await resumed;
    await flush();

    // One tick between them, not two; one chain scheduled.
    expect(runner.getStatus().ticksExecuted).toBe(2);
    expect(runner.getStatus().state).toBe("running");
    expect(timer()).not.toBeNull();
  });

  it("a pause asked during the step a start() waited on spends no extra tick", async () => {
    const { runner } = withPlayer();
    const entered = deferred();
    const gate = deferred();
    h.onTick = async (deps, report) => {
      h.onTick = null;
      entered.resolve();
      await gate.promise;
      deps.player?.requestPause(decisionPause(report.gameDateTime));
    };
    const stepping = runner.step(1);
    await entered.promise;
    const starting = runner.start();
    await flush();

    gate.resolve();
    await stepping;
    await starting;

    expect(runner.getStatus().ticksExecuted).toBe(1);
    expect(runner.getStatus().state).toBe("paused");
    expect(runner.getPlayerView()?.state.pending?.kind).toBe("decision");
  });

  it("the view is a copy", async () => {
    const { runner } = withPlayer({
      mode: "delegated",
      friendLog: [{ gameDateTime: START, answer: "Watch the door." }],
    });
    const view = runner.getPlayerView();
    view?.state.friendLog.splice(0);
    expect(runner.getPlayerView()?.state.friendLog).toHaveLength(1);
  });

  it("sendAdvice while delegated with no question waiting leaves words for next tick", async () => {
    const { runner } = withPlayer({ mode: "delegated" });
    await runner.sendAdvice("  Watch the door.  ");

    const state = runner.getPlayerView()?.state;
    expect(state?.friendLog).toEqual([
      { gameDateTime: START, answer: "Watch the door." },
    ]);
    expect(state?.forceWake).toBe(true);
    // Nothing was answered: the controller was not asked to resolve, and the
    // world was neither paused nor resumed for it.
    expect(h.resolveCalls).toHaveLength(0);
    expect(runner.getStatus().state).toBe("paused");
  });

  it("sendAdvice answers a waiting question and resumes", async () => {
    const { runner } = withPlayer({
      mode: "delegated",
      pending: { kind: "consult", since: START, question: "Stay or go?" },
    });
    await runner.sendAdvice("Stay.");

    expect(h.resolveCalls.map((c) => c.input.kind)).toEqual(["advice"]);
    const state = runner.getPlayerView()?.state;
    expect(state?.friendLog).toEqual([
      { gameDateTime: START, question: "Stay or go?", answer: "Stay." },
    ]);
    expect(state?.pending).toBeNull();
    expect(state?.forceWake).toBe(false);
    expect(["initializing", "running"]).toContain(runner.getStatus().state);
    await flush();
    expect(runner.getStatus().state).toBe("running");
  });

  it("sendAdvice in manual mode throws", async () => {
    const { runner } = withPlayer({ pending: decisionPause(START) });
    await expect(runner.sendAdvice("go north")).rejects.toThrow(
      "advice is for delegated mode"
    );
    const state = runner.getPlayerView()?.state;
    expect(state?.friendLog).toEqual([]);
    expect(state?.pending).toEqual(decisionPause(START));
    expect(h.resolveCalls).toHaveLength(0);
    expect(runner.getStatus().state).toBe("paused");
  });

  it("sendAdvice refuses empty text", async () => {
    const { runner } = withPlayer({ mode: "delegated" });
    await expect(runner.sendAdvice("   ")).rejects.toThrow("empty advice");
    expect(runner.getPlayerView()?.state.friendLog).toEqual([]);
  });

  it("player operations are refused once the simulation has ended", async () => {
    const { runner } = withPlayer();
    await runner.stop();
    await expect(runner.continuePlayer()).rejects.toThrow(
      "simulation has ended"
    );
  });
});
