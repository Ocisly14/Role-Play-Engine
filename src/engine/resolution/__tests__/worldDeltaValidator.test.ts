// Phase 7 validator: transition legality, first-resolution timing ownership,
// roll-consistency enforcement, delta reference/invariant checks, occurrence
// objectivity, and finalization (synthesized failures, id assignment,
// nextWakeAt computation, dropped-source deltas).

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
  RawTickResolution,
} from "../worldDeltaSchema.js";
import {
  applyRepair,
  finalizeResolution,
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
}): EngineResolutionContext {
  const newCommands = opts.newCommands ?? [command()];
  const activeActions = opts.activeActions ?? [];
  return {
    trigger: {
      triggers: [
        {
          actionIds: opts.triggerActionIds ?? [ACTION_ID],
          reason: "new_action",
        },
      ],
      actionIds: opts.triggerActionIds ?? [ACTION_ID],
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
      graph: { macroLocations: [], places: [], edges: [] },
      blockedEdges: [],
      placeKinds: { SCN_1: "scene" },
      connectionIds: [],
      places: [
        {
          id: "SCN_1",
          kind: "scene",
          name: "Study",
          description: "",
          parentLocationId: "L1",
          conditions: [],
          itemIds: ["lock_1"],
          connections: [],
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
          skills: { Locksmith: 60 },
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
    timingReason: "trivial action, one minute suffices",
    ...overrides,
  };
}

/** The objective trace every ending carries. It is a required field of the
 *  ending now, not a separate array to cross-reference — which is why the old
 *  "an ended action left no trace" rule has no test any more: it cannot be
 *  expressed. */
function occurrence(): RawActionEnd["occurrence"] {
  return {
    facts: [{ type: "action_result", content: "the latch gives" }],
    participants: [{ characterId: "npc_1", role: "actor" }],
    perceiverCharacterIds: ["npc_1"],
  };
}

function end(overrides: Partial<RawActionEnd> = {}): RawActionEnd {
  return {
    actionId: "action_live",
    outcome: "success",
    reason: "the latch gives",
    occurrence: occurrence(),
    ...overrides,
  };
}

/** A standalone occurrence, for the cases that are about the array itself. */
function trace(actionId: string = ACTION_ID): RawTickResolution["occurrences"] {
  return [{ ...occurrence(), sourceActionIds: [actionId] }];
}

describe("validateRawResolution — the three moments", () => {
  it("accepts a well-formed start", () => {
    const errors = validateRawResolution(
      { starting: [start()] },
      makeContext({}),
      []
    );
    expect(errors).toEqual([]);
  });

  it("rejects an unknown actionId and reports the unanswered trigger", () => {
    const errors = validateRawResolution(
      { starting: [start({ actionId: "action_ghost" })] },
      makeContext({}),
      []
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
      makeContext({}),
      []
    );
    expect(text(errors)).toContain("appears more than once");
  });

  it("refuses to end an action that has not started", () => {
    // Its minute has not been spent. Under the old single-shape entry this was
    // a `result` on a queued action; now it is a queued action in the wrong
    // list, and the error says which list it belongs in.
    const errors = validateRawResolution(
      { ending: [end({ actionId: ACTION_ID })] },
      makeContext({}),
      []
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
      }),
      []
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
      }),
      []
    );
    expect(text(errors)).toContain("cannot be resolved again");
  });

  it("asks nothing at all of an action that is merely still running", () => {
    // Silence already means "keeps running", so requiring an entry would be
    // asking for a sentence that carries no information. Coverage is only
    // about actions that have not begun and actions whose time is spent.
    const stillRunning = makeContext({
      newCommands: [],
      // 5 of 10 minutes — triggered (say, by an interruption) but not due.
      activeActions: [activeAction()],
      triggerActionIds: ["action_live"],
    });
    expect(validateRawResolution({}, stillRunning, [])).toEqual([]);
  });

  it("still demands an answer for an action whose time is spent", () => {
    const due = makeContext({
      newCommands: [],
      activeActions: [activeAction({ progressMinutes: 10 })],
      triggerActionIds: ["action_live"],
    });
    expect(text(validateRawResolution({}, due, []))).toContain(
      "was not answered"
    );
    // The duration was set once, when it began. There is no list to move it
    // to and no way to ask for more time: the only answer is what happened.
    expect(validateRawResolution({ ending: [end()] }, due, [])).toEqual([]);
  });

  it("checks the occurrence carried by an ending", () => {
    // It is a field of the ending rather than a cross-referenced array entry,
    // but it is the same thing and gets the same objectivity rules.
    const errors = validateRawResolution(
      {
        ending: [
          end({
            occurrence: {
              ...occurrence(),
              facts: [{ type: "action_result", content: "I feel it give" }],
            },
          }),
        ],
      },
      makeContext({
        newCommands: [],
        activeActions: [activeAction()],
        triggerActionIds: ["action_live"],
      }),
      []
    );
    expect(text(errors)).toContain("action:action_live");
  });
});

