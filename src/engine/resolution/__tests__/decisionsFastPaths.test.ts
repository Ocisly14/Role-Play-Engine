import { describe, expect, it, vi } from "vitest";
import {
  type DecisionQuestion,
  type DecisionsTransport,
  setDecisionsTransport,
} from "../../../models/decisions.js";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { type RoadNode, buildTopology } from "../../../state/topologyTypes.js";
import type { DynamicScene } from "../../../state/types.js";
import { placesAdjacent } from "../../actions/movementRuntime.js";
import {
  DURATION_BINS,
  decideStarts,
  leanedCheckLevel,
  routeCandidates,
  topGrade,
} from "../decisionsFastPaths.js";
import type { EngineResolutionContext } from "../types.js";

/** A hall with an open door to a kitchen, a study behind a concealed door
 *  off the kitchen, and a yard off the hall. */
function makeDgsm(): DynamicGameStateManager {
  const scene = (
    id: string,
    connections: Array<{ id: string; targetId: string; concealed?: boolean }>
  ) => ({ id, name: id, description: "", connections, items: [] });
  const scenes = new Map<string, unknown>([
    [
      "SCN_hall",
      scene("SCN_hall", [
        { id: "c.hall.kitchen", targetId: "SCN_kitchen" },
        { id: "c.hall.yard", targetId: "SCN_yard" },
      ]),
    ],
    [
      "SCN_kitchen",
      scene("SCN_kitchen", [
        { id: "c.kitchen.hall", targetId: "SCN_hall" },
        { id: "c.kitchen.study", targetId: "SCN_study", concealed: true },
      ]),
    ],
    ["SCN_study", scene("SCN_study", [])],
    [
      "SCN_yard",
      scene("SCN_yard", [{ id: "c.yard.hall", targetId: "SCN_hall" }]),
    ],
  ]);
  const roads = new Map<string, RoadNode>();
  return {
    getScene: (id: string) => scenes.get(id) ?? null,
    getTopology: () =>
      buildTopology(scenes as unknown as Map<string, DynamicScene>, roads),
  } as unknown as DynamicGameStateManager;
}

describe("DURATION_BINS", () => {
  it("has the 43 agreed bins, from a minute to a week", () => {
    expect(DURATION_BINS).toHaveLength(43);
    expect(DURATION_BINS.slice(0, 8)).toEqual([1, 2, 3, 5, 10, 15, 30, 60]);
    expect(DURATION_BINS).toContain(120);
    expect(DURATION_BINS).toContain(1440);
    expect(DURATION_BINS).toContain(1800);
    expect(DURATION_BINS).toContain(4320);
    expect(DURATION_BINS.at(-1)).toBe(10080);
    expect([...DURATION_BINS].sort((a, b) => a - b)).toEqual([
      ...DURATION_BINS,
    ]);
    expect(new Set(DURATION_BINS).size).toBe(43);
  });
});

it("asks for timing but skips difficulty and opposition for a retired social skill", async () => {
  const transport = vi.fn<DecisionsTransport>(async (_url, { body }) => {
    const { questions } = JSON.parse(body) as {
      questions: DecisionQuestion[];
    };
    expect(questions.map((q) => q.name)).toEqual(["duration:action_probe"]);
    return {
      status: 200,
      json: async () => ({
        answers: [
          {
            type: "choice",
            name: "duration:action_probe",
            probabilities: [{ value: "1", probability: 0.99 }],
          },
        ],
      }),
    };
  });
  vi.stubEnv("OPENAI_API_KEY", "test-key");
  setDecisionsTransport(transport);
  try {
    const context: EngineResolutionContext = {
      trigger: {
        triggers: [{ reason: "new_action", actionIds: ["action_probe"] }],
        actionIds: ["action_probe"],
      },
      tick: {
        tickId: "t",
        tickStartTime: "1923-04-02T09:00:00",
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
        places: [],
        placeKinds: {},
        connectionIds: [],
        items: [],
        itemHolders: {},
        characters: [],
      },
      actions: {
        newCommands: [
          {
            commandId: "probe",
            actorId: "npc_1",
            issuedAt: "1923-04-02T09:00:00",
            issuedSceneId: "SCN_hall",
            description: "I ask him where he was last night.",
            utterance: "Where were you last night?",
            objectRefs: [{ kind: "character", id: "npc_2" }],
            proposedDurationTicks: 1,
            declaredSkillId: "Social",
          },
        ],
        activeActions: [],
      },
      events: { objectiveWorldEvents: [], deterministicResults: [] },
    };
    const { rows } = await decideStarts(context, makeDgsm());
    expect(transport).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([
      { actionId: "action_probe", resolvedDurationTicks: 1 },
    ]);
  } finally {
    setDecisionsTransport(null);
    vi.unstubAllEnvs();
  }
});

