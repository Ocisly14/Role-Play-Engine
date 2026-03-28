import { describe, expect, it } from "vitest";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../../state/DynamicGameState.js";
import { buildTopology } from "../../state/topologyTypes.js";
import type { JunctionNode, RoadNode } from "../../state/topologyTypes.js";
import type { DynamicScene, ScenarioOutline } from "../../state/types.js";
import {
  areKnownMapIdsEqual,
  areKnownMapSnapshotsEquivalent,
  areKnownMapConnectionKeysEqual,
  buildKnownMapSnapshot,
  createFullKnownMapIds,
  createKnownMapIdsFromSeed,
  extractNameOnlySceneIds,
  hydrateKnownMapSnapshot,
  knownMapIdsContainLocation,
  makeKnownMapConnectionKey,
  mergeKnownMapIds,
  normalizeKnownMapConnectionKeys,
  revealKnownMapLocations,
  revealKnownMapLocationsDirect,
  getKnownMapLocationIdsFromPosition,
} from "../mapMemory.js";
import type { KnownMapIds, KnownMapSnapshot } from "../types.js";

// ===== Helpers =====

function makeScene(
  id: string,
  name: string,
  parentLocationId: string,
  connections: DynamicScene["connections"] = [],
  items: DynamicScene["items"] = []
): DynamicScene {
  return {
    id,
    name,
    description: `${name} description`,
    parentLocationId,
    items,
    conditions: [],
    connections,
  };
}

function makeJunction(
  id: string,
  name: string,
  connectedSceneIds: string[]
): JunctionNode {
  return {
    id,
    name,
    description: `${name} description`,
    parentLocationId: "OUTDOOR",
    items: [],
    conditions: [],
    connectedSceneIds,
  };
}

function makeRoad(
  id: string,
  name: string,
  endpointA: string,
  endpointB: string,
  travelTimeMinutes: number,
  alongConnections: RoadNode["alongConnections"] = []
): RoadNode {
  return {
    id,
    name,
    description: `${name} description`,
    parentLocationId: "OUTDOOR",
    endpointA,
    endpointB,
    travelTimeMinutes,
    alongConnections,
    items: [],
    conditions: [],
  };
}

/**
 * Create a realistic town topology:
 *
 *   JUNC_SQUARE ── ROAD_MAIN (~5 min) ── JUNC_STATION
 *       |                  |
 *   [Town Hall]       [Bookshop]
 *   (hall_lobby,       (bookshop_main)
 *    hall_office)
 *
 *   Town Hall has a hidden passage from hall_office → hall_basement
 */
