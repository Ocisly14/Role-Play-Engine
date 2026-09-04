// Phase 7 validator: transition legality, first-resolution timing ownership,
// speech rows versus ending entries, delta reference/invariant checks,
// occurrence objectivity, and finalization (id assignment,
// nextWakeAt computation, spoken lines carried in by code).

import { describe, expect, it } from "vitest";
import type { ActionCommand, EngineAction } from "../../actions/types.js";
import {
  type EngineResolutionContext,
  type ResolutionError,
  formatErrorTarget,
} from "../types.js";
import type {
  RawActionEnd,
  RawActionStart,
  RawOccurrence,
  RawTickResolution,
} from "../worldDeltaSchema.js";
import {
  MAX_SANITY_CHECKS,
  finalizeResolution,
  normalizeList,
  normalizeRawResolution,
  resolutionWorklist,
  validateRawResolution,
} from "../worldDeltaValidator.js";

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

const ACTION_ID = "action_c1";

/** Errors carry an address now; most assertions only care about the text. */
const text = (errors: ResolutionError[]): string =>
  errors.map((e) => `${formatErrorTarget(e.target)} ${e.message}`).join("\n");

function activeAction(overrides: Partial<EngineAction> = {}): EngineAction {
  return {
    id: "action_live",
    command: command({ commandId: "live", actorId: "npc_2" }),
    status: "active",
    submittedAt: "1923-04-02T09:00:00",
    startedAt: "1923-04-02T09:01:00",
    progressMinutes: 5,
    resolvedDurationTicks: 10,
    nextWakeAt: "1923-04-02T09:15:00",
    ...overrides,
  };
}

