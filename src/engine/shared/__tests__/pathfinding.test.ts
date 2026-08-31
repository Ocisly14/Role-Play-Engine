import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import {
  type JunctionNode,
  type RoadNode,
  buildTopology,
} from "../../../state/topologyTypes.js";
import { nearestRoadPosition, resolveTargetPosition } from "../pathfinding.js";

// Minimal town: S_HOME ── J_A ══ R_MAIN (10 min) ══ J_B
// Plus two outlines: OUTDOOR whose entry is the ROAD (the case that used to
// resolve to null and loop the mover on "couldn't work out a way"), and
// B_SHOP whose entry is a scene (the previously-working case).

const junctions = new Map<string, JunctionNode>([
  ["J_A", { id: "J_A", connectedSceneIds: ["S_HOME"] } as JunctionNode],
  ["J_B", { id: "J_B", connectedSceneIds: [] } as unknown as JunctionNode],
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
const topology = buildTopology(junctions, roads);

const dgsm = {
  getState: () => ({
    scenarioOutlines: [
      { id: "OUTDOOR", name: "街道", entrySceneId: "R_MAIN" },
      { id: "B_SHOP", name: "商铺", entrySceneId: "S_HOME" },
      { id: "LOOP", name: "自指", entrySceneId: "LOOP" },
    ],
    scenes: new Map(),
  }),
} as unknown as DynamicGameStateManager;

describe("resolveTargetPosition — outline entry recursion", () => {
  it("resolves an outline whose entry is a road", () => {
    expect(resolveTargetPosition("OUTDOOR", topology, dgsm)).toEqual({
      type: "road",
      roadId: "R_MAIN",
      position: 0.5,
    });
  });

  it("still resolves an outline whose entry is a scene", () => {
    expect(resolveTargetPosition("B_SHOP", topology, dgsm)).toEqual({
      type: "scene",
      sceneId: "S_HOME",
    });
  });

  it("does not recurse into a self-referencing outline", () => {
    expect(resolveTargetPosition("LOOP", topology, dgsm)).toBeNull();
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