describe("validateRawResolution — outcome and the bar", () => {
  const skillCommand = command({ declaredSkillId: "Locksmith" });
  const runningContext = (overrides: Partial<EngineAction> = {}) =>
    makeContext({
      newCommands: [],
      activeActions: [activeAction(overrides)],
      triggerActionIds: ["action_live"],
    });

  it("requires outcome when the action carried no check", () => {
    // Nothing rolled, so there is nothing to derive it from. This was the
    // single most common rejection in a measured run — the schema said the
    // field was optional while the validator required it.
    const errors = validateRawResolution(
      { ending: [end({ outcome: undefined })] },
      runningContext(),
      []
    );
    expect(text(errors)).toContain("carried no check");
    expect(text(errors)).toContain("endingNeedsOutcome");
  });

  it("refuses outcome when a check already decided it", () => {
    const errors = validateRawResolution(
      { ending: [end({ outcome: "success" })] },
      runningContext({
        check: { skillId: "Locksmith", requiredLevel: "regular", basis: "…" },
      }),
      []
    );
    expect(text(errors)).toContain("code decides success from the roll");
  });

  it("accepts an ending that leaves the checked outcome to code", () => {
    const errors = validateRawResolution(
      { ending: [end({ outcome: undefined })] },
      runningContext({
        check: { skillId: "Locksmith", requiredLevel: "regular", basis: "…" },
      }),
      []
    );
    expect(errors).toEqual([]);
  });

  it("accepts a bar for the skill the actor declared", () => {
    const errors = validateRawResolution(
      {
        starting: [
          start({
            check: {
              requiredLevel: "regular",
              basis: "a common pin lock in good light",
            },
          }),
        ],
      },
      makeContext({ newCommands: [skillCommand] }),
      []
    );
    expect(errors).toEqual([]);
  });

  it("rejects a bar when the actor declared no skill", () => {
    const errors = validateRawResolution(
      {
        starting: [
          start({ check: { requiredLevel: "hard", basis: "invented" } }),
        ],
      },
      makeContext({}),
      []
    );
    expect(text(errors)).toContain("nothing to check");
  });

  it("requires a real defender and a bar for an opposed check", () => {
    const unknown = validateRawResolution(
      {
        starting: [
          start({
            check: { requiredLevel: "regular", basis: "he resists" },
            opposedBy: [{ characterId: "npc_ghost", skillId: "Social" }],
          }),
        ],
      },
      makeContext({ newCommands: [skillCommand] }),
      []
    );
    expect(text(unknown)).toContain("does not exist");

    const noBar = validateRawResolution(
      {
        starting: [
          start({ opposedBy: [{ characterId: "npc_2", skillId: "Social" }] }),
        ],
      },
      makeContext({ newCommands: [skillCommand] }),
      []
    );
    expect(text(noBar)).toContain("needs a check");
  });
});

