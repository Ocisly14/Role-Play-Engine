import { describe, expect, it } from "vitest";
import type {
  JunctionNode,
  RoadNode,
  TownTopology,
} from "../../../state/topologyTypes.js";
import { buildTopology } from "../../../state/topologyTypes.js";
import { findTopologyPath } from "../pathfinding.js";

// Helper: build a simple test topology
//   JUNC_A -- ROAD_1 (10min) -- JUNC_B -- ROAD_2 (5min) -- JUNC_C
//                                  |
//                              ROAD_3 (15min)
//                                  |
//                               JUNC_D
function makeTestTopology(): TownTopology {
  const junctions = new Map<string, JunctionNode>([
    [
      "JUNC_A",
      {
        id: "JUNC_A",
        name: "A",
        description: "",
        parentLocationId: "OUTDOOR",
        items: [],
        conditions: [],
        connectedSceneIds: ["SCN_1"],
      },
    ],
    [
      "JUNC_B",
      {
        id: "JUNC_B",
        name: "B",
        description: "",
        parentLocationId: "OUTDOOR",
        items: [],
        conditions: [],
        connectedSceneIds: [],
      },
    ],
    [
      "JUNC_C",
      {
        id: "JUNC_C",
        name: "C",
        description: "",
        parentLocationId: "OUTDOOR",
        items: [],
        conditions: [],
        connectedSceneIds: ["SCN_2"],
      },
    ],
    [
      "JUNC_D",
      {
        id: "JUNC_D",
        name: "D",
        description: "",
        parentLocationId: "OUTDOOR",
        items: [],
        conditions: [],
        connectedSceneIds: [],
      },
    ],
  ]);

  const roads = new Map<string, RoadNode>([
    [
      "ROAD_1",
      {
        id: "ROAD_1",
        name: "R1",
        description: "",
        parentLocationId: "OUTDOOR",
        endpointA: "JUNC_A",
        endpointB: "JUNC_B",
        travelTimeMinutes: 10,
        alongConnections: [{ sceneId: "SCN_3", position: 0.5 }],
        items: [],
        conditions: [],
      },
    ],
    [
      "ROAD_2",
      {
        id: "ROAD_2",
        name: "R2",
        description: "",
        parentLocationId: "OUTDOOR",
        endpointA: "JUNC_B",
        endpointB: "JUNC_C",
        travelTimeMinutes: 5,
        alongConnections: [],
        items: [],
        conditions: [],
      },
    ],
    [
      "ROAD_3",
      {
        id: "ROAD_3",
        name: "R3",
        description: "",
        parentLocationId: "OUTDOOR",
        endpointA: "JUNC_B",
        endpointB: "JUNC_D",
        travelTimeMinutes: 15,
        alongConnections: [],
        items: [],
        conditions: [],
      },
    ],
  ]);

  return buildTopology(junctions, roads);
}

describe("findTopologyPath", () => {
  const topology = makeTestTopology();
  const blocked = new Map<string, string>();

  it("finds path between two junctions", () => {
    const path = findTopologyPath(
      { type: "junction", junctionId: "JUNC_A" },
      { type: "junction", junctionId: "JUNC_C" },
      topology,
      blocked
    );
    expect(path).not.toBeNull();
    expect(path!.totalMinutes).toBe(15); // ROAD_1 (10) + ROAD_2 (5)
  });

  it("finds path from scene at junction to another junction", () => {
    // SCN_1 is at JUNC_A
    const path = findTopologyPath(
      { type: "scene", sceneId: "SCN_1" },
      { type: "junction", junctionId: "JUNC_C" },
      topology,
      blocked
    );
    expect(path).not.toBeNull();
    // 1 min exit scene + 10 ROAD_1 + 5 ROAD_2 = 16
    expect(path!.totalMinutes).toBe(16);
  });

  it("finds path from scene on road to junction", () => {
    // SCN_3 is at ROAD_1 position 0.5
    const path = findTopologyPath(
      { type: "scene", sceneId: "SCN_3" },
      { type: "junction", junctionId: "JUNC_C" },
      topology,
      blocked
    );
    expect(path).not.toBeNull();
    // Exit scene (1) + half ROAD_1 to JUNC_B (5) + ROAD_2 (5) = 11
    expect(path!.totalMinutes).toBe(11);
  });

  it("finds path between two scenes", () => {
    // SCN_1 at JUNC_A, SCN_2 at JUNC_C
    const path = findTopologyPath(
      { type: "scene", sceneId: "SCN_1" },
      { type: "scene", sceneId: "SCN_2" },
      topology,
      blocked
    );
    expect(path).not.toBeNull();
    // exit (1) + ROAD_1 (10) + ROAD_2 (5) + enter (1) = 17
    expect(path!.totalMinutes).toBe(17);
  });

  it("returns null when path is blocked", () => {
    const blockedConns = new Map<string, string>();
    blockedConns.set("JUNC_A::ROAD_1", "fire");
    const path = findTopologyPath(
      { type: "junction", junctionId: "JUNC_A" },
      { type: "junction", junctionId: "JUNC_C" },
      topology,
      blockedConns
    );
    expect(path).toBeNull();
  });

  it("same location returns zero-step path", () => {
    const path = findTopologyPath(
      { type: "junction", junctionId: "JUNC_A" },
      { type: "junction", junctionId: "JUNC_A" },
      topology,
      blocked
    );
    expect(path).not.toBeNull();
    expect(path!.totalMinutes).toBe(0);
    expect(path!.steps.length).toBe(0);
  });

  it("finds path via intermediate junction", () => {
    // JUNC_A to JUNC_D goes through JUNC_B
    const path = findTopologyPath(
      { type: "junction", junctionId: "JUNC_A" },
      { type: "junction", junctionId: "JUNC_D" },
      topology,
      blocked
    );
    expect(path).not.toBeNull();
    expect(path!.totalMinutes).toBe(25); // ROAD_1 (10) + ROAD_3 (15)
  });

  it("returns null for orphaned scene", () => {
    const path = findTopologyPath(
      { type: "scene", sceneId: "UNKNOWN" },
      { type: "junction", junctionId: "JUNC_A" },
      topology,
      blocked
    );
    expect(path).toBeNull();
  });
});
