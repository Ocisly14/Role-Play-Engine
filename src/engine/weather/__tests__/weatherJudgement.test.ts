// src/engine/weather/__tests__/weatherJudgement.test.ts
//
// The deterministic half of the weather engine: which passages a region
// offers, what a valid judgement is, and how one becomes StateChanges.

import { describe, expect, it } from "vitest";
import { makeOutdoorDgsm } from "../../core/__tests__/outdoorFixture.js";
import type { WeatherRegionState } from "../../subsystem/weather.js";
import {
  EMPTY_WEATHER_JUDGEMENT,
  buildWeatherJudgementRequest,
  validateWeatherJudgement,
  weatherJudgementChanges,
} from "../weatherJudgement.js";

const RIDGE_PASS = "weather:ROAD_pass|SCN_ridge";
const HOLLOW_PASS = "weather:ROAD_pass|SCN_hollow";

function snow(intensity: number, judgedBlockIds?: string[]): WeatherRegionState {
  return {
    weatherType: "snow",
    intensity,
    minutesInState: 0,
    affectedSceneIds: ["SCN_ridge", "SCN_hollow", "ROAD_pass"],
    ...(judgedBlockIds ? { judgedBlockIds } : {}),
  };
}

describe("buildWeatherJudgementRequest", () => {
  it("lists the outdoor places and the outdoor-to-outdoor passages once each", () => {
    const dgsm = makeOutdoorDgsm();
    dgsm.setConnectionBlocked("SCN_ridge", "ROAD_pass", true, "a landslide");
    const request = buildWeatherJudgementRequest(dgsm, "OUTDOOR", snow(4, [RIDGE_PASS]));

    expect(request.weather).toEqual({ type: "snow", intensity: 4, label: "Blizzard" });
    expect(request.places.map((p) => [p.id, p.kind])).toEqual([
      ["SCN_ridge", "scene"],
      ["SCN_hollow", "scene"],
      ["ROAD_pass", "road"],
    ]);
    expect(request.places[0].description).toContain("山脊");
    // Both directions of one passage are one entry; the inn's doorway is
    // indoors and not the weather's to close.
    expect(request.passages.map((p) => p.connectionId).sort()).toEqual(
      [HOLLOW_PASS, RIDGE_PASS].sort()
    );
    const ridge = request.passages.find((p) => p.connectionId === RIDGE_PASS);
    expect(ridge).toMatchObject({ travelTimeMinutes: 20, blockedNow: "a landslide" });
    expect(request.previouslyClosed).toEqual([RIDGE_PASS]);
  });
});

describe("validateWeatherJudgement", () => {
  const dgsm = makeOutdoorDgsm();
  const request = buildWeatherJudgementRequest(dgsm, "OUTDOOR", snow(4));

  it("accepts a judgement naming only known passages and places", () => {
    const result = validateWeatherJudgement(
      {
        blocks: [{ connectionId: RIDGE_PASS, reason: "雪堆没过膝盖" }],
        conditions: [{ placeId: "SCN_ridge", description: "风雪横扫山脊 " }],
      },
      request
    );
    expect(result).toEqual({
      ok: true,
      judgement: {
        blocks: [{ connectionId: RIDGE_PASS, reason: "雪堆没过膝盖" }],
        conditions: [{ placeId: "SCN_ridge", description: "风雪横扫山脊" }],
      },
    });
  });

  it("treats missing lists as empty", () => {
    expect(validateWeatherJudgement({}, request)).toEqual({
      ok: true,
      judgement: { blocks: [], conditions: [] },
    });
  });

  it("refuses unknown ids, duplicates and empty text, naming each", () => {
    const result = validateWeatherJudgement(
      {
        blocks: [
          { connectionId: "connection.ridge.pass", reason: "x" },
          { connectionId: RIDGE_PASS, reason: "" },
          { connectionId: RIDGE_PASS, reason: "again" },
        ],
        conditions: [
          { placeId: "SCN_inn", description: "x" },
          { placeId: "SCN_hollow", description: "a" },
          { placeId: "SCN_hollow", description: "b" },
        ],
      },
      request
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("blocks[0]");
    expect(result.errors.join("\n")).toContain("blocks[1]");
    expect(result.errors.join("\n")).toContain("blocks[2]");
    expect(result.errors.join("\n")).toContain("conditions[0]");
    expect(result.errors.join("\n")).toContain("conditions[2]");
    expect(result.errors).toHaveLength(5);
  });

  it("refuses unreadable input", () => {
    expect(validateWeatherJudgement(undefined, request).ok).toBe(false);
  });
});

describe("weatherJudgementChanges", () => {
  it("sets the new blocks, lifts the ones no longer judged, replaces the conditions and remembers the set", () => {
    const state = snow(4, [RIDGE_PASS]);
    const changes = weatherJudgementChanges("OUTDOOR", state, {
      blocks: [{ connectionId: HOLLOW_PASS, reason: "谷口的雪堆" }],
      conditions: [{ placeId: "SCN_hollow", description: "巷子里积雪没踝" }],
    });

    expect(changes.filter((c) => c.kind === "connection.setBlock")).toEqual([
      {
        kind: "connection.setBlock",
        connectionId: HOLLOW_PASS,
        blocked: true,
        sourceFeatureId: "weather",
        reason: "谷口的雪堆",
      },
      {
        kind: "connection.setBlock",
        connectionId: RIDGE_PASS,
        blocked: false,
        sourceFeatureId: "weather",
        reason: "weather cleared",
      },
    ]);
    // Every affected place sheds its old weather condition; only the judged
    // ones get a new one, carrying the code-computed skill penalties.
    expect(changes.filter((c) => c.kind === "scene.removeCondition")).toEqual([
      { kind: "scene.removeCondition", sceneId: "SCN_ridge", predicate: { featureId: "weather" } },
      { kind: "scene.removeCondition", sceneId: "SCN_hollow", predicate: { featureId: "weather" } },
      { kind: "scene.removeCondition", sceneId: "ROAD_pass", predicate: { featureId: "weather" } },
    ]);
    expect(changes.filter((c) => c.kind === "scene.addCondition")).toEqual([
      {
        kind: "scene.addCondition",
        sceneId: "SCN_hollow",
        condition: {
          featureId: "weather",
          description: "[Weather] 巷子里积雪没踝",
          mechanicalEffect: {
            skillPenalty: {
              Investigation: -20,
              "Land Vehicle Operation": -20,
              Athletics: -20,
              "Survival & Navigation": -20,
            },
          },
        },
      },
    ]);
    expect(changes.at(-1)).toEqual({
      kind: "feature.setState",
      featureId: "weather",
      key: "OUTDOOR",
      state: { ...state, judgedBlockIds: [HOLLOW_PASS] },
    });
  });

  it("the empty judgement lifts everything and hangs nothing", () => {
    const changes = weatherJudgementChanges("OUTDOOR", snow(0, [RIDGE_PASS]), EMPTY_WEATHER_JUDGEMENT);
    expect(changes.filter((c) => c.kind === "connection.setBlock")).toEqual([
      {
        kind: "connection.setBlock",
        connectionId: RIDGE_PASS,
        blocked: false,
        sourceFeatureId: "weather",
        reason: "weather cleared",
      },
    ]);
    expect(changes.filter((c) => c.kind === "scene.addCondition")).toHaveLength(0);
    expect(changes.at(-1)).toMatchObject({
      kind: "feature.setState",
      state: { judgedBlockIds: [] },
    });
  });
});
