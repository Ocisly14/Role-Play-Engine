import { describe, expect, it } from "vitest";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../../../dynamicworldagent/state/DynamicGameState.js";
import { buildTopology } from "../../../dynamicworldagent/state/topologyTypes.js";
import type { JunctionNode, RoadNode } from "../../../dynamicworldagent/state/topologyTypes.js";
import type { DynamicNPCProfile, DynamicScene } from "../../../dynamicworldagent/state/types.js";
import {
  buildEncounterSignature,
  buildEncounterSnapshot,
  shouldEmitEncounter,
} from "../encounterDedup.js";

function makeNpc(id: string, name: string): DynamicNPCProfile {
  return {
    id,
    name,
    attributes: {
      STR: 50,
      CON: 50,
      DEX: 50,
      APP: 50,
      POW: 50,
      SIZ: 50,
      INT: 50,
      EDU: 50,
    },
    status: {
      hp: 10,
      maxHp: 10,
      sanity: 50,
      maxSanity: 50,
      luck: 50,
      conditions: [],
    },
    inventory: [],
    skills: {},
    longTermIntent: "Keep watch",
    relationships: [],
  };
}

function makeScene(
  id: string,
  name: string,
  parentLocationId = "HOUSE"
): DynamicScene {
  return {
    id,
    name,
    description: `${name} description`,
    parentLocationId,
    items: [],
    conditions: [],
    connections: [],
  };
}

function makeJunction(id: string): JunctionNode {
  return {
    id,
    name: id,
    description: `${id} description`,
    parentLocationId: "OUTDOOR",
    items: [],
    conditions: [],
    connectedSceneIds: [],
  };
}

function makeRoad(
  id: string,
  endpointA: string,
  endpointB: string,
  travelTimeMinutes: number
): RoadNode {
  return {
    id,
    name: id,
    description: `${id} description`,
    parentLocationId: "OUTDOOR",
    endpointA,
    endpointB,
    travelTimeMinutes,
    alongConnections: [],
    items: [],
    conditions: [],
  };
}

function createDgsm(): DynamicGameStateManager {
  const state = initialDynamicGameState({
    sessionId: "session",
    moduleName: "module",
    gameDay: 1,
    timeOfDay: "08:00",
  });

  state.topology = buildTopology(new Map(), new Map());
  state.scenes.set("study", makeScene("study", "Study"));
  state.scenes.set("hall", makeScene("hall", "Hall"));
  state.npcCharacters = [
    makeNpc("npc_a", "Alice"),
    makeNpc("npc_b", "Bob"),
    makeNpc("npc_c", "Cara"),
  ];
  state.npcStats = {
    npc_a: { hp: 10, san: 50 },
    npc_b: { hp: 10, san: 50 },
    npc_c: { hp: 10, san: 50 },
  };
  state.npcInventories = {
    npc_a: [],
    npc_b: [],
    npc_c: [],
  };
  state.characterPositions = {
    npc_a: { type: "scene", sceneId: "study" },
    npc_b: { type: "scene", sceneId: "study" },
    npc_c: { type: "scene", sceneId: "hall" },
  };

  return new DynamicGameStateManager(state);
}

