import { describe, expect, it, vi } from "vitest";
import type { CharacterAction } from "../../../planning/types.js";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { TownTopology } from "../../../state/topologyTypes.js";
import {
  applyIncidentalActionMove,
  sanitizeFatigueDelta,
  shouldRunResolver,
} from "../actionPostProcessing.js";

function createTopology(): TownTopology {
  return {
    junctions: new Map(),
    roads: new Map(),
    junctionToRoads: new Map(),
    sceneToParent: new Map([
      ["study", { type: "junction", junctionId: "JUNC_1" }],
      ["courtyard", { type: "junction", junctionId: "JUNC_1" }],
    ]),
  };
}

describe("applyIncidentalActionMove", () => {
  it("repositions the actor when moveTo resolves to a valid location", () => {
    const setCharacterPosition = vi.fn();
    const dgsm = {
      getTopology: () => createTopology(),
      getState: () => ({
        scenes: new Map(),
        scenarioOutlines: [],
      }),
      setCharacterPosition,
    } as unknown as DynamicGameStateManager;

    const moved = applyIncidentalActionMove({
      dgsm,
      characterId: "npc-1",
      moveTo: "courtyard",
    });

    expect(moved).toBe(true);
    expect(setCharacterPosition).toHaveBeenCalledWith("npc-1", {
      type: "scene",
      sceneId: "courtyard",
    });
  });

  it("ignores an invalid moveTo without moving the actor", () => {
    const setCharacterPosition = vi.fn();
    const dgsm = {
      getTopology: () => createTopology(),
      getState: () => ({
        scenes: new Map(),
        scenarioOutlines: [],
      }),
      setCharacterPosition,
    } as unknown as DynamicGameStateManager;

    const moved = applyIncidentalActionMove({
      dgsm,
      characterId: "npc-1",
      moveTo: "unknown_destination",
    });

    expect(moved).toBe(false);
    expect(setCharacterPosition).not.toHaveBeenCalled();
  });
});

describe("shouldRunResolver", () => {
  function makeAction(
    overrides: Partial<CharacterAction>
  ): CharacterAction {
    return {
      action: "test action",
      status: "completed",
      outcome: "done",
      gameTime: "10:00",
      location: "room1",
      impact: 0,
      ...overrides,
    } as CharacterAction;
  }

  it("returns true for completed actions", () => {
    expect(shouldRunResolver(makeAction({ status: "completed" }))).toBe(true);
  });

  it("returns true for interrupted actions", () => {
    expect(shouldRunResolver(makeAction({ status: "interrupted" }))).toBe(true);
  });

  it("returns true for skill_roll_failed actions", () => {
    expect(
      shouldRunResolver(
        makeAction({ status: "failed", failureReason: "skill_roll_failed" })
      )
    ).toBe(true);
  });

  it("returns false for other failed actions", () => {
    expect(
      shouldRunResolver(
        makeAction({ status: "failed", failureReason: "target_absent" })
      )
    ).toBe(false);
  });

  it("returns false for failed actions without skill_roll_failed", () => {
    expect(
      shouldRunResolver(
        makeAction({ status: "failed", failureReason: "prerequisite_not_met" })
      )
    ).toBe(false);
  });
});

describe("sanitizeFatigueDelta", () => {
  const shortCtx = { executionStatus: "completed" as const, startedAt: "08:00", resolvedAt: "08:30", elapsedMinutes: 30, plannedMinutes: 30 };
  const longCtx = { executionStatus: "completed" as const, startedAt: "08:00", resolvedAt: "12:00", elapsedMinutes: 240, plannedMinutes: 240 };

  it("returns 0 for null or undefined", () => {
    expect(sanitizeFatigueDelta(undefined, shortCtx)).toBe(0);
    expect(sanitizeFatigueDelta(null as any, shortCtx)).toBe(0);
  });

  it("returns 0 for NaN or Infinity", () => {
    expect(sanitizeFatigueDelta(NaN, shortCtx)).toBe(0);
    expect(sanitizeFatigueDelta(Infinity, shortCtx)).toBe(0);
  });

  it("clamps to ±3 for short actions (30 min)", () => {
    expect(sanitizeFatigueDelta(5, shortCtx)).toBe(3);
    expect(sanitizeFatigueDelta(-5, shortCtx)).toBe(-3);
  });

  it("allows up to ±8 for long actions (240 min)", () => {
    expect(sanitizeFatigueDelta(7, longCtx)).toBe(7);
    expect(sanitizeFatigueDelta(-6, longCtx)).toBe(-6);
    expect(sanitizeFatigueDelta(10, longCtx)).toBe(8);
    expect(sanitizeFatigueDelta(-10, longCtx)).toBe(-8);
  });

  it("truncates fractional values", () => {
    expect(sanitizeFatigueDelta(2.7, shortCtx)).toBe(2);
    expect(sanitizeFatigueDelta(-1.9, shortCtx)).toBe(-1);
  });
});