function createTownDgsm(): DynamicGameStateManager {
  const state = initialDynamicGameState({
    sessionId: "test-session",
    moduleName: "test-module",
    gameDay: 1,
    timeOfDay: "08:00",
  });

  // Outlines (macro locations)
  const outlines: ScenarioOutline[] = [
    {
      id: "TOWN_HALL",
      name: "Town Hall",
      description: "The local government building",
      entrySceneId: "hall_lobby",
    },
    {
      id: "BOOKSHOP",
      name: "Bookshop",
      description: "A dusty old bookshop",
      entrySceneId: "bookshop_main",
    },
    {
      id: "OUTDOOR",
      name: "Outdoor",
      description: "",
    },
  ];
  state.scenarioOutlines = outlines;

  // Scenes inside Town Hall
  state.scenes.set(
    "hall_lobby",
    makeScene("hall_lobby", "Town Hall Lobby", "TOWN_HALL", [
      { targetId: "hall_office", description: "a door to the office" },
      { targetId: "JUNC_SQUARE", description: "exit to the square" },
    ])
  );
  state.scenes.set(
    "hall_office",
    makeScene("hall_office", "Town Hall Office", "TOWN_HALL", [
      { targetId: "hall_lobby", description: "back to the lobby" },
      {
        targetId: "hall_basement",
        description: "a hidden trapdoor",
        hidden: true,
      },
    ])
  );
  state.scenes.set(
    "hall_basement",
    makeScene("hall_basement", "Town Hall Basement", "TOWN_HALL", [
      { targetId: "hall_office", description: "stairs up to the office" },
    ])
  );

  // Scene inside Bookshop
  state.scenes.set(
    "bookshop_main",
    makeScene("bookshop_main", "Bookshop Interior", "BOOKSHOP", [
      { targetId: "JUNC_STATION", description: "exit" },
    ])
  );

  // Junctions
  const junctions = new Map<string, JunctionNode>();
  junctions.set(
    "JUNC_SQUARE",
    makeJunction("JUNC_SQUARE", "Town Square", ["hall_lobby"])
  );
  junctions.set(
    "JUNC_STATION",
    makeJunction("JUNC_STATION", "Train Station", ["bookshop_main"])
  );
  state.junctions = junctions;

  // Road
  const roads = new Map<string, RoadNode>();
  roads.set(
    "ROAD_MAIN",
    makeRoad("ROAD_MAIN", "Main Street", "JUNC_SQUARE", "JUNC_STATION", 5)
  );
  state.roads = roads;

  // Build topology
  state.topology = buildTopology(junctions, roads);

  // NPCs
  state.npcCharacters = [
    { id: "npc_alice", name: "Alice" } as any,
    { id: "npc_bob", name: "Bob" } as any,
    { id: "npc_carol", name: "Carol" } as any,
  ];
  state.characterPositions = {
    npc_alice: { type: "scene", sceneId: "hall_office" },
    npc_bob: { type: "scene", sceneId: "bookshop_main" },
    npc_carol: { type: "junction", junctionId: "JUNC_SQUARE" },
  };

  return new DynamicGameStateManager(state);
}

function emptyKnownIds(): KnownMapIds {
  return { sceneIds: [], junctionIds: [], roadIds: [], scenarioOutlineIds: [] };
}

// ===== Tests =====

describe("createFullKnownMapIds", () => {
  it("returns all scenes, junctions, roads, and outlines", () => {
    const dgsm = createTownDgsm();
    const ids = createFullKnownMapIds(dgsm);

    expect(ids.sceneIds).toEqual([
      "bookshop_main",
      "hall_basement",
      "hall_lobby",
      "hall_office",
    ]);
    expect(ids.junctionIds).toEqual(["JUNC_SQUARE", "JUNC_STATION"]);
    expect(ids.roadIds).toEqual(["ROAD_MAIN"]);
    expect(ids.scenarioOutlineIds).toEqual([
      "BOOKSHOP",
      "OUTDOOR",
      "TOWN_HALL",
    ]);
  });
});

describe("createKnownMapIdsFromSeed", () => {
  it("returns full map when no seed provided", () => {
    const dgsm = createTownDgsm();
    const ids = createKnownMapIdsFromSeed(dgsm);
    const full = createFullKnownMapIds(dgsm);
    expect(areKnownMapIdsEqual(ids, full)).toBe(true);
  });

  it("returns only seeded locations when seed provided", () => {
    const dgsm = createTownDgsm();
    const ids = createKnownMapIdsFromSeed(dgsm, {
      sceneIds: ["hall_lobby", "hall_office"],
    });

    expect(ids.sceneIds).toContain("hall_lobby");
    expect(ids.sceneIds).toContain("hall_office");
    expect(ids.sceneIds).not.toContain("bookshop_main");
    // Should auto-include TOWN_HALL outline since scenes belong to it
    expect(ids.scenarioOutlineIds).toContain("TOWN_HALL");
    expect(ids.scenarioOutlineIds).not.toContain("BOOKSHOP");
  });

  it("filters out non-existent scene IDs from seed", () => {
    const dgsm = createTownDgsm();
    const ids = createKnownMapIdsFromSeed(dgsm, {
      sceneIds: ["hall_lobby", "nonexistent_scene"],
    });

    expect(ids.sceneIds).toContain("hall_lobby");
    expect(ids.sceneIds).not.toContain("nonexistent_scene");
  });
});

