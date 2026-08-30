import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { type RoadNode, buildTopology } from "../../../state/topologyTypes.js";
import type { DynamicScene } from "../../../state/types.js";
import { nearestRoadPosition, resolveTargetPosition } from "../pathfinding.js";

// Minimal town: S_HOME ── J_A ══ R_MAIN (10 min) ══ J_B
// Plus two outlines: OUTDOOR whose entry is the ROAD (the case that used to
// resolve to null and loop the mover on "couldn't work out a way"), and
// B_SHOP whose entry is a scene (the previously-working case).

// J_A/J_B are top-level scenes (no parentLocationId): geography nodes.
const scenes = new Map<string, DynamicScene>([
  [
    "J_A",
    {
      id: "J_A",
      connections: [{ id: "exit.ja.home", targetId: "S_HOME" }],
    } as unknown as DynamicScene,
  ],
  ["J_B", { id: "J_B", connections: [] } as unknown as DynamicScene],
  [
    "S_HOME",
    {
      id: "S_HOME",
      parentLocationId: "B_SHOP",
      connections: [],
    } as unknown as DynamicScene,
  ],
]);
const roads = new Map<string, RoadNode>([
  [
    "R_MAIN",
    {
      id: "R_MAIN",
      endpointA: "J_A",
      endpointB: "J_B",
      travelTimeMinutes: 10,
      alongConnections: [],
    } as unknown as RoadNode,
  ],
]);
const topology = buildTopology(scenes, roads);

const dgsm = {
  getState: () => ({
    scenarioOutlines: [
      { id: "OUTDOOR", name: "街道", entrySceneId: "R_MAIN" },
      { id: "B_SHOP", name: "商铺", entrySceneId: "S_HOME" },
      { id: "LOOP", name: "自指", entrySceneId: "LOOP" },
    ],
    scenes,
  }),
} as unknown as DynamicGameStateManager;

describe("resolveTargetPosition — retired macro-location ids", () => {
  it("answers null for an id that names no scene or road", () => {
    // Outline indirection is gone: a movement target must name a place in
    // the topology directly.
    expect(resolveTargetPosition("OUTDOOR", topology, dgsm)).toBeNull();
    expect(resolveTargetPosition("B_SHOP", topology, dgsm)).toBeNull();
  });
});

describe("nearestRoadPosition", () => {
  it("snaps to the road end nearest the mover", () => {
    expect(
      nearestRoadPosition(
        { type: "scene", sceneId: "S_HOME" },
        "R_MAIN",
        topology,
        dgsm
      )
    ).toBe(0);
  });

  it("keeps the mover's own position when already on the road", () => {
    expect(
      nearestRoadPosition(
        { type: "road", roadId: "R_MAIN", position: 0.7 },
        "R_MAIN",
        topology,
        dgsm
      )
    ).toBe(0.7);
  });
});
