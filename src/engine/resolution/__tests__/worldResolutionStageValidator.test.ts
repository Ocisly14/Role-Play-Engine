// Staged resolution: each phase judged the moment it submits, the accepted
// draft assembled back into the one shape the final gate reads, and a global
// error mapped to the earliest phase that could have prevented it.
//
// The point of these tests is that the split changed WHEN a fault is caught,
// not WHETHER: the last block re-runs `validateRawResolution` over an
// assembled draft and expects it to catch a cross-domain fault every phase
// accepted on its own.

import { describe, expect, it } from "vitest";
import type { ActionCommand, EngineAction } from "../../actions/types.js";
import {
  type EngineResolutionContext,
  type ResolutionError,
  formatErrorTarget,
} from "../types.js";
import type { RawOccurrence } from "../worldDeltaSchema.js";
import { validateRawResolution } from "../worldDeltaValidator.js";
import type {
  AcceptedResolutionDraft,
  EndingDecision,
} from "../worldResolutionStageSchemas.js";
import {
  acceptedPhaseValue,
  assembleRawResolution,
  phaseIndex,
  rewindPhaseFor,
  validatePhase,
} from "../worldResolutionStageValidator.js";

// ==================== Fixtures ====================

const QUEUED = "action_c1";
const ENDING = "action_live";
const TALKING = "action_talk";

function command(overrides: Partial<ActionCommand> = {}): ActionCommand {
  return {
    commandId: "c1",
    actorId: "npc_1",
    issuedAt: "1923-04-02T09:15:00",
    issuedSceneId: "SCN_1",
    description: "I try the lock.",
    objectRefs: [],
    proposedDurationTicks: 2,
    ...overrides,
  };
}

/** Due this minute: progress has reached the duration code set at start. */
function activeAction(overrides: Partial<EngineAction> = {}): EngineAction {
  return {
    id: ENDING,
    command: command({ commandId: "live", actorId: "npc_2" }),
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
    id: TALKING,
    command: command({
      commandId: "talk",
      actorId: "npc_1",
      description: "I greet him.",
      utterance: "Good morning, Hollins.",
    }),
    progressMinutes: 1,
    resolvedDurationTicks: 1,
  });