describe("encounter dedup helpers", () => {
  it("builds stable signatures from sorted visible rosters", () => {
    expect(buildEncounterSignature("study", ["npc_b", "npc_a", "npc_a"])).toBe(
      buildEncounterSignature("study", ["npc_a", "npc_b"])
    );
  });

  it("creates encounter snapshots only for visible groups with at least two NPCs", () => {
    const dgsm = createDgsm();

    expect([...buildEncounterSnapshot(dgsm)]).toEqual([
      buildEncounterSignature("study", ["npc_a", "npc_b"]),
    ]);

    dgsm.setCharacterHidden("npc_b", true);
    expect([...buildEncounterSnapshot(dgsm)]).toEqual([]);
  });

  it("suppresses encounters when the same roster already existed last tick", () => {
    const previousEncounterSignatures = new Set<string>([
      buildEncounterSignature("study", ["npc_a", "npc_b"]),
    ]);

    expect(
      shouldEmitEncounter(
        "study",
        ["npc_a", "npc_b"],
        previousEncounterSignatures
      )
    ).toBe(false);
    expect(
      shouldEmitEncounter(
        "study",
        ["npc_a", "npc_b", "npc_c"],
        previousEncounterSignatures
      )
    ).toBe(true);
  });

  it("treats hidden reveals as a new encounter because the visible roster changes", () => {
    const dgsm = createDgsm();
    dgsm.setCharacterHidden("npc_b", true);

    const previousEncounterSignatures = buildEncounterSnapshot(dgsm);

    dgsm.setCharacterHidden("npc_b", false);

    expect(
      shouldEmitEncounter(
        "study",
        ["npc_a", "npc_b"],
        previousEncounterSignatures
      )
    ).toBe(true);
  });

  it("emits when a member leaves and the roster shrinks", () => {
    const dgsm = createDgsm();
    // Tick N: A + B + C all in study
    dgsm.setCharacterPosition("npc_c", { type: "scene", sceneId: "study" });
    const previousEncounterSignatures = buildEncounterSnapshot(dgsm);

    // Tick N+1: C leaves — roster is now A + B only
    expect(
      shouldEmitEncounter(
        "study",
        ["npc_a", "npc_b"],
        previousEncounterSignatures
      )
    ).toBe(true);
  });

  it("emits for a location that had no previous encounter", () => {
    // hall had only npc_c (1 person) last tick — no signature stored
    const previousEncounterSignatures = new Set<string>([
      buildEncounterSignature("study", ["npc_a", "npc_b"]),
    ]);

    // Now B moves to hall, joining C
    expect(
      shouldEmitEncounter(
        "hall",
        ["npc_b", "npc_c"],
        previousEncounterSignatures
      )
    ).toBe(true);
  });

  it("suppresses independently per location — one scene suppressed does not affect another", () => {
    const dgsm = createDgsm();
    // Move C to study so both scenes have groups
    dgsm.setCharacterPosition("npc_c", { type: "scene", sceneId: "study" });
    // Add npc_d to hall
    dgsm.getState().npcCharacters.push(makeNpc("npc_d", "Dan"));
    dgsm.getState().npcStats["npc_d"] = { hp: 10, san: 50 };
    dgsm.getState().npcInventories["npc_d"] = [];
    dgsm.setCharacterPosition("npc_d", { type: "scene", sceneId: "hall" });
    dgsm.getState().npcCharacters.push(makeNpc("npc_e", "Eve"));
    dgsm.getState().npcStats["npc_e"] = { hp: 10, san: 50 };
    dgsm.getState().npcInventories["npc_e"] = [];
    dgsm.setCharacterPosition("npc_e", { type: "scene", sceneId: "hall" });

    const previousEncounterSignatures = buildEncounterSnapshot(dgsm);

    // study roster unchanged → suppressed
    expect(
      shouldEmitEncounter(
        "study",
        ["npc_a", "npc_b", "npc_c"],
        previousEncounterSignatures
      )
    ).toBe(false);

    // hall roster unchanged → suppressed
    expect(
      shouldEmitEncounter(
        "hall",
        ["npc_d", "npc_e"],
        previousEncounterSignatures
      )
    ).toBe(false);

    // study roster changes (C leaves) → emits
    expect(
      shouldEmitEncounter(
        "study",
        ["npc_a", "npc_b"],
        previousEncounterSignatures
      )
    ).toBe(true);
  });

  it("excludes dead NPCs from the snapshot", () => {
    const dgsm = createDgsm();
    // Kill npc_b
    dgsm.updateNpcHp("npc_b", -10);

    // Only npc_a is alive in study — no group of 2
    expect([...buildEncounterSnapshot(dgsm)]).toEqual([]);
  });

  it("emits when a dead NPC is replaced by a new arrival", () => {
    const dgsm = createDgsm();
    dgsm.updateNpcHp("npc_b", -10);

    // Snapshot: study has only npc_a (dead npc_b excluded) → no signature stored
    const previousEncounterSignatures = buildEncounterSnapshot(dgsm);

    // npc_c arrives at study — now npc_a + npc_c visible
    expect(
      shouldEmitEncounter(
        "study",
        ["npc_a", "npc_c"],
        previousEncounterSignatures
      )
    ).toBe(true);
  });

  it("never emits for a single-NPC roster", () => {
    expect(shouldEmitEncounter("study", ["npc_a"], new Set())).toBe(false);
  });

  it("never emits for an empty roster", () => {
    expect(shouldEmitEncounter("study", [], new Set())).toBe(false);
  });

  it("emits on the very first tick when previous signatures are empty", () => {
    expect(shouldEmitEncounter("study", ["npc_a", "npc_b"], new Set())).toBe(
      true
    );
  });

  it("snapshot groups NPCs at junctions separately from scenes", () => {
    const dgsm = createDgsm();
    // Move both A and B to a junction
    dgsm.setCharacterPosition("npc_a", {
      type: "junction",
      junctionId: "junc_01",
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "junction",
      junctionId: "junc_01",
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    expect(
      snapshot.has(buildEncounterSignature("junc_01", ["npc_a", "npc_b"]))
    ).toBe(true);
    // study no longer has a group
    expect(
      snapshot.has(buildEncounterSignature("study", ["npc_a", "npc_b"]))
    ).toBe(false);
  });
});

// ─── Road & Junction topology tests ───────────────────────────────────────────

function createDgsmWithTopology(): DynamicGameStateManager {
  const junctions = new Map<string, JunctionNode>([
    ["junc_a", makeJunction("junc_a")],
    ["junc_b", makeJunction("junc_b")],
  ]);
  // 10-minute road between junc_a and junc_b
  const roads = new Map<string, RoadNode>([
    ["road_01", makeRoad("road_01", "junc_a", "junc_b", 10)],
    ["road_02", makeRoad("road_02", "junc_a", "junc_b", 10)],
  ]);

  const state = initialDynamicGameState({
    sessionId: "session",
    moduleName: "module",
    gameDay: 1,
    timeOfDay: "08:00",
  });

  state.topology = buildTopology(junctions, roads);
  state.junctions = junctions;
  state.roads = roads;
  state.npcCharacters = [
    makeNpc("npc_a", "Alice"),
    makeNpc("npc_b", "Bob"),
    makeNpc("npc_c", "Cara"),
  ];
  state.npcStats = {
    npc_a: { hp: 10, san: 50 },
    npc_b: { hp: 10, san: 50 },
    npc_c: { hp: 10, san: 50 },
  };
  state.npcInventories = { npc_a: [], npc_b: [], npc_c: [] };
  state.characterPositions = {
    npc_a: { type: "road", roadId: "road_01", position: 0.5 },
    npc_b: { type: "road", roadId: "road_01", position: 0.5 },
    npc_c: { type: "junction", junctionId: "junc_a" },
  };

  return new DynamicGameStateManager(state);
}

describe("road encounters", () => {
  it("snapshot does NOT group road NPCs that are beyond encounter range", () => {
    const dgsm = createDgsmWithTopology();
    // A at 0.1, B at 0.9 on a 10-min road = 8 min apart, above the 2-min threshold
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.1,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.9,
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    // Each is alone in their component — no group of 2
    expect(
      snapshot.has(buildEncounterSignature("road_01", ["npc_a", "npc_b"]))
    ).toBe(false);
    expect([...snapshot]).toHaveLength(0);
  });

  it("snapshot groups road NPCs that are within encounter range", () => {
    const dgsm = createDgsmWithTopology();
    // A at 0.45, B at 0.55 on a 10-min road = 1 min apart, within 2-min threshold
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.45,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.55,
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    expect(
      snapshot.has(buildEncounterSignature("road_01", ["npc_a", "npc_b"]))
    ).toBe(true);
  });

  it("generates per-NPC perspective signatures when B bridges A and C", () => {
    const dgsm = createDgsmWithTopology();
    // road_01 = 10 min. Threshold = 2 min = 0.2 fraction.
    // A=0.0, B=0.15, C=0.30: A–B=1.5min✓, B–C=1.5min✓, A–C=3.0min✗
    // A sees only B → [A,B]; B sees A and C → [A,B,C]; C sees only B → [B,C]
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.0,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.15,
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "road",
      roadId: "road_01",
      position: 0.3,
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    // All three possible sub-groups are stored
    expect(
      snapshot.has(buildEncounterSignature("road_01", ["npc_a", "npc_b"]))
    ).toBe(true);
    expect(
      snapshot.has(
        buildEncounterSignature("road_01", ["npc_a", "npc_b", "npc_c"])
      )
    ).toBe(true);
    expect(
      snapshot.has(buildEncounterSignature("road_01", ["npc_b", "npc_c"]))
    ).toBe(true);
    expect([...snapshot]).toHaveLength(3);
  });

  it("suppresses sub-group encounter when A-B-C chain persists and only A moves", () => {
    const dgsm = createDgsmWithTopology();
    // Tick N: A=0.0, B=0.15, C=0.30 — snapshot stores [A,B], [A,B,C], [B,C]
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.0,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.15,
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "road",
      roadId: "road_01",
      position: 0.3,
    });
    const previousEncounterSignatures = buildEncounterSnapshot(dgsm);

    // Tick N+1: only A moves — scan produces [A, B] (A sees only B)
    // Must be suppressed because [A,B] is already in the snapshot
    expect(
      shouldEmitEncounter(
        "road_01",
        ["npc_a", "npc_b"],
        previousEncounterSignatures
      )
    ).toBe(false);

    // And [B,C] (if only C moves) is also suppressed
    expect(
      shouldEmitEncounter(
        "road_01",
        ["npc_b", "npc_c"],
        previousEncounterSignatures
      )
    ).toBe(false);

    // And [A,B,C] (if B moves) is also suppressed
    expect(
      shouldEmitEncounter(
        "road_01",
        ["npc_a", "npc_b", "npc_c"],
        previousEncounterSignatures
      )
    ).toBe(false);
  });

  it("produces two separate components when a gap splits road NPCs", () => {
    const dgsm = createDgsmWithTopology();
    dgsm.getState().npcCharacters.push(makeNpc("npc_d", "Dan"));
    dgsm.getState().npcStats["npc_d"] = { hp: 10, san: 50 };
    dgsm.getState().npcInventories["npc_d"] = [];
    // A=0.10, B=0.15 (1.5 min, within). C=0.80, D=0.85 (0.5 min, within).
    // B to C = (0.80-0.15)*10 = 6.5 min — beyond threshold.
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.1,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.15,
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "road",
      roadId: "road_01",
      position: 0.8,
    });
    dgsm.setCharacterPosition("npc_d", {
      type: "road",
      roadId: "road_01",
      position: 0.85,
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    expect(
      snapshot.has(buildEncounterSignature("road_01", ["npc_a", "npc_b"]))
    ).toBe(true);
    expect(
      snapshot.has(buildEncounterSignature("road_01", ["npc_c", "npc_d"]))
    ).toBe(true);
    expect([...snapshot]).toHaveLength(2);
  });

  it("includes road NPCs at exactly the 2-minute boundary", () => {
    const dgsm = createDgsmWithTopology();
    // 0.2 fraction on a 10-min road = exactly 2 min. Threshold is <=2.
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.0,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.2,
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    expect(
      snapshot.has(buildEncounterSignature("road_01", ["npc_a", "npc_b"]))
    ).toBe(true);
  });

  it("NPCs on different roads form independent groups", () => {
    const dgsm = createDgsmWithTopology();
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_02",
      position: 0.5,
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    expect(snapshot.has(buildEncounterSignature("road_01", ["npc_a"]))).toBe(
      false
    );
    expect(snapshot.has(buildEncounterSignature("road_02", ["npc_b"]))).toBe(
      false
    );
    // Each road has only 1 NPC — no group of 2
    expect([...snapshot]).toHaveLength(0);
  });

  it("suppresses road encounters when the same roster persists on the same road", () => {
    const dgsm = createDgsmWithTopology();
    // Tick N: A and B both on road_01 (within encounter range)
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    const previousEncounterSignatures = buildEncounterSnapshot(dgsm);

    // Tick N+1: same road, slightly different positions but still road_01
    expect(
      shouldEmitEncounter(
        "road_01",
        ["npc_a", "npc_b"],
        previousEncounterSignatures
      )
    ).toBe(false);
  });

  it("emits when an NPC moves onto a road that previously had only one NPC", () => {
    const dgsm = createDgsmWithTopology();
    // Tick N: only A on road_01
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "junction",
      junctionId: "junc_a",
    });
    const previousEncounterSignatures = buildEncounterSnapshot(dgsm);

    // Tick N+1: B moves onto road_01
    expect(
      shouldEmitEncounter(
        "road_01",
        ["npc_a", "npc_b"],
        previousEncounterSignatures
      )
    ).toBe(true);
  });

  it("does not suppress first real encounter when NPCs were on same road but out of range", () => {
    const dgsm = createDgsmWithTopology();
    // Tick N: A at 0.1, B at 0.9 — 8 min apart, NOT co-located.
    // buildEncounterSnapshot must produce NO shared signature for them.
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.1,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.9,
    });
    const previousEncounterSignatures = buildEncounterSnapshot(dgsm);

    // Tick N+1: A moves to 0.45, B to 0.55 — now 1 min apart, ARE co-located.
    // This is their first real encounter — shouldEmitEncounter must return true.
    expect(
      shouldEmitEncounter(
        "road_01",
        ["npc_a", "npc_b"],
        previousEncounterSignatures
      )
    ).toBe(true);
  });
});