describe("revealKnownMapLocations", () => {
  it("expands neighborhood when revealing a scene", () => {
    const dgsm = createTownDgsm();
    const base: KnownMapIds = {
      sceneIds: ["hall_lobby"],
      junctionIds: [],
      roadIds: [],
      scenarioOutlineIds: ["TOWN_HALL"],
    };
    const expanded = revealKnownMapLocations(dgsm, base, ["hall_lobby"]);

    // hall_lobby connects to hall_office (non-hidden) and JUNC_SQUARE
    expect(expanded.sceneIds).toContain("hall_lobby");
    expect(expanded.sceneIds).toContain("hall_office");
    expect(expanded.junctionIds).toContain("JUNC_SQUARE");
    // hidden connection → hall_basement should NOT be revealed
    expect(expanded.sceneIds).not.toContain("hall_basement");
  });

  it("expanding a junction reveals connected scenes and roads", () => {
    const dgsm = createTownDgsm();
    const expanded = revealKnownMapLocations(dgsm, emptyKnownIds(), [
      "JUNC_SQUARE",
    ]);

    expect(expanded.junctionIds).toContain("JUNC_SQUARE");
    expect(expanded.sceneIds).toContain("hall_lobby"); // building at junction
    expect(expanded.roadIds).toContain("ROAD_MAIN"); // road from junction
    // Road connects to JUNC_STATION, so that should be revealed too
    expect(expanded.junctionIds).toContain("JUNC_STATION");
  });
});

describe("revealKnownMapLocationsDirect", () => {
  it("adds locations without expanding neighborhood", () => {
    const dgsm = createTownDgsm();
    const result = revealKnownMapLocationsDirect(dgsm, emptyKnownIds(), [
      "hall_lobby",
    ]);

    expect(result.sceneIds).toContain("hall_lobby");
    // Should NOT expand to neighbors
    expect(result.sceneIds).not.toContain("hall_office");
    expect(result.junctionIds).not.toContain("JUNC_SQUARE");
  });
});

describe("mergeKnownMapIds", () => {
  it("merges two sets of known IDs", () => {
    const a: KnownMapIds = {
      sceneIds: ["hall_lobby"],
      junctionIds: ["JUNC_SQUARE"],
      roadIds: [],
      scenarioOutlineIds: ["TOWN_HALL"],
    };
    const b: KnownMapIds = {
      sceneIds: ["bookshop_main"],
      junctionIds: ["JUNC_STATION"],
      roadIds: ["ROAD_MAIN"],
      scenarioOutlineIds: ["BOOKSHOP"],
    };
    const merged = mergeKnownMapIds(a, b);

    expect(merged.sceneIds).toEqual(["bookshop_main", "hall_lobby"]);
    expect(merged.junctionIds).toEqual(["JUNC_SQUARE", "JUNC_STATION"]);
    expect(merged.roadIds).toEqual(["ROAD_MAIN"]);
    expect(merged.scenarioOutlineIds).toEqual(["BOOKSHOP", "TOWN_HALL"]);
  });

  it("deduplicates IDs", () => {
    const a: KnownMapIds = {
      sceneIds: ["hall_lobby"],
      junctionIds: [],
      roadIds: [],
      scenarioOutlineIds: [],
    };
    const merged = mergeKnownMapIds(a, a);
    expect(merged.sceneIds).toEqual(["hall_lobby"]);
  });
});

describe("areKnownMapIdsEqual", () => {
  it("returns true for identical IDs", () => {
    const ids: KnownMapIds = {
      sceneIds: ["a", "b"],
      junctionIds: ["j"],
      roadIds: [],
      scenarioOutlineIds: ["o"],
    };
    expect(areKnownMapIdsEqual(ids, { ...ids })).toBe(true);
  });

  it("returns false when IDs differ", () => {
    const a: KnownMapIds = {
      sceneIds: ["a"],
      junctionIds: [],
      roadIds: [],
      scenarioOutlineIds: [],
    };
    const b: KnownMapIds = {
      sceneIds: ["a", "b"],
      junctionIds: [],
      roadIds: [],
      scenarioOutlineIds: [],
    };
    expect(areKnownMapIdsEqual(a, b)).toBe(false);
  });
});

