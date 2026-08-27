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
  RawActionResolution,
  RawTickResolution,
} from "../worldDeltaSchema.js";
import {
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
      scenes: [
        {
          id: "SCN_1",
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

function entry(
  overrides: Partial<RawActionResolution> = {}
): RawActionResolution {
  return {
    actionId: ACTION_ID,
    to: "completed",
    progressDeltaMinutes: 1,
    resolvedDurationTicks: 1,
    timingReason: "trivial action, one minute suffices",
    judgement: {
      kind: "direct",
      outcome: "success",
      reason: "the latch was unlocked",
    },
    ...overrides,
  };
}

/** The objective trace an ended action must leave. Tests below are about
 *  transition legality and roll consistency, so they carry one rather than
 *  tripping the separate "ended action leaves a trace" rule. */
function trace(actionId: string = ACTION_ID): RawTickResolution["occurrences"] {
  return [
    {
      sourceActionIds: [actionId],
      facts: [{ type: "action_result", content: "the latch gives" }],
      participants: [{ characterId: "npc_1", role: "actor" }],
      perceiverCharacterIds: ["npc_1"],
    },
  ];
}

describe("validateRawResolution — transitions", () => {
  it("accepts a well-formed first resolution", () => {
    const errors = validateRawResolution(
      { actions: [entry()], occurrences: trace() },
      makeContext({}),
      []
    );
    expect(errors).toEqual([]);
  });

  it("rejects an unknown actionId and reports the missing trigger", () => {
    const errors = validateRawResolution(
      { actions: [entry({ actionId: "action_ghost" })] },
      makeContext({}),
      []
    );
    expect(text(errors)).toContain("unknown actionId");
    expect(text(errors)).toContain("received no transition");
  });

  it("requires an ended action to leave an objective trace", () => {
    // A failed move changes nothing the actor can see: same position, same
    // surroundings, so next tick's perception is identical and they re-issue
    // the same doomed action. Observed live as a seven-tick loop.
    const errors = validateRawResolution(
      { actions: [entry({ to: "failed", reason: "no route from here" })] },
      makeContext({}),
      []
    );
    expect(text(errors)).toContain("no occurrence citing it");

    // Still running is not ended — nothing to report yet.
    const running = validateRawResolution(
      { actions: [entry({ to: "active", nextWakeInTicks: 2 })] },
      makeContext({}),
      []
    );
    expect(text(running)).not.toContain("no occurrence citing it");
  });

  it("rejects duplicate transitions (single-transition invariant)", () => {
    const errors = validateRawResolution(
      { actions: [entry(), entry()] },
      makeContext({}),
      []
    );
    expect(text(errors)).toContain("duplicate transition");
  });

  it("requires resolvedDurationTicks + timingReason + judgement on first resolution", () => {
    const errors = validateRawResolution(
      {
        actions: [
          entry({
            resolvedDurationTicks: undefined,
            timingReason: undefined,
            judgement: undefined,
            to: "active",
            nextWakeInTicks: 3,
          }),
        ],
      },
      makeContext({}),
      []
    );
    expect(text(errors)).toContain("resolvedDurationTicks");
    expect(text(errors)).toContain("timingReason");
    expect(text(errors)).toContain("judgement");
  });

  it("requires nextWakeInTicks when staying active", () => {
    const errors = validateRawResolution(
      { actions: [entry({ to: "active" })] },
      makeContext({}),
      []
    );
    expect(text(errors)).toContain("nextWakeInTicks");
  });

  it("rejects illegal status migrations", () => {
    const context = makeContext({
      newCommands: [],
      activeActions: [activeAction()],
      triggerActionIds: ["action_live"],
    });
    const errors = validateRawResolution(
      {
        actions: [
          {
            actionId: "action_live",
            to: "cancelled",
            progressDeltaMinutes: 0,
          },
        ],
        occurrences: trace("action_live"),
      },
      context,
      []
    );
    expect(errors).toEqual([]);
    const bad = validateRawResolution(
      {
        actions: [
          {
            actionId: "action_live",
            to: "queued" as never,
            progressDeltaMinutes: 0,
          },
        ],
      },
      context,
      []
    );
    expect(text(bad)).toContain("illegal transition");
  });
});

describe("validateRawResolution — skill consistency", () => {
  const skillCommand = command({
    declaredSkillId: "Locksmith",
    skillRoll: {
      rollId: "r1",
      skillId: "Locksmith",
      skillValue: 60,
      roll: 45,
      successLevel: "regular",
    },
  });

  it("requires skill_assessed judgement for a skill command", () => {
    const errors = validateRawResolution(
      { actions: [entry()] },
      makeContext({ newCommands: [skillCommand] }),
      []
    );
    expect(text(errors)).toContain('must be kind "skill_assessed"');
  });

  it("rejects skill_assessed for a command without a roll", () => {
    const errors = validateRawResolution(
      {
        actions: [
          entry({
            judgement: {
              kind: "skill_assessed",
              applicability: "accepted",
              applicabilityBasis: "x",
              requiredLevel: "regular",
              requiredLevelBasis: "y",
              checkType: "single",
              targetIds: [],
              outcome: "success",
              reason: "z",
            },
          }),
        ],
      },
      makeContext({}),
      []
    );
    expect(text(errors)).toContain('must be kind "direct"');
  });

  it("accepts a consistent met check and rejects a contradicted one", () => {
    const base = entry({
      judgement: {
        kind: "skill_assessed",
        applicability: "accepted",
        applicabilityBasis: "picks on a pin lock",
        requiredLevel: "regular",
        requiredLevelBasis: "common lock, good light",
        checkType: "single",
        targetIds: [],
        outcome: "success",
        reason: "the lock yields",
      },
    });
    expect(
      validateRawResolution(
        { actions: [base], occurrences: trace() },
        makeContext({ newCommands: [skillCommand] }),
        []
      )
    ).toEqual([]);

    // regular roll vs extreme requirement claimed as success → contradiction.
    const contradicted = entry({
      judgement: {
        ...(base.judgement as never as Record<string, unknown>),
        requiredLevel: "extreme",
        requiredLevelBasis: "hair-trigger mechanism",
      } as never,
    });
    const errors = validateRawResolution(
      { actions: [contradicted] },
      makeContext({ newCommands: [skillCommand] }),
      []
    );
    expect(text(errors)).toContain("contradicts the deterministic check");
  });

  it("requires an opposedRoll invocation for each named defender", () => {
    const opposed = entry({
      judgement: {
        kind: "skill_assessed",
        applicability: "accepted",
        applicabilityBasis: "persuasion on a listener",
        requiredLevel: "regular",
        requiredLevelBasis: "no pressure",
        checkType: "opposed",
        targetIds: ["npc_2"],
        opposedDefense: [{ characterId: "npc_2", skillId: "Psychology" }],
        outcome: "success",
        reason: "he relents",
      },
    });
    const noCall = validateRawResolution(
      { actions: [opposed] },
      makeContext({ newCommands: [skillCommand] }),
      []
    );
    expect(text(noCall)).toContain("no opposedRoll tool call recorded");

    const withCall = validateRawResolution(
      { actions: [opposed], occurrences: trace() },
      makeContext({ newCommands: [skillCommand] }),
      [
        {
          toolName: "opposedRoll",
          input: { characterId: "npc_2", skillId: "Psychology" },
          output: {
            ok: true,
            record: {
              rollId: "rd",
              skillId: "Psychology",
              skillValue: 40,
              roll: 80,
              successLevel: "failure",
            },
          },
        },
      ]
    );
    expect(withCall).toEqual([]);
  });
});

describe("validateRawResolution — deltas and occurrences", () => {
  it("rejects unknown entities, missing causalBasis and unknown source actions", () => {
    const errors = validateRawResolution(
      {
        actions: [entry()],
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
      { actions: [entry()], itemChanges: [move("npc_2")] },
      makeContext({}),
      []
    );
    expect(text(wrongFrom)).toContain(
      "does not match the item's actual holder"
    );

    const doubleMove = validateRawResolution(
      {
        actions: [entry()],
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
        actions: [entry()],
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

  it("computes nextWakeAt from ticks and assigns occurrence/fact ids", () => {
    const raw: RawTickResolution = {
      actions: [
        entry({
          to: "active",
          nextWakeInTicks: 5,
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
    expect(t.to).toBe("active");
    expect(t.nextWakeAt).toBe("1923-04-02T09:20:00");
    expect(finalized.movementInits[ACTION_ID]).toEqual({
      destinationId: "SCN_1",
    });
    expect(finalized.judgements[ACTION_ID]).toMatchObject({
      kind: "direct",
      outcome: "success",
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
      actions: [
        entry({ to: "active", nextWakeInTicks: 2 }),
        {
          actionId: "action_live",
          to: "interrupted",
          progressDeltaMinutes: 3,
          reason: "abandoned for a new undertaking",
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
