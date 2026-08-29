// M3: connectionBlock finally WORKS. The Applier keys its refcount vote table
// by the canonical symmetric edge (the same key scheme as
// state.blockedConnections), resolves the exit id through the connection
// registry, and writes through the 4-arg setConnectionBlocked — so
// pathfinding, the movement runtime and the context builder all see the
// block through their existing read paths, zero changes there.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../../../state/DynamicGameState.js";
import {
  type JunctionNode,
  type RoadNode,
  buildTopology,
} from "../../../state/topologyTypes.js";
import type { DynamicScene } from "../../../state/types.js";
import type { SourcedWorldDelta } from "../../actions/types.js";
import { findTopologyPath } from "../../shared/pathfinding.js";
import { Applier } from "../applier.js";

// Topology: J_A —R_MAIN(10')— J_B, with a two-road detour J_A —R_A_C(5')—
// J_C —R_C_B(9')— J_B. S_HOME hangs off J_A with a two-way pair of exit ids.
function makeFixture() {
  const state = initialDynamicGameState({
    sessionId: "test-session",
    moduleName: "test-module",
  });

  const scene: DynamicScene = {
    id: "S_HOME",
    name: "Home",
    description: "A parlour.",
    parentLocationId: "LOC_TOWN",
    items: [],
    conditions: [],
    connections: [{ id: "exit.home.junc", targetId: "J_A" }],
  };

  const junction = (
    id: string,
    connections: JunctionNode["connections"],
    connectedSceneIds: string[] = []
  ): JunctionNode => ({
    id,
    name: id,
    description: `${id} crossing`,
    parentLocationId: "OUTDOOR",
    items: [],
    conditions: [],
    connections,
    connectedSceneIds,
  });

  const road = (
    id: string,
    a: string,
    b: string,
    minutes: number
  ): RoadNode => ({
    id,
    name: id,
    description: `${id} road`,
    parentLocationId: "OUTDOOR",
    connections: [
      { id: `exit.${id}.a`, targetId: a, role: "endpointA" },
      { id: `exit.${id}.b`, targetId: b, role: "endpointB" },
    ],
    endpointA: a,
    endpointB: b,
    travelTimeMinutes: minutes,
    alongConnections: [],
    items: [],
    conditions: [],
  });

  const jA = junction(
    "J_A",
    [
      { id: "exit.junc.home", targetId: "S_HOME" },
      { id: "exit.ja.rmain", targetId: "R_MAIN" },
      { id: "exit.ja.rac", targetId: "R_A_C" },
    ],
    ["S_HOME"]
  );
  const jB = junction("J_B", [
    { id: "exit.jb.rmain", targetId: "R_MAIN" },
    { id: "exit.jb.rcb", targetId: "R_C_B" },
  ]);
  const jC = junction("J_C", [
    { id: "exit.jc.rac", targetId: "R_A_C" },
    { id: "exit.jc.rcb", targetId: "R_C_B" },
  ]);
  const rMain = road("R_MAIN", "J_A", "J_B", 10);
  const rAC = road("R_A_C", "J_A", "J_C", 5);
  const rCB = road("R_C_B", "J_C", "J_B", 9);

  state.scenes.set(scene.id, scene);
  for (const j of [jA, jB, jC]) state.junctions.set(j.id, j);
  for (const r of [rMain, rAC, rCB]) state.roads.set(r.id, r);

  const dgsm = new DynamicGameStateManager(state);
  const topology = buildTopology(state.junctions, state.roads);
  const applier = new Applier(dgsm, new Map());
  return { dgsm, applier, topology, state };
}

/** A scene-domain connectionBlock delta as the World Action Engine emits it. */
function blockDelta(
  actionId: string,
  connectionId: string,
  blocked: boolean,
  reason: string
): SourcedWorldDelta {
  return {
    source: { kind: "action", actionId },
    causalBasis: "test",
    delta: {
      domain: "scene",
      sceneId: "J_A",
      operation: { kind: "connectionBlock", connectionId, blocked, reason },
    },
  };
}

const T = "1985-07-08T09:00:00";

