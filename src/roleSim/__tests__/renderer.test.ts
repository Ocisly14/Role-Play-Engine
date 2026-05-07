// src/roleSim/__tests__/renderer.test.ts
//
// Phase G renderer tests. Covers PerceivedBundle composition, god-eye
// fallback shape, and render() retry/fallback behavior with a mocked
// generateText.

import { vi } from "vitest";
import type { TickEngine } from "../../engine/core/tickEngine.js";
import type {
  ActionStep,
  CharacterAction,
  FeatureEvent,
  TickReport,
} from "../../engine/core/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { buildPerceivedBundle } from "../renderer/buildBundle.js";
import { buildGodEyeFallback } from "../renderer/godEyeFallback.js";
import { render } from "../renderer/index.js";

// Mockable generateText. Tests reach in via vi.mocked() to control behavior.
vi.mock("../../models/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../models/index.js")>(
    "../../models/index.js"
  );
  return {
    ...actual,
    generateText: vi.fn(),
  };
});
const { generateText } = await import("../../models/index.js");

// ---- Test doubles ----------------------------------------------------------

function makeDgsm(opts?: {
  sceneId?: string;
  sceneName?: string;
  sceneDescription?: string;
  sceneConditions?: Array<{ description: string }>;
  npcConditions?: Array<{ id: string; description: string }>;
}): DynamicGameStateManager {
  const sceneId = opts?.sceneId ?? "kitchen";
  const scene = {
    id: sceneId,
    name: opts?.sceneName ?? "kitchen",
    description: opts?.sceneDescription ?? "warm room",
    conditions: opts?.sceneConditions ?? [],
    items: [],
    parentLocationId: "house",
    connections: [],
  };
  return {
    getCharacterPosition: () => ({ type: "scene", sceneId }),
    resolveLocationId: (pos: { sceneId?: string }) => pos.sceneId ?? "",
    getScene: (id: string) => (id === sceneId ? scene : null),
    getNpcProfile: () => ({
      id: "npc1",
      name: "Alice",
      attributes: {},
      status: { conditions: opts?.npcConditions ?? [] },
      inventory: [],
      skills: {},
      longTermIntent: "",
      relationships: [],
    }),
    getState: () => ({
      npcCharacters: [
        {
          id: "npc1",
          name: "Alice",
          status: { conditions: opts?.npcConditions ?? [] },
          attributes: {},
          inventory: [],
          skills: {},
          longTermIntent: "",
          relationships: [],
        },
      ],
      characterPositions: { npc1: { type: "scene", sceneId } },
    }),
    isNpcAlive: () => true,
    getGameDateTime: () => "1923-10-17T08:00:00",
  } as unknown as DynamicGameStateManager;
}

function makeEngine(active?: ActionStep): TickEngine {
  return {
    getActorQueue: () => (active ? [active] : []),
  } as unknown as TickEngine;
}

function emptyReport(): TickReport {
  return {
    gameDateTime: "1923-10-17T08:00:00",
    commits: [],
    interruptions: [],
    cancellations: [],
    featureEvents: [],
    stateChanges: [],
    damageReports: [],
  };
}

function makeAction(actionText: string): CharacterAction {
  return {
    characterId: "npc1",
    handleId: "h1",
    stepGroupId: "g1",
    stepIndex: 0,
    definitionId: "action",
    actionText,
    sceneId: "kitchen",
    targetCharacterIds: [],
    activatedAt: "1923-10-17T08:00:00",
    completedAt: "1923-10-17T08:01:00",
  };
}

function activeStep(actionText: string): ActionStep {
  return {
    id: "step1",
    handle: {
      id: "h1",
      characterId: "npc1",
      submittedAt: "1923-10-17T08:00:00",
    },
    stepGroupId: "g1",
    stepIndex: 0,
    characterId: "npc1",
    targetCharacterIds: [],
    actionText,
    definitionId: "action",
    executionSceneId: "kitchen",
    submittedAt: "1923-10-17T08:00:00",
    status: "active",
  };
}

// ---- buildPerceivedBundle ---------------------------------------------------