describe("validateRawResolution — deltas and occurrences", () => {
  it("rejects unknown entities, missing causalBasis and unknown source actions", () => {
    const errors = validateRawResolution(
      {
        starting: [start()],
        characterChanges: [
          {
            sourceActionId: "action_ghost",
            causalBasis: "",
            characterId: "npc_ghost",
            operation: { kind: "hp", delta: -3, reason: "hit" },
          },
        ],
      },
      makeContext({}),
      []
    );
    const joined = text(errors);
    expect(joined).toContain('sourceActionId "action_ghost" is unknown');
    expect(joined).toContain("causalBasis is required");
    expect(joined).toContain('characterId "npc_ghost" does not exist');
  });

  it("rejects an item move whose `from` mismatches the real holder, and double moves", () => {
    const move = (from: string) => ({
      sourceActionId: ACTION_ID,
      causalBasis: "picked up",
      itemId: "lock_1",
      operation: { kind: "move", from, to: "npc_1" },
    });
    const wrongFrom = validateRawResolution(
      { starting: [start()], itemChanges: [move("npc_2")] },
      makeContext({}),
      []
    );
    expect(text(wrongFrom)).toContain(
      "does not match the item's actual holder"
    );

    const doubleMove = validateRawResolution(
      {
        starting: [start()],
        itemChanges: [move("scene:SCN_1"), move("scene:SCN_1")],
      },
      makeContext({}),
      []
    );
    expect(text(doubleMove)).toContain("unique-ownership conflict");
  });

  it("rejects perspective wording and unknown perceivers in occurrences", () => {
    const errors = validateRawResolution(
      {
        starting: [start()],
        occurrences: [
          {
            sourceActionIds: [ACTION_ID],
            locationId: "SCN_1",
            facts: [{ type: "action_result", content: "I see the lock slip" }],
            participants: [{ characterId: "npc_1", role: "actor" }],
            perceiverCharacterIds: ["npc_ghost"],
          },
        ],
      },
      makeContext({}),
      []
    );
    const joined = text(errors);
    expect(joined).toContain("character-perspective wording");
    expect(joined).toContain('perceiver "npc_ghost" does not exist');
  });
});

