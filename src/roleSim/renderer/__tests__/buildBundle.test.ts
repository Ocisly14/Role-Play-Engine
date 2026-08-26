// Phase 9 bundle assembly: ownAction derived from EngineAction lifecycle
// (transitions → ended + judgement surface; live action → ongoing with
// progress; neither → idle) and occurrence passthrough.

import { describe, expect, it } from "vitest";
import type { EngineAction, Occurrence } from "../../../engine/actions/types.js";
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
    junctions: new Map(),
    roads: new Map(),
  }),
  getSceneConditions: () => [],
  getTopology: () => ({
    junctions: new Map(),
    roads: new Map(),
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

  it("derives ended state from this tick's transition plus the judgement", () => {
    const done = action({
      status: "completed",
      runtime: {
        judgement: {
          kind: "direct",
          outcome: "success",
          reason: "the drawer yields a ledger",
        },
      },
    });
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
      outcome: { outcome: "success", reason: "the drawer yields a ledger" },
    });
  });

  it("falls back to the transition reason when no judgement exists", () => {
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
      outcome: { outcome: "failed", reason: "actor is dead" },
    });
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
      facts: [{ id: "occ_1#f0", type: "sound", content: "a crash", entityRefs: [] }],
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
});