describe("buildPerceivedBundle", () => {
  test("idle: ownAction.kind === 'idle' when no active step + no report entries", () => {
    const dgsm = makeDgsm();
    const engine = makeEngine();
    const bundle = buildPerceivedBundle({
      npcId: "npc1",
      report: emptyReport(),
      eventsForNpc: [],
      dgsm,
      engine,
    });
    expect(bundle.ownAction.kind).toBe("idle");
    expect(bundle.scene.name).toBe("kitchen");
    expect(bundle.events).toEqual([]);
  });

  test("ongoing: derives from engine queue when no end entry in report", () => {
    const dgsm = makeDgsm();
    const engine = makeEngine(activeStep("reading the journal"));
    const bundle = buildPerceivedBundle({
      npcId: "npc1",
      report: emptyReport(),
      eventsForNpc: [],
      dgsm,
      engine,
    });
    expect(bundle.ownAction).toEqual({
      kind: "ongoing",
      actionText: "reading the journal",
    });
  });

  test("ended: maps committed/interrupted/cancelled status", () => {
    const dgsm = makeDgsm();
    const engine = makeEngine();
    const report = emptyReport();
    report.commits.push(makeAction("finish reading"));
    const bundle = buildPerceivedBundle({
      npcId: "npc1",
      report,
      eventsForNpc: [],
      dgsm,
      engine,
    });
    expect(bundle.ownAction).toEqual({
      kind: "ended",
      actionText: "finish reading",
      status: "committed",
    });
  });

  test("ended: interruption maps to 'interrupted'", () => {
    const dgsm = makeDgsm();
    const engine = makeEngine();
    const report = emptyReport();
    report.interruptions.push({
      action: makeAction("flee"),
      reason: { triggerKind: "perception", description: "fire" },
    });
    const bundle = buildPerceivedBundle({
      npcId: "npc1",
      report,
      eventsForNpc: [],
      dgsm,
      engine,
    });
    expect(bundle.ownAction).toMatchObject({
      kind: "ended",
      status: "interrupted",
    });
  });

  test("works without a TickReport (bootstrap path)", () => {
    const dgsm = makeDgsm();
    const engine = makeEngine();
    const bundle = buildPerceivedBundle({
      npcId: "npc1",
      dgsm,
      engine,
    });
    expect(bundle.ownAction.kind).toBe("idle");
  });
});

// ---- buildGodEyeFallback ---------------------------------------------------

describe("buildGodEyeFallback", () => {
  test("emits scene baseline + own action + each event description", () => {
    const dgsm = makeDgsm({
      sceneName: "library",
      sceneDescription: "shelves",
    });
    const event: FeatureEvent = {
      type: "fire.spread",
      impact: 3,
      description: "Flames climb the east wall.",
      sceneId: "library",
    };
    const text = buildGodEyeFallback(
      "npc1",
      {
        scene: {
          id: "library",
          name: "library",
          description: "shelves",
          activeConditions: [{ description: "smoky" }],
        },
        ownConditions: [],
        ownAction: { kind: "ongoing", actionText: "reading the journal" },
        events: [event],
      },
      dgsm
    );
    expect(text).toContain("You are in library.");
    expect(text).toContain("shelves");
    expect(text).toContain("smoky");
    expect(text).toContain('"reading the journal"');
    expect(text).toContain("Flames climb the east wall.");
  });

  test("idle + no events still produces something", () => {
    const dgsm = makeDgsm({ sceneName: "kitchen" });
    const text = buildGodEyeFallback(
      "npc1",
      {
        scene: {
          id: "kitchen",
          name: "kitchen",
          description: "",
          activeConditions: [],
        },
        ownConditions: [],
        ownAction: { kind: "idle" },
        events: [],
      },
      dgsm
    );
    expect(text).toContain("kitchen");
    expect(text.length).toBeGreaterThan(0);
  });
});

// ---- render() (retry + fallback) -------------------------------------------

describe("render() with mocked generateText", () => {
  test("returns LLM output when generateText resolves", async () => {
    vi.mocked(generateText).mockResolvedValueOnce(
      "[narrative]\nI hear footsteps.\n\n[references]\n[1] Bob: tall man"
    );
    const dgsm = makeDgsm();
    const engine = makeEngine();
    const bundle = buildPerceivedBundle({
      npcId: "npc1",
      dgsm,
      engine,
    });
    const out = await render({ npcId: "npc1", bundle, dgsm });
    expect(out.llmSucceeded).toBe(true);
    expect(out.narrative).toContain("[narrative]");
    expect(out.narrative).toContain("footsteps");
  });

  test("falls back to god-eye when generateText throws", async () => {
    vi.mocked(generateText).mockRejectedValueOnce(new Error("boom"));
    const dgsm = makeDgsm({ sceneName: "parlor" });
    const engine = makeEngine();
    const bundle = buildPerceivedBundle({
      npcId: "npc1",
      dgsm,
      engine,
    });
    const out = await render({ npcId: "npc1", bundle, dgsm });
    expect(out.llmSucceeded).toBe(false);
    expect(out.narrative).toContain("parlor");
  });

  test("falls back when LLM returns empty string", async () => {
    vi.mocked(generateText).mockResolvedValueOnce("   ");
    const dgsm = makeDgsm();
    const engine = makeEngine();
    const bundle = buildPerceivedBundle({
      npcId: "npc1",
      dgsm,
      engine,
    });
    const out = await render({ npcId: "npc1", bundle, dgsm });
    expect(out.llmSucceeded).toBe(false);
    expect(out.narrative.length).toBeGreaterThan(0);
  });
});
