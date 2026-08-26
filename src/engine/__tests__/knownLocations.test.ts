import { describe, expect, it } from "vitest";
import {
  buildInterpreterPrompt,
  collectKnownLocations,
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
