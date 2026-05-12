// src/roleSim/__tests__/renderer.test.ts
//
// Phase G renderer tests. Covers PerceivedBundle composition and render()
// null-fallback behavior (D6) with a mocked generateText.
/// <reference types="vitest/globals" />

import { vi } from "vitest";
import type { TickEngine } from "../../engine/core/tickEngine.js";
import type {
  ActionStep,
  CharacterAction,
  TickReport,
} from "../../engine/core/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { buildPerceivedBundle } from "../renderer/buildBundle.js";
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
    referencedEntities: [],
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
    referencedEntities: [],
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

// ---- render() — D6 null fallback -------------------------------------------

describe("render() — D6 null fallback", () => {
  function makeBundle() {
    const dgsm = makeDgsm();
    const engine = makeEngine();
    const bundle = buildPerceivedBundle({ npcId: "npc1", dgsm, engine });
    return { bundle, dgsm };
  }

  test("returns null when LLM throws after retries", async () => {
    vi.mocked(generateText).mockRejectedValue(new Error("LLM hard fail"));
    const { bundle, dgsm } = makeBundle();
    const result = await render({ npcId: "npc1", bundle, dgsm });
    expect(result).toBeNull();
  });

  test("returns null when LLM returns empty output", async () => {
    vi.mocked(generateText).mockResolvedValue("   ");
    const { bundle, dgsm } = makeBundle();
    const result = await render({ npcId: "npc1", bundle, dgsm });
    expect(result).toBeNull();
  });

  test("returns RenderedPerception { narrative } on success — no llmSucceeded field", async () => {
    vi.mocked(generateText).mockResolvedValue(
      "[narrative]\nI walk in.\n\n[references]\n"
    );
    const { bundle, dgsm } = makeBundle();
    const result = await render({ npcId: "npc1", bundle, dgsm });
    expect(result).toEqual({
      narrative: "[narrative]\nI walk in.\n\n[references]",
    });
    expect(result && "llmSucceeded" in result).toBe(false);
  });
});