let fixture: ReturnType<typeof makeFixture>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fixture = makeFixture();
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("connectionBlock lands in state.blockedConnections", () => {
  it("writes the canonical edge key with the reason", () => {
    const { dgsm, applier, state } = fixture;
    applier.flush([], T, [
      blockDelta("a1", "exit.ja.rmain", true, "a felled tree"),
    ]);

    expect(state.blockedConnections.get("junction:J_A::road:R_MAIN")).toBe(
      "a felled tree"
    );
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBe(
      "a felled tree"
    );
    expect(dgsm.isConnectionBlocked("R_MAIN", "J_A")).toBe(true);
  });

  it("drops (warn, no throw) a vote whose connection id resolves to no edge", () => {
    const { applier, state } = fixture;
    expect(() =>
      applier.flush([], T, [
        blockDelta("a1", "exit.nowhere.door", true, "ghost"),
      ])
    ).not.toThrow();
    expect(state.blockedConnections.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"exit.nowhere.door" resolves to no edge')
    );
  });
});

describe("pathfinding refuses the blocked edge and detours", () => {
  const from = { type: "junction", junctionId: "J_A" } as const;
  const to = { type: "junction", junctionId: "J_B" } as const;

  it("takes the direct road while it is open", () => {
    const { topology, state, dgsm } = fixture;
    const path = findTopologyPath(
      from,
      to,
      topology,
      state.blockedConnections,
      dgsm
    );
    expect(path?.steps.map((s) => s.id)).toEqual(["R_MAIN"]);
    expect(path?.totalMinutes).toBe(10);
  });

  it("detours once the Engine blocks the direct road", () => {
    const { applier, topology, state, dgsm } = fixture;
    applier.flush([], T, [
      blockDelta("a1", "exit.ja.rmain", true, "a felled tree"),
    ]);

    const path = findTopologyPath(
      from,
      to,
      topology,
      state.blockedConnections,
      dgsm
    );
    expect(path).not.toBeNull();
    expect(path?.steps.map((s) => s.id)).toEqual(["R_A_C", "R_C_B"]);
    expect(path?.totalMinutes).toBe(14);
  });
});

describe("refcounted votes from several sources", () => {
  it("stays blocked until every voter withdraws", () => {
    const { dgsm, applier } = fixture;
    applier.flush([], T, [
      blockDelta("a1", "exit.ja.rmain", true, "a felled tree"),
      blockDelta("a2", "exit.ja.rmain", true, "a mudslide"),
    ]);
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBe(
      "a felled tree; a mudslide"
    );

    // One voter withdraws — the other's block stands, reason updated.
    applier.flush([], T, [
      blockDelta("a1", "exit.ja.rmain", false, "a felled tree"),
    ]);
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBe("a mudslide");

    // The last voter withdraws — the edge opens.
    applier.flush([], T, [
      blockDelta("a2", "exit.ja.rmain", false, "a mudslide"),
    ]);
    expect(dgsm.isConnectionBlocked("J_A", "R_MAIN")).toBe(false);
  });

  it("collapses the two directions' exit ids onto one edge", () => {
    const { dgsm, applier } = fixture;
    // Block through the scene's own exit id...
    applier.flush([], T, [
      blockDelta("a1", "exit.home.junc", true, "door jammed"),
    ]);
    expect(dgsm.isConnectionBlocked("S_HOME", "J_A")).toBe(true);

    // ...and lift it through the junction's opposite-direction exit id: same
    // edge, same vote table entry.
    applier.flush([], T, [
      blockDelta("a1", "exit.junc.home", false, "door jammed"),
    ]);
    expect(dgsm.isConnectionBlocked("S_HOME", "J_A")).toBe(false);
  });
});

describe("vote table serialization", () => {
  it("round-trips votes keyed by edge so a rehydrated applier can unblock", () => {
    const { dgsm, applier } = fixture;
    applier.flush([], T, [
      blockDelta("a1", "exit.ja.rmain", true, "a felled tree"),
      blockDelta("a2", "exit.ja.rmain", true, "a mudslide"),
    ]);

    const serialized = applier.serializeConnectionVotes();
    expect(Object.keys(serialized)).toEqual(["junction:J_A::road:R_MAIN"]);
    expect(serialized["junction:J_A::road:R_MAIN"]).toHaveLength(2);

    // A fresh applier (post-restart) picks the votes back up.
    const revived = new Applier(dgsm, new Map());
    revived.rehydrateConnectionVotes(JSON.parse(JSON.stringify(serialized)));
    revived.flush([], T, [
      blockDelta("a1", "exit.ja.rmain", false, "a felled tree"),
    ]);
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBe("a mudslide");
    revived.flush([], T, [
      blockDelta("a2", "exit.ja.rmain", false, "a mudslide"),
    ]);
    expect(dgsm.isConnectionBlocked("J_A", "R_MAIN")).toBe(false);
  });
});