function makeContext(
  opts: {
    newCommands?: ActionCommand[];
    activeActions?: EngineAction[];
    triggerActionIds?: string[];
  } = {}
): EngineResolutionContext {
  const newCommands = opts.newCommands ?? [command()];
  const activeActions = opts.activeActions ?? [activeAction(), talkingAction()];
  const triggerIds = opts.triggerActionIds ?? [QUEUED, ENDING, TALKING];
  return {
    trigger: {
      triggers: [{ actionIds: triggerIds, reason: "new_action" }],
      actionIds: triggerIds,
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
      graph: { places: [], edges: [] },
      blockedEdges: [],
      placeKinds: {
        SCN_1: "scene",
        SCN_2: "scene",
        SCN_3: "scene",
        SCN_TRUCK: "scene",
      },
      connectionIds: [
        "connection.scn1.door",
        "connection.scn1.hall",
        "connection.scn2.back",
      ],
      places: [
        {
          id: "SCN_1",
          kind: "scene",
          name: "Study",
          // The prose CITES the lock, which is what makes moving it out of
          // here a stale citation unless the same resolution rewrites this.
          description:
            "A cabinet stands against the far wall, its [lock_1] shut.",
          conditions: [],
          itemIds: ["lock_1"],
          connections: [
            {
              connectionId: "connection.scn1.door",
              targetId: "SCN_2",
              blockedReason: "the door is barred from the other side",
            },
            { connectionId: "connection.scn1.hall", targetId: "SCN_3" },
          ],
          environment: {
            temperature: 20,
            illumination: 3,
            oxygen: 1,
            noise: 0,
            airborneHazards: [],
          },
          presentCharacterIds: ["npc_1", "npc_2"],
        },
      ],
      items: [
        { id: "lock_1", name: "cabinet lock", holder: "scene:SCN_1" },
        { id: "pick_1", name: "lockpicks", holder: "npc_1" },
      ],
      itemHolders: { lock_1: "scene:SCN_1", pick_1: "npc_1" },
      vehicles: [
        {
          id: "VEH_1",
          name: "flatbed truck",
          interiorSceneId: "SCN_TRUCK",
          position: null,
        },
      ],
      characters: [
        {
          id: "npc_1",
          name: "Marsh",
          alive: true,
          attributes: {},
          skills: { "Stealth & Security": 60 },
          hp: 10,
          maxHp: 12,
          san: 40,
          maxSan: 60,
          fatigue: 2,
          maxFatigue: 10,
          position: { type: "scene", sceneId: "SCN_1" },
          locationId: "SCN_1",
          conditions: [],
          inventoryItemIds: ["pick_1"],
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

/** A tick with one queued action and nothing ending — the fixture the
 *  "an empty phase is legal" cases need. */
const nothingEnding = (): EngineResolutionContext =>
  makeContext({ activeActions: [], triggerActionIds: [QUEUED] });

const text = (errors: ResolutionError[]): string =>
  errors.map((e) => `${formatErrorTarget(e.target)} ${e.message}`).join("\n");

/** The decisions a well-formed endings phase produces for the default
 *  fixture, and the upstream fact every later phase reads. */
const ENDING_DECISIONS: EndingDecision[] = [
  { actionId: ENDING, mode: "outcome", outcome: "the latch gives" },
  { actionId: TALKING, mode: "pure_speech" },
];

const occurrence = (over: Partial<RawOccurrence> = {}): RawOccurrence => ({
  actionIds: [ENDING],
  speech: false,
  perceivers: [{ characterId: "npc_1", clarity: "full" }],
  content: "the latch gives",
  ...over,
});

const speechRow = (over: Partial<RawOccurrence> = {}): RawOccurrence => ({
  actionIds: [TALKING],
  speech: true,
  targetIds: ["npc_2"],
  perceivers: [{ characterId: "npc_2", clarity: "full" }],
  ...over,
});

// ==================== Endings ====================

describe("endings phase", () => {
  it("accepts one decision for every id the trigger ends", () => {
    expect(
      validatePhase("endings", { endings: ENDING_DECISIONS }, makeContext(), {})
    ).toEqual([]);
  });

  it("accepts [] when nothing ends this tick", () => {
    expect(
      validatePhase("endings", { endings: [] }, nothingEnding(), {})
    ).toEqual([]);
  });

  it("reports every ending id left without a decision", () => {
    const errors = validatePhase(
      "endings",
      { endings: [ENDING_DECISIONS[0]] },
      makeContext(),
      {}
    );
    expect(text(errors)).toContain(`resolution ending action "${TALKING}"`);
    expect(text(errors)).toContain("has no decision");
  });

  it("refuses a second decision for the same action", () => {
    const errors = validatePhase(
      "endings",
      { endings: [...ENDING_DECISIONS, ENDING_DECISIONS[0]] },
      makeContext(),
      {}
    );
    expect(text(errors)).toContain(`action:${ENDING}`);
    expect(text(errors)).toContain("appears more than once");
  });

  it("refuses an id that only starts this tick", () => {
    // Membership and the wrong-list rule are one answer, shared with the
    // final gate: this action has not begun, so it cannot have ended.
    const errors = validatePhase(
      "endings",
      {
        endings: [
          ...ENDING_DECISIONS,
          { actionId: QUEUED, mode: "outcome", outcome: "the lock gives" },
        ],
      },
      makeContext(),
      {}
    );
    expect(text(errors)).toContain(`action:${QUEUED}`);
    expect(text(errors)).toContain("has not started yet");
  });

  it("refuses an id nothing in this tick addresses", () => {
    const errors = validatePhase(
      "endings",
      {
        endings: [
          ...ENDING_DECISIONS,
          { actionId: "action_ghost", mode: "outcome", outcome: "x" },
        ],
      },
      makeContext(),
      {}
    );
    expect(text(errors)).toContain("unknown actionId");
  });

  it("refuses a mode that is neither outcome nor pure speech", () => {
    const errors = validatePhase(
      "endings",
      {
        endings: [
          { actionId: ENDING, mode: "partial", outcome: "the latch gives" },
          ENDING_DECISIONS[1],
        ],
      },
      makeContext(),
      {}
    );
    expect(text(errors)).toContain('mode must be "outcome" or "pure_speech"');
  });

  it("refuses an outcome decision with nothing in its outcome", () => {
    const errors = validatePhase(
      "endings",
      {
        endings: [
          { actionId: ENDING, mode: "outcome", outcome: "   " },
          ENDING_DECISIONS[1],
        ],
      },
      makeContext(),
      {}
    );
    expect(text(errors)).toContain("an ending requires an outcome");
  });

  it("refuses pure speech for an action whose command carries no words", () => {
    const errors = validatePhase(
      "endings",
      {
        endings: [
          { actionId: ENDING, mode: "pure_speech" },
          ENDING_DECISIONS[1],
        ],
      },
      makeContext(),
      {}
    );
    expect(text(errors)).toContain("carries no utterance");
  });

  it("refuses pure speech for an action that carried a check — the dice answered an attempt", () => {
    // Action before speech: a Social probe declared with a skill got a check
    // at start; whatever it said, what came of the probe is an outcome.
    const probed = talkingAction();
    probed.checkOutcome = {
      actor: {
        rollId: "r1",
        skillId: "Social",
        skillValue: 50,
        roll: 72,
        successLevel: "failure",
      },
      requiredLevel: "regular",
      met: false,
      fumble: false,
    };
    const errors = validatePhase(
      "endings",
      {
        endings: [
          ENDING_DECISIONS[0],
          { actionId: TALKING, mode: "pure_speech" },
        ],
      },
      makeContext({ activeActions: [activeAction(), probed] }),
      {}
    );
    expect(text(errors)).toContain(`action:${TALKING}`);
    expect(text(errors)).toContain("carried a check");
    expect(text(errors)).toContain('Decide it as mode "outcome"');
    // The same action decided as an outcome is fine.
    expect(
      validatePhase(
        "endings",
        {
          endings: [
            ENDING_DECISIONS[0],
            {
              actionId: TALKING,
              mode: "outcome",
              outcome: "he gave nothing away",
            },
          ],
        },
        makeContext({ activeActions: [activeAction(), probed] }),
        {}
      )
    ).toEqual([]);
  });

  it("refuses a pure-speech decision that still carries an outcome", () => {
    const errors = validatePhase(
      "endings",
      {
        endings: [
          ENDING_DECISIONS[0],
          { actionId: TALKING, mode: "pure_speech", outcome: "he nods" },
        ],
      },
      makeContext(),
      {}
    );
    expect(text(errors)).toContain("but this decision carries an outcome");
  });

  it("names a row that is not a decision at all by index", () => {
    const errors = validatePhase(
      "endings",
      { endings: [null, ...ENDING_DECISIONS] },
      makeContext(),
      {}
    );
    expect(text(errors)).toContain("endings[0] is not an entry");
  });
});

// ==================== Starts ====================

describe("starts phase", () => {
  const draft: AcceptedResolutionDraft = { endings: ENDING_DECISIONS };
  const goodStart = { actionId: QUEUED, resolvedDurationTicks: 2 };

  it("accepts the one action that begins this tick", () => {
    expect(
      validatePhase("starts", { starting: [goodStart] }, makeContext(), draft)
    ).toEqual([]);
  });

  it("accepts [] when nothing begins", () => {
    const context = makeContext({
      newCommands: [],
      triggerActionIds: [ENDING, TALKING],
    });
    expect(validatePhase("starts", { starting: [] }, context, draft)).toEqual(
      []
    );
  });

  it("reports a queued action left unanswered", () => {
    const errors = validatePhase(
      "starts",
      { starting: [] },
      makeContext(),
      draft
    );
    expect(text(errors)).toContain(`"${QUEUED}" was not answered`);
  });

  it("refuses the same action twice", () => {
    const errors = validatePhase(
      "starts",
      { starting: [goodStart, goodStart] },
      makeContext(),
      draft
    );
    expect(text(errors)).toContain("appears more than once");
  });

  it("refuses an id the endings phase already decided", () => {
    // The upstream draft is a FACT here, not another guess: the contradiction
    // is named against it rather than left for the final gate.
    const errors = validatePhase(
      "starts",
      {
        starting: [goodStart, { actionId: ENDING, resolvedDurationTicks: 2 }],
      },
      makeContext(),
      draft
    );
    expect(text(errors)).toContain("already answered in the endings phase");
  });

  it("refuses an id that does not begin this tick", () => {
    const errors = validatePhase(
      "starts",
      {
        starting: [goodStart, { actionId: ENDING, resolvedDurationTicks: 2 }],
      },
      makeContext(),
      // No accepted endings: the id is simply not on the starting worklist.
      {}
    );
    expect(text(errors)).toContain("does not start this tick");
  });

  it("still makes every check the final gate makes on a start", () => {
    const errors = validatePhase(
      "starts",
      { starting: [{ actionId: QUEUED }] },
      makeContext(),
      draft
    );
    expect(text(errors)).toContain("needs resolvedDurationTicks");
  });

  it("refuses a check on an actor who declared no skill", () => {
    const errors = validatePhase(
      "starts",
      {
        starting: [{ ...goodStart, check: { requiredLevel: "hard" } }],
      },
      makeContext(),
      draft
    );
    expect(text(errors)).toContain("the actor declared no skill");
  });

  it("names a row that is not an entry by index", () => {
    const errors = validatePhase(
      "starts",
      { starting: ["action_c1"] },
      makeContext(),
      draft
    );
    expect(text(errors)).toContain("starting[0] is not an entry");
  });
});

// ==================== Character changes ====================

describe("characterChanges phase", () => {
  const draft: AcceptedResolutionDraft = {
    endings: ENDING_DECISIONS,
    starting: [{ actionId: QUEUED, resolvedDurationTicks: 2 }],
  };

  it("accepts [] and a well-formed row", () => {
    expect(
      validatePhase(
        "characterChanges",
        { characterChanges: [] },
        makeContext(),
        draft
      )
    ).toEqual([]);
    expect(
      validatePhase(
        "characterChanges",
        {
          characterChanges: [
            {
              sourceActionId: QUEUED,
              characterId: "npc_1",
              operation: { kind: "hp", delta: -2, reason: "the lid snapped" },
            },
          ],
        },
        makeContext(),
        draft
      )
    ).toEqual([]);
  });

  it("addresses a bad row at its index", () => {
    const errors = validatePhase(
      "characterChanges",
      {
        characterChanges: [
          {
            sourceActionId: QUEUED,
            characterId: "npc_nobody",
            operation: { kind: "hp", delta: -2, reason: "x" },
          },
        ],
      },
      makeContext(),
      draft
    );
    expect(errors[0]?.target).toEqual({ kind: "characterChange", index: 0 });
    expect(text(errors)).toContain("does not exist");
  });

  it("catches a driver who never boarded — the first phase that can", () => {
    // The starts phase could not: the position change that boards him is in
    // THIS payload.
    const driving: AcceptedResolutionDraft = {
      endings: ENDING_DECISIONS,
      starting: [
        {
          actionId: QUEUED,
          movement: { route: ["SCN_3"], vehicleId: "VEH_1" },
        },
      ],
    };
    const missing = validatePhase(
      "characterChanges",
      { characterChanges: [] },
      makeContext(),
      driving
    );
    expect(text(missing)).toContain("is not in its interior scene");

    const boarded = validatePhase(
      "characterChanges",
      {
        characterChanges: [
          {
            sourceActionId: QUEUED,
            characterId: "npc_1",
            operation: {
              kind: "position",
              position: { type: "scene", sceneId: "SCN_TRUCK" },
            },
          },
        ],
      },
      makeContext(),
      driving
    );
    expect(boarded).toEqual([]);
  });
});

// ==================== Item changes ====================

describe("itemChanges phase", () => {
  const draft: AcceptedResolutionDraft = {
    endings: ENDING_DECISIONS,
    starting: [{ actionId: QUEUED, resolvedDurationTicks: 2 }],
    characterChanges: [],
  };
  const move = {
    sourceActionId: QUEUED,
    itemId: "lock_1",
    operation: { kind: "move", from: "scene:SCN_1", to: "npc_1" },
  };

  it("accepts [] and a well-formed move", () => {
    expect(
      validatePhase("itemChanges", { itemChanges: [] }, makeContext(), draft)
    ).toEqual([]);
    expect(
      validatePhase(
        "itemChanges",
        { itemChanges: [move] },
        makeContext(),
        draft
      )
    ).toEqual([]);
  });

  it("carries the same-tick uniqueness rule across the rows of one payload", () => {
    const errors = validatePhase(
      "itemChanges",
      { itemChanges: [move, move] },
      makeContext(),
      draft
    );
    expect(text(errors)).toContain("more than once this tick");
  });
});

// ==================== Scene changes ====================

describe("sceneChanges phase", () => {
  const base: AcceptedResolutionDraft = {
    endings: ENDING_DECISIONS,
    starting: [{ actionId: QUEUED, resolvedDurationTicks: 2 }],
    characterChanges: [],
    itemChanges: [],
  };

  it("accepts [] and a well-formed row", () => {
    expect(
      validatePhase("sceneChanges", { sceneChanges: [] }, makeContext(), base)
    ).toEqual([]);
    expect(
      validatePhase(
        "sceneChanges",
        {
          sceneChanges: [
            {
              sourceActionId: QUEUED,
              sceneId: "SCN_1",
              operation: { kind: "setDescription", description: "Bare wall." },
            },
          ],
        },
        makeContext(),
        base
      )
    ).toEqual([]);
  });

  it("refuses an unblock that duplicates an accepted one-shot grant", () => {
    const granted: AcceptedResolutionDraft = {
      ...base,
      starting: [
        {
          actionId: QUEUED,
          movement: {
            route: ["SCN_2"],
            passBlockedConnectionId: "connection.scn1.door",
          },
        },
      ],
    };
    const errors = validatePhase(
      "sceneChanges",
      {
        sceneChanges: [
          {
            sourceActionId: QUEUED,
            sceneId: "SCN_1",
            operation: {
              kind: "connectionBlock",
              connectionId: "connection.scn1.door",
              blocked: false,
              reason: "he lifted the bar",
            },
          },
        ],
      },
      makeContext(),
      granted
    );
    expect(text(errors)).toContain("name the same passage");
    // Addressed at the row this phase can actually drop.
    expect(errors.map((e) => e.target)).toContainEqual({
      kind: "sceneChange",
      index: 0,
    });
  });

  it("demands the rewrite an accepted item move orphans", () => {
    const moved: AcceptedResolutionDraft = {
      ...base,
      itemChanges: [
        {
          sourceActionId: QUEUED,
          itemId: "lock_1",
          operation: { kind: "move", from: "scene:SCN_1", to: "npc_1" },
        },
      ],
    };
    const errors = validatePhase(
      "sceneChanges",
      { sceneChanges: [] },
      makeContext(),
      moved
    );
    expect(text(errors)).toContain('is cited in the description of "SCN_1"');

    const rewritten = validatePhase(
      "sceneChanges",
      {
        sceneChanges: [
          {
            sourceActionId: QUEUED,
            sceneId: "SCN_1",
            operation: {
              kind: "setDescription",
              description: "A cabinet stands against the far wall, open.",
            },
          },
        ],
      },
      makeContext(),
      moved
    );
    expect(rewritten).toEqual([]);
  });
});

// ==================== Occurrences ====================

describe("occurrences phase", () => {
  const draft: AcceptedResolutionDraft = {
    endings: ENDING_DECISIONS,
    starting: [{ actionId: QUEUED, resolvedDurationTicks: 2 }],
    characterChanges: [],
    itemChanges: [],
    sceneChanges: [],
  };
  const check = (rows: unknown[]): string =>
    text(
      validatePhase("occurrences", { occurrences: rows }, makeContext(), draft)
    );

  it("accepts a trace for each ending decision, in the shape its mode demands", () => {
    expect(
      validatePhase(
        "occurrences",
        { occurrences: [occurrence(), speechRow()] },
        makeContext(),
        draft
      )
    ).toEqual([]);
  });

  it("demands a speech:false row for an outcome decision", () => {
    expect(check([speechRow()])).toContain("no speech:false row cites it");
  });

  it("demands a speech:true row for a pure-speech decision", () => {
    expect(check([occurrence()])).toContain("no speech:true row cites it");
  });

  it("refuses a speech:false row citing a pure-speech decision", () => {
    // Hands did something, so the decision two phases back was wrong — and
    // the message says so, because that is the only fix.
    const errors = check([
      occurrence(),
      speechRow(),
      occurrence({ actionIds: [TALKING], content: "he sets the cup down" }),
    ]);
    expect(errors).toContain("a speech:false row cites it");
    expect(errors).toContain('ending decision has to change to mode "outcome"');
  });

  it("refuses a speech row for an action that only starts this tick", () => {
    expect(check([occurrence(), speechRow({ actionIds: [QUEUED] })])).toContain(
      "carries no utterance"
    );
  });

  it("catches one character shocked in two different rows", () => {
    const sanity = [{ characterId: "npc_1", failureLoss: "1d4" }];
    expect(
      check([
        occurrence({ sanityChecks: sanity }),
        occurrence({
          actionIds: [ENDING],
          content: "the thing turns",
          sanityChecks: sanity,
        }),
        speechRow(),
      ])
    ).toContain("already checked elsewhere");
  });

  it("names a row that is not a row by index", () => {
    expect(check([7])).toContain("occurrences[0] is not a row");
  });
});

// ==================== Unreadable payloads ====================

describe("a payload of the wrong shape is an error, never a throw", () => {
  const bad = (payload: unknown): ResolutionError[] => {
    let errors: ResolutionError[] = [];
    expect(() => {
      errors = validatePhase("sceneChanges", payload, makeContext(), {});
    }).not.toThrow();
    return errors;
  };

  it("reports a payload that is not an object at all", () => {
    for (const payload of [null, undefined, "sceneChanges", 7, []]) {
      const errors = bad(payload);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.target).toEqual({ kind: "resolution" });
      expect(errors[0]?.message).toContain("submit_scene_changes");
    }
  });

  it("reports the one required field as missing", () => {
    const errors = bad({ somethingElse: [] });
    expect(text(errors)).toContain('"sceneChanges" is missing');
  });

  it("reports a field it cannot read as a list", () => {
    expect(text(bad({ sceneChanges: "not json" }))).toContain(
      "could not be read as a list"
    );
  });

  it("still recovers a list the model wrapped in a string", () => {
    const errors = validatePhase(
      "sceneChanges",
      {
        sceneChanges: JSON.stringify([
          {
            sourceActionId: QUEUED,
            sceneId: "SCN_1",
            operation: { kind: "setDescription", description: "Bare wall." },
          },
        ]),
      },
      makeContext(),
      { starting: [], itemChanges: [] }
    );
    expect(errors).toEqual([]);
  });
});

// ==================== Accepted value / assembly ====================

describe("acceptedPhaseValue", () => {
  it("reads the phase's own field out of the payload", () => {
    expect(
      acceptedPhaseValue("starts", { starting: [{ actionId: QUEUED }] })
    ).toEqual([{ actionId: QUEUED }]);
    expect(acceptedPhaseValue("endings", { endings: [] })).toEqual([]);
  });
});

describe("assembleRawResolution", () => {
  it("drops pure-speech decisions from `ending` and keeps the rest", () => {
    const raw = assembleRawResolution({
      endings: ENDING_DECISIONS,
      starting: [{ actionId: QUEUED, resolvedDurationTicks: 2 }],
      characterChanges: [],
      itemChanges: [],
      sceneChanges: [],
      occurrences: [occurrence(), speechRow()],
    });
    // A pure-speech action has no ending row at all: its speech occurrence is
    // the whole answer, which is what the intermediate decision existed for.
    expect(raw.ending).toEqual([
      { actionId: ENDING, outcome: "the latch gives" },
    ]);
    expect(raw.starting).toHaveLength(1);
    expect(raw.occurrences).toHaveLength(2);
  });

  it("turns an absent phase into an empty list", () => {
    expect(assembleRawResolution({})).toEqual({
      starting: [],
      ending: [],
      characterChanges: [],
      itemChanges: [],
      sceneChanges: [],
      occurrences: [],
    });
  });
});

// ==================== Rewind ====================

describe("rewindPhaseFor", () => {
  const context = makeContext();
  const only = (target: ResolutionError["target"]) =>
    rewindPhaseFor([{ target, message: "x" }], context);

  it("maps every target kind to the phase that can fix it", () => {
    expect(only({ kind: "resolution" })).toBe("endings");
    expect(only({ kind: "characterChange", index: 0 })).toBe(
      "characterChanges"
    );
    expect(only({ kind: "itemChange", index: 0 })).toBe("itemChanges");
    expect(only({ kind: "sceneChange", index: 0 })).toBe("sceneChanges");
    expect(only({ kind: "occurrence", actionIds: [ENDING] })).toBe(
      "occurrences"
    );
  });

  it("splits an action id by the moment the worklist puts it in", () => {
    expect(only({ kind: "action", actionId: ENDING })).toBe("endings");
    expect(only({ kind: "action", actionId: TALKING })).toBe("endings");
    expect(only({ kind: "action", actionId: QUEUED })).toBe("starts");
    expect(only({ kind: "action", actionId: "action_ghost" })).toBe("starts");
  });

  it("takes the earliest phase over the whole set", () => {
    expect(
      rewindPhaseFor(
        [
          { target: { kind: "occurrence", actionIds: [] }, message: "x" },
          { target: { kind: "itemChange", index: 1 }, message: "y" },
          { target: { kind: "sceneChange", index: 0 }, message: "z" },
        ],
        context
      )
    ).toBe("itemChanges");
  });

  it("rewinds nothing early when there is nothing to fix", () => {
    expect(rewindPhaseFor([], context)).toBe("occurrences");
  });
});

describe("phaseIndex", () => {
  it("is the execution order", () => {
    expect(phaseIndex("endings")).toBe(0);
    expect(phaseIndex("starts")).toBe(1);
    expect(phaseIndex("occurrences")).toBe(5);
    expect(phaseIndex("itemChanges")).toBeLessThan(phaseIndex("sceneChanges"));
  });
});

// ==================== The gate was not weakened ====================

describe("the final gate still judges the assembled draft", () => {
  it("catches a stale citation no single phase was asked about", () => {
    // Each phase here is internally fine — the item move alone is legal, and
    // an empty sceneChanges array alone is legal. Assembled, the prose of
    // SCN_1 points at an item that has left.
    const draft: AcceptedResolutionDraft = {
      endings: ENDING_DECISIONS,
      starting: [{ actionId: QUEUED, resolvedDurationTicks: 2 }],
      characterChanges: [],
      itemChanges: [
        {
          sourceActionId: QUEUED,
          itemId: "lock_1",
          operation: { kind: "move", from: "scene:SCN_1", to: "npc_1" },
        },
      ],
      sceneChanges: [],
      occurrences: [occurrence(), speechRow()],
    };
    // The item phase, judged on its own, accepted the move.
    expect(
      validatePhase(
        "itemChanges",
        { itemChanges: draft.itemChanges },
        makeContext(),
        { endings: draft.endings, starting: draft.starting }
      )
    ).toEqual([]);

    const errors = validateRawResolution(
      assembleRawResolution(draft),
      makeContext()
    );
    expect(text(errors)).toContain('is cited in the description of "SCN_1"');
    expect(errors.map((e) => e.target)).toContainEqual({
      kind: "itemChange",
      index: 0,
    });
    // And the rewind for it goes back to the phase that made the move.
    expect(rewindPhaseFor(errors, makeContext())).toBe("itemChanges");
  });

  it("accepts a draft every phase accepted and nothing spans", () => {
    const draft: AcceptedResolutionDraft = {
      endings: ENDING_DECISIONS,
      starting: [{ actionId: QUEUED, resolvedDurationTicks: 2 }],
      characterChanges: [],
      itemChanges: [],
      sceneChanges: [],
      occurrences: [occurrence(), speechRow()],
    };
    expect(
      validateRawResolution(assembleRawResolution(draft), makeContext())
    ).toEqual([]);
  });
});

// ==================== Retention and merge ====================
//
// The two keyed phases are corrected by difference. These cases are lifted
// from the 2026-09-04 tlou2 run: a bandaging action that lost its duration
// three times while every other entry was fine (tick 9), an occurrence phase
// that answered a one-row rejection by shrinking to two placeholder rows
// (tick 7), and an empty array offered twice with five endings pending
// (tick 3).

import {
  MERGE_PHASES,
  mergeRows,
  occurrenceObligations,
  retainedRows,
  unansweredStarts,
  unmetOccurrenceObligations,
} from "../worldResolutionStageValidator.js";

const SECOND = "action_c2";

/** Two queued commands: one silent (owes a duration), one spoken (owes none). */
const twoStarting = (): EngineResolutionContext =>
  makeContext({
    newCommands: [
      command(),
      command({
        commandId: "c2",
        actorId: "npc_2",
        description: "I tell him to hold still.",
        utterance: "Hold still.",
        proposedDurationTicks: 1,
      }),
    ],
    activeActions: [],
    triggerActionIds: [QUEUED, SECOND],
  });

/** One ending that both spoke and did something: two rows owed. */
const spokenOutcome = (): EngineResolutionContext =>
  makeContext({
    newCommands: [],
    activeActions: [
      activeAction({
        command: command({
          commandId: "live",
          actorId: "npc_2",
          utterance: "Got it.",
        }),
      }),
    ],
    triggerActionIds: [ENDING],
  });

const OUTCOME_ONLY: AcceptedResolutionDraft = {
  endings: [{ actionId: ENDING, mode: "outcome", outcome: "the latch gives" }],
};

describe("retention and merge — the two keyed phases", () => {
  it("names exactly starts and occurrences", () => {
    expect([...MERGE_PHASES].sort()).toEqual(["occurrences", "starts"]);
  });

  describe("starts", () => {
    const silentMissingDuration = { actionId: QUEUED };
    const spoken = { actionId: SECOND, resolvedDurationTicks: 1 };

    it("keeps the entries that pass on their own and names the ids still owed", () => {
      const ctx = twoStarting();
      const { retained, faulty } = retainedRows(
        "starts",
        [silentMissingDuration, spoken],
        ctx,
        {}
      );
      expect(retained).toEqual([spoken]);
      expect(faulty).toEqual([silentMissingDuration]);
      expect(unansweredStarts(retained, ctx)).toEqual([QUEUED]);
    });

    it("merges the one owed entry over the kept rows into a whole that validates", () => {
      const ctx = twoStarting();
      const merged = mergeRows(
        "starts",
        [spoken],
        [{ actionId: QUEUED, resolvedDurationTicks: 2 }],
        ctx,
        {}
      );
      expect(merged).toEqual([
        spoken,
        { actionId: QUEUED, resolvedDurationTicks: 2 },
      ]);
      expect(validatePhase("starts", { starting: merged }, ctx, {})).toEqual(
        []
      );
    });

    it("lets a resent entry replace its kept row only when it passes on its own", () => {
      const ctx = twoStarting();
      const better = { actionId: SECOND, resolvedDurationTicks: 1 };
      expect(mergeRows("starts", [spoken], [better], ctx, {})).toEqual([
        better,
      ]);
      // A resend that invents a route to dodge the duration is dropped; the
      // kept entry stands and the merged array is not made worse by it.
      const worse = { actionId: SECOND, movement: { route: ["placeholder"] } };
      expect(mergeRows("starts", [spoken], [worse], ctx, {})).toEqual([spoken]);
    });

    it("refuses a placeholder route and says which way out is real", () => {
      const ctx = twoStarting();
      const bad = { actionId: QUEUED, movement: { route: ["placeholder"] } };
      expect(retainedRows("starts", [bad], ctx, {}).faulty).toEqual([bad]);
      const errors = validatePhase(
        "starts",
        { starting: [bad, spoken] },
        ctx,
        {}
      );
      expect(text(errors)).toContain(`"placeholder" is not a place`);
      expect(text(errors)).toContain("never use placeholders");
      expect(text(errors)).toContain("provide resolvedDurationTicks instead");
    });

    it("tells a silent non-travel entry what the actor proposed", () => {
      const errors = validatePhase(
        "starts",
        { starting: [silentMissingDuration, spoken] },
        twoStarting(),
        {}
      );
      expect(text(errors)).toContain(`action:${QUEUED}`);
      expect(text(errors)).toContain("the command proposed 2 tick(s)");
      expect(text(errors)).toContain("do not delete this action");
    });

    it("retains nothing from an empty array and owes everything", () => {
      const ctx = twoStarting();
      const { retained, faulty } = retainedRows("starts", [], ctx, {});
      expect(retained).toEqual([]);
      expect(faulty).toEqual([]);
      expect(unansweredStarts(retained, ctx)).toEqual([QUEUED, SECOND]);
    });
  });

  describe("occurrences", () => {
    const spokenRow = (over: Partial<RawOccurrence> = {}): RawOccurrence => ({
      actionIds: [ENDING],
      speech: true,
      targetIds: ["npc_1"],
      perceivers: [{ characterId: "npc_1", clarity: "full" }],
      ...over,
    });
    const factRow = (over: Partial<RawOccurrence> = {}): RawOccurrence => ({
      actionIds: [ENDING],
      speech: false,
      perceivers: [{ characterId: "npc_1", clarity: "full" }],
      content: "the latch gives",
      ...over,
    });

    it("owes a fact row AND a speech row for an ending that spoke while it acted", () => {
      expect(occurrenceObligations(spokenOutcome(), OUTCOME_ONLY)).toEqual([
        { actionId: ENDING, speech: false },
        { actionId: ENDING, speech: true },
      ]);
    });

    it("owes one pair per decision on the default fixture, facts first", () => {
      expect(
        occurrenceObligations(makeContext(), { endings: ENDING_DECISIONS })
      ).toEqual([
        { actionId: ENDING, speech: false },
        { actionId: TALKING, speech: true },
      ]);
    });

    it("keeps a valid speech row and names the fact row still owed", () => {
      const ctx = spokenOutcome();
      const { retained, faulty } = retainedRows(
        "occurrences",
        [spokenRow()],
        ctx,
        OUTCOME_ONLY
      );
      expect(retained).toEqual([spokenRow()]);
      expect(faulty).toEqual([]);
      expect(unmetOccurrenceObligations(retained, ctx, OUTCOME_ONLY)).toEqual([
        { actionId: ENDING, speech: false },
      ]);
    });

    it("does not let a degenerate resend replace the kept row", () => {
      const ctx = spokenOutcome();
      const merged = mergeRows(
        "occurrences",
        [spokenRow()],
        [spokenRow({ content: "placeholder" }), factRow()],
        ctx,
        OUTCOME_ONLY
      );
      expect(merged).toEqual([
        spokenRow(),
        spokenRow({ content: "placeholder" }),
        factRow(),
      ]);
      expect(
        text(
          validatePhase(
            "occurrences",
            { occurrences: merged },
            ctx,
            OUTCOME_ONLY
          )
        )
      ).toContain("unfinished placeholder");
      expect(
        retainedRows("occurrences", merged, ctx, OUTCOME_ONLY).retained
      ).toEqual([spokenRow(), factRow()]);
    });

    it("lets two new rows share a key without one erasing the other", () => {
      const ctx = spokenOutcome();
      const shove = factRow({ content: "the shove lands" });
      const landing = factRow({ content: "he hits the far wall" });
      const merged = mergeRows(
        "occurrences",
        [spokenRow()],
        [shove, landing],
        ctx,
        OUTCOME_ONLY
      );
      expect(merged).toEqual([spokenRow(), shove, landing]);
    });

    it("refuses placeholder and tab-separated scratch content", () => {
      const ctx = spokenOutcome();
      for (const content of [
        "placeholder",
        "TODO",
        "Manny\ttolerant\ttolerant",
      ]) {
        const row = factRow({ content });
        expect(
          retainedRows("occurrences", [row], ctx, OUTCOME_ONLY).faulty
        ).toEqual([row]);
        const errors = validatePhase(
          "occurrences",
          { occurrences: [row, spokenRow()] },
          ctx,
          OUTCOME_ONLY
        );
        expect(text(errors)).toContain("unfinished placeholder");
      }
    });

    it("reports every unmet pair when the array is empty", () => {
      const errors = validatePhase(
        "occurrences",
        { occurrences: [] },
        spokenOutcome(),
        OUTCOME_ONLY
      );
      expect(text(errors)).toContain("no speech:false row cites it");
      expect(text(errors)).toContain("no speech:true row cites it");
    });

    it("a speech:false row citing a pure-speech decision is not kept", () => {
      const ctx = makeContext();
      const contradiction = occurrence({ actionIds: [TALKING] });
      const { retained, faulty } = retainedRows(
        "occurrences",
        [occurrence(), contradiction, speechRow()],
        ctx,
        { endings: ENDING_DECISIONS }
      );
      expect(retained).toEqual([occurrence(), speechRow()]);
      expect(faulty).toEqual([contradiction]);
    });
  });

  it("retains nothing for an index-addressed phase", () => {
    const rows = [{ sourceActionId: ENDING, itemId: "lock_1" }];
    expect(retainedRows("itemChanges", rows, makeContext(), {})).toEqual({
      retained: [],
      faulty: rows,
    });
    expect(mergeRows("itemChanges", [], rows, makeContext(), {})).toEqual(rows);
  });
});

describe("staged run failure regressions", () => {
  it("requires both fact and speech for an outcome with an utterance in both gates", () => {
    const context = makeContext();
    const draft: AcceptedResolutionDraft = {
      endings: [
        ENDING_DECISIONS[0],
        {
          actionId: TALKING,
          mode: "outcome",
          outcome: "He greets Hollins and opens the latch.",
        },
      ],
      starting: [{ actionId: QUEUED, resolvedDurationTicks: 2 }],
      characterChanges: [],
      itemChanges: [],
      sceneChanges: [],
      occurrences: [occurrence(), occurrence({ actionIds: [TALKING] })],
    };
    expect(
      text(
        validatePhase(
          "occurrences",
          { occurrences: draft.occurrences },
          context,
          draft
        )
      )
    ).toContain("Add a separate speech:true row");
    expect(
      text(validateRawResolution(assembleRawResolution(draft), context))
    ).toContain("Add a separate speech:true row");
    draft.occurrences?.push(speechRow());
    expect(
      validatePhase(
        "occurrences",
        { occurrences: draft.occurrences },
        context,
        draft
      )
    ).toEqual([]);
    expect(
      validateRawResolution(assembleRawResolution(draft), context)
    ).toEqual([]);
  });

  it.each(["placeholder", "Manny\ttolerant\ttolerant"])(
    "rejects unfinished prose even when coverage is complete: %s",
    (content) => {
      const draft: AcceptedResolutionDraft = { endings: ENDING_DECISIONS };
      const errors = validatePhase(
        "occurrences",
        { occurrences: [occurrence(), speechRow({ content })] },
        makeContext(),
        draft
      );
      expect(text(errors)).toContain("unfinished placeholder");
    }
  );

  it("points a missing-duration repair to the same action and the proposed duration", () => {
    const errors = validatePhase(
      "starts",
      { starting: [{ actionId: QUEUED }] },
      makeContext(),
      { endings: ENDING_DECISIONS }
    );
    expect(text(errors)).toContain('"action_c1" (actor "npc_1")');
    expect(text(errors)).toContain("command proposed 2 tick(s)");
    expect(text(errors)).toContain("Do not invent movement");
  });

  it("rejects empty and placeholder travel repairs without accepting lost required actions", () => {
    for (const waypoint of ["", "placeholder"]) {
      const errors = validatePhase(
        "starts",
        { starting: [{ actionId: QUEUED, movement: { route: [waypoint] } }] },
        makeContext(),
        { endings: ENDING_DECISIONS }
      );
      expect(text(errors)).toContain("provide resolvedDurationTicks instead");
    }
  });
});

describe("review regressions", () => {
  it("appends a repaired second fact without overwriting the first fact for the same action", () => {
    const ctx = spokenOutcome();
    const first = occurrence({ content: "The shove lands in the room." });
    const second = occurrence({
      content: "He lands in the courtyard.",
      perceivers: [{ characterId: "npc_2", clarity: "full" }],
    });
    expect(
      mergeRows("occurrences", [first], [second], ctx, OUTCOME_ONLY)
    ).toEqual([first, second]);
    expect(
      mergeRows("occurrences", [first], [{ ...first }], ctx, OUTCOME_ONLY)
    ).toEqual([first]);
  });

  it("does not clock a checked utterance at one minute when duration is missing", () => {
    const ctx = twoStarting();
    ctx.actions.newCommands[1].declaredSkillId = "Medicine & Psychology";
    const errors = validatePhase(
      "starts",
      {
        starting: [
          { actionId: QUEUED, resolvedDurationTicks: 2 },
          { actionId: SECOND, check: { requiredLevel: "regular" } },
        ],
      },
      ctx,
      {}
    );
    expect(text(errors)).toContain(
      "a structured utterance, which does not replace an explicit duration"
    );
  });

  it("refuses a pure-speech answer to a checked attempt even before a roll is available", () => {
    const ctx = spokenOutcome();
    ctx.actions.activeActions[0].check = {
      skillId: "Medicine & Psychology",
      requiredLevel: "regular",
    };
    const draft: AcceptedResolutionDraft = {
      endings: [{ actionId: ENDING, mode: "pure_speech" }],
      occurrences: [speechRow({ actionIds: [ENDING] })],
    };
    expect(
      text(validatePhase("endings", { endings: draft.endings }, ctx, {}))
    ).toContain("carried a check");
    expect(
      text(validateRawResolution(assembleRawResolution(draft), ctx))
    ).toContain("carried a check");
  });
});
