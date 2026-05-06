import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { makeDGSMFeatureReadContext } from "../../core/featureReadContext.js";
import type { StateChange } from "../../core/types.js";
import {
  TRANSITION_MATRIX,
  WEATHER_TYPES,
  type WeatherInitConfigEntry,
  type WeatherRegionState,
  weatherFeature,
} from "../weatherFeature.js";

function makeWeatherCtx(dgsm: DynamicGameStateManager) {
  return makeDGSMFeatureReadContext(dgsm, {
    callerFeatureId: "weather",
    callerScope: "region",
  });
}

function seedTownAndForest(dgsm: DynamicGameStateManager): void {
  dgsm.updateScene("town_square", {
    id: "town_square",
    name: "Town Square",
    description: "",
    parentLocationId: "town",
    items: [],
    conditions: [],
    connections: [{ targetId: "main_street" }],
  });
  dgsm.updateScene("main_street", {
    id: "main_street",
    name: "Main Street",
    description: "",
    parentLocationId: "town",
    items: [],
    conditions: [],
    connections: [{ targetId: "town_square" }, { targetId: "tavern" }],
  });
  dgsm.updateScene("tavern", {
    id: "tavern",
    name: "Tavern",
    description: "",
    parentLocationId: "town",
    items: [],
    conditions: [],
    connections: [{ targetId: "main_street" }],
    indoor: true,
  });
}

describe("weatherFeature internal invariants", () => {
  it("Markov transition matrix rows sum to ~1.0 for every weather type", () => {
    expect(TRANSITION_MATRIX).toHaveLength(WEATHER_TYPES.length);
    for (let i = 0; i < TRANSITION_MATRIX.length; i++) {
      const row = TRANSITION_MATRIX[i];
      expect(row).toHaveLength(WEATHER_TYPES.length);
      const sum = row.reduce((acc, v) => acc + v, 0);
      expect(
        sum,
        `row ${i} (${WEATHER_TYPES[i]}) must sum to ~1.0 (got ${sum})`
      ).toBeGreaterThanOrEqual(0.999);
      expect(sum).toBeLessThanOrEqual(1.001);
    }
  });

  it("init returns empty StateChange[] when no preset config is present", () => {
    const dgsm = new DynamicGameStateManager();
    seedTownAndForest(dgsm);
    const ctx = makeWeatherCtx(dgsm);
    const changes = weatherFeature.init?.(ctx) ?? [];
    expect(changes).toEqual([]);
  });

  it("init emits region state + env contribution + scene condition for non-clear preset", () => {
    const dgsm = new DynamicGameStateManager();
    seedTownAndForest(dgsm);
    const presets: WeatherInitConfigEntry[] = [
      { regionId: "town", weatherType: "fog", intensity: 3 },
    ];
    dgsm.loadWorldData({
      moduleSetup: {
        startDate: "1923-10-17",
        featureInit: { weather: presets },
      },
    });
    const ctx = makeWeatherCtx(dgsm);
    const changes: StateChange[] = weatherFeature.init?.(ctx) ?? [];

    // 1) region state set for "town" with the chosen weather and outdoor scenes
    const setStates = changes.filter(
      (c): c is Extract<StateChange, { kind: "feature.setState" }> =>
        c.kind === "feature.setState" && c.featureId === "weather"
    );
    expect(setStates).toHaveLength(1);
    expect(setStates[0].key).toBe("town");
    const regionState = setStates[0].state as WeatherRegionState;
    expect(regionState.weatherType).toBe("fog");
    expect(regionState.intensity).toBe(3);
    expect(regionState.affectedSceneIds).toEqual(
      expect.arrayContaining(["town_square", "main_street"])
    );
    expect(regionState.affectedSceneIds).not.toContain("tavern");

    // 2) at least one env.cap (fog → illumination cap) on an outdoor scene
    const envCaps = changes.filter(
      (c): c is Extract<StateChange, { kind: "environment.cap" }> =>
        c.kind === "environment.cap" && c.sourceFeatureId === "weather"
    );
    expect(envCaps.length).toBeGreaterThan(0);
    expect(envCaps.every((c) => c.quantity === "illumination")).toBe(true);
    expect(envCaps.map((c) => c.locationId)).toEqual(
      expect.arrayContaining(["town_square", "main_street"])
    );

    // 3) [Weather] scene condition emitted with skill-penalty Record (not array)
    const addConds = changes.filter(
      (c): c is Extract<StateChange, { kind: "scene.addCondition" }> =>
        c.kind === "scene.addCondition" && c.condition.featureId === "weather"
    );
    expect(addConds.length).toBeGreaterThan(0);
    const sample = addConds[0];
    expect(sample.condition.description.startsWith("[Weather]")).toBe(true);
    const skillPenalty = sample.condition.mechanicalEffect?.skillPenalty;
    expect(skillPenalty).toBeDefined();
    expect(typeof skillPenalty).toBe("object");
    expect(Array.isArray(skillPenalty)).toBe(false);
    // fog @ intensity 3 should hit Perception with -10*3 = -30
    expect(skillPenalty?.Perception).toBe(-30);
  });

  it("init returns no changes for a clear preset (intensity coerced to 0)", () => {
    const dgsm = new DynamicGameStateManager();
    seedTownAndForest(dgsm);
    const presets: WeatherInitConfigEntry[] = [
      { regionId: "town", weatherType: "clear", intensity: 0 },
    ];
    dgsm.loadWorldData({
      moduleSetup: {
        startDate: "1923-10-15",
        featureInit: { weather: presets },
      },
    });
    const ctx = makeWeatherCtx(dgsm);
    const changes = weatherFeature.init?.(ctx) ?? [];
    // Region state still set, but no env contributions and no scene conditions.
    const kinds = changes.map((c) => c.kind);
    expect(kinds).toContain("feature.setState");
    expect(kinds).not.toContain("environment.contribute");
    expect(kinds).not.toContain("environment.cap");
    expect(kinds).not.toContain("scene.addCondition");
  });

  it("connection.setBlock uses a stable reason across intensities so Applier refcount can withdraw", () => {
    // Regression test for B1: previously the reason field embedded the current
    // intensity, so the Applier's (featureId, reason) dedup couldn't withdraw
    // a prior vote and connections stayed blocked after weather calmed.
    // Now every weather setBlock must share the same reason regardless of
    // weatherType/intensity.
    const run = (
      weatherType: WeatherInitConfigEntry["weatherType"],
      intensity: number
    ): string[] => {
      const dgsm = new DynamicGameStateManager();
      seedTownAndForest(dgsm);
      dgsm.loadWorldData({
        moduleSetup: {
          startDate: "1923-10-17",
          featureInit: {
            weather: [{ regionId: "town", weatherType, intensity }],
          },
        },
      });
      const ctx = makeWeatherCtx(dgsm);
      const changes = weatherFeature.init?.(ctx) ?? [];
      return changes
        .filter(
          (c): c is Extract<StateChange, { kind: "connection.setBlock" }> =>
            c.kind === "connection.setBlock"
        )
        .map((c) => c.reason);
    };

    const reasons4 = run("storm", 4);
    const reasons5 = run("storm", 5);
    const reasonsSnow = run("snow", 4);

    const all = [...reasons4, ...reasons5, ...reasonsSnow];
    expect(all.length).toBeGreaterThan(0);
    // All blocks emitted by weather share one stable reason.
    expect(new Set(all).size).toBe(1);
  });
});