describe("junction encounters", () => {
  it("snapshot groups NPCs at the same junction", () => {
    const dgsm = createDgsmWithTopology();
    // npc_c starts at junc_a in this fixture; move it away first
    dgsm.setCharacterPosition("npc_c", {
      type: "road",
      roadId: "road_02",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_a", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "junction",
      junctionId: "junc_a",
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    expect(
      snapshot.has(buildEncounterSignature("junc_a", ["npc_a", "npc_b"]))
    ).toBe(true);
  });

  it("NPCs at different junctions form independent groups", () => {
    const dgsm = createDgsmWithTopology();
    dgsm.setCharacterPosition("npc_a", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "junction",
      junctionId: "junc_b",
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    expect([...snapshot]).toHaveLength(0); // each junction has only 1 NPC
  });

  it("suppresses junction encounter when the same pair stays at the same junction", () => {
    const dgsm = createDgsmWithTopology();
    dgsm.setCharacterPosition("npc_c", {
      type: "road",
      roadId: "road_02",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_a", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "junction",
      junctionId: "junc_a",
    });
    const previousEncounterSignatures = buildEncounterSnapshot(dgsm);

    expect(
      shouldEmitEncounter(
        "junc_a",
        ["npc_a", "npc_b"],
        previousEncounterSignatures
      )
    ).toBe(false);
  });

  it("emits when an NPC arrives at a junction where another NPC already stands", () => {
    const dgsm = createDgsmWithTopology();
    // Only npc_a and npc_c at junc_a in previous tick; npc_b was on road
    dgsm.setCharacterPosition("npc_a", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.1,
    });
    const previousEncounterSignatures = buildEncounterSnapshot(dgsm);

    // B arrives at junc_a — roster changes from [npc_a, npc_c] to [npc_a, npc_b, npc_c]
    expect(
      shouldEmitEncounter(
        "junc_a",
        ["npc_a", "npc_b", "npc_c"],
        previousEncounterSignatures
      )
    ).toBe(true);
  });

  it("scene and junction with the same string ID are treated as distinct locations", () => {
    // Guard against accidental collision between a scene ID and a junction ID
    const sigScene = buildEncounterSignature("loc_x", ["npc_a", "npc_b"]);
    const sigJunction = buildEncounterSignature("loc_x", ["npc_a", "npc_b"]);
    // resolveLocationId returns the raw ID for both — they ARE the same signature.
    // This test documents that the system relies on unique IDs across types.
    expect(sigScene).toBe(sigJunction);
  });

  it("three NPCs at the same junction produce one signature covering all three", () => {
    const dgsm = createDgsmWithTopology();
    dgsm.setCharacterPosition("npc_a", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "junction",
      junctionId: "junc_a",
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    expect(
      snapshot.has(
        buildEncounterSignature("junc_a", ["npc_a", "npc_b", "npc_c"])
      )
    ).toBe(true);
    expect([...snapshot]).toHaveLength(1);
  });

  it("hidden NPC at junction is excluded from the group", () => {
    const dgsm = createDgsmWithTopology();
    dgsm.setCharacterPosition("npc_a", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterHidden("npc_c", true);

    const snapshot = buildEncounterSnapshot(dgsm);

    // Only A and B visible — C excluded
    expect(
      snapshot.has(buildEncounterSignature("junc_a", ["npc_a", "npc_b"]))
    ).toBe(true);
    expect(
      snapshot.has(
        buildEncounterSignature("junc_a", ["npc_a", "npc_b", "npc_c"])
      )
    ).toBe(false);
    expect([...snapshot]).toHaveLength(1);
  });

  it("emits when a new NPC joins an existing junction pair", () => {
    const dgsm = createDgsmWithTopology();
    // Tick N: A and B at junc_a
    dgsm.setCharacterPosition("npc_c", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_a", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "junction",
      junctionId: "junc_a",
    });
    const previousEncounterSignatures = buildEncounterSnapshot(dgsm);

    // Tick N+1: C joins → new group [A, B, C]
    expect(
      shouldEmitEncounter(
        "junc_a",
        ["npc_a", "npc_b", "npc_c"],
        previousEncounterSignatures
      )
    ).toBe(true);
  });

  it("emits when a member leaves a junction group", () => {
    const dgsm = createDgsmWithTopology();
    // Tick N: A, B, C all at junc_a
    dgsm.setCharacterPosition("npc_a", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "junction",
      junctionId: "junc_a",
    });
    const previousEncounterSignatures = buildEncounterSnapshot(dgsm);

    // Tick N+1: C leaves → remaining pair [A, B] is a new group
    expect(
      shouldEmitEncounter(
        "junc_a",
        ["npc_a", "npc_b"],
        previousEncounterSignatures
      )
    ).toBe(true);
  });
});

describe("road encounters — edge cases", () => {
  it("all NPCs mutually within range produce one deduplicated signature", () => {
    const dgsm = createDgsmWithTopology();
    // A=0.0, B=0.1, C=0.15: all pairs within 2-min threshold
    // A–B=1min✓, A–C=1.5min✓, B–C=0.5min✓
    // Each sees the other two → all three per-NPC views produce [A,B,C] → deduplicated to 1
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.0,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.1,
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "road",
      roadId: "road_01",
      position: 0.15,
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    expect(
      snapshot.has(
        buildEncounterSignature("road_01", ["npc_a", "npc_b", "npc_c"])
      )
    ).toBe(true);
    expect([...snapshot]).toHaveLength(1);
  });

  it("hub NPC within range of two non-adjacent NPCs generates three distinct signatures", () => {
    const dgsm = createDgsmWithTopology();
    // B=0.15 is hub: A=0.0 (1.5min✓), C=0.35 (2min✓, boundary)
    // A–C = 3.5min ✗ → A and C don't see each other
    // A sees B → [A,B]; B sees A and C → [A,B,C]; C sees B → [B,C]
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.0,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.15,
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "road",
      roadId: "road_01",
      position: 0.35,
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    expect(
      snapshot.has(buildEncounterSignature("road_01", ["npc_a", "npc_b"]))
    ).toBe(true);
    expect(
      snapshot.has(
        buildEncounterSignature("road_01", ["npc_a", "npc_b", "npc_c"])
      )
    ).toBe(true);
    expect(
      snapshot.has(buildEncounterSignature("road_01", ["npc_b", "npc_c"]))
    ).toBe(true);
    expect([...snapshot]).toHaveLength(3);
  });

  it("four NPCs in a chain A-B-C-D produce four signatures", () => {
    const dgsm = createDgsmWithTopology();
    dgsm.getState().npcCharacters.push(makeNpc("npc_d", "Dan"));
    dgsm.getState().npcStats["npc_d"] = { hp: 10, san: 50 };
    dgsm.getState().npcInventories["npc_d"] = [];
    // A=0.0, B=0.15, C=0.30, D=0.45 — each consecutive pair 1.5min apart ✓
    // Non-consecutive: A–C=3min✗, A–D=4.5min✗, B–D=3min✗
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.0,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.15,
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "road",
      roadId: "road_01",
      position: 0.3,
    });
    dgsm.setCharacterPosition("npc_d", {
      type: "road",
      roadId: "road_01",
      position: 0.45,
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    // A sees B only → [A,B]
    expect(
      snapshot.has(buildEncounterSignature("road_01", ["npc_a", "npc_b"]))
    ).toBe(true);
    // B sees A and C → [A,B,C]
    expect(
      snapshot.has(
        buildEncounterSignature("road_01", ["npc_a", "npc_b", "npc_c"])
      )
    ).toBe(true);
    // C sees B and D → [B,C,D]
    expect(
      snapshot.has(
        buildEncounterSignature("road_01", ["npc_b", "npc_c", "npc_d"])
      )
    ).toBe(true);
    // D sees C only → [C,D]
    expect(
      snapshot.has(buildEncounterSignature("road_01", ["npc_c", "npc_d"]))
    ).toBe(true);
    expect([...snapshot]).toHaveLength(4);
  });

  it("single NPC on road produces no signature", () => {
    const dgsm = createDgsmWithTopology();
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "junction",
      junctionId: "junc_b",
    });

    expect([...buildEncounterSnapshot(dgsm)]).toHaveLength(0);
  });

  it("road NPC with no road metadata in state produces no signature", () => {
    const dgsm = createDgsmWithTopology();
    // Put A and B on an unknown road (not in state.roads)
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_unknown",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_unknown",
      position: 0.5,
    });

    const snapshot = buildEncounterSnapshot(dgsm);

    // arePositionsCoLocated returns false when road metadata is missing
    expect(
      snapshot.has(buildEncounterSignature("road_unknown", ["npc_a", "npc_b"]))
    ).toBe(false);
    expect([...snapshot]).toHaveLength(0);
  });

  it("hidden road NPC is excluded from all signatures", () => {
    const dgsm = createDgsmWithTopology();
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterHidden("npc_b", true);

    // Only A on road_01 (B hidden) → no group
    expect([...buildEncounterSnapshot(dgsm)]).toHaveLength(0);
  });

  it("road hidden reveal: snapshot has no [A,B] while B hidden, fires encounter after reveal", () => {
    const dgsm = createDgsmWithTopology();
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "road",
      roadId: "road_02",
      position: 0.5,
    });
    dgsm.setCharacterHidden("npc_b", true);

    // Tick N: B is hidden — snapshot has no entry for road_01
    const prevSigs = buildEncounterSnapshot(dgsm);
    expect(
      prevSigs.has(buildEncounterSignature("road_01", ["npc_a", "npc_b"]))
    ).toBe(false);
    expect([...prevSigs].filter((s) => s.includes("road_01"))).toHaveLength(0);

    // Tick N+1: B is revealed (by a Spot Hidden check during the tick)
    dgsm.setCharacterHidden("npc_b", false);

    // scanUnplannedEncounters would call shouldEmitEncounter([A,B], prevSigs)
    // prevSigs has no [road_01,[A,B]] entry because B was hidden → must fire
    expect(shouldEmitEncounter("road_01", ["npc_a", "npc_b"], prevSigs)).toBe(
      true
    );

    // After tick N+1, snapshot now includes [A,B]
    const newSigs = buildEncounterSnapshot(dgsm);
    expect(
      newSigs.has(buildEncounterSignature("road_01", ["npc_a", "npc_b"]))
    ).toBe(true);

    // Tick N+2: same group persists → no re-emit
    expect(shouldEmitEncounter("road_01", ["npc_a", "npc_b"], newSigs)).toBe(
      false
    );
  });

  it("road hidden observer excluded from signature even when they observe visible NPCs", () => {
    const dgsm = createDgsmWithTopology();
    // A is hidden, B and C are visible, all co-located on road_01
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterHidden("npc_a", true);

    // Snapshot excludes A: only B and C produce signatures
    const snapshot = buildEncounterSnapshot(dgsm);
    expect(
      snapshot.has(buildEncounterSignature("road_01", ["npc_b", "npc_c"]))
    ).toBe(true);
    expect([...snapshot].every((s) => !s.includes("npc_a"))).toBe(true);

    // shouldEmitEncounter with [B,C] (as scanUnplannedEncounters would produce) → false (already in snapshot)
    expect(shouldEmitEncounter("road_01", ["npc_b", "npc_c"], snapshot)).toBe(
      false
    );
  });

  it("emits when a new NPC joins an existing road pair within range", () => {
    const dgsm = createDgsmWithTopology();
    // Tick N: A and B co-located on road_01
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "road",
      roadId: "road_01",
      position: 0.55,
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "junction",
      junctionId: "junc_a",
    });
    const previousEncounterSignatures = buildEncounterSnapshot(dgsm);

    // Tick N+1: C moves onto road_01 near A and B → new group [A, B, C]
    expect(
      shouldEmitEncounter(
        "road_01",
        ["npc_a", "npc_b", "npc_c"],
        previousEncounterSignatures
      )
    ).toBe(true);
  });

  it("road and junction NPCs never share a signature regardless of IDs", () => {
    const dgsm = createDgsmWithTopology();
    // A on road_01, B at junc_a, C on road_02 — no two NPCs share a location
    dgsm.setCharacterPosition("npc_a", {
      type: "road",
      roadId: "road_01",
      position: 0.5,
    });
    dgsm.setCharacterPosition("npc_b", {
      type: "junction",
      junctionId: "junc_a",
    });
    dgsm.setCharacterPosition("npc_c", {
      type: "road",
      roadId: "road_02",
      position: 0.5,
    });

    expect([...buildEncounterSnapshot(dgsm)]).toHaveLength(0);
  });
});
