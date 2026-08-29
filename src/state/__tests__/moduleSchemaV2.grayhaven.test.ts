import fs from "node:fs";
import path from "node:path";
import {
  buildRoadV2,
  buildSceneV2,
  parsePlaceFileV2,
  validateModuleReferences,
  validateScenarioOutlines,
} from "@/state/moduleSchemaV2.js";
import { buildTopology } from "@/state/topologyTypes.js";
import type { RoadNode } from "@/state/topologyTypes.js";
import type { DynamicScene } from "@/state/types.js";
import { describe, expect, it } from "vitest";

// Data smoke test: every Grayhaven place file must parse, validate and
// assemble into a topology, straight from disk — no DB, no importer.
const MODULE_DIR = path.resolve(__dirname, "../../../testmods/grayhaven");
const SCENARIOS_DIR = path.join(MODULE_DIR, "Grayhaven_Scenarios");

function loadModuleFromDisk() {
  const scenes = new Map<string, DynamicScene>();
  const roads = new Map<string, RoadNode>();
  for (const file of fs.readdirSync(SCENARIOS_DIR).sort()) {
    if (!file.endsWith(".json")) continue;
    const data = JSON.parse(
      fs.readFileSync(path.join(SCENARIOS_DIR, file), "utf8")
    );
    const parsed = parsePlaceFileV2(path.basename(file, ".json"), data);
    if (parsed.id.startsWith("ROAD_")) {
      roads.set(parsed.id, buildRoadV2(parsed));
    } else {
      scenes.set(parsed.id, buildSceneV2(parsed));
    }
  }
  return { scenes, roads };
}

describe("grayhaven module data", () => {
  const module = loadModuleFromDisk();
  const topology = buildTopology(module.scenes, module.roads);

  it("has the designed place counts", () => {
    // 31 interior scenes + 15 former junctions, now top-level node scenes.
    expect(module.scenes.size).toBe(46);
    expect(topology.nodeSceneIds.size).toBe(15);
    expect(module.roads.size).toBe(18);
  });

  it("passes cross-file reference validation", () => {
    expect(() => validateModuleReferences(module)).not.toThrow();
  });

  it("assembles a topology", () => {
    expect(topology.sceneToRoads.size).toBeGreaterThan(0);
    // Interior scenes attach to their street node or road access point.
    expect(topology.sceneToParent.get("SCN_bluebird_dining")).toEqual({
      type: "scene",
      sceneId: "SCN_main_north",
    });
    expect(topology.sceneToParent.get("SCN_earl_cabin")).toEqual({
      type: "road",
      roadId: "ROAD_cliff_path",
      position: 0.15,
    });
    // The lighthouse interior hangs off the cliff node scene.
    expect(topology.sceneToParent.get("SCN_lighthouse_interior")).toEqual({
      type: "scene",
      sceneId: "SCN_lighthouse_cliff",
    });
  });

  it("keeps the fence a dead end (no edge into the station)", () => {
    const fence = module.scenes.get("SCN_fence");
    expect(fence).toBeTruthy();
    expect(fence?.parentLocationId).toBeUndefined();
    expect(fence?.connections ?? []).toHaveLength(0);
    const fenceRoads = topology.sceneToRoads
      .get("SCN_fence")
      ?.map((r: RoadNode) => r.id);
    expect(fenceRoads).toEqual(["ROAD_redwood_fence"]);
  });

  it("seeds the hidden clue items uncited", () => {
    const room4 = module.scenes.get("SCN_motel_room4");
    const liner = room4?.items.find(
      (i: { id: string }) => i.id === "item.motel_room4.suitcase_liner"
    );
    expect(liner?.hidden).toBe(true);
    expect(room4?.description.includes("item.motel_room4.suitcase_liner")).toBe(
      false
    );
    const store = module.scenes.get("SCN_grocery_store");
    const bills = store?.items.find(
      (i: { id: string }) => i.id === "item.grocery_store.duplicate_bills"
    );
    expect(bills?.hidden).toBe(true);
  });

  it("station dock's inner door stays pure prose (no exit reference)", () => {
    const dock = module.scenes.get("SCN_station_dock");
    expect(dock?.connections).toHaveLength(1);
    expect(dock?.connections[0]?.targetId).toBe("SCN_station_yard");
  });

  it("validates the scenario outline against loaded places", () => {
    const outline = JSON.parse(
      fs.readFileSync(path.join(MODULE_DIR, "scenarios_outline.json"), "utf8")
    );
    const outlines = validateScenarioOutlines(
      "__scenarios_outline__",
      outline,
      { scenes: module.scenes }
    );
    // The four street/gate wrapper locations and the lighthouse container
    // were dissolved into top-level node scenes: 16 → 11.
    expect(outlines).toHaveLength(11);
  });
});
