import { describe, expect, it } from "vitest";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../DynamicGameState.js";

function makeManager(): DynamicGameStateManager {
  const state = initialDynamicGameState({
    sessionId: "scoped-feature-test",
    moduleName: "test-module",
  });
  return new DynamicGameStateManager(state);
}

describe("DGSM scoped feature state", () => {
  it("stores per-scope buckets independently", () => {
    const d = makeManager();
    d.setScopedFeatureState("fire", "scene", "s1", { intensity: 3 });
    d.setScopedFeatureState("weather", "region", "r1", { kind: "storm" });
    d.setScopedFeatureState("stamina", "character", "npc1", { value: 80 });
    d.setScopedFeatureState("timeOfDay", "global", "", { phase: "dawn" });

    expect(d.getScopedFeatureState("fire", "scene", "s1")).toEqual({
      intensity: 3,
    });
    expect(d.getScopedFeatureState("weather", "region", "r1")).toEqual({
      kind: "storm",
    });
    expect(d.getScopedFeatureState("stamina", "character", "npc1")).toEqual({
      value: 80,
    });
    expect(d.getScopedFeatureState("timeOfDay", "global", "")).toEqual({
      phase: "dawn",
    });
  });

  it("getAllScopedFeatureStates returns all entries for a feature in a scope", () => {
    const d = makeManager();
    d.setScopedFeatureState("fire", "scene", "s1", { intensity: 1 });
    d.setScopedFeatureState("fire", "scene", "s2", { intensity: 2 });
    const all = d.getAllScopedFeatureStates("fire", "scene");
    expect(all).toHaveLength(2);
    expect(new Set(all.map((e) => e.key))).toEqual(new Set(["s1", "s2"]));
  });

  it("removeScopedFeatureState deletes one entry without touching others", () => {
    const d = makeManager();
    d.setScopedFeatureState("fire", "scene", "s1", { intensity: 1 });
    d.setScopedFeatureState("fire", "scene", "s2", { intensity: 2 });
    d.removeScopedFeatureState("fire", "scene", "s1");
    expect(d.getScopedFeatureState("fire", "scene", "s1")).toBeUndefined();
    expect(d.getScopedFeatureState("fire", "scene", "s2")).toEqual({
      intensity: 2,
    });
  });
});
