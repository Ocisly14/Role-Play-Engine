// The staged runner: the Engine's two functions, each a session of its own
// over its own context — the START JUDGEMENT (one phase, `starts`) and the
// SETTLEMENT (five, `endings` → `occurrences`) — with a context that asks for
// both refused outright. Within a session: phases in a fixed order, each its
// own request offering only its own submission tool, each answer validated on
// arrival and kept only when accepted; addressed phase-local corrections that
// rerun ONE phase; a shared budget of provider calls; one global gate over the
// assembled draft, and one rewind to the phase of THIS session that owns a
// global fault; and — when a phase cannot converge, the budget runs out, or
// the model fails — a result that applies nothing at all.

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type DecisionsTransport,
  setDecisionsTransport,
} from "../../../models/decisions.js";
import type { ToolCallOptions } from "../../../models/types.js";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { ActionCommand, EngineAction } from "../../actions/types.js";
import { CodeToolRegistry } from "../../tools/codeTool.js";
import {
  engineModelIdentity,
  isStrictDowngraded,
  resetStrictDowngrades,
} from "../strictSchemaFallback.js";
import type { EngineResolutionContext, ResolutionError } from "../types.js";
import {
  PHASE_TOOLS,
  PHASE_TOOL_NAMES,
  RESOLUTION_PHASES,
  type ResolutionPhase,
  SESSION_PHASES,
  schemaFingerprint,
  sessionOfPhase,
} from "../worldResolutionStageSchemas.js";

const generateToolCalls = vi.fn();
vi.mock("../../../models/index.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../../models/types.js"
  );
  return { ...actual, generateToolCalls };
});

// The global gate, wrapped so a test can make it refuse a draft every phase
// accepted. Every check the gate makes is mirrored by some phase (the stage
// validator calls the same helpers), so a cross-domain fault that slips all
// six phases is not constructible from the real rules — the rewind path is
// exercised by overriding the gate's verdict, and only there. Everything else
// in the validator module is the real thing.
const gate = vi.fn();
vi.mock("../worldDeltaValidator.js", async () => {
  const actual = await vi.importActual<
    typeof import("../worldDeltaValidator.js")
  >("../worldDeltaValidator.js");
  return {
    ...actual,
    validateRawResolution: (...args: unknown[]) => gate(...args),
  };
});
const realValidator = await vi.importActual<
  typeof import("../worldDeltaValidator.js")
>("../worldDeltaValidator.js");

const {
  MAX_PHASE_ATTEMPTS,
  MAX_PROVIDER_CALLS,
  exitsFromHere,
  renderContext,
  renderContextSegments,
  renderWorldGraph,
  resolveTick,
} = await import("../worldActionEngine.js");
const { assembleRawResolution } = await import(
  "../worldResolutionStageValidator.js"
);

// ==================== Fixtures ====================

const cmd: ActionCommand = {
  commandId: "c1",
  actorId: "npc_1",
  issuedAt: "1923-04-02T09:15:00",
  issuedSceneId: "SCN_1",
  description: "I walk to the far room.",
  objectRefs: [],
  proposedDurationTicks: 3,
};

const LIVE = "action_live";
const TALK = "action_talk";

/** Due this minute: progress has reached the duration code set at start. */
function activeAction(overrides: Partial<EngineAction> = {}): EngineAction {
  return {
    id: LIVE,
    command: {
      ...cmd,
      commandId: "live",
      actorId: "npc_2",
      description: "I force the cabinet.",
    },
    status: "active",
    submittedAt: "1923-04-02T09:00:00",
    startedAt: "1923-04-02T09:10:00",
    progressMinutes: 5,
    resolvedDurationTicks: 5,
    nextWakeAt: "1923-04-02T09:15:00",
    ...overrides,
  };
}

/** An action whose command carries words — the only kind a `pure_speech`
 *  decision is legal for. */
const talkingAction = (): EngineAction =>
  activeAction({
    id: TALK,
    command: {
      ...cmd,
      commandId: "talk",
      actorId: "npc_2",
      description: "I greet him.",
      utterance: "Good morning.",
    },
    progressMinutes: 1,
    resolvedDurationTicks: 1,
  });

/** A second queued command, silent and non-travel: it owes a duration. */
const cmd2: ActionCommand = {
  ...cmd,
  commandId: "c2",
  actorId: "npc_2",
  description: "I force the cabinet lock.",
  proposedDurationTicks: 2,
};

/**
 * One context, asking for ONE of the Engine's two functions.
 *
 * A start context carries the queued commands and a single `new_action`
 * trigger; its active actions are context the Engine reads and is asked
 * nothing about. A settlement context carries no new command at all and
 * triggers on the actions whose time is up. The two are never mixed — the
 * runner refuses a context that asks for both — so the fixture cannot build
 * one by accident.
 */
function makeContext(
  opts: {
    kind?: "start" | "settlement";
    ending?: boolean;
    talk?: boolean;
    blocked?: boolean;
    second?: boolean;
  } = {}
): EngineResolutionContext {
  const settlement = opts.kind === "settlement";
  const activeActions = [
    ...(opts.ending ? [activeAction()] : []),
    ...(opts.talk ? [talkingAction()] : []),
  ];
  const newCommands = settlement ? [] : [cmd, ...(opts.second ? [cmd2] : [])];
  const actionIds = settlement
    ? activeActions.map((a) => a.id)
    : newCommands.map((c) => `action_${c.commandId}`);
  return {
    trigger: {
      triggers: [
        { actionIds, reason: settlement ? "duration_reached" : "new_action" },
      ],
      actionIds,
    },
    tick: {
      tickId: "tick_1",
      tickStartTime: "1923-04-02T09:15:00",
      durationMinutes: 1,
    },
    rules: {
      resolutionGuide: "src/engine/rules/world-action-resolution.md",
      outputSchemaVersion: 1,
      worldInvariants: [],
    },
    state: {
      // The skeleton carries only the macro location; the scenes the actor
      // stands in / moves to are real via placeKinds (the validator's
      // full-world lookup), and the involved one is snapshotted below.
      graph: {
        places: [{ id: "J_A", kind: "scene" as const, name: "Crossing" }],
        edges: [],
      },
      // `blocked` shuts the one passage out of SCN_1, which is what a
      // `passBlockedConnectionId` grant has to name.
      blockedEdges: opts.blocked
        ? [
            {
              connectionId: "connection.scn1.far",
              from: "SCN_1",
              to: "SCN_FAR",
              reason: "a fallen beam",
            },
          ]
        : [],
      placeKinds: { SCN_1: "scene", SCN_FAR: "scene" },
      connectionIds: ["connection.scn1.far"],
      places: [
        {
          id: "SCN_1",
          kind: "scene",
          name: "Reading room",
          description: "Shelves and a long table.",
          parentLocationId: "OUTDOOR",
          conditions: [],
          itemIds: ["lamp_1"],
          connections: [
            {
              connectionId: "connection.scn1.far",
              targetId: "SCN_FAR",
              description: "a far door",
            },
          ],
          environment: {
            temperature: 18,
            illumination: 60,
            oxygen: 100,
            noise: 10,
            airborneHazards: [],
          },
          presentCharacterIds: ["npc_1", "npc_2"],
        },
      ],
      items: [{ id: "lamp_1", name: "oil lamp", holder: "scene:SCN_1" }],
      itemHolders: { lamp_1: "scene:SCN_1" },
      characters: [
        {
          id: "npc_1",
          name: "Marsh",
          alive: true,
          attributes: {},
          skills: {},
          hp: 10,
          maxHp: 10,
          san: 50,
          maxSan: 60,
          fatigue: 0,
          maxFatigue: 10,
          position: null,
          // A grant is held against the actor's own `exitsFromHere`, which
          // needs their place; the plain fixture leaves it unknown as before.
          locationId: opts.blocked ? "SCN_1" : "",
          conditions: [],
          inventoryItemIds: [],
        },
        {
          id: "npc_2",
          name: "Hollins",
          alive: true,
          attributes: {},
          skills: {},
          hp: 10,
          maxHp: 10,
          san: 50,
          maxSan: 60,
          fatigue: 0,
          maxFatigue: 10,
          position: { type: "scene", sceneId: "SCN_1" },
          locationId: "SCN_1",
          conditions: [],
          inventoryItemIds: [],
        },
      ],
    },
    actions: { newCommands, activeActions },
    events: { objectiveWorldEvents: [], deterministicResults: [] },
  };
}

function makeDeps() {
  const codeTools = new CodeToolRegistry();
  // The endings phase offers only the dice. (pathfinding, movementCost and
  // inventoryValidation were removed — a tool call costs a full-context
  // round trip, and those three answered from data the request already
  // carries.)
  codeTools.register({
    name: "damageRoll",
    description: "stub",
    execute: () => ({ ok: true, total: 5, dice: [4, 1] }),
  });
  return { dgsm: {} as DynamicGameStateManager, codeTools };
}

// ==================== Turn builders ====================

type Call = {
  id: string;
  name: string;
  args?: object;
  unreadableArgs?: { rawLength: number };
};