describe("knownMapIdsContainLocation", () => {
  it("finds scene IDs", () => {
    const ids: KnownMapIds = {
      sceneIds: ["hall_lobby"],
      junctionIds: ["JUNC_SQUARE"],
      roadIds: ["ROAD_MAIN"],
      scenarioOutlineIds: [],
    };
    expect(knownMapIdsContainLocation(ids, "hall_lobby")).toBe(true);
    expect(knownMapIdsContainLocation(ids, "JUNC_SQUARE")).toBe(true);
    expect(knownMapIdsContainLocation(ids, "ROAD_MAIN")).toBe(true);
    expect(knownMapIdsContainLocation(ids, "nonexistent")).toBe(false);
  });
});

describe("normalizeKnownMapConnectionKeys", () => {
  it("filters out invalid or non-hidden connections", () => {
    const dgsm = createTownDgsm();
    const keys = [
      makeKnownMapConnectionKey("hall_office", "hall_basement"), // valid hidden
      makeKnownMapConnectionKey("hall_office", "hall_lobby"), // not hidden
      makeKnownMapConnectionKey("nonexistent", "hall_lobby"), // invalid scene
    ];
    const normalized = normalizeKnownMapConnectionKeys(dgsm, keys);

    expect(normalized).toEqual([
      makeKnownMapConnectionKey("hall_office", "hall_basement"),
    ]);
  });

  it("deduplicates keys", () => {
    const dgsm = createTownDgsm();
    const key = makeKnownMapConnectionKey("hall_office", "hall_basement");
    const normalized = normalizeKnownMapConnectionKeys(dgsm, [key, key, key]);
    expect(normalized).toEqual([key]);
  });

  it("returns empty array for undefined input", () => {
    const dgsm = createTownDgsm();
    expect(normalizeKnownMapConnectionKeys(dgsm, undefined)).toEqual([]);
  });
});

describe("getKnownMapLocationIdsFromPosition", () => {
  it("returns sceneId for scene position", () => {
    expect(
      getKnownMapLocationIdsFromPosition({ type: "scene", sceneId: "hall_lobby" })
    ).toEqual(["hall_lobby"]);
  });

  it("returns junctionId for junction position", () => {
    expect(
      getKnownMapLocationIdsFromPosition({
        type: "junction",
        junctionId: "JUNC_SQUARE",
      })
    ).toEqual(["JUNC_SQUARE"]);
  });

  it("returns roadId for road position", () => {
    expect(
      getKnownMapLocationIdsFromPosition({
        type: "road",
        roadId: "ROAD_MAIN",
        progress: 0.5,
      })
    ).toEqual(["ROAD_MAIN"]);
  });

  it("returns empty array for null position", () => {
    expect(getKnownMapLocationIdsFromPosition(null)).toEqual([]);
  });
});

