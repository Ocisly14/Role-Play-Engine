import { describe, it, expect } from "vitest";
import {
  isRoadId,
  isJunctionId,
  getTopologyNeighbors,
  resolveCharacterLocationId,
} from "../topologyHelpers.js";
import type { JunctionNode, RoadNode, TownTopology } from "../../../state/topologyTypes.js";
import { buildTopology } from "../../../state/topologyTypes.js";

// ===== Test topology =====
//
//   JUNC_A ── ROAD_1 (SCN_ALONG at 0.5) ── JUNC_B ── ROAD_2 ── JUNC_C
//     │                                        │
//   SCN_A1 (connected to JUNC_A)             SCN_B1 (connected to JUNC_B)
//
function makeTestTopology(): TownTopology {
  const junctions = new Map<string, JunctionNode>([
    [
      "JUNC_A",
      {
        id: "JUNC_A",
        name: "Junction A",
        description: "",
        parentLocationId: "OUTDOOR",
        items: [],
        conditions: [],
        connectedSceneIds: ["SCN_A1"],
      },
    ],
    [
      "JUNC_B",
      {
        id: "JUNC_B",
        name: "Junction B",
        description: "",
        parentLocationId: "OUTDOOR",
        items: [],
        conditions: [],
        connectedSceneIds: ["SCN_B1"],
      },
    ],
    [
      "JUNC_C",
      {
        id: "JUNC_C",
        name: "Junction C",
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
        name: "Road 1",
        description: "",
        parentLocationId: "OUTDOOR",
        endpointA: "JUNC_A",
        endpointB: "JUNC_B",
        travelTimeMinutes: 10,
        alongConnections: [{ sceneId: "SCN_ALONG", position: 0.5 }],
        items: [],
        conditions: [],
      },
    ],
    [
      "ROAD_2",
      {
        id: "ROAD_2",
        name: "Road 2",
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
  ]);

  return buildTopology(junctions, roads);
}

// ===== Mock DGSM for resolveCharacterLocationId =====

function createMockDgsm(overrides?: {
  characterPositions?: Record<string, any>;
  npcLocations?: Record<string, string>;
}) {
  const characterPositions: Record<string, any> = overrides?.characterPositions ?? {};
  const npcLocations: Record<string, string> = overrides?.npcLocations ?? {};

  return {
    getCharacterPosition(characterId: string) {
      return characterPositions[characterId] ?? null;
    },
    resolveLocationId(position: { type: string; junctionId?: string; roadId?: string; sceneId?: string }) {
      switch (position.type) {
        case "junction":
          return position.junctionId!;
        case "road":
          return position.roadId!;
        case "scene":
          return position.sceneId!;
        default:
          return "";
      }
    },
    getNpcLocation(npcId: string) {
      return npcLocations[npcId];
    },
  };
}

// ===== Tests =====

describe("isRoadId", () => {
  const topology = makeTestTopology();

  it("returns true for a road ID", () => {
    expect(isRoadId("ROAD_1", topology)).toBe(true);
    expect(isRoadId("ROAD_2", topology)).toBe(true);
  });

  it("returns false for a junction ID", () => {
    expect(isRoadId("JUNC_A", topology)).toBe(false);
  });

  it("returns false for a scene ID", () => {
    expect(isRoadId("SCN_A1", topology)).toBe(false);
  });

  it("returns false for an unknown ID", () => {
    expect(isRoadId("NONEXISTENT", topology)).toBe(false);
  });
});

describe("isJunctionId", () => {
  const topology = makeTestTopology();

  it("returns true for a junction ID", () => {
    expect(isJunctionId("JUNC_A", topology)).toBe(true);
    expect(isJunctionId("JUNC_B", topology)).toBe(true);
    expect(isJunctionId("JUNC_C", topology)).toBe(true);
  });

  it("returns false for a road ID", () => {
    expect(isJunctionId("ROAD_1", topology)).toBe(false);
  });

  it("returns false for a scene ID", () => {
    expect(isJunctionId("SCN_A1", topology)).toBe(false);
  });

  it("returns false for an unknown ID", () => {
    expect(isJunctionId("NONEXISTENT", topology)).toBe(false);
  });
});

describe("getTopologyNeighbors", () => {
  const topology = makeTestTopology();

  describe("scene neighbors", () => {
    it("returns parent junction for a scene connected to a junction", () => {
      const neighbors = getTopologyNeighbors("SCN_A1", topology);
      expect(neighbors).toContain("JUNC_A");
      expect(neighbors).toHaveLength(1);
    });

    it("returns parent road for a scene along a road", () => {
      const neighbors = getTopologyNeighbors("SCN_ALONG", topology);
      expect(neighbors).toContain("ROAD_1");
      expect(neighbors).toHaveLength(1);
    });

    it("returns empty array for unknown scene", () => {
      const neighbors = getTopologyNeighbors("UNKNOWN_SCENE", topology);
      expect(neighbors).toEqual([]);
    });
  });

  describe("road neighbors", () => {
    it("returns endpoint junctions and along-road scenes", () => {
      const neighbors = getTopologyNeighbors("ROAD_1", topology);
      expect(neighbors).toContain("JUNC_A");
      expect(neighbors).toContain("JUNC_B");
      expect(neighbors).toContain("SCN_ALONG");
      expect(neighbors).toHaveLength(3);
    });

    it("returns only endpoint junctions when no along-connections", () => {
      const neighbors = getTopologyNeighbors("ROAD_2", topology);
      expect(neighbors).toContain("JUNC_B");
      expect(neighbors).toContain("JUNC_C");
      expect(neighbors).toHaveLength(2);
    });
  });

  describe("junction neighbors", () => {
    it("returns connected roads and connected scenes", () => {
      // JUNC_A connects to: ROAD_1, and scene SCN_A1
      const neighbors = getTopologyNeighbors("JUNC_A", topology);
      expect(neighbors).toContain("ROAD_1");
      expect(neighbors).toContain("SCN_A1");
      expect(neighbors).toHaveLength(2);
    });

    it("returns multiple roads for a junction with multiple connections", () => {
      // JUNC_B connects to: ROAD_1, ROAD_2, and scene SCN_B1
      const neighbors = getTopologyNeighbors("JUNC_B", topology);
      expect(neighbors).toContain("ROAD_1");
      expect(neighbors).toContain("ROAD_2");
      expect(neighbors).toContain("SCN_B1");
      expect(neighbors).toHaveLength(3);
    });

    it("returns only roads for a junction with no connected scenes", () => {
      // JUNC_C connects to: ROAD_2, no connected scenes
      const neighbors = getTopologyNeighbors("JUNC_C", topology);
      expect(neighbors).toContain("ROAD_2");
      expect(neighbors).toHaveLength(1);
    });
  });

  describe("unknown ID", () => {
    it("returns empty array for a completely unknown ID", () => {
      const neighbors = getTopologyNeighbors("TOTALLY_UNKNOWN", topology);
      expect(neighbors).toEqual([]);
    });
  });
});

describe("resolveCharacterLocationId", () => {
  it("resolves location from CharacterPosition (junction)", () => {
    const dgsm = createMockDgsm({
      characterPositions: {
        "npc-1": { type: "junction", junctionId: "JUNC_A" },
      },
    });
    expect(resolveCharacterLocationId("npc-1", dgsm as any)).toBe("JUNC_A");
  });

  it("resolves location from CharacterPosition (road)", () => {
    const dgsm = createMockDgsm({
      characterPositions: {
        "npc-1": { type: "road", roadId: "ROAD_1", position: 0.5 },
      },
    });
    expect(resolveCharacterLocationId("npc-1", dgsm as any)).toBe("ROAD_1");
  });

  it("resolves location from CharacterPosition (scene)", () => {
    const dgsm = createMockDgsm({
      characterPositions: {
        "npc-1": { type: "scene", sceneId: "SCN_A1" },
      },
    });
    expect(resolveCharacterLocationId("npc-1", dgsm as any)).toBe("SCN_A1");
  });

  it("falls back to getNpcLocation for NPCs without CharacterPosition", () => {
    const dgsm = createMockDgsm({
      npcLocations: { "npc-2": "SCN_ALONG" },
    });
    expect(resolveCharacterLocationId("npc-2", dgsm as any)).toBe("SCN_ALONG");
  });

  it("returns undefined when no location is found at all", () => {
    const dgsm = createMockDgsm();
    expect(resolveCharacterLocationId("unknown-char", dgsm as any)).toBeUndefined();
  });

  it("prefers CharacterPosition over fallback", () => {
    const dgsm = createMockDgsm({
      characterPositions: {
        "npc-1": { type: "junction", junctionId: "JUNC_B" },
      },
      npcLocations: { "npc-1": "SCN_A1" },
    });
    // CharacterPosition takes precedence
    expect(resolveCharacterLocationId("npc-1", dgsm as any)).toBe("JUNC_B");
  });
});