function turn(calls: Call[]) {
  const toolCalls = calls.map((c) => ({ ...c, args: c.args ?? {} }));
  return {
    toolCalls,
    assistantMessage: { role: "assistant" as const, toolCalls },
  };
}

/** One call of a phase's own tool. */
function phaseCall(
  phase: ResolutionPhase,
  args: object,
  id = `${phase}_call`
): Call {
  return { id, name: PHASE_TOOL_NAMES[phase], args };
}

const accept = (phase: ResolutionPhase, args: object) =>
  turn([phaseCall(phase, args)]);

const roll = (id: string, args: object = { formula: "1d6" }) =>
  turn([{ id, name: "damageRoll", args }]);

/** What a tick with one starting movement action submits, phase by phase.
 *  A movement action leaves the clock to the route: `resolvedDurationTicks`
 *  on it is refused by the validator, and the runtime derives the time. */
const BASE_ANSWERS: Record<ResolutionPhase, object> = {
  endings: { endings: [] },
  starts: {
    starting: [{ actionId: "action_c1", movement: { route: ["SCN_FAR"] } }],
  },
  characterChanges: { characterChanges: [] },
  itemChanges: { itemChanges: [] },
  sceneChanges: { sceneChanges: [] },
  occurrences: { occurrences: [] },
};

/** What the one-phase START JUDGEMENT submits for the plain fixture. */
const START_ANSWERS: Partial<Record<ResolutionPhase, object>> = {
  starts: BASE_ANSWERS.starts,
};

/** What the five-phase SETTLEMENT submits when nothing is ending: every
 *  domain empty. A context with an action ending in it owes decisions, and
 *  the tests that build one override them (see `SETTLES_LIVE`). No `starts`
 *  key: a settlement session never runs that phase. */
const SETTLEMENT_ANSWERS: Record<Exclude<ResolutionPhase, "starts">, object> = {
  endings: BASE_ANSWERS.endings,
  characterChanges: BASE_ANSWERS.characterChanges,
  itemChanges: BASE_ANSWERS.itemChanges,
  sceneChanges: BASE_ANSWERS.sceneChanges,
  occurrences: BASE_ANSWERS.occurrences,
};

/** The start judgement's one first-try acceptance. */
function startPath(overrides: Partial<Record<ResolutionPhase, object>> = {}) {
  return SESSION_PHASES.start.map((phase) =>
    accept(phase, overrides[phase] ?? START_ANSWERS[phase] ?? {})
  );
}

/** Five first-try acceptances, with any phase's answer overridden. */
function settlementPath(
  overrides: Partial<Record<ResolutionPhase, object>> = {}
) {
  // SESSION_PHASES.settlement is typed as the full ResolutionPhase (it is
  // one array among others of that shape) though it never actually holds
  // "starts" — the one cast lives here.
  const answers = SETTLEMENT_ANSWERS as Record<ResolutionPhase, object>;
  return SESSION_PHASES.settlement.map((phase) =>
    accept(phase, overrides[phase] ?? answers[phase])
  );
}

/** The session that owns `phase`, with further attempts spliced in right
 *  after that phase's first turn. The runner asks the SAME phase again before
 *  it moves on, so a retry appended after the session's acceptances would be
 *  read as the answer to a later phase's request — a wrong-tool turn, not the
 *  correction. */
function retrying(
  phase: ResolutionPhase,
  overrides: Partial<Record<ResolutionPhase, object>>,
  ...retries: ReturnType<typeof turn>[]
) {
  const kind = sessionOfPhase(phase);
  const path =
    kind === "start" ? startPath(overrides) : settlementPath(overrides);
  const i = SESSION_PHASES[kind].indexOf(phase);
  return [...path.slice(0, i + 1), ...retries, ...path.slice(i + 1)];
}

function script(...turns: ReturnType<typeof turn>[]) {
  for (const t of turns) generateToolCalls.mockResolvedValueOnce(t);
}

// ==================== Request inspection ====================

const requests = (): ToolCallOptions[] =>
  generateToolCalls.mock.calls.map((c) => c[0] as ToolCallOptions);

/** Which phase each request was for, in order, read off the operation tag. */
const phasesRequested = (): string[] =>
  requests().map((r) =>
    (r.operation ?? "").replace("world-action-engine:", "")
  );

/** The phase instruction: the third text block of the opening user turn. */
function instructionOf(req: ToolCallOptions): string {
  const first = req.messages[0];
  if (first.role !== "user") return "";
  const block = first.content[2];
  return block?.kind === "text" ? block.text : "";
}

function lastToolResults(req: ToolCallOptions) {
  const msg = [...req.messages].reverse().find((m) => m.role === "tool");
  return msg && msg.role === "tool" ? msg.results : [];
}

// Every change is sourced to an action of THIS session, and a settlement's
// actions are the ones ending in it — `action_c1` is a start, and a settlement
// context does not carry it at all.
const A_BAD_ITEM_OP = {
  itemChanges: [
    {
      sourceActionId: LIVE,
      itemId: "lamp_1",
      operation: { kind: "teleport" },
    },
  ],
};
const A_GOOD_ITEM_OP = {
  itemChanges: [
    {
      sourceActionId: LIVE,
      itemId: "lamp_1",
      operation: { kind: "move", from: "scene:SCN_1", to: "npc_1" },
    },
  ],
};

/** The settlement of `makeContext({ kind: "settlement", ending: true })`: the
 *  one ending action decided, and the one occurrence that traces it. Every
 *  settlement test that carries an ending but is not ABOUT the ending starts
 *  from these two. */
const LIVE_OUTCOME = {
  endings: [{ actionId: LIVE, mode: "outcome", outcome: "The cabinet gives." }],
};
const LIVE_TRACE = {
  occurrences: [
    {
      actionIds: [LIVE],
      speech: false,
      perceivers: [{ characterId: "npc_2", clarity: "full" }],
      content: "The cabinet door gives way.",
    },
  ],
};
const SETTLES_LIVE = { endings: LIVE_OUTCOME, occurrences: LIVE_TRACE };

describe("exitsFromHere — code's passability verdict beside the command", () => {
  // The model read "lodge_drive ↔ porch is closed" as "the porch is closed"
  // and ended a walk from the greatroom to the porch as weather-blocked. The
  // greatroom's door onto the porch was open; only the drive's was shut.
  const state = {
    characters: [{ id: "npc_joel", locationId: "SCN_greatroom" }],
    places: [
      {
        id: "SCN_greatroom",
        connections: [
          { connectionId: "connection.greatroom.porch", targetId: "SCN_porch" },
          {
            connectionId: "connection.greatroom.upstairs",
            targetId: "SCN_upstairs",
            concealed: true,
          },
        ],
      },
      {
        id: "SCN_drive",
        connections: [
          { connectionId: "connection.drive.porch", targetId: "SCN_porch" },
        ],
      },
    ],
    blockedEdges: [
      {
        connectionId: "connection.drive.porch",
        from: "SCN_drive",
        to: "SCN_porch",
        reason: "weather-block",
      },
    ],
  };
  const ctx = { state } as never;

  it("marks the greatroom's own door open even though the porch appears in a blocked edge", () => {
    expect(exitsFromHere(ctx, "npc_joel")).toEqual([
      {
        connectionId: "connection.greatroom.porch",
        to: "SCN_porch",
        open: true,
      },
    ]);
  });

  it("marks the drive's door closed, with the reason, in either direction", () => {
    const fromDrive = {
      state: {
        ...state,
        characters: [{ id: "npc_x", locationId: "SCN_drive" }],
      },
    } as never;
    expect(exitsFromHere(fromDrive, "npc_x")).toEqual([
      {
        connectionId: "connection.drive.porch",
        to: "SCN_porch",
        open: false,
        reason: "weather-block",
      },
    ]);
  });

  it("returns nothing for an actor whose place is not in the snapshot", () => {
    expect(exitsFromHere(ctx, "npc_nobody")).toBeUndefined();
  });
});

