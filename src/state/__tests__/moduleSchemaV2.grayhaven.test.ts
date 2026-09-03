import fs from "node:fs";
import path from "node:path";
import {
  loadScriptedEvents,
  validateScriptedEventReferences,
} from "@/engine/scriptedEvents/loader.js";
import {
  buildRoadV2,
  buildSceneV2,
  parsePlaceFileV2,
  validateModuleReferences,
} from "@/state/moduleSchemaV2.js";
import { parseVehicleFileV2 } from "@/state/moduleSchemaV2.js";
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
  const rawVehicles: Array<{ entryId: string; data: unknown }> = [];
  for (const file of fs.readdirSync(SCENARIOS_DIR).sort()) {
    if (!file.endsWith(".json")) continue;
    const data = JSON.parse(
      fs.readFileSync(path.join(SCENARIOS_DIR, file), "utf8")
    );
    const entryId = path.basename(file, ".json");
    if (entryId.startsWith("VEH_")) {
      rawVehicles.push({ entryId, data });
      continue;
    }
    const parsed = parsePlaceFileV2(entryId, data);
    if (parsed.id.startsWith("ROAD_")) {
      roads.set(parsed.id, buildRoadV2(parsed));
    } else {
      scenes.set(parsed.id, buildSceneV2(parsed));
    }
  }
  const vehicles = rawVehicles.map(({ entryId, data }) =>
    parseVehicleFileV2(entryId, data, {
      scenes,
      placeIds: new Set([...scenes.keys(), ...roads.keys()]),
    })
  );
  return { scenes, roads, vehicles };
}

describe("grayhaven module data", () => {
  const module = loadModuleFromDisk();
  const topology = buildTopology(module.scenes, module.roads);

  it("has the designed place counts", () => {
    // 36 interior scenes (incl. the three closed truth-space rooms and the
    // two vehicle cabs, whose "parent" is the vehicle) + 16 top-level node
    // scenes.
    expect(module.scenes.size).toBe(52);
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
    // The production cross-check: every place, connection and holder an
    // event references must exist — a typo fails the load, not the flood.
    const npcIds = new Set(
      fs
        .readdirSync(path.join(MODULE_DIR, "grayhaven_npc"))
        .filter((f) => f.endsWith(".json"))
        .map(
          (f) =>
            (
              JSON.parse(
                fs.readFileSync(
                  path.join(MODULE_DIR, "grayhaven_npc", f),
                  "utf8"
                )
              ) as { id: string }
            ).id
        )
    );
    expect(() =>
      validateScriptedEventReferences(events, {
        placeIds: new Set([...module.scenes.keys(), ...module.roads.keys()]),
        npcIds,
        connectionIds: new Set([
          ...[...module.scenes.values()].flatMap((s) =>
            (s.connections ?? []).map((c) => c.id)
          ),
          ...[...module.roads.values()].flatMap((r) =>
            (r.connections ?? []).map((c) => c.id)
          ),
        ]),
      })
    ).not.toThrow();
  });

  it("Frank's truck parses: cab off-topology, parked at the Holt gate", () => {
    // Two vehicles: Frank's truck and Ray's patrol car, each with its own cab.
    expect(module.vehicles.map((v) => v.id).sort()).toEqual([
      "VEH_frank_truck",
      "VEH_patrol_car",
    ]);
    const truck = module.vehicles.find((v) => v.id === "VEH_frank_truck");
    if (!truck) throw new Error("VEH_frank_truck missing");
    expect(truck.interiorSceneId).toBe("SCN_truck_cab");
    expect(truck.position).toEqual({ type: "scene", sceneId: "SCN_holt_gate" });
    // The cab is interior (parent = the vehicle) and NOT statically attached:
    // its place in the world is wherever the truck stands.
    const cab = module.scenes.get("SCN_truck_cab");
    expect(cab?.parentLocationId).toBe("VEH_frank_truck");
    expect(topology.sceneToParent.has("SCN_truck_cab")).toBe(false);
    // Drivable roads carry drive times; trails do not.
    expect(module.roads.get("ROAD_station_drive")?.driveTimeMinutes).toBe(30);
    expect(
      module.roads.get("ROAD_trail_creek")?.driveTimeMinutes
    ).toBeUndefined();
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
    expect(
      dock?.items.some(
        (i) => i.id === "item.station_dock.inner_door" && !i.hidden
      )
    ).toBe(true);
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
