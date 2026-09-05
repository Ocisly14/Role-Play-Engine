// The staged runner: six phases in a fixed order, each its own request
// offering only its own submission tool, each answer validated on arrival and
// kept only when accepted; addressed phase-local corrections that rerun ONE
// phase; a shared budget of provider calls; one global gate over the assembled
// draft, and one rewind to the phase that owns a global fault; and — when a
// phase cannot converge, the budget runs out, or the model fails — a result
// that applies nothing at all.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  schemaFingerprint,
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

function makeContext(
  opts: {
    ending?: boolean;
    talk?: boolean;
    blocked?: boolean;
    second?: boolean;
  } = {}
): EngineResolutionContext {
  const activeActions = [
    ...(opts.ending ? [activeAction()] : []),
    ...(opts.talk ? [talkingAction()] : []),
  ];
  const newCommands = [cmd, ...(opts.second ? [cmd2] : [])];
  const actionIds = [
    ...newCommands.map((c) => `action_${c.commandId}`),
    ...activeActions.map((a) => a.id),
  ];
  return {
    trigger: {
      triggers: [{ actionIds, reason: "new_action" }],
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

/** Six first-try acceptances, with any phase's answer overridden. */
function happyPath(overrides: Partial<Record<ResolutionPhase, object>> = {}) {
  return RESOLUTION_PHASES.map((phase) =>
    accept(phase, overrides[phase] ?? BASE_ANSWERS[phase])
  );
}

/** The happy path with further attempts spliced in right after `phase`'s
 *  first turn. The runner asks the SAME phase again before it moves on, so a
 *  retry appended after the six acceptances would be read as the answer to a
 *  later phase's request — a wrong-tool turn, not the correction. */
function retrying(
  phase: ResolutionPhase,
  overrides: Partial<Record<ResolutionPhase, object>>,
  ...retries: ReturnType<typeof turn>[]
) {
  const path = happyPath(overrides);
  const i = RESOLUTION_PHASES.indexOf(phase);
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

const A_BAD_ITEM_OP = {
  itemChanges: [
    {
      sourceActionId: "action_c1",
      itemId: "lamp_1",
      operation: { kind: "teleport" },
    },
  ],
};
const A_GOOD_ITEM_OP = {
  itemChanges: [
    {
      sourceActionId: "action_c1",
      itemId: "lamp_1",
      operation: { kind: "move", from: "scene:SCN_1", to: "npc_1" },
    },
  ],
};

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
            hidden: true,
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

  it("runs the six phases in order, one call each, and assembles the same resolution the single submission did", async () => {
    script(...happyPath());

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolution.transitions).toEqual([
      expect.objectContaining({ actionId: "action_c1", to: "active" }),
    ]);
    // Travel time is the movement runtime's: nothing is clocked here.
    expect(result.resolution.transitions[0].resolvedDurationTicks).toBe(
      undefined
    );
    expect(result.movementInits.action_c1).toEqual({ route: ["SCN_FAR"] });
    expect(result.checkInits).toEqual({});
    expect(result.codeToolInvocations).toEqual([]);
    expect(generateToolCalls).toHaveBeenCalledTimes(6);
    expect(phasesRequested()).toEqual([...RESOLUTION_PHASES]);
    // Each phase is its own conversation: no request carries another
    // phase's turns.
    for (const req of requests()) expect(req.messages).toHaveLength(1);
    // The global gate ran exactly once, over the assembled draft.
    expect(gate).toHaveBeenCalledTimes(1);
  });

  it("accepts `[]` for every domain that has nothing to say", async () => {
    // A tick with one starting action: every phase but starts is empty, and
    // an accepted empty array is a fact the later phases are shown.
    script(...happyPath());

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolution.occurrences).toEqual([]);
    expect(result.resolution.characterChanges).toEqual([]);
    expect(result.resolution.itemChanges).toEqual([]);
    expect(result.resolution.sceneChanges).toEqual([]);
    const last = instructionOf(requests()[5]);
    expect(last).toContain("### `endings` — accepted in phase 1\n[]");
    expect(last).toContain("### `itemChanges` — accepted in phase 4\n[]");
  });

  it("pure speech: a pure_speech decision plus its speech row ends the action with no ending row", async () => {
    script(
      ...happyPath({
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

    const result = await resolveTick(makeContext({ talk: true }), makeDeps());

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
      ...happyPath({ endings: outcome, occurrences: { occurrences: [] } }),
      accept("occurrences", trace)
    );

    const context = makeContext({ ending: true });
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
    expect(phasesRequested()).toEqual([...RESOLUTION_PHASES, "occurrences"]);
    const rejection = lastToolResults(requests()[6])[0].content;
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
      starting: [{ actionId: "action_c1", movement: { route: ["SCN_FAR"] } }],
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
        { itemChanges: A_BAD_ITEM_OP },
        accept("itemChanges", A_GOOD_ITEM_OP)
      )
    );

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.ok).toBe(true);
    expect(phasesRequested()).toEqual([
      "endings",
      "starts",
      "characterChanges",
      "itemChanges",
      "itemChanges",
      "sceneChanges",
      "occurrences",
    ]);
    // The second item request continues the item conversation: the opening
    // turn, the rejected call, and its addressed rejection.
    const retry = requests()[4];
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
    expect(instructionOf(requests()[5])).not.toContain("teleport");
  });

  it("shows each phase the accepted upstream draft, verbatim and read-only", async () => {
    script(...happyPath({ itemChanges: A_GOOD_ITEM_OP }));

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.ok).toBe(true);
    const scene = instructionOf(requests()[4]);
    expect(scene).toContain("### `itemChanges` — accepted in phase 4");
    expect(scene).toContain('"kind": "move"');
    expect(scene).toContain('"to": "npc_1"');
    expect(scene).not.toContain("### `sceneChanges`");
    const occurrences = instructionOf(requests()[5]);
    for (const heading of [
      "### `endings` — accepted in phase 1",
      "### `starting` — accepted in phase 2",
      "### `characterChanges` — accepted in phase 3",
      "### `itemChanges` — accepted in phase 4",
      "### `sceneChanges` — accepted in phase 5",
    ]) {
      expect(occurrences).toContain(heading);
    }
    expect(occurrences).toContain("read-only");
    // And the first phase is told it stands alone.
    expect(instructionOf(requests()[0])).toContain(
      "Nothing precedes this phase"
    );
  });

  it("pass versus unblock: a grant on an accepted start refuses an unblock of the same passage in the scene phase", async () => {
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
    const unblock = {
      sceneChanges: [
        {
          sourceActionId: "action_c1",
          sceneId: "SCN_1",
          operation: {
            kind: "connectionBlock",
            connectionId: "connection.scn1.far",
            blocked: false,
            reason: "the beam is lifted aside",
          },
        },
      ],
    };
    script(
      ...retrying(
        "sceneChanges",
        { starts: granted, sceneChanges: unblock },
        accept("sceneChanges", { sceneChanges: [] })
      )
    );

    const result = await resolveTick(
      makeContext({ blocked: true }),
      makeDeps()
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The grant stands: one walker gets through, the passage stays shut.
    expect(result.movementInits.action_c1).toEqual({
      route: ["SCN_FAR"],
      passBlockedConnectionId: "connection.scn1.far",
    });
    expect(result.resolution.sceneChanges).toEqual([]);
    expect(phasesRequested()).toEqual([
      "endings",
      "starts",
      "characterChanges",
      "itemChanges",
      "sceneChanges",
      "sceneChanges",
      "occurrences",
    ]);
    const rejection = lastToolResults(requests()[5])[0].content;
    expect(rejection).toContain("sceneChange:0");
    expect(rejection).toContain("never both for one passage");
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
      ...happyPath({ itemChanges: A_GOOD_ITEM_OP }),
      accept("itemChanges", A_GOOD_ITEM_OP),
      accept("sceneChanges", BASE_ANSWERS.sceneChanges),
      accept("occurrences", BASE_ANSWERS.occurrences)
    );

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.ok).toBe(true);
    expect(phasesRequested()).toEqual([
      ...RESOLUTION_PHASES,
      "itemChanges",
      "sceneChanges",
      "occurrences",
    ]);
    expect(generateToolCalls).toHaveBeenCalledTimes(9);
    expect(gate).toHaveBeenCalledTimes(2);
    // The rewound phase gets the verdict, once, in its opening instruction —
    // and still sees the earlier phases, which were kept.
    const redo = instructionOf(requests()[6]);
    expect(redo).toContain("## Why this phase is being redone");
    expect(redo).toContain("itemChange:0 — the prose of SCN_1 still cites");
    expect(redo).toContain("### `characterChanges` — accepted in phase 3");
    expect(redo).not.toContain("### `sceneChanges`");
    // The phases behind it are rerun because the draft changed, and told
    // nothing about a fault that was not theirs.
    expect(instructionOf(requests()[7])).not.toContain("being redone");
    expect(instructionOf(requests()[8])).not.toContain("being redone");
  });

  it("a second global failure rejects the tick atomically, naming the rewind", async () => {
    const errors: ResolutionError[] = [
      {
        target: { kind: "occurrence", actionIds: ["action_c1"] },
        message: "x",
      },
    ];
    gate.mockImplementation(() => errors);
    script(...happyPath(), accept("occurrences", BASE_ANSWERS.occurrences));

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toContain("still invalid after 1 global rewind(s)");
    expect(result.failure).toContain("nothing applied");
    expect(result.errors).toEqual(errors);
    expect(phasesRequested()).toEqual([...RESOLUTION_PHASES, "occurrences"]);
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
      expect(phasesRequested()).toEqual([
        "endings",
        "starts",
        "starts",
        "characterChanges",
        "itemChanges",
        "sceneChanges",
        "occurrences",
      ]);
      const rejection = lastToolResults(requests()[2])[0].content;
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
        makeContext({ ending: true, talk: true }),
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
      expect(generateToolCalls).toHaveBeenCalledTimes(8);
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
        makeContext({ ending: true, talk: true }),
        makeDeps()
      );
      expect(result.ok).toBe(true);
      const rejection = lastToolResults(requests()[7])[0].content;
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

      const result = await resolveTick(makeContext({ talk: true }), makeDeps());

      expect(result.ok).toBe(true);
      const instruction = instructionOf(requests()[5]);
      expect(instruction).toContain(
        "## Required occurrence coverage (1 obligations)"
      );
      expect(instruction).toContain("An empty array is invalid.");
      expect(instruction).not.toContain("Nothing perceptible happened is `[]`");
      const rejection = lastToolResults(requests()[6])[0].content;
      expect(rejection).toContain("## Kept by code (0 rows)");
      expect(rejection).toContain(`"actionId": "${TALK}",\n  "speech": true`);
    });
  });

  it("per-phase cap: three rejected item submissions end the tick; a fourth is never requested", async () => {
    script(
      ...retrying(
        "itemChanges",
        { itemChanges: A_BAD_ITEM_OP },
        accept("itemChanges", A_BAD_ITEM_OP),
        accept("itemChanges", A_BAD_ITEM_OP)
      )
    );
    // Were a fourth request made, it would succeed — and the assertion below
    // would see an accepted tick.
    generateToolCalls.mockResolvedValue(accept("itemChanges", A_GOOD_ITEM_OP));

    const result = await resolveTick(makeContext(), makeDeps());

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
      "starts",
      "characterChanges",
      "itemChanges",
      "itemChanges",
      "itemChanges",
    ]);
    expect(gate).not.toHaveBeenCalled();
  });

  it("shared cap: dice turns count, and the thirteenth call is never made", async () => {
    // Seven dice turns and five accepted phases spend the twelve; the
    // occurrence phase cannot open, and the tick applies nothing.
    script(
      ...Array.from({ length: 7 }, (_, i) => roll(`r${i}`)),
      ...happyPath().slice(0, 5)
    );
    generateToolCalls.mockResolvedValue(
      accept("occurrences", BASE_ANSWERS.occurrences)
    );

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(generateToolCalls).toHaveBeenCalledTimes(MAX_PROVIDER_CALLS);
    expect(result.failure).toContain(
      `call budget of ${MAX_PROVIDER_CALLS} exhausted in phase occurrences`
    );
    // Every roll that was made is still in the record.
    expect(result.codeToolInvocations).toHaveLength(7);
    expect(gate).not.toHaveBeenCalled();
  });

  it("a model error mid-phase applies nothing and makes no further call", async () => {
    // An engine that cannot answer is a fault, not an event in the world:
    // the actions keep the state they had rather than being marked failed.
    script(accept("endings", BASE_ANSWERS.endings));
    generateToolCalls.mockRejectedValueOnce(new Error("provider down"));

    const result = await resolveTick(makeContext(), makeDeps());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure).toContain("model error in phase starts");
    expect(generateToolCalls).toHaveBeenCalledTimes(2);
  });

  it("damage rolls made in endings survive a later phase's correction, on success and on failure", async () => {
    // The roll is executed by the registry and attributed to its action.
    script(
      roll("dmg", { actionId: "action_c1", formula: "1d4" }),
      ...retrying(
        "itemChanges",
        { itemChanges: A_BAD_ITEM_OP },
        accept("itemChanges", A_GOOD_ITEM_OP)
      )
    );
    const ok = await resolveTick(makeContext(), makeDeps());
    expect(ok.ok).toBe(true);
    expect(ok.codeToolInvocations).toHaveLength(1);
    expect(ok.codeToolInvocations[0]).toMatchObject({
      toolName: "damageRoll",
      actionId: "action_c1",
      output: { ok: true, total: 5 },
    });
    // The second endings request carried the roll back to the model.
    expect(lastToolResults(requests()[1])[0].content).toContain("total");

    generateToolCalls.mockReset();
    script(
      roll("dmg", { actionId: "action_c1", formula: "1d4" }),
      ...retrying(
        "itemChanges",
        { itemChanges: A_BAD_ITEM_OP },
        accept("itemChanges", A_BAD_ITEM_OP),
        accept("itemChanges", A_BAD_ITEM_OP)
      )
    );
    const failed = await resolveTick(makeContext(), makeDeps());
    expect(failed.ok).toBe(false);
    expect(failed.codeToolInvocations).toHaveLength(1);
    expect(failed.codeToolInvocations[0]).toMatchObject({
      toolName: "damageRoll",
    });
  });

  describe("structural refusals — each its own answer, each one attempt", () => {
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
        script(
          accept("endings", BASE_ANSWERS.endings),
          fault(),
          fault(),
          fault()
        );
        generateToolCalls.mockResolvedValue(
          accept("starts", BASE_ANSWERS.starts)
        );

        const result = await resolveTick(makeContext(), makeDeps());

        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.failure).toContain(
          `phase starts still invalid after ${MAX_PHASE_ATTEMPTS} attempts`
        );
        expect(phasesRequested()).toEqual([
          "endings",
          "starts",
          "starts",
          "starts",
        ]);
        // Every call of the refused turn is answered — an unanswered
        // tool_use is a 400 on the very next request — and the phase call's
        // answer names the fault.
        const answered = lastToolResults(requests()[2]);
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
        accept("endings", BASE_ANSWERS.endings),
        turn([
          good,
          { id: "x", name: "submit_item_changes", args: { itemChanges: [] } },
        ]),
        ...happyPath().slice(1)
      );

      const result = await resolveTick(makeContext(), makeDeps());

      expect(result.ok).toBe(true);
      const companion = lastToolResults(requests()[2]).find(
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
        ...happyPath()
      );

      const result = await resolveTick(makeContext(), makeDeps());

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
      script(
        accept("endings", BASE_ANSWERS.endings),
        turn([{ id: "w", name: "submit_endings", args: { endings: [] } }]),
        ...happyPath().slice(1)
      );

      const result = await resolveTick(makeContext(), makeDeps());

      expect(result.ok).toBe(true);
      expect(phasesRequested()).toEqual([
        "endings",
        "starts",
        "starts",
        ...RESOLUTION_PHASES.slice(2),
      ]);
      const answer = lastToolResults(requests()[2])[0].content;
      expect(answer).toContain("`submit_endings` was NOT accepted");
      expect(answer).toContain("Call `submit_starts` now");
    });

    it("a dice turn in the endings phase is not an attempt", async () => {
      // Three rolls, then the submission — and the phase still has its three
      // tries. Only the call budget bounds dice turns.
      script(roll("a"), roll("b"), roll("c"), ...happyPath());

      const result = await resolveTick(makeContext(), makeDeps());

      expect(result.ok).toBe(true);
      expect(phasesRequested().filter((p) => p === "endings")).toHaveLength(4);
    });
  });

  it("offers each phase exactly its own tool, forced, and a system prompt naming only that tool", async () => {
    script(...happyPath());
    await resolveTick(makeContext(), makeDeps());

    const all = requests();
    expect(all).toHaveLength(6);
    RESOLUTION_PHASES.forEach((phase, i) => {
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
      expect(instructionOf(req)).toContain(`# Phase ${i + 1} of 6`);
      expect(instructionOf(req)).toContain(`Call \`${own}\` now`);
    });
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
          sourceActionId: "action_c1",
          sceneId: "SCN_1",
          operation: { kind: "levitate" },
        },
      ],
    };

    /** The four phases before the scene phase, all accepted first try. */
    const beforeScene = () => script(...happyPath().slice(0, 4));
    const fromScene = () => script(...happyPath().slice(4));

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
      script(...happyPath());

      const result = await resolveTick(makeContext(), makeDeps());

      expect(result.ok).toBe(true);
      expect(requests()).toHaveLength(6);
      for (const req of requests()) expect(req.tools[0].strict).toBe(true);
      expect(warned).toEqual([]);
    });

    it("retries the refused phase once without strict, and says so", async () => {
      beforeScene();
      generateToolCalls.mockRejectedValueOnce(grammarError());
      fromScene();

      const result = await resolveTick(makeContext(), makeDeps());

      expect(result.ok).toBe(true);
      expect(generateToolCalls).toHaveBeenCalledTimes(7);
      expect(phasesRequested()).toEqual([
        "endings",
        "starts",
        "characterChanges",
        "itemChanges",
        "sceneChanges",
        "sceneChanges",
        "occurrences",
      ]);
      const refused = requests()[4];
      const retried = requests()[5];
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
      expect((await resolveTick(makeContext(), makeDeps())).ok).toBe(true);

      // A second tick in the same process. Nothing is refused this time,
      // because nothing strict is offered for that phase any more.
      generateToolCalls.mockClear();
      warned = [];
      script(...happyPath());
      const second = await resolveTick(makeContext(), makeDeps());

      expect(second.ok).toBe(true);
      expect(generateToolCalls).toHaveBeenCalledTimes(6);
      expect(phasesRequested()).toEqual([...RESOLUTION_PHASES]);
      // Only that phase: the five schemas nobody refused are still strict.
      requests().forEach((req, i) => {
        expect(req.tools[0].strict).toBe(i !== 4);
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
        accept("occurrences", BASE_ANSWERS.occurrences)
      );

      const result = await resolveTick(makeContext(), makeDeps());

      expect(result.ok).toBe(true);
      expect(generateToolCalls).toHaveBeenCalledTimes(8);
      const correction = requests()[6];
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

      const result = await resolveTick(makeContext(), makeDeps());

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure).toContain("model error in phase sceneChanges");
      expect(generateToolCalls).toHaveBeenCalledTimes(5);
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

      const result = await resolveTick(makeContext(), makeDeps());

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
          hidden: true,
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
      "  connections: [connection.home.secret] -> R_MAIN (hidden)",
      "Roads:",
      // No description and no prose — the node line stands alone.
      "- R_MAIN (Star Avenue)",
      "  connections: [connection.road.a] -> J_A 15min",
    ]);
  });
});