describe("resolveTick — the staged runner", () => {
  // Braces matter: `() => generateToolCalls.mockReset()` implicitly returns
  // the mock, and vitest treats a function returned from a hook as a teardown
  // callback — it would CALL the mock after each test, re-throwing whatever
  // implementation the test installed.
  beforeEach(() => {
    generateToolCalls.mockReset();
    gate.mockReset();
    gate.mockImplementation(realValidator.validateRawResolution);
    // The strict downgrade is remembered for the PROCESS, so one test's
    // refusal would otherwise decide what every later test's requests offer.
    resetStrictDowngrades();
  });

  it("the start judgement is one request; the settlement is five, in order; each assembles the same resolution the single submission did", async () => {
    script(...startPath());
    const start = await resolveTick(makeContext(), makeDeps());
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(start.resolution.transitions).toEqual([
      expect.objectContaining({ actionId: "action_c1", to: "active" }),
    ]);
    // Travel time is the movement runtime's: nothing is clocked here.
    expect(start.resolution.transitions[0].resolvedDurationTicks).toBe(
      undefined
    );
    expect(start.movementInits.action_c1).toEqual({ route: ["SCN_FAR"] });
    expect(start.checkInits).toEqual({});
    expect(start.codeToolInvocations).toEqual([]);
    expect(phasesRequested()).toEqual(["starts"]);
    expect(gate).toHaveBeenCalledTimes(1);

    generateToolCalls.mockClear();
    gate.mockClear();
    script(
      ...settlementPath({
        endings: {
          endings: [
            { actionId: LIVE, mode: "outcome", outcome: "The cabinet gives." },
          ],
        },
        occurrences: {
          occurrences: [
            {
              actionIds: [LIVE],
              speech: false,
              perceivers: [{ characterId: "npc_2", clarity: "full" }],
              content: "The cabinet door gives way.",
            },
          ],
        },
      })
    );
    const settled = await resolveTick(
      makeContext({ kind: "settlement", ending: true }),
      makeDeps()
    );
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    expect(settled.resolution.transitions).toEqual([
      expect.objectContaining({ actionId: LIVE, to: "completed" }),
    ]);
    expect(phasesRequested()).toEqual([...SESSION_PHASES.settlement]);
    // Each phase is its own conversation: no request carries another
    // phase's turns.
    for (const req of requests()) expect(req.messages).toHaveLength(1);
    // The global gate ran exactly once, over the assembled draft.
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("refuses a context that asks for both functions at once, without a model call", async () => {
    const mixed = makeContext({ kind: "start", ending: true });
    mixed.trigger.triggers.push({
      actionIds: [LIVE],
      reason: "duration_reached",
    });
    const result = await resolveTick(mixed, makeDeps());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toContain("two sessions at once");
    expect(generateToolCalls).not.toHaveBeenCalled();
  });

  it("accepts `[]` for every domain that has nothing to say", async () => {
    // A settlement with nothing ending in it: every phase is empty, and an
    // accepted empty array is a fact the later phases are shown.
    script(...settlementPath());

    const result = await resolveTick(
      makeContext({ kind: "settlement" }),
      makeDeps()
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolution.occurrences).toEqual([]);
    expect(result.resolution.characterChanges).toEqual([]);
    expect(result.resolution.itemChanges).toEqual([]);
    expect(result.resolution.sceneChanges).toEqual([]);
    const last = instructionOf(requests()[4]);
    expect(last).toContain("### `endings` — accepted in phase 1\n[]");
    expect(last).toContain("### `itemChanges` — accepted in phase 3\n[]");
  });

  it("settles a routine wait through all five phases without generating an outcome or event", async () => {
    script(
      ...settlementPath({
        endings: { endings: [{ actionId: LIVE, mode: "no_change" }] },
      })
    );
    const ctx = makeContext({ kind: "settlement", ending: true });
    ctx.actions.activeActions[0].command.description =
      "I wait and watch the room.";
    const result = await resolveTick(ctx, makeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolution.transitions).toEqual([
      expect.objectContaining({ actionId: LIVE, to: "completed" }),
    ]);
    expect(result.resolution.transitions[0].reason).toBeUndefined();
    expect(result.resolution.occurrences).toEqual([]);
    expect(gate).toHaveBeenCalledTimes(1);
    expect(phasesRequested()).toEqual([...SESSION_PHASES.settlement]);
  });

  it("pure speech: a pure_speech decision plus its speech row ends the action with no ending row", async () => {
    script(
      ...settlementPath({
        endings: { endings: [{ actionId: TALK, mode: "pure_speech" }] },
        occurrences: {
          occurrences: [
            {
              actionIds: [TALK],
              speech: true,
              targetIds: ["npc_1"],
              perceivers: [{ characterId: "npc_1", clarity: "full" }],
            },
          ],
        },
      })
    );

    const result = await resolveTick(
      makeContext({ kind: "settlement", talk: true }),
      makeDeps()
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The assembled resolution the gate judged carries NO ending row for it:
    // the speech row is the whole answer.
    const judged = gate.mock.calls[0][0] as { ending: unknown[] };
    expect(judged.ending).toEqual([]);
    // The clock still closes the action, with no reason — what came of it is
    // the words, delivered by the row.
    const closed = result.resolution.transitions.find(
      (t) => t.actionId === TALK
    );
    expect(closed).toMatchObject({ to: "completed" });
    expect(closed?.reason).toBeUndefined();
  });

  it("delivers an interrogation's observable conduct and exact words without a check", async () => {
    const context = makeContext({ kind: "settlement", talk: true });
    const [action] = context.actions.activeActions;
    action.command.description =
      "I spread the ledger open and point at the date.";
    action.command.utterance = "Where were you that night?";
    const conduct = "She spreads the ledger open and points at the date.";
    const perceivers = [{ characterId: "npc_1", clarity: "full" }];
    script(
      ...settlementPath({
        endings: {
          endings: [{ actionId: TALK, mode: "outcome", outcome: conduct }],
        },
        occurrences: {
          occurrences: [
            { actionIds: [TALK], speech: false, content: conduct, perceivers },
            {
              actionIds: [TALK],
              speech: true,
              targetIds: ["npc_1"],
              perceivers,
            },
          ],
        },
      })
    );

    const result = await resolveTick(context, makeDeps());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [gesture, speech] = result.resolution.occurrences;
    expect(gesture.facts[0].content).toBe(conduct);
    expect(speech.facts[0].content).toBe("Where were you that night?");
    expect(gesture.perceivers).toEqual(perceivers);
    expect(speech.perceivers).toEqual(perceivers);
    expect(speech.participants).toContainEqual({
      characterId: "npc_1",
      role: "target",
    });
    expect(result.resolution.characterChanges).toEqual([]);
  });

  describe("skipping change phases when nothing has an outcome (DECISIONS_PHASE_SKIP)", () => {
    // No Decisions call may reach the network from a test: without a key the
    // client answers `no_key` and the phase falls back to the model.
    beforeEach(() => {
      vi.stubEnv("OPENAI_API_KEY", "");
    });
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    const NO_CHANGE = { endings: [{ actionId: LIVE, mode: "no_change" }] };
    const TALK_ROW = {
      occurrences: [
        {
          actionIds: [TALK],
          speech: true,
          targetIds: ["npc_1"],
          perceivers: [{ characterId: "npc_1", clarity: "full" }],
        },
      ],
    };

    it("on: every ending no_change → only endings and occurrences are requested", async () => {
      vi.stubEnv("DECISIONS_PHASE_SKIP", "on");
      script(
        accept("endings", NO_CHANGE),
        accept("occurrences", BASE_ANSWERS.occurrences)
      );

      const result = await resolveTick(
        makeContext({ kind: "settlement", ending: true }),
        makeDeps()
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(phasesRequested()).toEqual(["endings", "occurrences"]);
      expect(result.resolution.characterChanges).toEqual([]);
      expect(result.resolution.itemChanges).toEqual([]);
      expect(result.resolution.sceneChanges).toEqual([]);
      expect(gate).toHaveBeenCalledTimes(1);
    });

    it("on: a pure_speech ending skips them too", async () => {
      vi.stubEnv("DECISIONS_PHASE_SKIP", "on");
      script(
        accept("endings", {
          endings: [{ actionId: TALK, mode: "pure_speech" }],
        }),
        accept("occurrences", TALK_ROW)
      );

      const result = await resolveTick(
        makeContext({ kind: "settlement", talk: true }),
        makeDeps()
      );

      expect(result.ok).toBe(true);
      expect(phasesRequested()).toEqual(["endings", "occurrences"]);
    });

    it("on: one outcome among the endings runs all five phases", async () => {
      vi.stubEnv("DECISIONS_PHASE_SKIP", "on");
      script(...settlementPath(SETTLES_LIVE));

      const result = await resolveTick(
        makeContext({ kind: "settlement", ending: true }),
        makeDeps()
      );

      expect(result.ok).toBe(true);
      expect(phasesRequested()).toEqual([...SESSION_PHASES.settlement]);
    });

    it("on: a rewind into a skipped phase runs it", async () => {
      vi.stubEnv("DECISIONS_PHASE_SKIP", "on");
      gate.mockImplementationOnce((): ResolutionError[] => [
        {
          target: { kind: "itemChange", index: 0 },
          message: "the prose of SCN_1 still cites the lamp that left it",
        },
      ]);
      script(
        accept("endings", NO_CHANGE),
        accept("occurrences", BASE_ANSWERS.occurrences),
        accept("itemChanges", BASE_ANSWERS.itemChanges),
        accept("sceneChanges", BASE_ANSWERS.sceneChanges),
        accept("occurrences", BASE_ANSWERS.occurrences)
      );

      const result = await resolveTick(
        makeContext({ kind: "settlement", ending: true }),
        makeDeps()
      );

      expect(result.ok).toBe(true);
      expect(phasesRequested()).toEqual([
        "endings",
        "occurrences",
        "itemChanges",
        "sceneChanges",
        "occurrences",
      ]);
      expect(gate).toHaveBeenCalledTimes(2);
    });

    it("shadow: all five run, and three shadow lines say agree: true", async () => {
      const file = join(mkdtempSync(join(tmpdir(), "phaseskip-")), "s.jsonl");
      vi.stubEnv("DECISIONS_PHASE_SKIP", "shadow");
      vi.stubEnv("DECISIONS_SHADOW_LOG", file);
      script(...settlementPath({ endings: NO_CHANGE }));

      const result = await resolveTick(
        makeContext({ kind: "settlement", ending: true }),
        makeDeps()
      );

      expect(result.ok).toBe(true);
      expect(phasesRequested()).toEqual([...SESSION_PHASES.settlement]);
      const lines = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(lines.map((l) => l.phase)).toEqual([
        "characterChanges",
        "itemChanges",
        "sceneChanges",
      ]);
      expect(lines.every((l) => l.agree === true && l.rows === 0)).toBe(true);
    });

    /** A Decisions stub answering every question it is asked: predicates
     *  with `p`, choices with `choiceP` on the last option. */
    function answerAll(p: number, choiceP = 0.9): DecisionsTransport {
      return async (_url, init) => {
        const body = JSON.parse(init.body) as {
          questions: Array<{
            name: string;
            type: string;
            choices?: Array<{ value: string }>;
          }>;
        };
        return {
          status: 200,
          json: async () => ({
            answers: body.questions.map((q) =>
              q.type === "predicate"
                ? { type: "predicate", name: q.name, probability: p }
                : {
                    type: "choice",
                    name: q.name,
                    probabilities: (q.choices ?? []).map((c, i, all) => ({
                      value: c.value,
                      probability: i === all.length - 1 ? choiceP : 0.01,
                    })),
                  }
            ),
          }),
        };
      };
    }

    it("on, with perceivers: a words-only minute settles with no model call at all", async () => {
      vi.stubEnv("DECISIONS_PHASE_SKIP", "on");
      vi.stubEnv("DECISIONS_PERCEIVERS", "on");
      vi.stubEnv("OPENAI_API_KEY", "test-key");
      setDecisionsTransport(answerAll(0.02));
      try {
        const result = await resolveTick(
          makeContext({ kind: "settlement", talk: true }),
          makeDeps()
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(generateToolCalls).not.toHaveBeenCalled();
        expect(result.resolution.transitions).toContainEqual(
          expect.objectContaining({ actionId: TALK, to: "completed" })
        );
        const row = result.resolution.occurrences[0];
        expect(row.sourceActionIds).toEqual([TALK]);
        expect(row.facts.some((f) => f.type === "utterance")).toBe(true);
        // The speaker hears themself; the other person in the room, at the
        // grade the stub gave (the last option, "full").
        expect(row.perceivers).toEqual(
          expect.arrayContaining([
            { characterId: "npc_2", clarity: "full" },
            { characterId: "npc_1", clarity: "full" },
          ])
        );
      } finally {
        setDecisionsTransport(null);
      }
    });

    it("perceivers on: the model writes the rows without perceivers, Decisions fills them in", async () => {
      vi.stubEnv("DECISIONS_PERCEIVERS", "on");
      vi.stubEnv("OPENAI_API_KEY", "test-key");
      setDecisionsTransport(answerAll(0.02));
      try {
        script(
          ...settlementPath({
            endings: LIVE_OUTCOME,
            occurrences: {
              occurrences: [
                {
                  actionIds: [LIVE],
                  speech: false,
                  content: "The cabinet door gives way.",
                },
              ],
            },
          })
        );
        const result = await resolveTick(
          makeContext({ kind: "settlement", ending: true }),
          makeDeps()
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // The occurrences request offered the tool with no perceivers field.
        const occTool = requests()[4].tools?.[0] as unknown as {
          inputSchema: {
            properties: {
              occurrences: { items: { properties: Record<string, unknown> } };
            };
          };
        };
        expect(
          occTool.inputSchema.properties.occurrences.items.properties
        ).not.toHaveProperty("perceivers");
        expect(result.resolution.occurrences[0].perceivers).toEqual(
          expect.arrayContaining([
            { characterId: "npc_1", clarity: "full" },
            { characterId: "npc_2", clarity: "full" },
          ])
        );
      } finally {
        setDecisionsTransport(null);
      }
    });

    it("perceivers on: when Decisions fails, the model is asked again with the full tool", async () => {
      vi.stubEnv("DECISIONS_PERCEIVERS", "on");
      vi.stubEnv("OPENAI_API_KEY", "test-key");
      setDecisionsTransport(async () => ({
        status: 500,
        json: async () => ({}),
      }));
      try {
        script(
          ...settlementPath({
            endings: LIVE_OUTCOME,
            occurrences: {
              occurrences: [
                {
                  actionIds: [LIVE],
                  speech: false,
                  content: "The cabinet door gives way.",
                },
              ],
            },
          }),
          accept("occurrences", LIVE_TRACE)
        );
        const result = await resolveTick(
          makeContext({ kind: "settlement", ending: true }),
          makeDeps()
        );
        expect(result.ok).toBe(true);
        expect(phasesRequested()).toEqual([
          ...SESSION_PHASES.settlement,
          "occurrences",
        ]);
        const retryTool = requests()[5].tools?.[0] as unknown as {
          inputSchema: {
            properties: {
              occurrences: { items: { properties: Record<string, unknown> } };
            };
          };
        };
        expect(
          retryTool.inputSchema.properties.occurrences.items.properties
        ).toHaveProperty("perceivers");
      } finally {
        setDecisionsTransport(null);
      }
    });

    it("on: an unsure Decisions answer leaves the endings to the model", async () => {
      vi.stubEnv("DECISIONS_PHASE_SKIP", "on");
      vi.stubEnv("OPENAI_API_KEY", "test-key");
      setDecisionsTransport(answerAll(0.5));
      try {
        script(
          accept("endings", {
            endings: [{ actionId: TALK, mode: "pure_speech" }],
          }),
          accept("occurrences", TALK_ROW)
        );
        const result = await resolveTick(
          makeContext({ kind: "settlement", talk: true }),
          makeDeps()
        );
        expect(result.ok).toBe(true);
        expect(phasesRequested()).toEqual(["endings", "occurrences"]);
      } finally {
        setDecisionsTransport(null);
      }
    });

    it("off: all five run (unchanged)", async () => {
      script(...settlementPath({ endings: NO_CHANGE }));

      const result = await resolveTick(
        makeContext({ kind: "settlement", ending: true }),
        makeDeps()
      );

      expect(result.ok).toBe(true);
      expect(phasesRequested()).toEqual([...SESSION_PHASES.settlement]);
    });
  });

  it("a physical ending without a speech:false row is refused in the occurrence phase, and by the gate", async () => {
    const outcome = {
      endings: [
        { actionId: LIVE, mode: "outcome", outcome: "The cabinet gives." },
      ],
    };
    const trace = {
      occurrences: [
        {
          actionIds: [LIVE],
          speech: false,
          perceivers: [{ characterId: "npc_2", clarity: "full" }],
          content: "The cabinet door gives way.",
        },
      ],
    };
    script(
      ...settlementPath({ endings: outcome, occurrences: { occurrences: [] } }),
      accept("occurrences", trace)
    );

    const context = makeContext({ kind: "settlement", ending: true });
    const result = await resolveTick(context, makeDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolution.transitions).toContainEqual(
      expect.objectContaining({
        actionId: LIVE,
        to: "completed",
        reason: "The cabinet gives.",
      })
    );
    // Only the occurrence phase was rerun, and its rejection was local.
    expect(phasesRequested()).toEqual([
      ...SESSION_PHASES.settlement,
      "occurrences",
    ]);
    const rejection = lastToolResults(requests()[5])[0].content;
    expect(rejection).toContain("REJECTED");
    expect(rejection).toContain("`submit_occurrences`");
    expect(rejection).toContain(`occurrence:${LIVE}`);
    expect(rejection).toContain("no speech:false row cites it");
    // Had it slipped past the phase, the gate would have refused the same
    // draft: the phase check is a subset of the whole-resolution check.
    const slipped = assembleRawResolution({
      endings: [
        { actionId: LIVE, mode: "outcome", outcome: "The cabinet gives." },
      ],
      starting: [],
      characterChanges: [],
      itemChanges: [],
      sceneChanges: [],
      occurrences: [],
    });
    const global = realValidator.validateRawResolution(slipped, context);
    expect(global.some((e) => e.message.includes("no occurrence cites"))).toBe(
      true
    );
  });

  it("local correction reruns ONLY the item phase, with the error addressed at the row", async () => {
    script(
      ...retrying(
        "itemChanges",
        { ...SETTLES_LIVE, itemChanges: A_BAD_ITEM_OP },
        accept("itemChanges", A_GOOD_ITEM_OP)
      )
    );

    const result = await resolveTick(
      makeContext({ kind: "settlement", ending: true }),
      makeDeps()
    );

    expect(result.ok).toBe(true);
    expect(phasesRequested()).toEqual([
      "endings",
      "characterChanges",
      "itemChanges",
      "itemChanges",
      "sceneChanges",
      "occurrences",
    ]);
    // The second item request continues the item conversation: the opening
    // turn, the rejected call, and its addressed rejection.
    const retry = requests()[3];
    expect(retry.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    const rejection = lastToolResults(retry);
    expect(rejection).toHaveLength(1);
    expect(rejection[0].toolCallId).toBe("itemChanges_call");
    expect(rejection[0].content).toContain("itemChange:0");
    expect(rejection[0].content).toContain(
      'unknown item operation kind "teleport"'
    );
    expect(rejection[0].content).toContain("COMPLETE `itemChanges` array");
    expect(rejection[0].content).toContain("There is no patch");
    // Nothing of the rejected array reached the next phase.
    expect(instructionOf(requests()[4])).not.toContain("teleport");
  });

  it("shows each phase the accepted upstream draft, verbatim and read-only", async () => {
    script(...settlementPath({ ...SETTLES_LIVE, itemChanges: A_GOOD_ITEM_OP }));

    const result = await resolveTick(
      makeContext({ kind: "settlement", ending: true }),
      makeDeps()
    );

    expect(result.ok).toBe(true);
    const scene = instructionOf(requests()[3]);
    expect(scene).toContain("### `itemChanges` — accepted in phase 3");
    expect(scene).toContain('"kind": "move"');
    expect(scene).toContain('"to": "npc_1"');
    expect(scene).not.toContain("### `sceneChanges`");
    const occurrences = instructionOf(requests()[4]);
    for (const heading of [
      "### `endings` — accepted in phase 1",
      "### `characterChanges` — accepted in phase 2",
      "### `itemChanges` — accepted in phase 3",
      "### `sceneChanges` — accepted in phase 4",
    ]) {
      expect(occurrences).toContain(heading);
    }
    expect(occurrences).toContain("read-only");
    // And the first phase is told it stands alone.
    expect(instructionOf(requests()[0])).toContain(
      "Nothing precedes this phase"
    );
  });

  it("a one-shot grant on a start names the blocked passage and rides through to the movement init", async () => {
    // The passage stays shut for everybody else; the grant is the exact edge
    // this walker gets past, and it is settled in the start judgement — the
    // settlement, a minute later, never sees the start at all.
    const granted = {
      starting: [
        {
          actionId: "action_c1",
          movement: {
            route: ["SCN_FAR"],
            passBlockedConnectionId: "connection.scn1.far",
          },
        },
      ],
    };
    script(...startPath({ starts: granted }));

    const result = await resolveTick(
      makeContext({ blocked: true }),
      makeDeps()
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.movementInits.action_c1).toEqual({
      route: ["SCN_FAR"],
      passBlockedConnectionId: "connection.scn1.far",
    });
    expect(phasesRequested()).toEqual(["starts"]);
  });

  it("global rewind: a gate fault rewinds to its owning phase, tells that phase why, and reruns the tail", async () => {
    const stale: ResolutionError[] = [
      {
        target: { kind: "itemChange", index: 0 },
        message: "the prose of SCN_1 still cites the lamp that left it",
      },
    ];
    gate.mockImplementationOnce(() => stale);
    script(
      ...settlementPath({ ...SETTLES_LIVE, itemChanges: A_GOOD_ITEM_OP }),
      accept("itemChanges", A_GOOD_ITEM_OP),
      accept("sceneChanges", BASE_ANSWERS.sceneChanges),
      accept("occurrences", LIVE_TRACE)
    );

    const result = await resolveTick(
      makeContext({ kind: "settlement", ending: true }),
      makeDeps()
    );

    expect(result.ok).toBe(true);
    expect(phasesRequested()).toEqual([
      ...SESSION_PHASES.settlement,
      "itemChanges",
      "sceneChanges",
      "occurrences",
    ]);
    expect(generateToolCalls).toHaveBeenCalledTimes(8);
    expect(gate).toHaveBeenCalledTimes(2);
    // The rewound phase gets the verdict, once, in its opening instruction —
    // and still sees the earlier phases, which were kept.
    const redo = instructionOf(requests()[5]);
    expect(redo).toContain("## Why this phase is being redone");
    expect(redo).toContain("itemChange:0 — the prose of SCN_1 still cites");
    expect(redo).toContain("### `characterChanges` — accepted in phase 2");
    expect(redo).not.toContain("### `sceneChanges`");
    // The phases behind it are rerun because the draft changed, and told
    // nothing about a fault that was not theirs.
    expect(instructionOf(requests()[6])).not.toContain("being redone");
    expect(instructionOf(requests()[7])).not.toContain("being redone");
  });

  it("a second global failure rejects the tick atomically, naming the rewind", async () => {
    const errors: ResolutionError[] = [
      {
        target: { kind: "occurrence", actionIds: [LIVE] },
        message: "x",
      },
    ];
    gate.mockImplementation(() => errors);
    script(
      ...settlementPath(),
      accept("occurrences", BASE_ANSWERS.occurrences)
    );

    const result = await resolveTick(
      makeContext({ kind: "settlement" }),
      makeDeps()
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toContain("still invalid after 1 global rewind(s)");
    expect(result.failure).toContain("nothing applied");
    expect(result.errors).toEqual(errors);
    expect(phasesRequested()).toEqual([
      ...SESSION_PHASES.settlement,
      "occurrences",
    ]);
    expect(gate).toHaveBeenCalledTimes(2);
  });

  describe("corrections by difference — starts and occurrences", () => {
    it("starts: the model answers only the owed entry and the kept row survives the merge", async () => {
      // Tick 9 of the measured run in miniature: one entry lacks its
      // duration, the other is fine. Asked for the complete array the model
      // shrank it; asked for the difference it need only send one entry.
      const first = {
        starting: [
          { actionId: "action_c1", movement: { route: ["SCN_FAR"] } },
          { actionId: "action_c2" },
        ],
      };
      script(
        ...retrying(
          "starts",
          { starts: first },
          accept("starts", {
            starting: [{ actionId: "action_c2", resolvedDurationTicks: 2 }],
          })
        )
      );

      const result = await resolveTick(
        makeContext({ second: true }),
        makeDeps()
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.resolution.transitions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ actionId: "action_c1", to: "active" }),
          expect.objectContaining({
            actionId: "action_c2",
            to: "active",
            resolvedDurationTicks: 2,
          }),
        ])
      );
      expect(result.movementInits.action_c1).toEqual({ route: ["SCN_FAR"] });
      expect(phasesRequested()).toEqual(["starts", "starts"]);
      const rejection = lastToolResults(requests()[1])[0].content;
      expect(rejection).toContain("## Kept by code (1 rows)");
      expect(rejection).toContain('"actionId": "action_c1"');
      expect(rejection).toContain(
        "## Still owed — send ONLY these (1 entries)"
      );
      expect(rejection).toContain('"proposedDurationTicks": 2');
      expect(rejection).toContain("the command proposed 2 tick(s)");
      expect(rejection).not.toContain("Use `[]`");
    });

    it("occurrences: refuses a degenerate resend while retaining both valid rows for the next repair", async () => {
      // Tick 7 of the measured run: told one fact row was missing, the model
      // answered with two rows whose content was "placeholder". Here the
      // kept speech row wins over its placeholder twin, and the fact row
      // the correction asked for is appended.
      const speech = {
        actionIds: [TALK],
        speech: true,
        targetIds: ["npc_1"],
        perceivers: [{ characterId: "npc_1", clarity: "full" }],
      };
      const fact = {
        actionIds: [LIVE],
        speech: false,
        perceivers: [{ characterId: "npc_1", clarity: "full" }],
        content: "The cabinet door splinters around the lock and swings open.",
      };
      script(
        ...retrying(
          "occurrences",
          {
            endings: {
              endings: [
                { actionId: LIVE, mode: "outcome", outcome: "the door gives" },
                { actionId: TALK, mode: "pure_speech" },
              ],
            },
            occurrences: { occurrences: [speech] },
          },
          accept("occurrences", {
            occurrences: [{ ...speech, content: "placeholder" }, fact],
          }),
          accept("occurrences", { occurrences: [] })
        )
      );

      const result = await resolveTick(
        makeContext({ kind: "settlement", ending: true, talk: true }),
        makeDeps()
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const rows = JSON.stringify(result.resolution.occurrences);
      expect(result.resolution.occurrences).toHaveLength(2);
      expect(rows).not.toContain("placeholder");
      expect(rows).toContain("splinters around the lock");
      const rejection = lastToolResults(requests()[6])[0].content;
      expect(rejection).toContain("## Kept by code (2 rows)");
      expect(rejection).toContain(
        "## Still owed — send ONLY these (0 coverage pairs"
      );
      expect(rejection).toContain("unfinished placeholder");
      expect(generateToolCalls).toHaveBeenCalledTimes(7);
    });

    it("keeps retained rows visible after a malformed repair envelope", async () => {
      const speech = {
        actionIds: [TALK],
        speech: true,
        targetIds: ["npc_1"],
        perceivers: [{ characterId: "npc_1", clarity: "full" }],
      };
      const fact = {
        actionIds: [LIVE],
        speech: false,
        perceivers: [{ characterId: "npc_1", clarity: "full" }],
        content: "The cabinet opens.",
      };
      script(
        ...retrying(
          "occurrences",
          {
            endings: {
              endings: [
                {
                  actionId: LIVE,
                  mode: "outcome",
                  outcome: "The cabinet opens.",
                },
                { actionId: TALK, mode: "pure_speech" },
              ],
            },
            occurrences: { occurrences: [speech] },
          },
          accept("occurrences", { occurrences: null }),
          accept("occurrences", { occurrences: [fact] })
        )
      );
      const result = await resolveTick(
        makeContext({ kind: "settlement", ending: true, talk: true }),
        makeDeps()
      );
      expect(result.ok).toBe(true);
      const rejection = lastToolResults(requests()[6])[0].content;
      expect(rejection).toContain("Kept by code (1 rows)");
      expect(rejection).toContain("1 coverage pairs");
      if (result.ok) expect(result.resolution.occurrences).toHaveLength(2);
    });

    it("occurrences: an empty array is refused with every owed pair, and the whole checklist is in the instruction", async () => {
      const speech = {
        actionIds: [TALK],
        speech: true,
        targetIds: ["npc_1"],
        perceivers: [{ characterId: "npc_1", clarity: "full" }],
      };
      script(
        ...retrying(
          "occurrences",
          {
            endings: { endings: [{ actionId: TALK, mode: "pure_speech" }] },
            occurrences: { occurrences: [] },
          },
          accept("occurrences", { occurrences: [speech] })
        )
      );

      const result = await resolveTick(
        makeContext({ kind: "settlement", talk: true }),
        makeDeps()
      );

      expect(result.ok).toBe(true);
      const instruction = instructionOf(requests()[4]);
      expect(instruction).toContain(
        "## Required occurrence coverage (1 obligations)"
      );
      expect(instruction).toContain("An empty array is invalid.");
      expect(instruction).not.toContain("Nothing perceptible happened is `[]`");
      const rejection = lastToolResults(requests()[5])[0].content;
      expect(rejection).toContain("## Kept by code (0 rows)");
      expect(rejection).toContain(`"actionId": "${TALK}",\n  "speech": true`);
    });
  });

  it("per-phase cap: three rejected item submissions end the tick; a fourth is never requested", async () => {
    script(
      ...retrying(
        "itemChanges",
        { ...SETTLES_LIVE, itemChanges: A_BAD_ITEM_OP },
        accept("itemChanges", A_BAD_ITEM_OP),
        accept("itemChanges", A_BAD_ITEM_OP)
      )
    );
    // Were a fourth request made, it would succeed — and the assertion below
    // would see an accepted tick.
    generateToolCalls.mockResolvedValue(accept("itemChanges", A_GOOD_ITEM_OP));

    const result = await resolveTick(
      makeContext({ kind: "settlement", ending: true }),
      makeDeps()
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toContain(
      `phase itemChanges still invalid after ${MAX_PHASE_ATTEMPTS} attempts`
    );
    expect(result.errors.some((e) => e.target.kind === "itemChange")).toBe(
      true
    );
    expect(phasesRequested()).toEqual([
      "endings",
      "characterChanges",
      "itemChanges",
      "itemChanges",
      "itemChanges",
    ]);
    expect(gate).not.toHaveBeenCalled();
  });

  it("shared cap: dice turns count, and the thirteenth call is never made", async () => {
    // Eight dice turns and four accepted phases spend the twelve; the
    // occurrence phase cannot open, and the tick applies nothing.
    script(
      ...Array.from({ length: 8 }, (_, i) => roll(`r${i}`)),
      ...settlementPath().slice(0, 4)
    );
    generateToolCalls.mockResolvedValue(
      accept("occurrences", BASE_ANSWERS.occurrences)
    );

    const result = await resolveTick(
      makeContext({ kind: "settlement" }),
      makeDeps()
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(generateToolCalls).toHaveBeenCalledTimes(MAX_PROVIDER_CALLS);
    expect(result.failure).toContain(
      `call budget of ${MAX_PROVIDER_CALLS} exhausted in phase occurrences`
    );
    // Every roll that was made is still in the record.
    expect(result.codeToolInvocations).toHaveLength(8);
    expect(gate).not.toHaveBeenCalled();
  });

  it("a model error mid-phase applies nothing and makes no further call", async () => {
    // An engine that cannot answer is a fault, not an event in the world:
    // the actions keep the state they had rather than being marked failed.
    script(accept("endings", BASE_ANSWERS.endings));
    generateToolCalls.mockRejectedValueOnce(new Error("provider down"));

    const result = await resolveTick(
      makeContext({ kind: "settlement" }),
      makeDeps()
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toContain("model error in phase characterChanges");
    expect(generateToolCalls).toHaveBeenCalledTimes(2);
  });

  it("damage rolls made in endings survive a later phase's correction, on success and on failure", async () => {
    // The roll is executed by the registry and attributed to its action.
    script(
      roll("dmg", { actionId: LIVE, formula: "1d4" }),
      ...retrying(
        "itemChanges",
        { ...SETTLES_LIVE, itemChanges: A_BAD_ITEM_OP },
        accept("itemChanges", A_GOOD_ITEM_OP)
      )
    );
    const ok = await resolveTick(
      makeContext({ kind: "settlement", ending: true }),
      makeDeps()
    );
    expect(ok.ok).toBe(true);
    expect(ok.codeToolInvocations).toHaveLength(1);
    expect(ok.codeToolInvocations[0]).toMatchObject({
      toolName: "damageRoll",
      actionId: LIVE,
      output: { ok: true, total: 5 },
    });
    // The second endings request carried the roll back to the model.
    expect(lastToolResults(requests()[1])[0].content).toContain("total");

    generateToolCalls.mockReset();
    script(
      roll("dmg", { actionId: LIVE, formula: "1d4" }),
      ...retrying(
        "itemChanges",
        { ...SETTLES_LIVE, itemChanges: A_BAD_ITEM_OP },
        accept("itemChanges", A_BAD_ITEM_OP),
        accept("itemChanges", A_BAD_ITEM_OP)
      )
    );
    const failed = await resolveTick(
      makeContext({ kind: "settlement", ending: true }),
      makeDeps()
    );
    expect(failed.ok).toBe(false);
    expect(failed.codeToolInvocations).toHaveLength(1);
    expect(failed.codeToolInvocations[0]).toMatchObject({
      toolName: "damageRoll",
    });
  });

  describe("structural refusals — each its own answer, each one attempt", () => {
    // Shown on the start judgement's one phase, which is where a refusal has
    // nowhere to hide: the session is that phase.
    const good = phaseCall("starts", BASE_ANSWERS.starts);
    const faults: Array<[string, () => ReturnType<typeof turn>, string]> = [
      // `{}` is legal JSON, so it used to reach the validator and come back
      // as "you did not answer any of these actions" — a correction for a
      // mistake the model had not made. The empty call gets its own answer.
      ["empty", () => turn([phaseCall("starts", {})]), "NO arguments"],
      [
        "unreadable",
        () =>
          turn([
            { ...phaseCall("starts", {}), unreadableArgs: { rawLength: 512 } },
          ]),
        "512 characters) did not arrive as readable JSON",
      ],
      [
        "duplicate",
        () =>
          turn([
            phaseCall("starts", BASE_ANSWERS.starts, "a"),
            phaseCall("starts", BASE_ANSWERS.starts, "b"),
          ]),
        "more than once in one turn",
      ],
      [
        "mixed",
        () =>
          turn([
            good,
            { id: "x", name: "submit_item_changes", args: { itemChanges: [] } },
          ]),
        "arrived in the same turn as `submit_item_changes`",
      ],
    ];

    it.each(faults)(
      "%s is refused with its own text and counts against the three attempts",
      async (_kind, fault, text) => {
        script(fault(), fault(), fault());
        generateToolCalls.mockResolvedValue(
          accept("starts", BASE_ANSWERS.starts)
        );

        const result = await resolveTick(makeContext(), makeDeps());

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure).toContain(
          `phase starts still invalid after ${MAX_PHASE_ATTEMPTS} attempts`
        );
        expect(phasesRequested()).toEqual(["starts", "starts", "starts"]);
        // Every call of the refused turn is answered — an unanswered
        // tool_use is a 400 on the very next request — and the phase call's
        // answer names the fault.
        const answered = lastToolResults(requests()[1]);
        const refused = fault().toolCalls;
        expect(answered.map((r) => r.toolCallId)).toEqual(
          refused.map((c) => c.id)
        );
        const phaseAnswer = answered.find(
          (r) => r.toolCallId === refused[0].id
        );
        expect(phaseAnswer?.content).toContain(text);
      }
    );

    it("answers the companion of a mixed turn as the wrong tool", async () => {
      script(
        turn([
          good,
          { id: "x", name: "submit_item_changes", args: { itemChanges: [] } },
        ]),
        ...startPath()
      );

      const result = await resolveTick(makeContext(), makeDeps());

      expect(result.ok).toBe(true);
      const companion = lastToolResults(requests()[1]).find(
        (r) => r.toolCallId === "x"
      );
      expect(companion?.content).toContain(
        "`submit_item_changes` was NOT accepted and did nothing"
      );
      expect(companion?.content).toContain("`submit_starts` is the only tool");
    });

    it("executes the dice of a mixed endings turn and refuses the submission beside them", async () => {
      // An outcome written in the same turn as the roll it depends on was
      // written before the roll came back: the roll is answered, the
      // submission is not taken.
      script(
        turn([
          { id: "d", name: "damageRoll", args: { formula: "1d6" } },
          phaseCall("endings", BASE_ANSWERS.endings, "e"),
        ]),
        ...settlementPath()
      );

      const result = await resolveTick(
        makeContext({ kind: "settlement" }),
        makeDeps()
      );

      expect(result.ok).toBe(true);
      expect(result.codeToolInvocations).toHaveLength(1);
      const answered = lastToolResults(requests()[1]);
      expect(answered.find((r) => r.toolCallId === "d")?.content).toContain(
        "total"
      );
      const submission = answered.find((r) => r.toolCallId === "e")?.content;
      expect(submission).toContain("arrived in the same turn as `damageRoll`");
      expect(submission).toContain("before the roll came back");
      expect(submission).toContain("call `submit_endings` alone");
    });

    it("a wrong phase's tool is refused and counts as an attempt", async () => {
      // `submit_endings` belongs to the other session entirely: reaching for
      // it from the start judgement is refused like any other wrong tool.
      script(
        turn([{ id: "w", name: "submit_endings", args: { endings: [] } }]),
        ...startPath()
      );

      const result = await resolveTick(makeContext(), makeDeps());

      expect(result.ok).toBe(true);
      expect(phasesRequested()).toEqual(["starts", "starts"]);
      const answer = lastToolResults(requests()[1])[0].content;
      expect(answer).toContain("`submit_endings` was NOT accepted");
      expect(answer).toContain("Call `submit_starts` now");
    });

    it("a dice turn in the endings phase is not an attempt", async () => {
      // Three rolls, then the submission — and the phase still has its three
      // tries. Only the call budget bounds dice turns.
      script(roll("a"), roll("b"), roll("c"), ...settlementPath());

      const result = await resolveTick(
        makeContext({ kind: "settlement" }),
        makeDeps()
      );

      expect(result.ok).toBe(true);
      expect(phasesRequested().filter((p) => p === "endings")).toHaveLength(4);
    });
  });

  it("offers each phase exactly its own tool, forced, and a system prompt naming only that tool", async () => {
    // Each session is checked on its own: the phase count and the session's
    // name in the heading are what a phase knows about where it is.
    const checkSession = (
      phases: readonly ResolutionPhase[],
      session: string
    ) => {
      const all = requests();
      expect(all).toHaveLength(phases.length);
      phases.forEach((phase, i) => {
        const req = all[i];
        const own = PHASE_TOOL_NAMES[phase];
        // The dice ride along in endings only, and only there is the choice
        // left open — everywhere else the phase tool is the structured output.
        if (phase === "endings") {
          expect(req.tools.map((t) => t.name)).toEqual([own, "damageRoll"]);
          expect(req.toolChoice).toBe("any");
          expect(req.allowParallelCalls).toBe(true);
        } else {
          expect(req.tools.map((t) => t.name)).toEqual([own]);
          expect(req.toolChoice).toEqual({ name: own });
          expect(req.allowParallelCalls).toBe(false);
        }
        expect(req.tools[0].strict).toBe(true);
        expect(req.operation).toBe(`world-action-engine:${phase}`);
        expect(req.cacheSystemPrompt).toBe(true);

        const prompt = req.customSystemPrompt ?? "";
        expect(prompt).toContain(`\`${own}\``);
        for (const other of RESOLUTION_PHASES.filter((p) => p !== phase)) {
          expect(prompt).not.toContain(PHASE_TOOL_NAMES[other]);
        }
        // The budget is a code constant and a prompt sentence at once; the
        // document names it with placeholders so the two cannot drift.
        expect(prompt).not.toContain("{{");
        expect(prompt).toContain(`budget of ${MAX_PROVIDER_CALLS} model calls`);
        expect(prompt).toContain(
          `at most ${MAX_PHASE_ATTEMPTS} submission attempts`
        );
        // damageRoll is named only where it is offered.
        expect(prompt.includes("damageRoll")).toBe(phase === "endings");

        // The opening turn: the two cached context blocks, then the phase's
        // own instruction.
        const first = req.messages[0];
        expect(first.role).toBe("user");
        if (first.role !== "user") return;
        expect(first.content).toHaveLength(3);
        expect(first.content[0]).toMatchObject({
          kind: "text",
          cacheControl: true,
        });
        expect(first.content[1]).toMatchObject({
          kind: "text",
          cacheControl: true,
        });
        expect(first.content[2]).not.toHaveProperty("cacheControl");
        expect(instructionOf(req)).toContain(
          `# Phase ${i + 1} of ${phases.length} of the ${session}`
        );
        expect(instructionOf(req)).toContain(`Call \`${own}\` now`);
      });
    };

    script(...settlementPath());
    await resolveTick(makeContext({ kind: "settlement" }), makeDeps());
    checkSession(SESSION_PHASES.settlement, "SETTLEMENT");

    generateToolCalls.mockClear();
    script(...startPath());
    await resolveTick(makeContext(), makeDeps());
    checkSession(SESSION_PHASES.start, "START JUDGEMENT");
  });

  // ==================== The strict-schema fallback ====================
  //
  // A strict tool is compiled into a grammar before a single token is
  // generated, and the compiler can refuse the request outright. That refusal
  // is deterministic — the same schema, the same model, the same 400 next
  // tick — so it is the ONE error the runner answers by changing the request
  // rather than by giving up the tick: once, unstrict, and remembered for the
  // process. Nothing else downgrades anything.
  describe("strict-schema fallback", () => {
    const GRAMMAR_REFUSAL =
      "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools.";
    /** As the policy layer delivers it: three retries, then the last message
     *  inside `runWithPolicy`'s own envelope. */
    const grammarError = () =>
      new Error(
        `Failed to generate after 3 attempts with anthropic: 400 invalid_request_error — ${GRAMMAR_REFUSAL}`
      );

    const fingerprintOf = (phase: ResolutionPhase) => {
      const { provider, model } = engineModelIdentity();
      return schemaFingerprint(provider, model, PHASE_TOOLS[phase]);
    };

    const SCENE = PHASE_TOOL_NAMES.sceneChanges;
    const A_BAD_SCENE_OP = {
      sceneChanges: [
        {
          sourceActionId: LIVE,
          sceneId: "SCN_1",
          operation: { kind: "levitate" },
        },
      ],
    };

    /** One settlement, with the ending it has to answer. */
    const settling = () => makeContext({ kind: "settlement", ending: true });
    /** The three phases before the scene phase, all accepted first try. */
    const beforeScene = () =>
      script(...settlementPath(SETTLES_LIVE).slice(0, 3));
    const fromScene = () => script(...settlementPath(SETTLES_LIVE).slice(3));

    let warned: string[] = [];
    let warnSpy: { mockRestore: () => void };
    beforeEach(() => {
      warned = [];
      warnSpy = vi.spyOn(console, "warn").mockImplementation((...args) => {
        warned.push(args.map((a) => String(a)).join(" "));
      });
    });
    afterEach(() => warnSpy.mockRestore());

    it("offers every phase its strict tool while nothing has been refused", async () => {
      script(...settlementPath(SETTLES_LIVE));

      const result = await resolveTick(settling(), makeDeps());

      expect(result.ok).toBe(true);
      expect(requests()).toHaveLength(5);
      for (const req of requests()) expect(req.tools[0].strict).toBe(true);
      expect(warned).toEqual([]);
    });

    it("retries the refused phase once without strict, and says so", async () => {
      beforeScene();
      generateToolCalls.mockRejectedValueOnce(grammarError());
      fromScene();

      const result = await resolveTick(settling(), makeDeps());

      expect(result.ok).toBe(true);
      expect(generateToolCalls).toHaveBeenCalledTimes(6);
      expect(phasesRequested()).toEqual([
        "endings",
        "characterChanges",
        "itemChanges",
        "sceneChanges",
        "sceneChanges",
        "occurrences",
      ]);
      const refused = requests()[3];
      const retried = requests()[4];
      expect(refused.tools[0]).toMatchObject({ name: SCENE, strict: true });
      expect(retried.tools[0]).toMatchObject({ name: SCENE, strict: false });
      // The same question, asked again: the refusal happened before the model
      // saw anything, so there is nothing to tell it about — the retry is the
      // opening turn, not a correction.
      expect(retried.messages).toHaveLength(1);
      expect(instructionOf(retried)).toBe(instructionOf(refused));
      expect(retried.toolChoice).toEqual({ name: SCENE });
      // The warning names the tool, the vendor, the fingerprint and quotes
      // what the provider actually said.
      const warning = warned.join("\n");
      expect(warning).toContain(`strict schema for ${SCENE} rejected by`);
      expect(warning).toContain(fingerprintOf("sceneChanges").slice(0, 8));
      expect(warning).toContain(GRAMMAR_REFUSAL);
      expect(warning).toContain("retrying this phase once without strict");
      expect(isStrictDowngraded(fingerprintOf("sceneChanges"))).toBe(true);
    });

    it("remembers the downgrade: the next tick opens that phase unstrict", async () => {
      beforeScene();
      generateToolCalls.mockRejectedValueOnce(grammarError());
      fromScene();
      expect((await resolveTick(settling(), makeDeps())).ok).toBe(true);

      // A second tick in the same process. Nothing is refused this time,
      // because nothing strict is offered for that phase any more.
      generateToolCalls.mockClear();
      warned = [];
      script(...settlementPath(SETTLES_LIVE));
      const second = await resolveTick(settling(), makeDeps());

      expect(second.ok).toBe(true);
      expect(generateToolCalls).toHaveBeenCalledTimes(5);
      expect(phasesRequested()).toEqual([...SESSION_PHASES.settlement]);
      // Only that phase: the schemas nobody refused are still strict.
      requests().forEach((req, i) => {
        expect(req.tools[0].strict).toBe(i !== 3);
      });
      // Quiet: the refusal was warned about in the tick that met it.
      expect(warned).toEqual([]);
    });

    it("validates a non-strict answer exactly as it validates a strict one", async () => {
      // What the fallback gives up is structure enforcement, never a check on
      // what the answer says.
      beforeScene();
      generateToolCalls.mockRejectedValueOnce(grammarError());
      script(
        accept("sceneChanges", A_BAD_SCENE_OP),
        accept("sceneChanges", BASE_ANSWERS.sceneChanges),
        accept("occurrences", LIVE_TRACE)
      );

      const result = await resolveTick(settling(), makeDeps());

      expect(result.ok).toBe(true);
      expect(generateToolCalls).toHaveBeenCalledTimes(7);
      const correction = requests()[5];
      const rejection = lastToolResults(correction)[0].content;
      expect(rejection).toContain("sceneChange:0");
      expect(rejection).toContain('unknown scene operation kind "levitate"');
      expect(rejection).toContain("COMPLETE `sceneChanges` array");
      // Still the downgraded tool: the correction is the same phase.
      expect(correction.tools[0]).toMatchObject({ name: SCENE, strict: false });
    });

    it("does not downgrade on an error that says nothing about the schema", async () => {
      beforeScene();
      generateToolCalls.mockRejectedValueOnce(
        new Error(
          "Failed to generate after 3 attempts with anthropic: 429 rate_limit_error: number of requests has exceeded your rate limit"
        )
      );
      // Were a retry made, this would answer it and the tick would go on.
      generateToolCalls.mockResolvedValue(
        accept("sceneChanges", BASE_ANSWERS.sceneChanges)
      );

      const result = await resolveTick(settling(), makeDeps());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure).toContain("model error in phase sceneChanges");
      expect(generateToolCalls).toHaveBeenCalledTimes(4);
      expect(isStrictDowngraded(fingerprintOf("sceneChanges"))).toBe(false);
      expect(warned.join("\n")).not.toContain("without strict");
    });

    it("makes no retry when the refusal arrives on the last call of the budget", async () => {
      // Eleven dice turns spend the budget down to one call; the twelfth is
      // the endings submission, and its grammar is refused. The retry is a
      // provider call like any other, and there is none left.
      script(...Array.from({ length: 11 }, (_, i) => roll(`r${i}`)));
      generateToolCalls.mockRejectedValueOnce(grammarError());
      // Were a retry made, this would answer it.
      generateToolCalls.mockResolvedValue(
        accept("endings", BASE_ANSWERS.endings)
      );

      const result = await resolveTick(settling(), makeDeps());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(generateToolCalls).toHaveBeenCalledTimes(MAX_PROVIDER_CALLS);
      expect(result.failure).toContain("model error in phase endings");
      // The refusal is still learned — the next tick will not pay for it.
      expect(isStrictDowngraded(fingerprintOf("endings"))).toBe(true);
      // And every roll that was made is still in the record.
      expect(result.codeToolInvocations).toHaveLength(11);
    });
  });
});

describe("renderContext addressing", () => {
  // A prompt that shows both `commandId` and `action_<commandId>` gives the
  // model two ids for one action; it echoed the commandId, every entry failed
  // lookup as "unknown actionId", and all three correction rounds re-sent the same
  // mismatch. The prompt now carries only the id the schema addresses.
  it("prints the actionId and never the raw commandId", () => {
    const context = makeContext();
    context.actions.activeActions = [
      {
        id: "action_c0",
        status: "active",
        command: { ...cmd, commandId: "c0" },
        progressMinutes: 2,
        resolvedDurationTicks: 3,
      } as EngineResolutionContext["actions"]["activeActions"][number],
    ];

    const prompt = renderContext(context);

    expect(prompt).toContain('"actionId": "action_c1"');
    expect(prompt).toContain('"actionId": "action_c0"');
    expect(prompt).not.toContain("commandId");
    // The bare ids must not appear as standalone values either — that is the
    // string the model would copy.
    expect(prompt).not.toContain('"c1"');
    expect(prompt).not.toContain('"c0"');
  });

  // Rendered as `checkOutcome`, the roll was echoed back as the ending's
  // `outcome` — the one field a checked ending must not carry — in a third
  // of checked solo endings over a measured 30-tick run. The name now says
  // dice, the verdict bit stays, and the derivable/bookkeeping fields go.
  it("renders the roll as diceRoll with the verdict and without outcome words", () => {
    const context = makeContext();
    context.actions.activeActions = [
      {
        id: "action_c0",
        status: "active",
        command: { ...cmd, commandId: "c0" },
        progressMinutes: 10,
        resolvedDurationTicks: 10,
        check: {
          skillId: "Repair & Engineering",
          requiredLevel: "regular",
        },
        checkOutcome: {
          actor: {
            rollId: "roll-1",
            skillId: "Repair & Engineering",
            skillValue: 65,
            roll: 4,
            successLevel: "extreme",
          },
          requiredLevel: "regular",
          defenders: [
            {
              characterId: "npc_2",
              record: {
                rollId: "roll-2",
                skillId: "Stealth",
                skillValue: 40,
                roll: 60,
                successLevel: "failure",
              },
              actorWon: true,
            },
          ],
          met: true,
          fumble: false,
        },
      } as EngineResolutionContext["actions"]["activeActions"][number],
    ];

    const prompt = renderContext(context);

    expect(prompt).toContain('"diceRoll"');
    expect(prompt).not.toContain("checkOutcome");
    expect(prompt).toContain('"successLevel": "extreme"');
    expect(prompt).toContain('"actorWon": true');
    expect(prompt).toContain('"met": true');
    expect(prompt).not.toContain('"fumble"');
    expect(prompt).not.toContain("rollId");
  });
});

describe("renderContextSegments caching layout", () => {
  // `## Tick` is 114 characters and used to sit at offset 360 of a 116k
  // prompt, so the measured cross-tick common prefix was 0.3% — the whole
  // world description was re-sent at full price every minute. Stability, not
  // topic, decides the order now.
  it("keeps the world in the stable half and the minute in the volatile half", () => {
    const { stable, volatile } = renderContextSegments(makeContext());

    expect(stable).toContain("## World Graph");
    expect(stable).toContain("## World Invariants");
    // The skeleton renders as a compact adjacency list, not JSON.
    expect(stable).toContain("- J_A (Crossing)");
    expect(stable).not.toContain('"places"');

    // Detailed places, items and blocked state depend on this tick, so they
    // live in the volatile half — blocking an edge must not invalidate the
    // cached stable prefix.
    for (const section of [
      "## Tick",
      "## Trigger",
      "## Blocked Connections",
      "## Detailed Places",
      "## Items",
      "## Characters",
      "## New Commands",
      "## Active Actions",
    ]) {
      expect(stable).not.toContain(section);
      expect(volatile).toContain(section);
    }
  });

  it("concatenates back to the single-string form", () => {
    const context = makeContext();
    const { stable, volatile } = renderContextSegments(context);
    expect(stable + volatile).toBe(renderContext(context));
    expect(stable + volatile).not.toContain("\n\n\n");
  });
});

describe("renderWorldGraph", () => {
  it("renders each node as description + connection references", () => {
    const text = renderWorldGraph({
      places: [
        {
          id: "J_A",
          kind: "scene",
          name: "Crossing",
          description: "A windswept\ncrossing.",
        },
        {
          id: "R_MAIN",
          kind: "road",
          name: "Star Avenue",
        },
      ],
      edges: [
        {
          connectionId: "connection.home.secret",
          from: "J_A",
          to: "R_MAIN",
          concealed: true,
        },
        {
          connectionId: "connection.road.a",
          from: "R_MAIN",
          to: "J_A",
          travelTimeMinutes: 15,
        },
      ],
    });
    expect(text.split("\n")).toEqual([
      "Outdoor node scenes:",
      // Authored prose rides along, newlines flattened.
      "- J_A (Crossing): A windswept crossing.",
      "  connections: [connection.home.secret] -> R_MAIN (concealed)",
      "Roads:",
      // No description and no prose — the node line stands alone.
      "- R_MAIN (Star Avenue)",
      "  connections: [connection.road.a] -> J_A 15min",
    ]);
  });
});