function makeContext(opts: {
  newCommands?: ActionCommand[];
  activeActions?: EngineAction[];
  triggerActionIds?: string[];
  /** Ids the trigger also lists under reason "replacement". */
  replacedActionIds?: string[];
}): EngineResolutionContext {
  const newCommands = opts.newCommands ?? [command()];
  const activeActions = opts.activeActions ?? [];
  const triggerIds = opts.triggerActionIds ?? [ACTION_ID];
  return {
    trigger: {
      triggers: [
        { actionIds: triggerIds, reason: "new_action" },
        ...(opts.replacedActionIds?.length
          ? [
              {
                actionIds: opts.replacedActionIds,
                reason: "replacement" as const,
              },
            ]
          : []),
      ],
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
      placeKinds: { SCN_1: "scene", SCN_2: "scene", SCN_3: "scene" },
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
          description: "",
          parentLocationId: "L1",
          conditions: [],
          itemIds: ["lock_1"],
          // One barred door and one open hall — the actor's `exitsFromHere`.
          // `connection.scn2.back` is real but leaves from somewhere else.
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

function start(overrides: Partial<RawActionStart> = {}): RawActionStart {
  return {
    actionId: ACTION_ID,
    resolvedDurationTicks: 1,
    ...overrides,
  };
}

/** The objective trace every ending leaves. It used to be a required field
 *  OF the ending; now it is a flat row in `occurrences`, and the validator
 *  checks that every ending is cited by one (`actionIds`) — the same
 *  guarantee, as a check rather than a nested slot the model had to close. */
function occurrence(overrides: Partial<RawOccurrence> = {}): RawOccurrence {
  return {
    actionIds: ["action_live"],
    speech: false,
    perceivers: [{ characterId: "npc_1", clarity: "full" }],
    content: "the latch gives",
    ...overrides,
  };
}

/** Two scalars. The trace is not here — see `ended` for the pair. */
function end(overrides: Partial<RawActionEnd> = {}): RawActionEnd {
  return {
    actionId: "action_live",
    outcome: "the latch gives",
    ...overrides,
  };
}

/** An ending together with the row that cites it — what most ending tests
 *  need, since an uncited ending is itself an error. */
function ended(
  endOverrides: Partial<RawActionEnd> = {},
  occurrenceOverrides: Partial<RawOccurrence> = {}
): Pick<RawTickResolution, "ending" | "occurrences"> {
  const entry = end(endOverrides);
  return {
    ending: [entry],
    occurrences: [
      occurrence({ actionIds: [entry.actionId], ...occurrenceOverrides }),
    ],
  };
}

describe("validateRawResolution — the three moments", () => {
  it("accepts a well-formed start", () => {
    const errors = validateRawResolution(
      { starting: [start()] },
      makeContext({})
    );
    expect(errors).toEqual([]);
  });

  it("rejects an unknown actionId and reports the unanswered trigger", () => {
    const errors = validateRawResolution(
      { starting: [start({ actionId: "action_ghost" })] },
      makeContext({})
    );
    expect(text(errors)).toContain("unknown actionId");
    expect(text(errors)).toContain("was not answered");
  });

  it("rejects an action that appears in two moments at once", () => {
    // The list an action sits in IS the decision about what happens to it, so
    // two lists is a contradiction rather than a duplicate.
    const errors = validateRawResolution(
      {
        starting: [start()],
        ending: [end({ actionId: ACTION_ID })],
      },
      makeContext({})
    );
    expect(text(errors)).toContain("appears more than once");
  });

  it("refuses to end an action that has not started", () => {
    // Its minute has not been spent. Under the old single-shape entry this was
    // a `result` on a queued action; now it is a queued action in the wrong
    // list, and the error says which list it belongs in.
    const errors = validateRawResolution(
      { ending: [end({ actionId: ACTION_ID })] },
      makeContext({})
    );
    expect(text(errors)).toContain("has not started yet");
    expect(text(errors)).toContain('"starting"');
  });

  it("refuses to start an action that is already running", () => {
    const errors = validateRawResolution(
      { starting: [start({ actionId: "action_live" })] },
      makeContext({
        newCommands: [],
        activeActions: [activeAction()],
        triggerActionIds: ["action_live"],
      })
    );
    expect(text(errors)).toContain("already running");
  });

  it("refuses to re-open an action that already ended", () => {
    const errors = validateRawResolution(
      { ending: [end()] },
      makeContext({
        newCommands: [],
        activeActions: [{ ...activeAction(), status: "completed" as const }],
        triggerActionIds: ["action_live"],
      })
    );
    expect(text(errors)).toContain("cannot be resolved again");
  });

  it("asks nothing at all of an action that is merely still running", () => {
    // Silence already means "keeps running", so requiring an entry would be
    // asking for a sentence that carries no information. Coverage is only
    // about actions that have not begun and actions whose time is spent.
    const stillRunning = makeContext({
      newCommands: [],
      // 5 of 10 minutes — present in a defensive/manual context, but not due.
      activeActions: [activeAction()],
      triggerActionIds: ["action_live"],
    });
    expect(validateRawResolution({}, stillRunning)).toEqual([]);
    expect(text(validateRawResolution(ended(), stillRunning))).toContain(
      "does not end this tick"
    );
  });

  it("treats duration and interruption triggers as authoritative endings", () => {
    for (const reason of ["duration_reached", "interrupted"] as const) {
      const context = makeContext({
        newCommands: [],
        activeActions: [activeAction()], // deliberately below its duration
        triggerActionIds: ["action_live"],
      });
      context.trigger.triggers = [{ actionIds: ["action_live"], reason }];
      expect(resolutionWorklist(context).ending).toEqual(["action_live"]);
      expect(text(validateRawResolution({}, context))).toContain(
        "was not answered"
      );
    }
  });

  it("demands an ending for an action its own actor has replaced, however much time it had left", () => {
    // Replacement used to be a trigger reason and nothing else: the old
    // action landed under `stillRunning`, the Engine was told silence keeps
    // it running, and both it and its successor ran to completion side by
    // side. Measured: a notebook handed over twice, in consecutive minutes.
    const ctx = makeContext({
      newCommands: [],
      activeActions: [activeAction()], // 5 of 10 minutes
      triggerActionIds: ["action_live"],
      replacedActionIds: ["action_live"],
    });
    const worklist = resolutionWorklist(ctx);
    expect(worklist.ending).toEqual(["action_live"]);
    expect(worklist.replaced).toEqual(["action_live"]);
    expect(worklist.stillRunning).toEqual([]);
    expect(text(validateRawResolution({}, ctx))).toContain("action_live");
  });

  it("still demands an answer for an action whose time is spent", () => {
    const due = makeContext({
      newCommands: [],
      activeActions: [activeAction({ progressMinutes: 10 })],
      triggerActionIds: ["action_live"],
    });
    expect(text(validateRawResolution({}, due))).toContain("was not answered");
    // The duration was set once, when it began. There is no list to move it
    // to and no way to ask for more time: the only answer is what happened.
    expect(validateRawResolution(ended(), due)).toEqual([]);
  });

  it("checks the occurrence that cites an ending, addressed at the occurrence by the actions it cites", () => {
    // The trace used to be a field of the ending and its errors were
    // addressed at the action; it is a row of its own now, addressed by the
    // ids it cites — the same objectivity rules either way.
    const errors = validateRawResolution(
      ended({}, { content: "I feel it give" }),
      makeContext({
        newCommands: [],
        activeActions: [activeAction({ progressMinutes: 10 })],
        triggerActionIds: ["action_live"],
      })
    );
    expect(text(errors)).toContain(
      "occurrence:action_live content: character-perspective wording"
    );
    expect(text(errors)).not.toContain("action:action_live");
  });
  it("refuses an ending no occurrence cites, and accepts one that is", () => {
    // The guarantee the nested `occurrence` slot used to give, now a check:
    // without a trace the actor perceives nothing, concludes nothing
    // happened, and re-issues the same action next minute.
    const context = makeContext({
      newCommands: [],
      activeActions: [activeAction({ progressMinutes: 10 })],
      triggerActionIds: ["action_live"],
    });
    const uncited = validateRawResolution({ ending: [end()] }, context);
    expect(uncited).toEqual([
      {
        target: { kind: "action", actionId: "action_live" },
        message: expect.stringContaining("no occurrence cites this ending"),
      },
    ]);
    expect(text(uncited)).toContain('"actionIds"');

    expect(validateRawResolution(ended(), context)).toEqual([]);
  });
});

describe("validateRawResolution — outcome, talk and the bar", () => {
  const skillCommand = command({ declaredSkillId: "Stealth & Security" });
  const runningContext = (overrides: Partial<EngineAction> = {}) =>
    makeContext({
      newCommands: [],
      activeActions: [activeAction({ progressMinutes: 10, ...overrides })],
      triggerActionIds: ["action_live"],
    });
  /** The running action, but its command carries a spoken line. */
  const talking = (utterance = "你们哪边的，兄弟？") =>
    runningContext({
      command: command({ commandId: "live", actorId: "npc_2", utterance }),
    });
  const speechRow = (overrides: Partial<RawOccurrence> = {}): RawOccurrence =>
    occurrence({
      speech: true,
      targetIds: ["npc_1"],
      perceivers: [
        { characterId: "npc_1", clarity: "full" },
        { characterId: "npc_2", clarity: "full" },
      ],
      content: undefined,
      ...overrides,
    });

  it("requires an outcome paragraph on every ending entry", () => {
    // The one thing an ending says. It used to be a `reason` beside an
    // `outcome` enum nothing downstream read; the enum is gone and the
    // paragraph took its name.
    const errors = validateRawResolution(
      ended({ outcome: "  " }),
      runningContext()
    );
    expect(text(errors)).toContain("an ending requires an outcome");
  });

  it("takes an outcome on a checked ending too — consistent with the roll, not instead of it", () => {
    // The enum used to be refused here because code had decided success. The
    // paragraph is not a verdict: it is what the actor is told came of it,
    // and a checked action still has to tell them something.
    const errors = validateRawResolution(
      ended(),
      runningContext({
        check: { skillId: "Stealth & Security", requiredLevel: "regular" },
      })
    );
    expect(errors).toEqual([]);
  });

  it("answers a pure-speech ending with one speech row and no ending entry", () => {
    // Talk is delivered, not judged. The row says who was addressed and who
    // heard; code adds the words. There is nothing for an ending entry to say.
    const errors = validateRawResolution(
      { occurrences: [speechRow()] },
      talking()
    );
    expect(errors).toEqual([]);
  });

  it("refuses an ending entry whose only trace is the speech row", () => {
    // Pure talk has no ending entry; a physical result has a speech:false
    // row. An entry cited only by speech rows is neither. It used to be
    // tolerated because a bare refusal once left the model no legal move
    // (measured on DeepSeek); the refusal now names both moves.
    const errors = validateRawResolution(
      { ending: [end()], occurrences: [speechRow()] },
      talking()
    );
    const all = text(errors);
    expect(all).toContain(
      "action:action_live only a speech row cites this ending"
    );
    expect(all).toContain('drop this "ending" entry');
    expect(all).toContain("add a speech:false occurrence");
    // One instruction, not a field-by-field review on top of it.
    expect(errors).toHaveLength(1);
  });

  it("delivers one utterance per speech row", () => {
    // Two speakers in one row: code places the row where the FIRST cited
    // actor stands, so the second one's words land in the wrong room.
    const second = activeAction({
      id: "action_other",
      command: command({
        commandId: "other",
        actorId: "npc_1",
        utterance: "这边的。",
      }),
      progressMinutes: 10,
    });
    const ctx = makeContext({
      newCommands: [],
      activeActions: [
        activeAction({
          progressMinutes: 10,
          command: command({
            commandId: "live",
            actorId: "npc_2",
            utterance: "你们哪边的，兄弟？",
          }),
        }),
        second,
      ],
      triggerActionIds: ["action_live", "action_other"],
    });
    const merged = validateRawResolution(
      {
        occurrences: [
          speechRow({ actionIds: ["action_live", "action_other"] }),
        ],
      },
      ctx
    );
    expect(text(merged)).toContain("a speech row delivers ONE utterance");
    expect(text(merged)).toContain("cites 2 actions");

    const split = validateRawResolution(
      {
        occurrences: [
          speechRow({ actionIds: ["action_live"] }),
          speechRow({ actionIds: ["action_other"], targetIds: ["npc_2"] }),
        ],
      },
      ctx
    );
    expect(split).toEqual([]);
  });

  it("still requires the ending entry when hands did something besides talking", () => {
    // A line spoken while a cup changes hands is two rows; the second one is
    // what makes the ending an ending.
    const both = [
      speechRow(),
      occurrence({ content: "the cup changes hands" }),
    ];
    const missing = validateRawResolution({ occurrences: both }, talking());
    expect(text(missing)).toContain("was not answered");
    expect(text(missing)).toContain("speech true");

    const answered = validateRawResolution(
      {
        ending: [end({ outcome: "the cup is in her hands" })],
        occurrences: both,
      },
      talking()
    );
    expect(answered).toEqual([]);
  });

  it("refuses a speech row for an action that carries no words", () => {
    const errors = validateRawResolution(
      { occurrences: [speechRow()] },
      runningContext()
    );
    expect(text(errors)).toContain("carries no utterance");
    // And the ending is then unanswered, since the speech row does not count.
    expect(text(errors)).toContain("was not answered");
  });

  it("refuses a speech row for an action that is not ending this tick", () => {
    // Words are delivered when the action ends, and a queued action has not
    // even begun.
    const errors = validateRawResolution(
      {
        starting: [start()],
        occurrences: [speechRow({ actionIds: [ACTION_ID] })],
      },
      makeContext({ newCommands: [command({ utterance: "喂。" })] })
    );
    expect(text(errors)).toContain("does not end this tick");
    // The rejection says when the words WILL land and how to take the row
    // back: the correction must omit the premature row from the complete
    // resubmission rather than trying to patch it in place.
    expect(text(errors)).toContain("endingWithUtterance");
    expect(text(errors)).toContain("Leave this row out of the resubmission");
  });

  it("lets a spoken line start without a duration — code clocks it at one minute", () => {
    const errors = validateRawResolution(
      { starting: [start({ resolvedDurationTicks: undefined })] },
      makeContext({ newCommands: [command({ utterance: "喂。" })] })
    );
    expect(errors).toEqual([]);
    // A silent action still has to say how long it takes.
    const silent = validateRawResolution(
      { starting: [start({ resolvedDurationTicks: undefined })] },
      makeContext({ newCommands: [command()] })
    );
    expect(text(silent)).toContain("needs resolvedDurationTicks");
  });

  it("lists a starting action's utterance under startingWithUtterance, not endingWithUtterance", () => {
    const worklist = resolutionWorklist(
      makeContext({ newCommands: [command({ utterance: "喂。" })] })
    );
    expect(worklist.startingWithUtterance).toEqual([ACTION_ID]);
    expect(worklist.endingWithUtterance).toEqual([]);
  });

  it("requires targetIds on a speech row, and lets the list be empty for the room", () => {
    const unaddressed = validateRawResolution(
      { occurrences: [speechRow({ targetIds: undefined })] },
      talking()
    );
    expect(text(unaddressed)).toContain("a speech row requires targetIds");

    const toTheRoom = validateRawResolution(
      { occurrences: [speechRow({ targetIds: [] })] },
      talking()
    );
    expect(toTheRoom).toEqual([]);
  });

  it("requires content when the row is not speech, and not when it is", () => {
    const silent = validateRawResolution(
      ended({}, { content: undefined }),
      runningContext()
    );
    expect(text(silent)).toContain("content is required when speech is false");

    const spoken = validateRawResolution(
      { occurrences: [speechRow({ content: "he asks it lightly, grinning" })] },
      talking()
    );
    expect(spoken).toEqual([]);
  });

  it("requires the speech flag itself", () => {
    const errors = validateRawResolution(
      ended({}, { speech: undefined as unknown as boolean }),
      runningContext()
    );
    expect(text(errors)).toContain("speech is required, true or false");
  });

  it("accepts a bar for the skill the actor declared", () => {
    const errors = validateRawResolution(
      { starting: [start({ check: { requiredLevel: "regular" } })] },
      makeContext({ newCommands: [skillCommand] })
    );
    expect(errors).toEqual([]);
  });

  it("rejects a bar when the actor declared no skill", () => {
    const errors = validateRawResolution(
      { starting: [start({ check: { requiredLevel: "hard" } })] },
      makeContext({})
    );
    expect(text(errors)).toContain("nothing to check");
  });

  it("requires a real defender and a bar for an opposed check", () => {
    const unknown = validateRawResolution(
      {
        starting: [
          start({
            check: { requiredLevel: "regular" },
            opposedBy: [{ characterId: "npc_ghost", skillId: "Social" }],
          }),
        ],
      },
      makeContext({ newCommands: [skillCommand] })
    );
    expect(text(unknown)).toContain("does not exist");

    const noBar = validateRawResolution(
      {
        starting: [
          start({ opposedBy: [{ characterId: "npc_2", skillId: "Social" }] }),
        ],
      },
      makeContext({ newCommands: [skillCommand] })
    );
    expect(text(noBar)).toContain("needs a check");
  });
});

describe("validateRawResolution — deltas and occurrences", () => {
  it("rejects unknown entities and unknown source actions", () => {
    const errors = validateRawResolution(
      {
        starting: [start()],
        characterChanges: [
          {
            sourceActionId: "action_ghost",
            characterId: "npc_ghost",
            operation: { kind: "hp", delta: -3, reason: "hit" },
          },
        ],
      },
      makeContext({})
    );
    const joined = text(errors);
    expect(joined).toContain('sourceActionId "action_ghost" is unknown');
    expect(joined).toContain('characterId "npc_ghost" does not exist');
  });
  it("rejects an item move whose `from` mismatches the real holder, and double moves", () => {
    const move = (from: string) => ({
      sourceActionId: ACTION_ID,
      itemId: "lock_1",
      operation: { kind: "move", from, to: "npc_1" },
    });
    const wrongFrom = validateRawResolution(
      { starting: [start()], itemChanges: [move("npc_2")] },
      makeContext({})
    );
    expect(text(wrongFrom)).toContain(
      "does not match the item's actual holder"
    );

    const doubleMove = validateRawResolution(
      {
        starting: [start()],
        itemChanges: [move("scene:SCN_1"), move("scene:SCN_1")],
      },
      makeContext({})
    );
    expect(text(doubleMove)).toContain("unique-ownership conflict");
  });

  it("rejects perspective wording, unknown perceivers and unknown targets in occurrences", () => {
    const errors = validateRawResolution(
      {
        starting: [start()],
        occurrences: [
          {
            actionIds: [ACTION_ID],
            speech: false,
            targetIds: ["npc_nobody"],
            perceivers: [{ characterId: "npc_ghost", clarity: "full" }],
            content: "I see the lock slip",
          },
        ],
      },
      makeContext({})
    );
    const joined = text(errors);
    expect(joined).toContain("character-perspective wording");
    expect(joined).toContain(
      'perceivers[0]: character "npc_ghost" does not exist'
    );
    expect(joined).toContain('targetIds: "npc_nobody" does not exist');
  });
});

describe("finalizeResolution", () => {
  it("clocks a spoken line at one minute whatever the Engine wrote", () => {
    // Words are delivered when the action ends. A line the Engine gave three
    // minutes was three minutes of nobody hearing it — and of the Engine
    // trying to deliver it early. Measured: 26 rejected speech rows in one
    // run cited an id the Engine had just placed under `starting`.
    const { resolution } = finalizeResolution(
      { starting: [start({ resolvedDurationTicks: 3 })] },
      makeContext({ newCommands: [command({ utterance: "喂。" })] })
    );
    const t = resolution.transitions.find((x) => x.actionId === ACTION_ID);
    expect(t?.resolvedDurationTicks).toBe(1);
    expect(t?.timingReason).toBe("a spoken line takes one minute");
    expect(t?.nextWakeAt).toBe("1923-04-02T09:16:00");
    // A silent action keeps the Engine's clock.
    const silent = finalizeResolution(
      { starting: [start({ resolvedDurationTicks: 3 })] },
      makeContext({ newCommands: [command()] })
    );
    expect(
      silent.resolution.transitions.find((x) => x.actionId === ACTION_ID)
        ?.resolvedDurationTicks
    ).toBe(3);
  });

  // finalize no longer validates, drops or synthesizes anything: by the time
  // it runs, the resolution has already passed validation. A resolution that
  // could not be corrected never reaches it — the tick applies nothing.

  const talkingContext = (spoken: string) =>
    makeContext({
      newCommands: [],
      activeActions: [
        activeAction({
          progressMinutes: 10,
          command: command({
            commandId: "live",
            actorId: "npc_2",
            utterance: spoken,
            objectRefs: [{ kind: "character", id: "npc_1", role: "target" }],
          }),
        }),
      ],
      triggerActionIds: ["action_live"],
    });

  it("places an occurrence where the actor of the action it cites stands", () => {
    // There is no `locationId` on the wire any more: every row cites an
    // action, and the actor's place is the row's place. Measured before: a
    // doorway conversation rendered, for fifty minutes, as everyone in one
    // room, because the field was left blank and a blank read as "here".
    const raw: RawTickResolution = {
      starting: [start({ resolvedDurationTicks: 1 })],
      occurrences: [
        {
          actionIds: [ACTION_ID],
          speech: false,
          perceivers: [{ characterId: "npc_1", clarity: "full" }],
          content: "a question through the door",
        },
      ],
    };
    const { resolution } = finalizeResolution(raw, makeContext({}));
    expect(resolution.occurrences[0].locationId).toBe("SCN_1");
    expect(resolution.occurrences[0].participants).toEqual([
      { characterId: "npc_1", role: "actor" },
    ]);
  });

  it("carries the actor's own words through verbatim on a speech row, ahead of the Engine's paragraph", () => {
    // The words a character chose are the one part of a command that is
    // already objective. Before this they were summarised by the Engine and
    // then re-imagined by the renderer, and the actor's own diction reached
    // nobody.
    const spoken = "Eh——你们哪边的，兄弟？";
    const raw: RawTickResolution = {
      occurrences: [
        occurrence({
          speech: true,
          targetIds: ["npc_1"],
          perceivers: [
            { characterId: "npc_1", clarity: "full" },
            { characterId: "npc_2", clarity: "full" },
          ],
          content: "he asks it lightly, grinning",
        }),
      ],
    };
    const { resolution } = finalizeResolution(raw, talkingContext(spoken));
    const [occ] = resolution.occurrences;
    expect(occ.facts.map((f) => f.type)).toEqual(["utterance", "speech"]);
    expect(occ.facts[0].content).toBe(spoken);
    // The line points at whoever said it, and code knows that is a person.
    expect(occ.facts[0].entityRefs).toEqual([
      { kind: "character", id: "npc_2" },
    ]);
    expect(occ.facts[1].content).toContain("grinning");
    expect(occ.participants).toEqual([
      { characterId: "npc_2", role: "actor" },
      { characterId: "npc_1", role: "target" },
    ]);
  });

  it("closes a pure-speech action with no ending entry, and writes no reason", () => {
    // The speech row ended it. The clock still has to close the action, so
    // the transition is code's; what came of it is the words themselves,
    // which the row delivers to everyone listed on it.
    const raw: RawTickResolution = {
      occurrences: [
        occurrence({
          speech: true,
          targetIds: [],
          perceivers: [
            { characterId: "npc_1", clarity: "full" },
            { characterId: "npc_2", clarity: "full" },
          ],
          content: undefined,
        }),
      ],
    };
    const { resolution } = finalizeResolution(raw, talkingContext("喂。"));
    expect(resolution.transitions).toEqual([
      {
        actionId: "action_live",
        actorId: "npc_2",
        from: "active",
        to: "completed",
        progressDeltaMinutes: 0,
      },
    ]);
    expect(resolution.occurrences[0].facts.map((f) => f.type)).toEqual([
      "utterance",
    ]);
  });

  it("grades the one speech row per listener instead of splitting it by degree", () => {
    // One fact, two degrees: the one addressed makes out the words, the one
    // behind the door hears only a raised voice. That used to be two rows —
    // a speech row for the first and a `speech:false` paragraph for the
    // second. Now it is one speech row, and the grade says how much of it
    // each listener gets; the renderer degrades, the Engine does not split.
    const spoken = "把手举起来。";
    const raw: RawTickResolution = {
      occurrences: [
        occurrence({
          speech: true,
          targetIds: ["npc_1"],
          perceivers: [
            { characterId: "npc_1", clarity: "full" },
            { characterId: "npc_2", clarity: "trace" },
          ],
          content: undefined,
        }),
      ],
    };
    expect(validateRawResolution(raw, talkingContext(spoken))).toEqual([]);
    const { resolution } = finalizeResolution(raw, talkingContext(spoken));
    expect(resolution.occurrences).toHaveLength(1);
    const [only] = resolution.occurrences;
    expect(only.facts.map((f) => f.type)).toEqual(["utterance"]);
    expect(only.facts[0].content).toBe(spoken);
    expect(only.sourceActionIds).toEqual(["action_live"]);
    expect(only.perceivers).toEqual([
      { characterId: "npc_1", clarity: "full" },
      { characterId: "npc_2", clarity: "trace" },
    ]);
    expect(only.participants).toEqual([
      { characterId: "npc_2", role: "actor" },
      { characterId: "npc_1", role: "target" },
    ]);
  });

  it("carries the ending's outcome as the transition reason", () => {
    // The renderer's "Result:" line and the event log both read it there.
    const raw: RawTickResolution = {
      ending: [{ actionId: "action_live", outcome: "the latch gives" }],
      occurrences: [occurrence()],
    };
    const { resolution } = finalizeResolution(
      raw,
      makeContext({
        newCommands: [],
        activeActions: [activeAction({ progressMinutes: 10 })],
        triggerActionIds: ["action_live"],
      })
    );
    expect(resolution.transitions[0]).toMatchObject({
      actionId: "action_live",
      to: "completed",
      reason: "the latch gives",
    });
  });

  it("derives the lifecycle and the wake time, and assigns ids", () => {
    const raw: RawTickResolution = {
      starting: [
        start({ resolvedDurationTicks: 5, movement: { route: ["SCN_1"] } }),
      ],
      occurrences: [
        {
          actionIds: [ACTION_ID],
          speech: false,
          perceivers: [
            { characterId: "npc_2", clarity: "limited" },
            { characterId: "npc_1", clarity: "full" },
          ],
          content: "metal scrapes inside the lock; the pick slips out",
        },
      ],
    };
    const finalized = finalizeResolution(raw, makeContext({}));
    const t = finalized.resolution.transitions[0];
    // It arrived in `starting`, so it is running — code says so, not the
    // Engine, which never mentions a status at all.
    expect(t.to).toBe("active");
    expect(t.nextWakeAt).toBe("1923-04-02T09:20:00");
    expect(t.progressDeltaMinutes).toBe(0);
    expect(finalized.movementInits[ACTION_ID]).toEqual({
      route: ["SCN_1"],
    });

    const occ = finalized.resolution.occurrences[0];
    expect(occ.id).toBe("occ_tick_1_0");
    expect(occ.tickId).toBe("tick_1");
    expect(occ.facts.map((f) => f.id)).toEqual(["occ_tick_1_0#f0"]);
    // Order and grade carried through as written: finalize dedupes nothing,
    // because the validator has already refused a repeated id.
    expect(occ.perceivers).toEqual([
      { characterId: "npc_2", clarity: "limited" },
      { characterId: "npc_1", clarity: "full" },
    ]);
  });

  it("refuses a perceiver list that is missing, empty, ungraded or repeated", () => {
    // One entry per character at the single clarity they actually reach.
    // The old list was deduped silently at finalization; a repeated id is now
    // a contradiction the Engine has to settle, not a typo code tidies away.
    const at = (over: Record<string, unknown>): string =>
      text(
        validateRawResolution(
          {
            starting: [start()],
            occurrences: [
              {
                actionIds: [ACTION_ID],
                speech: false,
                content: "the pick slips out",
                ...over,
              } as never,
            ],
          },
          makeContext({})
        )
      );
    expect(at({})).toContain("perceivers is required");
    expect(at({ perceivers: [] })).toContain("perceivers is required");
    expect(at({ perceivers: [{ clarity: "full" }] })).toContain(
      "perceivers[0]: characterId is required"
    );
    expect(
      at({ perceivers: [{ characterId: "npc_ghost", clarity: "full" }] })
    ).toContain('perceivers[0]: character "npc_ghost" does not exist');
    const loud = at({
      perceivers: [{ characterId: "npc_1", clarity: "loud" }],
    });
    expect(loud).toContain('perceivers[0]: clarity "loud" is not one of');
    expect(loud).toContain("full, limited, trace");
    expect(
      at({
        perceivers: [
          { characterId: "npc_1", clarity: "full" },
          { characterId: "npc_2", clarity: "limited" },
          { characterId: "npc_2", clarity: "trace" },
        ],
      })
    ).toContain('character "npc_2" is listed twice');
    expect(
      at({
        perceivers: [
          { characterId: "npc_1", clarity: "full" },
          { characterId: "npc_2", clarity: "trace" },
        ],
      })
    ).toBe("");
  });

  it("records the bar without a justification", () => {
    const finalized = finalizeResolution(
      { starting: [start({ check: { requiredLevel: "hard" } })] },
      makeContext({
        newCommands: [command({ declaredSkillId: "Stealth & Security" })],
      })
    );
    expect(finalized.checkInits[ACTION_ID]).toEqual({ requiredLevel: "hard" });
  });

  it("keeps interruption of an active action alongside a new action's start (replacement)", () => {
    const live = activeAction({
      command: command({ commandId: "live", actorId: "npc_1" }),
    });
    const context = makeContext({
      newCommands: [command({ replacesActionId: "action_live" })],
      activeActions: [live],
      triggerActionIds: [ACTION_ID, "action_live"],
    });
    const raw: RawTickResolution = {
      starting: [start({ resolvedDurationTicks: 2 })],
      ending: [
        { actionId: "action_live", outcome: "abandoned for a new undertaking" },
      ],
      occurrences: [occurrence()],
    };
    const { resolution } = finalizeResolution(raw, context);
    expect(resolution.transitions).toHaveLength(2);
    const statuses = Object.fromEntries(
      resolution.transitions.map((t) => [t.actionId, t.to])
    );
    expect(statuses).toEqual({
      [ACTION_ID]: "active",
      action_live: "interrupted",
    });
  });

  it("carries one exact passBlockedConnectionId into the movement init", () => {
    const finalized = finalizeResolution(
      {
        starting: [
          start({
            resolvedDurationTicks: undefined,
            movement: {
              route: ["SCN_1"],
              passBlockedConnectionId: "connection.scn1.door",
            },
          }),
        ],
      },
      makeContext({})
    );
    expect(finalized.movementInits[ACTION_ID]).toEqual({
      route: ["SCN_1"],
      passBlockedConnectionId: "connection.scn1.door",
    });

    const errors = validateRawResolution(
      {
        starting: [
          start({
            movement: {
              route: ["SCN_1"],
              passBlockedConnectionId: "connection.unknown",
            },
          }),
        ],
      },
      makeContext({})
    );
    expect(text(errors)).toContain("passBlockedConnectionId");
  });

  it("rejects passage before an unresolved check can be rolled", () => {
    const errors = validateRawResolution(
      {
        starting: [
          start({
            resolvedDurationTicks: undefined,
            check: { requiredLevel: "hard" },
            movement: {
              route: ["SCN_2"],
              passBlockedConnectionId: "connection.scn1.door",
            },
          }),
        ],
      },
      makeContext({})
    );
    expect(text(errors)).toContain("cannot accompany a check");
  });

  describe("a defender resists with a real ability domain", () => {
    // Unchecked, a name outside the catalog was a SILENT failure: the
    // defender roll does not resolve, the orchestrator writes no outcome,
    // and both sides' dice are discarded — the action runs its full duration
    // and the Engine judges its ending with no roll in front of it.
    const opposed = (skillId: unknown) =>
      text(
        validateRawResolution(
          {
            starting: [
              start({
                check: { requiredLevel: "regular" },
                opposedBy: [{ characterId: "npc_2", skillId }] as never,
              }),
            ],
          },
          // The actor declared a skill, so the bar itself is legal and the
          // only thing left to be wrong is the defender's domain.
          makeContext({
            newCommands: [command({ declaredSkillId: "Stealth & Security" })],
          })
        )
      );

    it("accepts a catalog domain, case-insensitively", () => {
      expect(opposed("Athletics")).toBe("");
      expect(opposed("stealth & security")).toBe("");
    });

    it("refuses a name outside the catalog and lists the domains", () => {
      for (const bad of ["Locksmith", "lockpicking", "  ", 7, undefined]) {
        const out = opposed(bad);
        expect(out).toContain("opposedBy[0].skillId");
        expect(out).not.toContain("does not exist");
      }
      expect(opposed("Locksmith")).toContain("Melee Combat");
    });

    it("refuses Languages, which no defender is asked to roll", () => {
      expect(opposed("Languages")).toContain("never resisted with Languages");
      // It IS a catalog name, so the generic message must not be the one.
      expect(opposed("Languages")).not.toContain("is not one of the ability");
    });
  });

  describe("a grant names one of the actor's OWN blocked exits", () => {
    // Checked against the same `exitsFromHere` list the prompt shows beside
    // the command. It used to be "any connection id in the world", and a
    // wrong grant was silently ignored by the runtime: the walker was
    // interrupted again with the same reason, and nobody learned why.
    const walk = (passBlockedConnectionId: string, route = ["SCN_2"]) =>
      text(
        validateRawResolution(
          {
            starting: [
              start({
                resolvedDurationTicks: undefined,
                movement: { route, passBlockedConnectionId },
              }),
            ],
          },
          makeContext({})
        )
      );

    it("accepts the barred door on the route's first step", () => {
      expect(walk("connection.scn1.door")).toBe("");
    });

    it("refuses a real passage that does not leave from here, naming the ones that do", () => {
      const out = walk("connection.scn2.back");
      expect(out).toContain("is not an exit of where npc_1 stands");
      expect(out).toContain("connection.scn1.door");
      expect(out).not.toContain("connection.scn1.hall");
    });

    it("refuses a grant for an open passage", () => {
      expect(walk("connection.scn1.hall", ["SCN_3"])).toContain(
        "that passage is open"
      );
    });

    it("refuses a grant for a passage the route does not take", () => {
      expect(walk("connection.scn1.door", ["SCN_3"])).toContain(
        'the route\'s first step is "SCN_3"'
      );
    });

    it("refuses clearing the obstacle AND granting passage through it", () => {
      const errors = validateRawResolution(
        {
          starting: [
            start({
              resolvedDurationTicks: undefined,
              movement: {
                route: ["SCN_2"],
                passBlockedConnectionId: "connection.scn1.door",
              },
            }),
          ],
          sceneChanges: [
            {
              sourceActionId: ACTION_ID,
              sceneId: "SCN_1",
              operation: {
                kind: "connectionBlock",
                connectionId: "connection.scn1.door",
                blocked: false,
                reason: "the bar is broken",
              },
            } as never,
          ],
        },
        makeContext({})
      );
      expect(text(errors)).toContain("never both for one passage");
    });
  });
});

describe("an entry in the wrong list gets one instruction, not a review", () => {
  it("reports only the misfiling when a queued action is sent as an ending", () => {
    // Reported alongside the field checks, "this should not be in ending" and
    // "your ending is missing its outcome" are both obeyed — which puts the
    // action in starting AND leaves the ending in place. That is the
    // duplicate it started as, and it cost a measured tick three rounds and
    // its whole resolution.
    const errors = validateRawResolution(
      {
        ending: [{ actionId: ACTION_ID, outcome: "" }],
        occurrences: [occurrence({ actionIds: [ACTION_ID] })],
      },
      makeContext({})
    );
    const aboutTheAction = errors.filter(
      (e) => e.target.kind === "action" && e.target.actionId === ACTION_ID
    );
    expect(aboutTheAction).toHaveLength(1);
    expect(aboutTheAction[0].message).toContain("has not started yet");
    // The two that contradicted it: both demand the misfiled ending be
    // completed rather than moved.
    const all = text(errors);
    expect(all).not.toContain("an ending requires an outcome");
  });
});

describe("prose coherence — a cited item cannot leave silently", () => {
  const proseContext = () => {
    const ctx = makeContext({});
    // The study's prose cites the lock: moving it out must rewrite the prose.
    ctx.state.places[0].description =
      "A study. A cabinet lock gleams on the desk [lock_1].";
    return ctx;
  };
  const moveOut = {
    sourceActionId: ACTION_ID,
    itemId: "lock_1",
    operation: { kind: "move", from: "scene:SCN_1", to: "npc_1" },
  };

  it("rejects moving a cited item without rewriting the place's prose", () => {
    const errors = text(
      validateRawResolution(
        { starting: [start()], itemChanges: [moveOut] },
        proseContext()
      )
    );
    expect(errors).toContain('cited in the description of "SCN_1"');
    expect(errors).toContain("setDescription");
  });

  it("accepts the same move when the submission rewrites the prose", () => {
    const errors = text(
      validateRawResolution(
        {
          starting: [start()],
          itemChanges: [moveOut],
          sceneChanges: [
            {
              sourceActionId: ACTION_ID,
              sceneId: "SCN_1",
              operation: {
                kind: "setDescription",
                description: "A study. The desk is bare.",
              },
            },
          ],
        },
        proseContext()
      )
    );
    expect(errors).not.toContain("cited in the description");
  });

  it("does not fire for an uncited item", () => {
    const errors = text(
      validateRawResolution(
        { starting: [start()], itemChanges: [moveOut] },
        makeContext({})
      )
    );
    expect(errors).not.toContain("cited in the description");
  });
});

describe("operations are checked against the fields they advertise", () => {
  // Each of these passed validation before and reached the applier, where a
  // bad value either did nothing or wrote nonsense into the world. A delta
  // that applies cleanly and changes nothing is the worst kind: the actor
  // perceives no consequence and re-issues the same action.
  const delta = (operation: Record<string, unknown>) => ({
    sourceActionId: ACTION_ID,
    characterId: "npc_1",
    operation: operation as never,
  });
  const errorsFor = (operation: Record<string, unknown>) =>
    text(
      validateRawResolution(
        { starting: [start()], characterChanges: [delta(operation)] },
        makeContext({})
      )
    );

  it("rejects a position type that is not a scene", () => {
    expect(
      errorsFor({ kind: "position", position: { type: "teleport" } })
    ).toContain('position.type must be "scene"');
    // The junction kind is gone: geography nodes are scenes now.
    expect(
      errorsFor({ kind: "position", position: { type: "junction" } })
    ).toContain('position.type must be "scene"');
  });

  it("rejects a scene position with no sceneId", () => {
    expect(
      errorsFor({ kind: "position", position: { type: "scene" } })
    ).toContain("requires sceneId");
  });

  it("rejects a road, shown or not — roads are walked, never assigned", () => {
    // A road position carries a fraction only the movement runtime sets;
    // one assigned here had none, and the next route planned from it was NaN.
    expect(
      errorsFor({
        kind: "position",
        position: { type: "road", roadId: "ROAD_NOWHERE" },
      })
    ).toContain("cannot put a character on a road");
  });

  it("accepts a spot, and accepts the empty string as the clear", () => {
    // Free text by design: whether "behind the counter" is a sensible place
    // to be is a judgement in full context, which is the Engine's job.
    expect(errorsFor({ kind: "spot", spot: "at the workbench" })).toBe("");
    expect(errorsFor({ kind: "spot", spot: "" })).toBe("");
  });

  it("rejects a spot that is not a string", () => {
    expect(errorsFor({ kind: "spot", spot: { at: "workbench" } })).toContain(
      "spot requires a spot string"
    );
  });

  it("rejects a spot long enough to crowd out the block it sits in", () => {
    expect(errorsFor({ kind: "spot", spot: "a".repeat(500) })).toContain(
      "it is a phrase, not a description"
    );
  });

  it("accepts an appearance rewrite, and refuses a blank one", () => {
    // The operation exists because `profile.appearance` is read by every
    // onlooker's render, the character's own, and the Engine's snapshot —
    // and until now nothing could change it: a shaved beard had nowhere to go.
    expect(
      errorsFor({
        kind: "setAppearance",
        appearance: "tall, the grey beard now shaved to stubble",
      })
    ).toBe("");
    expect(errorsFor({ kind: "setAppearance", appearance: "  " })).toContain(
      "non-empty appearance string"
    );
  });

  it("keeps character condition validation structural", () => {
    const missingDescription = errorsFor({
      kind: "addCondition",
      condition: {
        id: "broken_forearm",
      },
    });
    expect(missingDescription).toContain("description");

    expect(
      errorsFor({
        kind: "addCondition",
        condition: {
          id: "broken_forearm",
          description:
            "the left forearm is visibly deformed; the left arm cannot lift, grip, or brace",
        },
      })
    ).toBe("");
  });

  it("has no relationship operation to check", () => {
    // What one character thinks of another is theirs to write, through
    // `writeMemory`. The Engine used to have an operation for it, and it did
    // exactly the damage that rule exists to prevent — told to record that
    // Nancy had grown wary of Philip, the applier wrote the same score and
    // the same note onto Philip's row as well.
    expect(
      errorsFor({ kind: "relationship", toCharacterId: "npc_2", delta: -5 })
    ).toContain("unknown character operation kind");
  });

  it("rejects an environmentHazard that hazards nothing", () => {
    const errors = text(
      validateRawResolution(
        {
          starting: [start()],
          sceneChanges: [
            {
              sourceActionId: ACTION_ID,
              sceneId: "SCN_1",
              operation: { kind: "environmentHazard" } as never,
            },
          ],
        },
        makeContext({})
      )
    );
    expect(errors).toContain('environmentHazard needs "add" or "remove"');
  });

  it("rejects a movement waypoint nobody was shown", () => {
    const errors = text(
      validateRawResolution(
        { starting: [start({ movement: { route: ["SCN_ATLANTIS"] } })] },
        makeContext({})
      )
    );
    expect(errors).toContain("is not a place in this world");
  });
});

// `input_schema` is a description the provider does not enforce — `strict` is
// off everywhere and cannot be turned on for `submit_resolution` (every
// top-level field is optional and `operation` is deliberately open). So the
// contents can arrive in shapes the schema does not describe, and dropping a
// whole list takes a resolution with it: observed once as `starting` arriving
// as an array and `ending`, in the same call, as its own JSON text.
describe("normalizeRawResolution reads what the schema did not guarantee", () => {
  const entry = { actionId: "action_c1", outcome: "the lock gives" };

  /** The shapes below are exactly what the schema does NOT describe, so they
   *  are cast in: the parameter is typed as if the provider had honoured it. */
  const asRaw = (v: unknown) =>
    v as Parameters<typeof normalizeRawResolution>[0];

  it("parses a list that arrived as its own JSON text", () => {
    const raw = normalizeRawResolution(
      asRaw({ starting: [], ending: JSON.stringify([entry]) })
    );
    expect(raw.ending).toHaveLength(1);
    expect(raw.ending?.[0]).toMatchObject({ actionId: "action_c1" });
  });

  it("still reads the index-keyed object form", () => {
    const raw = normalizeRawResolution(asRaw({ ending: { 0: entry } }));
    expect(raw.ending).toHaveLength(1);
  });

  it("drops a string that is not a list, rather than guessing", () => {
    const raw = normalizeRawResolution(
      asRaw({ ending: "nothing ended this tick" })
    );
    expect(raw.ending).toEqual([]);
  });

  it("drops a JSON string that parses to something other than a list", () => {
    const raw = normalizeRawResolution(
      asRaw({ ending: JSON.stringify(entry) })
    );
    expect(raw.ending).toEqual([]);
  });
});

describe("declared sanity checks", () => {
  const consequence = {
    description:
      "speech is incoherent and the person cannot remain oriented to place, so they cannot communicate a coherent plan or act safely without guidance",
    durationMinutes: 30,
  };
  const sane = {
    characterId: "npc_1",
    failureLoss: "1d4",
    consequence,
  };

  /** A standalone occurrence carrying whatever declarations a case needs. */
  const occ = (
    sanityChecks: unknown[],
    over: Record<string, unknown> = {}
  ) => ({
    actionIds: [ACTION_ID],
    speech: false,
    perceivers: [
      { characterId: "npc_1", clarity: "full" },
      { characterId: "npc_2", clarity: "full" },
    ],
    sanityChecks,
    content: "the body is in the water",
    ...over,
  });

  const check = (raw: RawTickResolution): string =>
    text(validateRawResolution(raw, makeContext({})));

  it("accepts a well-formed declaration", () => {
    expect(
      check({ starting: [start()], occurrences: [occ([sane]) as never] })
    ).toBe("");
  });

  it("caps the declarations per occurrence — the bound the schema used to carry", () => {
    // `maxItems` is outside the strict subset, so the count moved here. (The
    // per-character duplicate rule fires too on this fixture; the cap is the
    // line under test.)
    const many = Array.from({ length: MAX_SANITY_CHECKS + 1 }, () => sane);
    expect(
      check({ starting: [start()], occurrences: [occ(many) as never] })
    ).toContain(`at most ${MAX_SANITY_CHECKS}`);
    expect(
      check({ starting: [start()], occurrences: [occ([sane]) as never] })
    ).not.toContain("at most");
  });

  it("rejects a character who did not perceive the occurrence", () => {
    // Exposure is perception. The same evidence that decided the perceiver
    // list decides who can be shocked — a set membership test, not a
    // judgement about whether the sight was upsetting enough.
    const errs = check({
      starting: [start()],
      occurrences: [
        occ([sane], {
          perceivers: [{ characterId: "npc_2", clarity: "full" }],
        }) as never,
      ],
    });
    expect(errs).toContain("is not among this occurrence's perceivers");
  });

  it("rejects a check on someone who perceives the occurrence only as a trace", () => {
    // A trace has no source: a muffled impact cannot be a horror exposure.
    // Limited is enough — the kind of thing and its result reached them.
    const graded = (clarity: string): string =>
      check({
        starting: [start()],
        occurrences: [
          occ([sane], {
            perceivers: [
              { characterId: "npc_1", clarity },
              { characterId: "npc_2", clarity: "full" },
            ],
          }) as never,
        ],
      });
    expect(graded("trace")).toContain("only as a trace");
    expect(graded("limited")).toBe("");
    expect(graded("full")).toBe("");
  });

  it("rejects an unknown or dead character, and one with no sanity capacity", () => {
    expect(
      check({
        starting: [start()],
        occurrences: [occ([{ ...sane, characterId: "nobody" }]) as never],
      })
    ).toContain('character "nobody" does not exist');
  });

  it("rejects the same character twice in one occurrence", () => {
    expect(
      check({ starting: [start()], occurrences: [occ([sane, sane]) as never] })
    ).toContain("is already checked in this occurrence");
  });

  it("rejects the same character across two occurrences of one submission", () => {
    // The structural replacement for the deleted session ledger: the model
    // cannot loop, because the whole submission is judged at once.
    const errs = check({
      starting: [start()],
      occurrences: [occ([sane]) as never, occ([sane]) as never],
    });
    expect(errs).toContain("is already checked elsewhere in this submission");
  });

  it("accepts only the four rungs of the loss ladder", () => {
    // The guidance offers 1, 1d4, 1d6, 1d10 and nothing else. The validator
    // used to take any dice formula, and the model took the offer.
    for (const bad of ["terror", "0", "2d6+1", "1d100", "1d3", 4, null]) {
      expect(
        check({
          starting: [start()],
          occurrences: [occ([{ ...sane, failureLoss: bad }]) as never],
        })
      ).toContain("must be exactly one of 1, 1d4, 1d6, 1d10");
    }
    for (const good of ["1", "1d4", "1d6", "1d10"]) {
      expect(
        check({
          starting: [start()],
          occurrences: [occ([{ ...sane, failureLoss: good }]) as never],
        })
      ).not.toContain("failureLoss");
    }
  });

  it("refuses a direct san delta — the roll is the only thing that moves SAN", () => {
    const errs = check({
      starting: [start()],
      characterChanges: [
        {
          sourceActionId: ACTION_ID,
          characterId: "npc_1",
          operation: { kind: "san", delta: -3, reason: "shaken" },
        } as never,
      ],
    });
    expect(errs).toContain('unknown character operation kind "san"');
  });

  it("rejects a duration that is fractional, too short, or too long", () => {
    // Crash prevention, not hygiene: finalization hands this to `addMinutes`,
    // which throws on a non-integer, and a throw there loses the whole tick.
    for (const durationMinutes of [2.5, 1, 5000]) {
      expect(
        check({
          starting: [start()],
          occurrences: [
            occ([
              { ...sane, consequence: { ...consequence, durationMinutes } },
            ]) as never,
          ],
        })
      ).toContain("must be a whole number of minutes");
    }
  });

  it("requires a consequence description", () => {
    expect(
      check({
        starting: [start()],
        occurrences: [
          occ([
            { ...sane, consequence: { ...consequence, description: "  " } },
          ]) as never,
        ],
      })
    ).toContain("consequence.description is required");
  });

  it("allows no condition candidate", () => {
    expect(
      check({
        starting: [start()],
        occurrences: [
          occ([{ characterId: "npc_1", failureLoss: "1d4" }]) as never,
        ],
      })
    ).toBe("");
  });

  it("requires an action to attribute the loss to", () => {
    expect(
      check({
        starting: [start()],
        occurrences: [occ([sane], { actionIds: [] }) as never],
      })
    ).toContain("must name at least one actionId");
  });

  it("addresses a declaration on an ending's trace at the occurrence, not the action", () => {
    // The trace is a top-level row now, so there is one place a declaration
    // can live and one kind of address for it — the actions the row cites,
    // even when the row is the trace of an ending.
    const errors = validateRawResolution(
      {
        starting: [start()],
        ...ended(
          {},
          {
            perceivers: [{ characterId: "npc_2", clarity: "full" }],
            sanityChecks: [sane],
          }
        ),
      },
      makeContext({ activeActions: [activeAction()] })
    );
    const failure = errors.find((e) =>
      e.message.includes("this occurrence's perceivers")
    );
    expect(failure?.target).toEqual({
      kind: "occurrence",
      actionIds: ["action_live"],
    });
  });
  it("rolls the declaration into ordinary character deltas at finalization", () => {
    const finalized = finalizeResolution(
      {
        starting: [start()],
        occurrences: [occ([{ ...sane, failureLoss: "1d6" }]) as never],
      },
      makeContext({}),
      { rng: () => 0.99 } // fails the check; then a 1d6 face of 6
    );

    const kinds = finalized.resolution.characterChanges.map(
      (d) => (d.delta as { operation: { kind: string } }).operation.kind
    );
    expect(kinds).toEqual(["san", "addCondition"]);
    expect(finalized.sanityOutcomes[0]).toMatchObject({
      characterId: "npc_1",
      passed: false,
    });
  });
});

describe("bounds the schema no longer carries (strict subset)", () => {
  it("rejects a zero or fractional resolvedDurationTicks on a start", () => {
    for (const bad of [0, -2, 1.5]) {
      const errors = validateRawResolution(
        { starting: [start({ resolvedDurationTicks: bad })] },
        makeContext({})
      );
      expect(text(errors)).toContain("at least 1");
    }
    expect(
      validateRawResolution(
        { starting: [start({ resolvedDurationTicks: 1 })] },
        makeContext({})
      )
    ).toEqual([]);
  });
});

describe("position places a character in a scene, never on a road", () => {
  const change = (position: unknown) => ({
    starting: [start()],
    characterChanges: [
      {
        sourceActionId: ACTION_ID,
        characterId: "npc_1",
        operation: { kind: "position", position },
      },
    ],
  });

  it("accepts a scene the world has", () => {
    expect(
      validateRawResolution(
        change({ type: "scene", sceneId: "SCN_1" }) as never,
        makeContext({})
      )
    ).toEqual([]);
  });

  it("refuses a road — that is what movement.route is for", () => {
    // The op that produced the tick-67 NaN: a road with no fraction, planned
    // from next tick.
    const errors = validateRawResolution(
      change({ type: "road", roadId: "ROAD_main_street" }) as never,
      makeContext({})
    );
    expect(text(errors)).toContain("cannot put a character on a road");
    expect(text(errors)).toContain("movement.route");
  });
});

describe("normalizeList reads a list the model wrapped in a string", () => {
  // Shapes measured on a provider without strict mode. Both parse; the
  // second is the list wrapped in an object under its own name — or a name
  // the model made up.
  it("parses a serialized array", () => {
    expect(normalizeList<unknown>('[{"actionId":"a"}]', "starting")).toEqual([
      { actionId: "a" },
    ]);
  });

  it("unwraps a serialized {name: [...]} object", () => {
    expect(
      normalizeList<unknown>('{"starting": [{"actionId":"a"}]}', "starting")
    ).toEqual([{ actionId: "a" }]);
    expect(
      normalizeList<unknown>('{"actions": [{"actionId":"b"}]}', "starting")
    ).toEqual([{ actionId: "b" }]);
  });

  it("still drops what it cannot read", () => {
    expect(normalizeList<unknown>("not json", "starting")).toEqual([]);
    expect(normalizeList<unknown>('{"a": 1}', "starting")).toEqual([]);
  });
});

describe("the validator is a total function over model output", () => {
  // `submit_resolution` is strict, so Anthropic and OpenAI cannot send any of
  // these shapes; DeepSeek has no strict mode and can. Every one of them used
  // to reach a `.entries()`, a `for…of` or a `.trim()` and take the tick down
  // with a TypeError instead of coming back as an error the Engine can fix.
  const noThrow = (raw: unknown): ResolutionError[] => {
    let errors: ResolutionError[] = [];
    expect(() => {
      errors = validateRawResolution(raw as RawTickResolution, makeContext({}));
    }).not.toThrow();
    return errors;
  };

  it("names a null or non-object action entry by list and index", () => {
    for (const bad of [null, "action_c1", 7, ["action_c1"]]) {
      const errors = noThrow({ starting: [bad] });
      expect(text(errors)).toContain("resolution starting[0] is not an entry");
      // The trigger still wants its answer — said separately, addressed.
      expect(text(errors)).toContain(`"${ACTION_ID}" was not answered`);
    }
    expect(text(noThrow({ ending: [{}] }))).toContain(
      "ending[0] is not an entry"
    );
    expect(text(noThrow({ starting: [{ actionId: "  " }] }))).toContain(
      "starting[0] is not an entry"
    );
  });

  it("reports a misshapen check, opposedBy or movement instead of reading into it", () => {
    const errors = noThrow({
      starting: [
        start({
          check: "hard" as never,
          opposedBy: {} as never,
          movement: "SCN_1" as never,
          resolvedDurationTicks: undefined,
        }),
      ],
    });
    const all = text(errors);
    expect(all).toContain("check must be");
    expect(all).toContain("opposedBy must be an array");
    expect(all).toContain("movement must be an object");

    const items = text(
      noThrow({
        starting: [
          start({
            check: { requiredLevel: "impossible" } as never,
            opposedBy: [null, "npc_2", { skillId: "x" }] as never,
          }),
        ],
      })
    );
    expect(items).toContain("check must be");
    expect(items).toContain("opposedBy[0] must be");
    expect(items).toContain("opposedBy[1] must be");
    expect(items).toContain("opposedBy[2] must be");
  });

  it("names a null or non-object change by its index", () => {
    const errors = noThrow({
      starting: [start()],
      characterChanges: [null],
      sceneChanges: ["SCN_1"],
      itemChanges: [5],
    });
    const all = text(errors);
    expect(all).toContain("characterChange:0 is not a change");
    expect(all).toContain("sceneChange:0 is not a change");
    expect(all).toContain("itemChange:0 is not a change");
  });

  it("names a null or non-object occurrence row by its index", () => {
    const errors = noThrow({
      starting: [start()],
      occurrences: [null, "the door opens"],
    });
    const all = text(errors);
    expect(all).toContain("occurrences[0] is not a row");
    expect(all).toContain("occurrences[1] is not a row");
  });

  it("reads an occurrence whose list fields are objects, and says which", () => {
    const errors = noThrow({
      starting: [start()],
      occurrences: [
        {
          actionIds: { 0: ACTION_ID },
          speech: false,
          content: "the lock clicks",
          perceivers: { npc_1: "full" },
          targetIds: {},
          sanityChecks: {},
        },
      ],
    });
    const all = text(errors);
    expect(all).toContain("actionIds is required");
    expect(all).toContain("perceivers is required");
    expect(all).toContain("targetIds must be an array");
    expect(all).toContain("sanityChecks must be an array");
    // The address is still readable even though `actionIds` was not a list.
    expect(
      errors.every(
        (e) =>
          e.target.kind !== "occurrence" || Array.isArray(e.target.actionIds)
      )
    ).toBe(true);
  });

  it("reads a sanity declaration whose fields are the wrong type", () => {
    const errors = noThrow({
      starting: [start()],
      occurrences: [
        {
          actionIds: [ACTION_ID],
          speech: false,
          content: "something moves in the dark",
          perceivers: [{ characterId: "npc_1", clarity: "full" }],
          sanityChecks: [
            null,
            {
              characterId: "npc_1",
              failureLoss: "1d4",
              consequence: { description: 5, durationMinutes: "ten" },
            },
          ],
        },
      ],
    });
    const all = text(errors);
    expect(all).toContain("sanityChecks[0]: characterId is required");
    expect(all).toContain(
      "sanityChecks[1]: consequence.description is required"
    );
    expect(all).toContain(
      "sanityChecks[1]: consequence.durationMinutes must be"
    );
  });
});

describe("movement time belongs to code", () => {
  // The rules and the schema both say to omit `resolvedDurationTicks` on a
  // movement action. The validator used to accept it anyway (the runtime
  // overrides it), which taught the model the sentence was optional.
  it("rejects resolvedDurationTicks on a movement action", () => {
    const errors = validateRawResolution(
      {
        starting: [
          start({ resolvedDurationTicks: 5, movement: { route: ["SCN_1"] } }),
        ],
      },
      makeContext({})
    );
    expect(text(errors)).toContain("must omit resolvedDurationTicks");
  });

  it("accepts a movement action that leaves the clock to the route", () => {
    const errors = validateRawResolution(
      {
        starting: [
          start({
            resolvedDurationTicks: undefined,
            movement: { route: ["SCN_1"] },
          }),
        ],
      },
      makeContext({})
    );
    expect(errors).toEqual([]);
  });
});