describe("topGrade", () => {
  const ans = (p: Record<string, number>) => ({
    name: "x",
    type: "choice" as const,
    probabilities: p,
  });
  const SIGHT = ["none", "glimpse", "partial", "clear"] as const;
  const HEARING = ["none", "faint", "muffled", "clear"] as const;

  it("takes the most probable grade, however close the next", () => {
    expect(topGrade(ans({ clear: 0.7, partial: 0.2 }), SIGHT)).toBe("clear");
    expect(topGrade(ans({ partial: 0.45, clear: 0.4 }), SIGHT)).toBe("partial");
    expect(topGrade(ans({ none: 0.45, faint: 0.4 }), HEARING)).toBe("none");
  });

  it("a most probable 'none' is taken as it is", () => {
    expect(topGrade(ans({ none: 0.63, faint: 0.33 }), HEARING)).toBe("none");
  });

  it("no answer → none", () => {
    expect(topGrade(undefined, SIGHT)).toBe("none");
  });
});

describe("leanedCheckLevel", () => {
  const ans = (p: Record<string, number>) => ({
    name: "x",
    type: "choice" as const,
    probabilities: p,
  });

  it("takes the most probable level when the top two are apart", () => {
    expect(leanedCheckLevel(ans({ regular: 0.43, none: 0.27 }), 0.1)).toBe(
      "regular"
    );
    expect(leanedCheckLevel(ans({ none: 0.63, regular: 0.31 }), 0.1)).toBe(
      "none"
    );
  });

  it("a close call between no check and a bar takes the bar", () => {
    expect(leanedCheckLevel(ans({ none: 0.39, regular: 0.31 }), 0.1)).toBe(
      "regular"
    );
    expect(leanedCheckLevel(ans({ hard: 0.4, none: 0.35 }), 0.1)).toBe("hard");
  });

  it("a close call between two bars takes the lower", () => {
    expect(leanedCheckLevel(ans({ hard: 0.45, regular: 0.4 }), 0.1)).toBe(
      "regular"
    );
    expect(leanedCheckLevel(ans({ regular: 0.45, extreme: 0.4 }), 0.1)).toBe(
      "regular"
    );
  });

  it("no answer → null", () => {
    expect(leanedCheckLevel(undefined, 0.1)).toBeNull();
  });
});

