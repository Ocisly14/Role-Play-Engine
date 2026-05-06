import { describe, expect, it } from "vitest";
import { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { Applier } from "../applier.js";
import { DEFAULT_ENVIRONMENT_READING } from "../types.js";
import type { StateChange } from "../types.js";

describe("Applier — environment aggregation (Pass 1.5)", () => {
  it("single-source contribution raises temperature above baseline", () => {
    const d = new DynamicGameStateManager();
    const applier = new Applier(d, new Map());
    const changes: StateChange[] = [
      {
        kind: "environment.contribute",
        locationId: "warehouse",
        quantity: "temperature",
        value: 300,
        sourceFeatureId: "fire",
      },
    ];
    applier.flush(changes, "1923-10-17T08:00:00");
    const reading = d.getEnvironmentReading("warehouse");
    expect(reading.temperature).toBe(320);
    expect(reading.illumination).toBe(DEFAULT_ENVIRONMENT_READING.illumination);
    expect(reading.oxygen).toBe(DEFAULT_ENVIRONMENT_READING.oxygen);
    expect(reading.noise).toBe(DEFAULT_ENVIRONMENT_READING.noise);
    expect(reading.airborneHazards).toEqual([]);
  });

  it("aggregates multi-quantity, multi-feature contributions per scene", () => {
    const d = new DynamicGameStateManager();
    const applier = new Applier(d, new Map());
    const changes: StateChange[] = [
      // fire contributes
      {
        kind: "environment.contribute",
        locationId: "warehouse",
        quantity: "temperature",
        value: 300,
        sourceFeatureId: "fire",
      },
      {
        kind: "environment.contribute",
        locationId: "warehouse",
        quantity: "illumination",
        value: 4,
        sourceFeatureId: "fire",
      },
      {
        kind: "environment.contribute",
        locationId: "warehouse",
        quantity: "oxygen",
        value: -0.3,
        sourceFeatureId: "fire",
      },
      {
        kind: "environment.hazard",
        locationId: "warehouse",
        add: ["smoke"],
        sourceFeatureId: "fire",
      },
      // sun contributes
      {
        kind: "environment.contribute",
        locationId: "warehouse",
        quantity: "illumination",
        value: 5,
        sourceFeatureId: "sun",
      },
    ];
    applier.flush(changes, "1923-10-17T08:00:00");
    const reading = d.getEnvironmentReading("warehouse");
    expect(reading.temperature).toBe(320);
    expect(reading.illumination).toBe(5);
    expect(reading.oxygen).toBeCloseTo(0.7, 10);
    expect(reading.noise).toBe(0);
    expect(reading.airborneHazards).toEqual(["smoke"]);
  });

  it("illumination cap lowers final value below max contribution", () => {
    const d = new DynamicGameStateManager();
    const applier = new Applier(d, new Map());
    const changes: StateChange[] = [
      {
        kind: "environment.contribute",
        locationId: "outdoor",
        quantity: "illumination",
        value: 5,
        sourceFeatureId: "sun",
      },
      {
        kind: "environment.cap",
        locationId: "outdoor",
        quantity: "illumination",
        value: 2,
        sourceFeatureId: "storm",
      },
    ];
    applier.flush(changes, "1923-10-17T08:00:00");
    const reading = d.getEnvironmentReading("outdoor");
    expect(reading.illumination).toBe(2);
  });

  it("untouched location returns DEFAULT_ENVIRONMENT_READING", () => {
    const d = new DynamicGameStateManager();
    const applier = new Applier(d, new Map());
    // Flush something that touches a different location only.
    applier.flush(
      [
        {
          kind: "environment.contribute",
          locationId: "warehouse",
          quantity: "temperature",
          value: 50,
          sourceFeatureId: "fire",
        },
      ],
      "1923-10-17T08:00:00"
    );
    const reading = d.getEnvironmentReading("untouched-location");
    expect(reading).toEqual(DEFAULT_ENVIRONMENT_READING);
  });

  it("hazard add+remove in same flush: remove wins; noise contributions aggregate by max", () => {
    const d = new DynamicGameStateManager();
    const applier = new Applier(d, new Map());
    const changes: StateChange[] = [
      {
        kind: "environment.hazard",
        locationId: "warehouse",
        add: ["smoke", "toxic_gas"],
        sourceFeatureId: "fire",
      },
      {
        kind: "environment.hazard",
        locationId: "warehouse",
        remove: ["toxic_gas"],
        sourceFeatureId: "ventilation",
      },
      {
        kind: "environment.contribute",
        locationId: "warehouse",
        quantity: "noise",
        value: 3,
        sourceFeatureId: "fire",
      },
      {
        kind: "environment.contribute",
        locationId: "warehouse",
        quantity: "noise",
        value: 5,
        sourceFeatureId: "combat",
      },
    ];
    applier.flush(changes, "1923-10-17T08:00:00");
    const reading = d.getEnvironmentReading("warehouse");
    // remove wins over add when both present in same flush
    expect(reading.airborneHazards).toEqual(["smoke"]);
    // noise takes max across contributions
    expect(reading.noise).toBe(5);
  });

  it("second flush replaces first flush's reading (no merging across flushes)", () => {
    const d = new DynamicGameStateManager();
    const applier = new Applier(d, new Map());
    // First flush: hot, smoky
    applier.flush(
      [
        {
          kind: "environment.contribute",
          locationId: "warehouse",
          quantity: "temperature",
          value: 300,
          sourceFeatureId: "fire",
        },
        {
          kind: "environment.hazard",
          locationId: "warehouse",
          add: ["smoke"],
          sourceFeatureId: "fire",
        },
      ],
      "1923-10-17T08:00:00"
    );
    expect(d.getEnvironmentReading("warehouse").temperature).toBe(320);

    // Second flush: cold, clean — same location, different state
    applier.flush(
      [
        {
          kind: "environment.contribute",
          locationId: "warehouse",
          quantity: "temperature",
          value: -10,
          sourceFeatureId: "weather",
        },
      ],
      "1923-10-17T08:01:00"
    );
    const reading = d.getEnvironmentReading("warehouse");
    // Previous +300 is GONE; only current -10 counts (plus baseline 20)
    expect(reading.temperature).toBe(10);
    // Previous smoke is GONE; this flush didn't emit any hazard
    expect(reading.airborneHazards).toEqual([]);
  });
});
