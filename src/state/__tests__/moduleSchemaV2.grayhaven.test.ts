import fs from "node:fs";
import path from "node:path";
import {
  buildRoadV2,
  buildSceneV2,
  parsePlaceFileV2,
  validateModuleReferences,
} from "@/state/moduleSchemaV2.js";
import { loadScriptedEvents } from "@/engine/scriptedEvents/loader.js";
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
    // 34 interior scenes (incl. the three closed truth-space rooms behind
    // the station's inner door) + 16 top-level node scenes.
    expect(module.scenes.size).toBe(50);
    expect(topology.nodeSceneIds.size).toBe(16);
    expect(module.roads.size).toBe(19);
  });

  it("passes cross-file reference validation", () => {
    expect(() => validateModuleReferences(module)).not.toThrow();
  });

  it("assembles a topology", () => {
    expect(topology.sceneToRoads.size).toBeGreaterThan(0);
    // Storefronts hang off the main street at their access positions.
    expect(topology.sceneToParent.get("SCN_bluebird_dining")).toEqual({
      type: "road",
      roadId: "ROAD_main_street",
      position: 0.1,
    });
    expect(topology.sceneToParent.get("SCN_clinic_waiting")).toEqual({
      type: "road",
      roadId: "ROAD_main_street",
      position: 0.82,
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

  it("scripted events load through the real loader and point at real places", () => {
    const eventsDir = path.join(MODULE_DIR, "scripted-events");
    const files = fs
      .readdirSync(eventsDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => ({
        file: f,
        raw: JSON.parse(fs.readFileSync(path.join(eventsDir, f), "utf8")),
      }));
    const events = loadScriptedEvents(files);
    expect(events.length).toBeGreaterThanOrEqual(3);
    // Every place a restock writes into, and every witness-guard scene,
    // must exist in the module.
    for (const event of events) {
      for (const effect of event.onComplete) {
        if (effect.kind === "item.create") {
          expect(module.scenes.has(effect.location)).toBe(true);
        }
      }
      const stack = [event.fireWhen, ...(event.failWhen ? [event.failWhen] : [])];
      while (stack.length > 0) {
        const pred = stack.pop();
        if (!pred) continue;
        if (pred.op === "sceneOccupied") {
          expect(module.scenes.has(pred.sceneId)).toBe(true);
        } else if (pred.op === "and" || pred.op === "or") {
          stack.push(...pred.children);
        } else if (pred.op === "not") {
          stack.push(pred.child);
        }
      }
    }
  });

  it("the truth space exists but stays sealed behind a hidden connection", () => {
    const dock = module.scenes.get("SCN_station_dock");
    expect(dock?.connections).toHaveLength(2);
    const inner = dock?.connections.find(
      (c) => c.targetId === "SCN_station_hall"
    );
    // The door is a VISIBLE item (Frank can point at it); the passage is
    // hidden — filtered from perception, uncitable, unciteable in prose.
    expect(inner?.hidden).toBe(true);
    expect(dock?.items.some((i) => i.id === "item.station_dock.inner_door" && !i.hidden)).toBe(true);
    // The three base rooms are real scenes, closed at start.
    for (const id of [
      "SCN_station_hall",
      "SCN_station_archive",
      "SCN_station_maintenance",
    ]) {
      expect(module.scenes.get(id)).toBeTruthy();
    }
  });

});