describe("concealed passages and stated routes", () => {
  it("a concealed passage joins nothing without its grant", () => {
    const dgsm = makeDgsm();
    expect(placesAdjacent(dgsm, "SCN_kitchen", "SCN_study")).toBe(false);
    expect(
      placesAdjacent(dgsm, "SCN_kitchen", "SCN_study", "c.kitchen.study")
    ).toBe(true);
    expect(placesAdjacent(dgsm, "SCN_hall", "SCN_kitchen")).toBe(true);
  });

  it("routes are built only from the places the actor cited", () => {
    const dgsm = makeDgsm();
    // Cited the kitchen: one step.
    expect(routeCandidates(dgsm, "SCN_hall", ["SCN_kitchen"])).toEqual([
      ["SCN_kitchen"],
    ]);
    // Cited the study behind the concealed door: no candidate walks there.
    expect(
      routeCandidates(dgsm, "SCN_hall", ["SCN_kitchen", "SCN_study"])
    ).toEqual([["SCN_kitchen"]]);
    // Cited nothing: nothing to walk.
    expect(routeCandidates(dgsm, "SCN_hall", [])).toEqual([]);
  });

  it("offers the implied first step onto the way when the first cited place is one step further", () => {
    const dgsm = makeDgsm();
    const routes = routeCandidates(dgsm, "SCN_yard", ["SCN_kitchen"]);
    expect(routes).toContainEqual(["SCN_hall", "SCN_kitchen"]);
  });
});

describe("decideStarts reads the top answer, except for the check level", () => {
  /** A one-command start context in SCN_hall; the command declares `skill`
   *  when given. */
  function startContext(skill?: string): EngineResolutionContext {
    return {
      trigger: {
        triggers: [{ reason: "new_action", actionIds: ["action_c1"] }],
        actionIds: ["action_c1"],
      },
      tick: {
        tickId: "t",
        tickStartTime: "1923-04-02T09:00:00",
        durationMinutes: 1,
      },
      rules: {
        resolutionGuide: "x",
        outputSchemaVersion: 1,
        worldInvariants: [],
      },
      state: {
        graph: { places: [], edges: [] },
        blockedEdges: [],
        places: [],
        placeKinds: {},
        connectionIds: [],
        items: [],
        itemHolders: {},
        characters: [],
      },
      actions: {
        newCommands: [
          {
            commandId: "c1",
            actorId: "npc_1",
            issuedAt: "1923-04-02T09:00:00",
            issuedSceneId: "SCN_hall",
            description: "I count the till against the ledger.",
            objectRefs: [],
            proposedDurationTicks: 10,
            ...(skill ? { declaredSkillId: skill } : {}),
          },
        ],
        activeActions: [],
      },
      events: { objectiveWorldEvents: [], deterministicResults: [] },
    } as unknown as EngineResolutionContext;
  }

  function answering(answers: unknown[]): DecisionsTransport {
    return async () => ({ status: 200, json: async () => ({ answers }) });
  }

  it("a spread duration still gives a row, at its most probable bin", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    setDecisionsTransport(
      answering([
        {
          type: "choice",
          name: "duration:action_c1",
          probabilities: [
            { value: "10", probability: 0.35 },
            { value: "5", probability: 0.17 },
            { value: "15", probability: 0.3 },
          ],
        },
      ])
    );
    try {
      const { rows } = await decideStarts(startContext(), makeDgsm());
      expect(rows).toEqual([
        { actionId: "action_c1", resolvedDurationTicks: 10 },
      ]);
    } finally {
      setDecisionsTransport(null);
      vi.unstubAllEnvs();
    }
  });

  it("a close call between no check and a bar rolls the dice", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");
    setDecisionsTransport(
      answering([
        {
          type: "choice",
          name: "duration:action_c1",
          probabilities: [{ value: "10", probability: 0.9 }],
        },
        {
          type: "choice",
          name: "check:action_c1",
          probabilities: [
            { value: "none", probability: 0.39 },
            { value: "regular", probability: 0.31 },
            { value: "hard", probability: 0.23 },
          ],
        },
      ])
    );
    try {
      const { rows, decided } = await decideStarts(
        startContext("Knowledge & Craft"),
        makeDgsm()
      );
      expect(rows).toEqual([
        {
          actionId: "action_c1",
          resolvedDurationTicks: 10,
          check: { requiredLevel: "regular" },
        },
      ]);
      expect(decided.has("action_c1")).toBe(true);
    } finally {
      setDecisionsTransport(null);
      vi.unstubAllEnvs();
    }
  });
});