describe("finalizeResolution", () => {
  // finalize no longer validates, drops or synthesizes anything: by the time
  // it runs, the resolution has already passed validation. A resolution that
  // could not be repaired never reaches it — the tick applies nothing.

  it("derives the lifecycle and the wake time, and assigns ids", () => {
    const raw: RawTickResolution = {
      starting: [
        start({
          resolvedDurationTicks: 5,
          timingReason: "five minutes at the keyway",
          movement: { destinationId: "SCN_1" },
        }),
      ],
      occurrences: [
        {
          sourceActionIds: [ACTION_ID],
          locationId: "SCN_1",
          facts: [
            { type: "sound", content: "metal scraping inside the lock" },
            {
              type: "action_result",
              content: "the pick slips out of the keyway",
            },
          ],
          participants: [{ characterId: "npc_1", role: "actor" }],
          perceiverCharacterIds: ["npc_1", "npc_2", "npc_2"],
          signals: [{ channel: "sound", factIndexes: [0] }],
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
      destinationId: "SCN_1",
    });

    const occ = finalized.resolution.occurrences[0];
    expect(occ.id).toBe("occ_tick_1_0");
    expect(occ.tickId).toBe("tick_1");
    expect(occ.facts.map((f) => f.id)).toEqual([
      "occ_tick_1_0#f0",
      "occ_tick_1_0#f1",
    ]);
    expect(occ.perceiverCharacterIds).toEqual(["npc_1", "npc_2"]);
    expect(occ.signals[0].factIds).toEqual(["occ_tick_1_0#f0"]);
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
      starting: [
        start({ resolvedDurationTicks: 2, timingReason: "two minutes" }),
      ],
      ending: [
        {
          actionId: "action_live",
          outcome: "blocked",
          reason: "abandoned for a new undertaking",
          occurrence: occurrence(),
        },
      ],
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
});

describe("applyRepair — one shape for every field", () => {
  // The repair tool used to take index-keyed OBJECTS for deltas and an ARRAY
  // for actions. The model mixed them up and sent an object where the
  // submission's array belonged, which reached `.filter` and took the tick
  // down. Now every field is an array whose items carry their own address.
  const base = (): RawTickResolution => ({
    starting: [start()],
    characterChanges: [
      {
        sourceActionId: ACTION_ID,
        causalBasis: "first",
        characterId: "npc_1",
        operation: { kind: "hp", delta: -1, reason: "scrape" },
      },
      {
        sourceActionId: ACTION_ID,
        causalBasis: "second",
        characterId: "npc_2",
        operation: { kind: "hp", delta: -2, reason: "graze" },
      },
    ],
  });

  it("replaces the element at the quoted index", () => {
    const out = applyRepair(base(), {
      characterChanges: [
        {
          index: 1,
          sourceActionId: ACTION_ID,
          causalBasis: "fixed",
          characterId: "npc_2",
          operation: { kind: "hp", delta: -5, reason: "corrected" },
        },
      ],
    });
    expect(out.characterChanges?.[0]?.causalBasis).toBe("first");
    expect(out.characterChanges?.[1]?.causalBasis).toBe("fixed");
    expect(out.characterChanges?.[1]?.operation).not.toHaveProperty("index");
  });

  it("appends an item that carries no index", () => {
    const out = applyRepair(base(), {
      characterChanges: [
        {
          sourceActionId: ACTION_ID,
          causalBasis: "the one that was missing",
          characterId: "npc_1",
          operation: { kind: "fatigue", delta: 2, reason: "exertion" },
        },
      ],
    });
    expect(out.characterChanges).toHaveLength(3);
    expect(out.characterChanges?.[2]?.causalBasis).toBe(
      "the one that was missing"
    );
  });

  it("withdraws with remove, and never resurrects it as an addition", () => {
    const out = applyRepair(base(), {
      characterChanges: [{ index: 0, remove: true }],
    });
    expect(out.characterChanges?.[0]).toBeNull();
    expect(out.characterChanges).toHaveLength(2);
  });

  it("still reads a stale index-keyed object rather than throwing", () => {
    const out = applyRepair(base(), {
      characterChanges: {
        "1": {
          sourceActionId: ACTION_ID,
          causalBasis: "old shape",
          characterId: "npc_2",
          operation: { kind: "hp", delta: -3, reason: "legacy" },
        },
      } as never,
    });
    expect(out.characterChanges?.[1]?.causalBasis).toBe("old shape");
  });

  it("replaces an action by its own id, within its own moment", () => {
    const out = applyRepair(base(), {
      starting: [
        {
          actionId: ACTION_ID,
          resolvedDurationTicks: 9,
          timingReason: "revised",
        },
      ],
    });
    expect(out.starting).toHaveLength(1);
    expect(out.starting?.[0].resolvedDurationTicks).toBe(9);
  });

  it("moves an action between moments, leaving nothing behind", () => {
    // "this belongs in ending, not starting" has to remove it from starting as
    // well, or the next round rejects both copies as one action in two moments.
    const out = applyRepair(base(), {
      ending: [
        {
          actionId: ACTION_ID,
          outcome: "failure",
          reason: "it was over before it began",
          occurrence: occurrence(),
        },
      ],
    });
    expect(out.starting).toHaveLength(0);
    expect(out.ending).toHaveLength(1);
    expect(out.ending?.[0].actionId).toBe(ACTION_ID);
  });
});

describe("operations are checked against the fields they advertise", () => {
  // Each of these passed validation before and reached the applier, where a
  // bad value either did nothing or wrote nonsense into the world. A delta
  // that applies cleanly and changes nothing is the worst kind: the actor
  // perceives no consequence and re-issues the same action.
  const delta = (operation: Record<string, unknown>) => ({
    sourceActionId: ACTION_ID,
    causalBasis: "it follows",
    characterId: "npc_1",
    operation: operation as never,
  });
  const errorsFor = (operation: Record<string, unknown>) =>
    text(
      validateRawResolution(
        { starting: [start()], characterChanges: [delta(operation)] },
        makeContext({}),
        []
      )
    );

  it("rejects a position type outside the two real kinds", () => {
    expect(
      errorsFor({ kind: "position", position: { type: "teleport" } })
    ).toContain('position.type must be "scene" or "road"');
    // The junction kind is gone: geography nodes are scenes now.
    expect(
      errorsFor({ kind: "position", position: { type: "junction" } })
    ).toContain('position.type must be "scene" or "road"');
  });

  it("rejects a position whose id field is missing for its type", () => {
    expect(
      errorsFor({ kind: "position", position: { type: "road" } })
    ).toContain("requires roadId");
  });

  it("rejects a road nobody was shown", () => {
    // Only scenes used to be checked, so any road id at all was accepted
    // and the character was stood somewhere that does not exist.
    expect(
      errorsFor({
        kind: "position",
        position: { type: "road", roadId: "ROAD_NOWHERE" },
      })
    ).toContain("is not a place you were shown");
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
              causalBasis: "the fire is out",
              sceneId: "SCN_1",
              operation: { kind: "environmentHazard" } as never,
            },
          ],
        },
        makeContext({}),
        []
      )
    );
    expect(errors).toContain('environmentHazard needs "add" or "remove"');
  });

  it("rejects a movement destination nobody was shown", () => {
    const errors = text(
      validateRawResolution(
        { starting: [start({ movement: { destinationId: "SCN_ATLANTIS" } })] },
        makeContext({}),
        []
      )
    );
    expect(errors).toContain("is not a place you were shown");
  });
});