describe("buildKnownMapSnapshot", () => {
  it("builds snapshot with full detail for known scenes", () => {
    const dgsm = createTownDgsm();
    const ids = createFullKnownMapIds(dgsm);
    const snapshot = buildKnownMapSnapshot(dgsm, ids);

    expect(Object.keys(snapshot.scenes)).toHaveLength(4);
    expect(snapshot.scenes.hall_lobby.name).toBe("Town Hall Lobby");
    expect(snapshot.scenes.hall_lobby.description).toBe(
      "Town Hall Lobby description"
    );
    expect(snapshot.scenes.hall_lobby.detailLevel).toBe("full");
  });

  it("only includes connections to known locations", () => {
    const dgsm = createTownDgsm();
    // Only know about hall_lobby and hall_office, not JUNC_SQUARE
    const ids: KnownMapIds = {
      sceneIds: ["hall_lobby", "hall_office"],
      junctionIds: [],
      roadIds: [],
      scenarioOutlineIds: ["TOWN_HALL"],
    };
    const snapshot = buildKnownMapSnapshot(dgsm, ids);

    const lobbyConnections = snapshot.scenes.hall_lobby.connections;
    // hall_office should be included, JUNC_SQUARE should be filtered out
    expect(lobbyConnections.some((c) => c.targetId === "hall_office")).toBe(
      true
    );
    expect(lobbyConnections.some((c) => c.targetId === "JUNC_SQUARE")).toBe(
      false
    );
  });

  it("hidden connections remain hidden without revealedHiddenConnections", () => {
    const dgsm = createTownDgsm();
    const ids: KnownMapIds = {
      sceneIds: ["hall_office", "hall_basement"],
      junctionIds: [],
      roadIds: [],
      scenarioOutlineIds: ["TOWN_HALL"],
    };
    const snapshot = buildKnownMapSnapshot(dgsm, ids);
    const hiddenConn = snapshot.scenes.hall_office.connections.find(
      (c) => c.targetId === "hall_basement"
    );
    expect(hiddenConn?.hidden).toBe(true);
  });

  it("reveals hidden connections when specified", () => {
    const dgsm = createTownDgsm();
    const ids: KnownMapIds = {
      sceneIds: ["hall_office", "hall_basement"],
      junctionIds: [],
      roadIds: [],
      scenarioOutlineIds: ["TOWN_HALL"],
    };
    const snapshot = buildKnownMapSnapshot(dgsm, ids, {
      revealedHiddenConnections: [
        makeKnownMapConnectionKey("hall_office", "hall_basement"),
      ],
    });
    const revealedConn = snapshot.scenes.hall_office.connections.find(
      (c) => c.targetId === "hall_basement"
    );
    expect(revealedConn?.hidden).toBe(false);
  });

  it("renders name_only scenes with minimal data", () => {
    const dgsm = createTownDgsm();
    const ids: KnownMapIds = {
      sceneIds: ["hall_lobby", "hall_office"],
      junctionIds: [],
      roadIds: [],
      scenarioOutlineIds: ["TOWN_HALL"],
    };
    const snapshot = buildKnownMapSnapshot(dgsm, ids, {
      nameOnlySceneIds: ["hall_office"],
    });

    const office = snapshot.scenes.hall_office;
    expect(office.detailLevel).toBe("name_only");
    expect(office.name).toBe("Town Hall Office");
    expect(office.description).toBe("");
    expect(office.connections).toEqual([]);
    expect(office.items).toEqual([]);
    expect(office.conditions).toEqual([]);

    // hall_lobby should still be full
    expect(snapshot.scenes.hall_lobby.detailLevel).toBe("full");
  });

  it("currentLocationId overrides name_only for that scene", () => {
    const dgsm = createTownDgsm();
    const ids: KnownMapIds = {
      sceneIds: ["hall_lobby", "hall_office"],
      junctionIds: [],
      roadIds: [],
      scenarioOutlineIds: ["TOWN_HALL"],
    };
    const snapshot = buildKnownMapSnapshot(dgsm, ids, {
      nameOnlySceneIds: ["hall_lobby", "hall_office"],
      currentLocationId: "hall_office",
    });

    // Current location should be full despite being in nameOnlySceneIds
    expect(snapshot.scenes.hall_office.detailLevel).toBe("full");
    // Other scenes still name_only
    expect(snapshot.scenes.hall_lobby.detailLevel).toBe("name_only");
  });

  it("includes scenario conditions from scenarioConditions map", () => {
    const dgsm = createTownDgsm();
    dgsm.appendSceneCondition("hall_lobby", {
      description: "[Weather] Heavy rain outside",
    });
    const ids = createFullKnownMapIds(dgsm);
    const snapshot = buildKnownMapSnapshot(dgsm, ids);

    expect(
      snapshot.scenes.hall_lobby.conditions.some(
        (c) => c.description === "[Weather] Heavy rain outside"
      )
    ).toBe(true);
  });

  it("includes junctions filtered to known scenes", () => {
    const dgsm = createTownDgsm();
    const ids: KnownMapIds = {
      sceneIds: ["hall_lobby"],
      junctionIds: ["JUNC_SQUARE", "JUNC_STATION"],
      roadIds: [],
      scenarioOutlineIds: ["TOWN_HALL"],
    };
    const snapshot = buildKnownMapSnapshot(dgsm, ids);

    // JUNC_SQUARE connects to hall_lobby (known) — should keep it
    expect(snapshot.junctions.JUNC_SQUARE.connectedSceneIds).toContain(
      "hall_lobby"
    );
    // JUNC_STATION connects to bookshop_main (not known) — should filter it out
    expect(snapshot.junctions.JUNC_STATION.connectedSceneIds).not.toContain(
      "bookshop_main"
    );
  });

  it("includes blocked connections only between known locations", () => {
    const dgsm = createTownDgsm();
    dgsm.setConnectionBlocked("hall_lobby", "hall_office", "Door is locked");
    dgsm.setConnectionBlocked("hall_lobby", "bookshop_main", "No passage");

    const ids: KnownMapIds = {
      sceneIds: ["hall_lobby", "hall_office"],
      junctionIds: [],
      roadIds: [],
      scenarioOutlineIds: ["TOWN_HALL"],
    };
    const snapshot = buildKnownMapSnapshot(dgsm, ids);

    // hall_lobby → hall_office: both known, should be included
    const keys = Object.keys(snapshot.blockedConnections);
    expect(keys.length).toBeGreaterThanOrEqual(1);
    // hall_lobby → bookshop_main: bookshop_main not known, should be excluded
  });

  it("includes scenario outlines and transport edges", () => {
    const dgsm = createTownDgsm();
    const ids = createFullKnownMapIds(dgsm);
    const snapshot = buildKnownMapSnapshot(dgsm, ids);

    expect(snapshot.scenarioOutlines.length).toBeGreaterThan(0);
    expect(snapshot.scenarioOutlines.some((o) => o.id === "TOWN_HALL")).toBe(
      true
    );
  });

  it("sets schemaVersion and updatedAt", () => {
    const dgsm = createTownDgsm();
    const ids = createFullKnownMapIds(dgsm);
    const snapshot = buildKnownMapSnapshot(dgsm, ids);

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.updatedAt).toBeTruthy();
  });
});

