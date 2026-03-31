import { describe, expect, it } from "vitest";
import type { JunctionNode, RoadNode } from "../../../state/topologyTypes.js";
import {
  arePositionsCoLocated,
  describePrecisePosition,
  getRoadDistanceMinutesBetweenPositions,
  isCharacterAtLocation,
} from "../locationPresence.js";

function createMockDgsm() {
  const roads = new Map<string, RoadNode>([
    [
      "ROAD_1",
      {
        id: "ROAD_1",
        name: "Harbor Road",
        description: "",
        parentLocationId: "OUTDOOR",
        endpointA: "JUNC_A",
        endpointB: "JUNC_B",
        travelTimeMinutes: 10,
        alongConnections: [],
        items: [],
        conditions: [],
      },
    ],
  ]);
  const junctions = new Map<string, JunctionNode>([
    [
      "JUNC_A",
      {
        id: "JUNC_A",
        name: "North Gate",
        description: "",
        parentLocationId: "OUTDOOR",
        items: [],
        conditions: [],
        connectedSceneIds: [],
      },
    ],
    [
      "JUNC_B",
      {
        id: "JUNC_B",
        name: "South Gate",
        description: "",
        parentLocationId: "OUTDOOR",
        items: [],
        conditions: [],
        connectedSceneIds: [],
      },
    ],
  ]);

  return {
    getState() {
      return { roads, junctions };
    },
    getScene(sceneId: string) {
      return sceneId === "SCENE_1" ? { id: "SCENE_1", name: "Library" } : null;
    },
  };
}

describe("locationPresence", () => {
  const dgsm = createMockDgsm() as any;

  it("treats scene, junction, and road membership as exact location checks", () => {
    expect(
      isCharacterAtLocation({ type: "scene", sceneId: "SCENE_1" }, "SCENE_1")
    ).toBe(true);
    expect(
      isCharacterAtLocation(
        { type: "junction", junctionId: "JUNC_A" },
        "JUNC_A"
      )
    ).toBe(true);
    expect(
      isCharacterAtLocation(
        { type: "road", roadId: "ROAD_1", position: 0.3 },
        "ROAD_1"
      )
    ).toBe(true);
    expect(
      isCharacterAtLocation(
        { type: "road", roadId: "ROAD_1", position: 0.3 },
        "JUNC_A"
      )
    ).toBe(false);
  });

  it("uses travel-time distance for road co-location", () => {
    const a = { type: "road", roadId: "ROAD_1", position: 0.1 } as const;
    const b = { type: "road", roadId: "ROAD_1", position: 0.25 } as const;
    const c = { type: "road", roadId: "ROAD_1", position: 0.8 } as const;

    expect(getRoadDistanceMinutesBetweenPositions(a, b, dgsm)).toBeCloseTo(1.5);
    expect(arePositionsCoLocated(a, b, dgsm, 2)).toBe(true);
    expect(arePositionsCoLocated(a, c, dgsm, 2)).toBe(false);
  });

  it("describes precise road and scene positions for revise context", () => {
    expect(
      describePrecisePosition({ type: "scene", sceneId: "SCENE_1" }, dgsm)
    ).toBe("Inside Library.");
    expect(
      describePrecisePosition(
        { type: "road", roadId: "ROAD_1", position: 0.2 },
        dgsm
      )
    ).toContain("about 2 minute(s) from North Gate");
  });
});
