// Phase 9 bundle assembly: ownAction derived from EngineAction lifecycle
// (transitions → ended, with the transition's reason; live action → ongoing with
// progress; neither → idle) and occurrence passthrough.

import { describe, expect, it } from "vitest";
import type {
  EngineAction,
  Occurrence,
} from "../../../engine/actions/types.js";
import type { TickEngine } from "../../../engine/core/tickEngine.js";
import type { TickReport } from "../../../engine/core/types.js";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { buildPerceivedBundle, resolveOwnAction } from "../buildBundle.js";

function makeEngine(actions: EngineAction[]): TickEngine {
  return {
    getActorActions: (actorId: string) =>
      actions.filter((a) => a.command.actorId === actorId),
    getAction: (id: string) => actions.find((a) => a.id === id),
  } as unknown as TickEngine;
}

const dgsm = {
  getNpcProfile: (id: string) => ({
    id,
    name: id,
    status: { conditions: [] },
  }),
  getCharacterPosition: () => ({ type: "scene", sceneId: "SCN_1" }),
  getCharacterSpot: () => null,
  getState: () => ({
    scenes: new Map([
      [
        "SCN_1",
        {
          id: "SCN_1",
          name: "Study",
          description: "a dim study",
          conditions: [],
          items: [],
        },
      ],
    ]),
    npcCharacters: [],
    characterPositions: {},
    roads: new Map(),
  }),
  getSceneConditions: () => [],
  getTopology: () => ({
    nodeSceneIds: new Set(),
    roads: new Map(),
    sceneToRoads: new Map(),
    sceneToParent: new Map([["SCN_1", "L1"]]),
  }),
  resolveLocationId: () => "SCN_1",
  getScene: () => ({
    id: "SCN_1",
    name: "Study",
    description: "a dim study",
    conditions: [],
    items: [],
  }),
} as unknown as DynamicGameStateManager;

function action(overrides: Partial<EngineAction> = {}): EngineAction {
  return {
    id: "action_1",
    command: {
      commandId: "c1",
      actorId: "npc_1",
      issuedAt: "t0",
      issuedSceneId: "SCN_1",
      description: "I search the desk.",
      objectRefs: [],
      proposedDurationTicks: 3,
    },
    status: "active",
    submittedAt: "t0",
    startedAt: "1923-04-02T09:01:00",
    progressMinutes: 2,
    resolvedDurationTicks: 5,
    ...overrides,
  };
}