describe("areKnownMapSnapshotsEquivalent", () => {
  it("returns true for same content with different updatedAt", () => {
    const dgsm = createTownDgsm();
    const ids = createFullKnownMapIds(dgsm);
    const a = buildKnownMapSnapshot(dgsm, ids);
    const b = { ...a, updatedAt: "2099-01-01T00:00:00Z" };
    expect(areKnownMapSnapshotsEquivalent(a, b)).toBe(true);
  });

  it("returns false when scene data differs", () => {
    const dgsm = createTownDgsm();
    const ids = createFullKnownMapIds(dgsm);
    const a = buildKnownMapSnapshot(dgsm, ids);
    dgsm.appendSceneCondition("hall_lobby", { description: "New condition" });
    const b = buildKnownMapSnapshot(dgsm, ids);
    expect(areKnownMapSnapshotsEquivalent(a, b)).toBe(false);
  });
});

describe("extractNameOnlySceneIds", () => {
  it("returns IDs of name_only scenes", () => {
    const dgsm = createTownDgsm();
    const ids: KnownMapIds = {
      sceneIds: ["hall_lobby", "hall_office", "bookshop_main"],
      junctionIds: [],
      roadIds: [],
      scenarioOutlineIds: [],
    };
    const snapshot = buildKnownMapSnapshot(dgsm, ids, {
      nameOnlySceneIds: ["hall_office", "bookshop_main"],
    });

    const nameOnly = extractNameOnlySceneIds(snapshot);
    expect(nameOnly).toEqual(["bookshop_main", "hall_office"]);
  });

  it("returns empty array for null snapshot", () => {
    expect(extractNameOnlySceneIds(null)).toEqual([]);
  });
});

describe("hydrateKnownMapSnapshot", () => {
  it("converts snapshot records to Maps", () => {
    const dgsm = createTownDgsm();
    const ids = createFullKnownMapIds(dgsm);
    const snapshot = buildKnownMapSnapshot(dgsm, ids);
    const hydrated = hydrateKnownMapSnapshot(snapshot);

    expect(hydrated.scenes).toBeInstanceOf(Map);
    expect(hydrated.junctions).toBeInstanceOf(Map);
    expect(hydrated.roads).toBeInstanceOf(Map);
    expect(hydrated.blockedConnections).toBeInstanceOf(Map);
    expect(hydrated.scenes.get("hall_lobby")?.name).toBe("Town Hall Lobby");
  });

  it("rebuilds topology from junctions and roads", () => {
    const dgsm = createTownDgsm();
    const ids = createFullKnownMapIds(dgsm);
    const snapshot = buildKnownMapSnapshot(dgsm, ids);
    const hydrated = hydrateKnownMapSnapshot(snapshot);

    expect(hydrated.topology.junctions.size).toBeGreaterThan(0);
    expect(hydrated.topology.roads.size).toBeGreaterThan(0);
  });
});

