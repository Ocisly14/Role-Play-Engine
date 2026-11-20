// Distance for perception: the straight line between places' points, and —
// where a place has none — the walking time by the ways that join them. The
// walking fallback replaced a road-endpoint search that sent two rooms behind
// one door out to the street's end and back (27 minutes, measured on
// grayhaven, 2026-11-18).

import {
  type PlaceLookup,
  WalkGraph,
  pointOf,
  straightLineMeters,
} from "@/engine/shared/placeDistance.js";
import type { RoadNode, VehicleState } from "@/state/topologyTypes.js";
import type { DynamicScene, PlaceCoordinates } from "@/state/types.js";
import { describe, expect, it } from "vitest";

function scene(
  id: string,
  targets: string[] = [],
  coordinates?: PlaceCoordinates
): DynamicScene {
  return {
    id,
    name: id,
    setting: "",
    items: [],
    conditions: [],
    connections: targets.map((t) => ({ id: `c.${id}.${t}`, targetId: t })),
    ...(coordinates ? { coordinates } : {}),
  };
}

// Main street, 15 minutes, north end → south end. The clinic's waiting room
// opens onto it at 0.82 and its exam room is behind the waiting room's door;
// the repair shop opens onto it at 0.72.
const scenes = [
  scene("SCN_north", [], { x: 0, y: 600, z: 5 }),
  scene("SCN_south", [], { x: 0, y: -600, z: 5 }),
  scene("SCN_waiting", ["SCN_exam", "ROAD_main"], { x: 15, y: -384, z: 5 }),
  scene("SCN_exam", ["SCN_waiting"], { x: 22, y: -392, z: 5 }),
  scene("SCN_shop", ["ROAD_main"], { x: 15, y: -264, z: 5 }),
  scene("SCN_unplaced", ["SCN_waiting"]),
  scene("SCN_cab", []),
];
const road: RoadNode = {
  id: "ROAD_main",
  name: "main",
  setting: "",
  connections: [],
  endpointA: "SCN_north",
  endpointB: "SCN_south",
  travelTimeMinutes: 15,
  alongConnections: [
    { sceneId: "SCN_waiting", position: 0.82 },
    { sceneId: "SCN_shop", position: 0.72 },
  ],
  items: [],
  conditions: [],
} as unknown as RoadNode;
const truck: VehicleState = {
  id: "VEH_truck",
  name: "truck",
  description: "",
  interiorSceneId: "SCN_cab",
  position: { type: "road", roadId: "ROAD_main", position: 0.5 },
};
const lookup: PlaceLookup = {
  scene: (id) => scenes.find((s) => s.id === id),
  road: (id) => (id === road.id ? road : undefined),
  vehicleByInterior: (id) => (id === truck.interiorSceneId ? truck : undefined),
};
const at = (sceneId: string) => ({ type: "scene" as const, sceneId });

describe("pointOf", () => {
  it("a scene's own point", () => {
    expect(pointOf(at("SCN_exam"), lookup)).toEqual({ x: 22, y: -392, z: 5 });
  });

  it("a road point lies between its endpoints", () => {
    expect(
      pointOf({ type: "road", roadId: "ROAD_main", position: 0.25 }, lookup)
    ).toEqual({ x: 0, y: 300, z: 5 });
  });

  it("a vehicle's interior is wherever the vehicle is", () => {
    expect(pointOf(at("SCN_cab"), lookup)).toEqual({ x: 0, y: 0, z: 5 });
  });

  it("a place without a point has none", () => {
    expect(pointOf(at("SCN_unplaced"), lookup)).toBeNull();
  });

  it("the straight line counts height", () => {
    expect(
      straightLineMeters({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 12 })
    ).toBe(13);
  });
});

describe("WalkGraph", () => {
  const graph = new WalkGraph(scenes, [road], lookup);

  it("two rooms behind one door are a minute apart", () => {
    expect(graph.minutes(at("SCN_exam"), at("SCN_waiting"))).toBe(1);
  });

  it("two doors on one street: out, along, in — not out to its end", () => {
    // 1 out + 0.10 × 15 along + 1 in, and the exam room's extra door.
    expect(graph.minutes(at("SCN_shop"), at("SCN_waiting"))).toBeCloseTo(3.5);
    expect(graph.minutes(at("SCN_shop"), at("SCN_exam"))).toBeCloseTo(4.5);
  });

  it("from a point on the road", () => {
    expect(
      graph.minutes(
        { type: "road", roadId: "ROAD_main", position: 0.8 },
        at("SCN_waiting")
      )
    ).toBeCloseTo(1.3);
  });

  it("a vehicle's interior walks from where the vehicle is", () => {
    // 0.5 → 0.72: 3.3 along + 1 in.
    expect(graph.minutes(at("SCN_cab"), at("SCN_shop"))).toBeCloseTo(4.3);
  });

  it("an unjoined place is null", () => {
    const lonely = new WalkGraph([...scenes, scene("SCN_island")], [road], {
      ...lookup,
      scene: (id) =>
        id === "SCN_island" ? scene("SCN_island") : lookup.scene(id),
    });
    expect(lonely.minutes(at("SCN_island"), at("SCN_exam"))).toBeNull();
  });
});