function report(overrides: Partial<TickReport> = {}): TickReport {
  return {
    gameDateTime: "1923-04-02T09:05:00",
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

describe("resolveOwnAction", () => {
  it("derives ongoing state with intent, start and progress — no runtime internals", () => {
    const own = resolveOwnAction("npc_1", undefined, makeEngine([action()]));
    expect(own).toEqual({
      kind: "ongoing",
      description: "I search the desk.",
      startedAt: "1923-04-02T09:01:00",
      progressMinutes: 2,
      resolvedDurationTicks: 5,
    });
  });

  it("derives ended state from this tick's transition alone", () => {
    // Nothing writes a verdict onto the action: the Engine's account of what
    // came of it arrives as the transition's `reason`, and that is the whole
    // outcome surface. (A `runtime.judgement` slot used to be read here — it
    // never had a writer, so its fallback, the clock status, was what the
    // renderer got, dressed up as a result.)
    const done = action({ status: "completed" });
    const own = resolveOwnAction(
      "npc_1",
      report({
        transitions: [
          {
            actionId: "action_1",
            actorId: "npc_1",
            from: "active",
            to: "completed",
            progressDeltaMinutes: 3,
          },
        ],
      }),
      makeEngine([done])
    );
    expect(own).toEqual({
      kind: "ended",
      description: "I search the desk.",
      status: "completed",
    });
  });

  it("carries the transition's reason as the account of what came of it", () => {
    const failed = action({ status: "failed" });
    const own = resolveOwnAction(
      "npc_1",
      report({
        transitions: [
          {
            actionId: "action_1",
            actorId: "npc_1",
            from: "queued",
            to: "failed",
            progressDeltaMinutes: 0,
            reason: "actor is dead",
          },
        ],
      }),
      makeEngine([failed])
    );
    expect(own).toMatchObject({
      kind: "ended",
      status: "failed",
      reason: "actor is dead",
    });
    expect(own).not.toHaveProperty("outcome");
  });

  it("is idle with no report and no live action", () => {
    expect(resolveOwnAction("npc_1", undefined, makeEngine([]))).toEqual({
      kind: "idle",
    });
  });
});

describe("buildPerceivedBundle", () => {
  it("passes routed occurrences through untouched", () => {
    const occ: Occurrence = {
      id: "occ_1",
      tickId: "t",
      sourceActionIds: [],
      facts: [
        { id: "occ_1#f0", type: "sound", content: "a crash", entityRefs: [] },
      ],
      participants: [],
      perceiverCharacterIds: ["npc_1"],
      signals: [{ factIds: ["occ_1#f0"], channel: "sound" }],
    };
    const bundle = buildPerceivedBundle({
      npcId: "npc_1",
      occurrencesForNpc: [occ],
      dgsm,
      engine: makeEngine([]),
    });
    expect(bundle.occurrences).toEqual([occ]);
    expect(bundle.ownAction).toEqual({ kind: "idle" });
  });

  it("carries the viewpoint's own spot and a co-located character's", () => {
    // Both reach the renderer prompt: your own is proprioceptive, theirs is
    // as visible as the armchair they are sitting in.
    const base = dgsm as unknown as { getState: () => Record<string, unknown> };
    const spotted = {
      ...dgsm,
      getCharacterSpot: (id: string) =>
        id === "npc_1" ? "at the workbench" : "in the corner armchair",
      isNpcAlive: () => true,
      getState: () => ({
        ...base.getState(),
        npcCharacters: [{ id: "npc_1" }, { id: "npc_2" }],
      }),
    } as unknown as DynamicGameStateManager;

    const bundle = buildPerceivedBundle({
      npcId: "npc_1",
      dgsm: spotted,
      engine: makeEngine([]),
    });

    expect(bundle.ownSpot).toBe("at the workbench");
    expect(bundle.charactersInScene.map((c) => c.spot)).toEqual([
      "in the corner armchair",
    ]);
  });

  it("omits the spot entirely when there is none", () => {
    const bundle = buildPerceivedBundle({
      npcId: "npc_1",
      dgsm,
      engine: makeEngine([]),
    });
    expect(bundle.ownSpot).toBeUndefined();
  });
});

// A sheriff spent three ticks failing to leave his own bedroom: every
// paragraph rendered the armchair and the light, and none of them said the
// door led to the living room. His memories are about the town — the lane,
// the main street, the docks — and hold nothing about which door of his own
// house opens where. Perception was his only source, and it did not say.
describe("the ways out", () => {
  /** A study whose door leads to the hall, optionally unfound. */
  function studyWithDoor(hidden: boolean): DynamicGameStateManager {
    const study = {
      id: "SCN_1",
      name: "Study",
      description: "a dim study",
      conditions: [],
      items: [],
      connections: [
        {
          id: "connection.study.door",
          targetId: "SCN_HALL",
          ...(hidden ? { hidden: true } : {}),
        },
      ],
    };
    const hall = {
      id: "SCN_HALL",
      name: "The Hall",
      description: "a hall",
      conditions: [],
      items: [],
      connections: [],
    };
    const scenes = new Map([
      ["SCN_1", study],
      ["SCN_HALL", hall],
    ]);
    return {
      ...(dgsm as unknown as Record<string, unknown>),
      getState: () => ({
        scenes,
        npcCharacters: [],
        characterPositions: {},
        roads: new Map(),
      }),
      getScene: (id: string) => scenes.get(id) ?? null,
      getTopology: () => ({
        nodeSceneIds: new Set(),
        roads: new Map(),
        sceneToRoads: new Map(),
        sceneToParent: new Map([["SCN_1", "L1"]]),
      }),
    } as unknown as DynamicGameStateManager;
  }

  it("carries the place this one leads to, by name", () => {
    const bundle = buildPerceivedBundle({
      npcId: "npc_1",
      dgsm: studyWithDoor(false),
      engine: makeEngine([]),
    });
    expect(bundle.scene.adjacentPlaces).toContainEqual({
      id: "SCN_HALL",
      name: "The Hall",
    });
  });

  it("leaves out a passage the character has not found", () => {
    // `adjacentIds` filters `!c.hidden` upstream, so an unrevealed door never
    // reaches the bundle — a renderer told to write the ways out cannot hand
    // the character one they have not discovered.
    const bundle = buildPerceivedBundle({
      npcId: "npc_1",
      dgsm: studyWithDoor(true),
      engine: makeEngine([]),
    });
    expect(bundle.scene.adjacentPlaces.map((e) => e.id)).not.toContain(
      "SCN_HALL"
    );
  });
});