describe("areKnownMapConnectionKeysEqual", () => {
  it("returns true for identical arrays", () => {
    expect(areKnownMapConnectionKeysEqual(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("returns true for both undefined", () => {
    expect(areKnownMapConnectionKeysEqual(undefined, undefined)).toBe(true);
  });

  it("returns false for different arrays", () => {
    expect(areKnownMapConnectionKeysEqual(["a"], ["a", "b"])).toBe(false);
  });
});

describe("NPC scene map scenarios", () => {
  describe("NPC with limited seed sees restricted map", () => {
    it("Alice in Town Hall only knows Town Hall scenes", () => {
      const dgsm = createTownDgsm();
      const aliceSeed = {
        sceneIds: ["hall_lobby", "hall_office"],
      };
      const aliceIds = createKnownMapIdsFromSeed(dgsm, aliceSeed);
      const aliceSnapshot = buildKnownMapSnapshot(dgsm, aliceIds);

      // Alice knows Town Hall scenes
      expect(Object.keys(aliceSnapshot.scenes)).toContain("hall_lobby");
      expect(Object.keys(aliceSnapshot.scenes)).toContain("hall_office");
      // Alice does NOT know about Bookshop
      expect(Object.keys(aliceSnapshot.scenes)).not.toContain("bookshop_main");
      // Alice does NOT know about basement (hidden connection)
      expect(Object.keys(aliceSnapshot.scenes)).not.toContain("hall_basement");
    });
  });

  describe("NPC moves to new scene — map expands", () => {
    it("moving to JUNC_SQUARE reveals junction neighborhood", () => {
      const dgsm = createTownDgsm();
      const base: KnownMapIds = {
        sceneIds: ["hall_lobby"],
        junctionIds: [],
        roadIds: [],
        scenarioOutlineIds: ["TOWN_HALL"],
      };

      // NPC walks out to JUNC_SQUARE
      const expanded = revealKnownMapLocations(dgsm, base, ["JUNC_SQUARE"]);

      expect(expanded.junctionIds).toContain("JUNC_SQUARE");
      expect(expanded.roadIds).toContain("ROAD_MAIN");
      // Junction reveals connected buildings
      expect(expanded.sceneIds).toContain("hall_lobby");
      // Road reveals other endpoint
      expect(expanded.junctionIds).toContain("JUNC_STATION");
    });
  });

  describe("two NPCs see different maps", () => {
    it("Alice and Bob have independent map views", () => {
      const dgsm = createTownDgsm();

      // Alice: knows Town Hall area
      const aliceIds = createKnownMapIdsFromSeed(dgsm, {
        sceneIds: ["hall_lobby", "hall_office"],
      });
      const aliceSnapshot = buildKnownMapSnapshot(dgsm, aliceIds);

      // Bob: knows Bookshop area
      const bobIds = createKnownMapIdsFromSeed(dgsm, {
        sceneIds: ["bookshop_main"],
        junctionIds: ["JUNC_STATION"],
      });
      const bobSnapshot = buildKnownMapSnapshot(dgsm, bobIds);

      // Alice sees Town Hall, not Bookshop
      expect(aliceSnapshot.scenes.hall_lobby).toBeDefined();
      expect(aliceSnapshot.scenes.bookshop_main).toBeUndefined();

      // Bob sees Bookshop, not Town Hall
      expect(bobSnapshot.scenes.bookshop_main).toBeDefined();
      expect(bobSnapshot.scenes.hall_lobby).toBeUndefined();
    });
  });

  describe("hidden connection discovery is per-NPC", () => {
    it("Alice discovers trapdoor, Bob does not know", () => {
      const dgsm = createTownDgsm();
      const bothKnowIds: KnownMapIds = {
        sceneIds: ["hall_lobby", "hall_office", "hall_basement"],
        junctionIds: [],
        roadIds: [],
        scenarioOutlineIds: ["TOWN_HALL"],
      };

      // Alice discovered the trapdoor
      const aliceSnapshot = buildKnownMapSnapshot(dgsm, bothKnowIds, {
        revealedHiddenConnections: [
          makeKnownMapConnectionKey("hall_office", "hall_basement"),
        ],
      });

      // Bob has not discovered it
      const bobSnapshot = buildKnownMapSnapshot(dgsm, bothKnowIds);

      // Alice sees the connection as not hidden
      const aliceConn = aliceSnapshot.scenes.hall_office.connections.find(
        (c) => c.targetId === "hall_basement"
      );
      expect(aliceConn?.hidden).toBe(false);

      // Bob still sees it as hidden
      const bobConn = bobSnapshot.scenes.hall_office.connections.find(
        (c) => c.targetId === "hall_basement"
      );
      expect(bobConn?.hidden).toBe(true);
    });
  });

  describe("scene conditions are included in snapshot", () => {
    it("dynamic conditions appear in snapshot scenes", () => {
      const dgsm = createTownDgsm();
      dgsm.appendSceneCondition("hall_lobby", {
        description: "[Fire] The lobby is on fire!",
      });
      dgsm.appendSceneCondition("bookshop_main", {
        description: "[Lighting] Dim candlelight",
      });

      const ids = createFullKnownMapIds(dgsm);
      const snapshot = buildKnownMapSnapshot(dgsm, ids);

      expect(
        snapshot.scenes.hall_lobby.conditions.some(
          (c) => c.description === "[Fire] The lobby is on fire!"
        )
      ).toBe(true);
      expect(
        snapshot.scenes.bookshop_main.conditions.some(
          (c) => c.description === "[Lighting] Dim candlelight"
        )
      ).toBe(true);
    });

    it("NPC with limited map does not see other scene conditions", () => {
      const dgsm = createTownDgsm();
      dgsm.appendSceneCondition("bookshop_main", {
        description: "[Fire] Fire in bookshop",
      });

      const aliceIds = createKnownMapIdsFromSeed(dgsm, {
        sceneIds: ["hall_lobby"],
      });
      const aliceSnapshot = buildKnownMapSnapshot(dgsm, aliceIds);

      expect(aliceSnapshot.scenes.bookshop_main).toBeUndefined();
    });
  });

  describe("name_only scenes in movement expansion", () => {
    it("simulates ensureCurrentLocationInMap behavior", () => {
      const dgsm = createTownDgsm();

      // Start: NPC only knows hall_lobby
      const base: KnownMapIds = {
        sceneIds: ["hall_lobby"],
        junctionIds: [],
        roadIds: [],
        scenarioOutlineIds: ["TOWN_HALL"],
      };

      // NPC moves to hall_lobby — expand neighborhood
      const expanded = revealKnownMapLocations(dgsm, base, ["hall_lobby"]);

      // New scenes discovered through expansion
      const newSceneIds = expanded.sceneIds.filter(
        (id) => !base.sceneIds.includes(id)
      );

      // Build snapshot with new scenes as name_only, current as full
      const snapshot = buildKnownMapSnapshot(dgsm, expanded, {
        nameOnlySceneIds: newSceneIds,
        currentLocationId: "hall_lobby",
      });

      // Current location is full
      expect(snapshot.scenes.hall_lobby.detailLevel).toBe("full");
      expect(snapshot.scenes.hall_lobby.description).toBeTruthy();

      // Newly discovered neighbors are name_only
      if (snapshot.scenes.hall_office) {
        expect(snapshot.scenes.hall_office.detailLevel).toBe("name_only");
        expect(snapshot.scenes.hall_office.description).toBe("");
        expect(snapshot.scenes.hall_office.connections).toEqual([]);
      }
    });
  });
});
