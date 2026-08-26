import { describe, expect, it } from "vitest";
import {
  buildInterpreterPrompt,
  collectKnownLocations,
  sanitizeMovementSteps,
} from "../interpreter/gameInterpreter.js";

describe("collectKnownLocations", () => {
  it("collects buildings, scenes, junctions and roads with de-duplication", () => {
    const locations = collectKnownLocations({
      scenarioOutlines: [
        { id: "SCN_16", name: "Reindeer Bar" },
        { id: "SCN_16", name: "Reindeer Bar (dup)" },
      ],
      scenes: new Map([
        ["SCN_16_SUB_1", { name: "Bar Hall" }],
        ["SCN_16", { name: "shadowed by outline" }],
      ]),
      junctions: new Map([["JUNC_1", { name: "Crescent Crossing" }]]),
      roads: new Map([["ROAD_1", { name: "" }]]),
    });
    expect(locations).toEqual([
      { id: "SCN_16", name: "Reindeer Bar", kind: "building" },
      { id: "SCN_16_SUB_1", name: "Bar Hall", kind: "scene" },
      { id: "JUNC_1", name: "Crescent Crossing", kind: "junction" },
      { id: "ROAD_1", name: "ROAD_1", kind: "road" },
    ]);
  });

  it("returns empty for empty input", () => {
    expect(collectKnownLocations({})).toEqual([]);
  });
});

describe("buildInterpreterPrompt — Known Locations section", () => {
  it("lists locations and the id-only rule when locations are provided", () => {
    const prompt = buildInterpreterPrompt(
      [],
      [{ id: "SCN_16", name: "Reindeer Bar", kind: "building" }]
    );
    expect(prompt).toContain("## Known Locations (movement destinations)");
    expect(prompt).toContain("- SCN_16 — Reindeer Bar (building)");
    expect(prompt).toContain("MUST be one of the location ids");
  });

  it("omits the section when no locations are provided", () => {
    expect(buildInterpreterPrompt([])).not.toContain("## Known Locations");
  });
});

describe("current-location rules", () => {
  it("prompt tells the model movement means leaving the current location", () => {
    const prompt = buildInterpreterPrompt(
      [],
      [{ id: "SCN_16", name: "Reindeer Bar", kind: "building" }]
    );
    expect(prompt).toContain("actor's CURRENT location");
    expect(prompt).toContain("Never output the current location's id");
  });
});

describe("sanitizeMovementSteps", () => {
  const moveStep = (destination?: string) => ({
    definitionId: "movement",
    impact: 0 as const,
    engine: "code" as const,
    codeSubsystem: "movement",
    ...(destination ? { overlayFields: { destination } } : {}),
  });
  const downgraded = {
    definitionId: "action",
    engine: "llm",
    codeSubsystem: undefined,
    overlayFields: undefined,
  };
  const known = new Set(["SCN_3_SUB_1", "SCN_13_SUB_2", "ROAD_1"]);

  it("turns a movement step targeting the current location into action", () => {
    const steps = [moveStep("SCN_3_SUB_1"), moveStep("SCN_13_SUB_2")];
    sanitizeMovementSteps(steps, {
      knownLocationIds: known,
      currentLocationId: "SCN_3_SUB_1",
    });
    expect(steps[0]).toMatchObject(downgraded);
    // A genuinely different, listed destination is left untouched.
    expect(steps[1]).toMatchObject({
      definitionId: "movement",
      codeSubsystem: "movement",
      overlayFields: { destination: "SCN_13_SUB_2" },
    });
  });

  it("keeps unknown destinations as movement so the failure reaches the character", () => {
    // Display name echoed instead of an id, and a missing destination. Both
    // are kept: movement activation fails fast and writes the character a
    // "couldn't work out where that is" memory, so THEY re-decide — a
    // downgrade to `action` would narrate a beat that hides the failure.
    const steps = [moveStep("卡森德拉街道"), moveStep()];
    sanitizeMovementSteps(steps, { knownLocationIds: known });
    expect(steps[0]).toMatchObject({
      definitionId: "movement",
      codeSubsystem: "movement",
      overlayFields: { destination: "卡森德拉街道" },
    });
    expect(steps[1]).toMatchObject({
      definitionId: "movement",
      codeSubsystem: "movement",
    });
  });

  it("accepts a road destination with an explicit @position", () => {
    const steps = [moveStep("ROAD_1@0.3")];
    sanitizeMovementSteps(steps, { knownLocationIds: known });
    expect(steps[0]).toMatchObject({
      definitionId: "movement",
      overlayFields: { destination: "ROAD_1@0.3" },
    });
  });

  it("in-place downgrade works without a known-locations list", () => {
    const steps = [moveStep("SCN_3_SUB_1")];
    sanitizeMovementSteps(steps, { currentLocationId: "SCN_3_SUB_1" });
    expect(steps[0]).toMatchObject(downgraded);
  });

  it("leaves non-movement steps alone", () => {
    const steps = [
      {
        definitionId: "perception",
        impact: 0 as const,
        engine: "llm" as const,
      },
    ];
    sanitizeMovementSteps(steps, { knownLocationIds: known });
    expect(steps[0].definitionId).toBe("perception");
  });
});
