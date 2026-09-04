// connectionBlock lands on state.blockedConnections as ONE flag per canonical
// edge (the same key scheme pathfinding, the movement runtime and the context
// builder already read): the exit id resolves through the connection
// registry, a subsystem's `<featureId>:<a>|<b>` pair through the fallback,
// and whoever writes last says whether the passage is open.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../../../state/DynamicGameState.js";
import {
  makeFeatureEdgeId,
  parseFeatureEdgeId,
} from "../../../state/blockedConnections.js";
import { type RoadNode, buildTopology } from "../../../state/topologyTypes.js";
import type { DynamicScene, SceneConnection } from "../../../state/types.js";
import type { SourcedWorldDelta } from "../../actions/types.js";
import { findTopologyPath } from "../../shared/pathfinding.js";
import { Applier } from "../applier.js";
import type { StateChange } from "../types.js";

// Topology: J_A —R_MAIN(10')— J_B, with a two-road detour J_A —R_A_C(5')—
// J_C —R_C_B(9')— J_B. S_HOME hangs off J_A with a two-way pair of exit ids.
function makeFixture() {
  const state = initialDynamicGameState();

  const scene: DynamicScene = {
    id: "S_HOME",
    name: "Home",
    description: "A parlour.",
    parentLocationId: "LOC_TOWN",
    items: [],
    conditions: [],
    connections: [{ id: "connection.home.junc", targetId: "J_A" }],
  };

  // Top-level scenes (no parentLocationId) are the geography nodes.
  const junction = (
    id: string,
    connections: SceneConnection[]
  ): DynamicScene => ({
    id,
    name: id,
    description: `${id} crossing`,
    items: [],
    conditions: [],
    connections,
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
      { id: `connection.${id}.a`, targetId: a, role: "endpointA" },
      { id: `connection.${id}.b`, targetId: b, role: "endpointB" },
    ],
    endpointA: a,
    endpointB: b,
    travelTimeMinutes: minutes,
    alongConnections: [],
    items: [],
    conditions: [],
  });

  const jA = junction("J_A", [
    { id: "connection.junc.home", targetId: "S_HOME" },
    { id: "connection.ja.rmain", targetId: "R_MAIN" },
    { id: "connection.ja.rac", targetId: "R_A_C" },
  ]);
  const jB = junction("J_B", [
    { id: "connection.jb.rmain", targetId: "R_MAIN" },
    { id: "connection.jb.rcb", targetId: "R_C_B" },
  ]);
  const jC = junction("J_C", [
    { id: "connection.jc.rac", targetId: "R_A_C" },
    { id: "connection.jc.rcb", targetId: "R_C_B" },
  ]);
  const rMain = road("R_MAIN", "J_A", "J_B", 10);
  const rAC = road("R_A_C", "J_A", "J_C", 5);
  const rCB = road("R_C_B", "J_C", "J_B", 9);

  state.scenes.set(scene.id, scene);
  for (const j of [jA, jB, jC]) state.scenes.set(j.id, j);
  for (const r of [rMain, rAC, rCB]) state.roads.set(r.id, r);

  const dgsm = new DynamicGameStateManager(state);
  const topology = buildTopology(state.scenes, state.roads);
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
      blockDelta("a1", "connection.ja.rmain", true, "a felled tree"),
    ]);

    expect(state.blockedConnections.get("road:R_MAIN::scene:J_A")).toBe(
      "a felled tree"
    );
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBe(
      "a felled tree"
    );
    expect(dgsm.getConnectionBlockReason("R_MAIN", "J_A")).toBeDefined();
  });

  it("drops (warn, no throw) a block whose connection id resolves to no edge", () => {
    const { applier, state } = fixture;
    expect(() =>
      applier.flush([], T, [
        blockDelta("a1", "connection.nowhere.door", true, "ghost"),
      ])
    ).not.toThrow();
    expect(state.blockedConnections.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"connection.nowhere.door" resolves to no edge')
    );
  });
});

describe("a subsystem addresses a pair of places, not an authored exit", () => {
  // Weather closes a road in both directions at once, so it has no authored
  // exit id to name — it mints `<featureId>:<a>|<b>`. The Applier resolved
  // block ids through the connection registry only, so every one of these was
  // dropped as "resolves to no edge": snow never closed a road, and nobody
  // noticed until a run's warnings were counted.
  const weatherVote = (
    connectionId: string,
    blocked: boolean
  ): StateChange => ({
    kind: "connection.setBlock",
    connectionId,
    blocked,
    sourceFeatureId: "weather",
    reason: "weather-block",
  });

  it("lands on the same canonical edge an authored exit resolves to", () => {
    const { applier, state, dgsm } = fixture;
    applier.flush(
      [weatherVote(makeFeatureEdgeId("weather", "J_A", "R_MAIN"), true)],
      T,
      []
    );

    expect(state.blockedConnections.get("road:R_MAIN::scene:J_A")).toBe(
      "weather-block"
    );
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBe(
      "weather-block"
    );
  });

  it("lifts the block it cast, from either endpoint order", () => {
    const { applier, state } = fixture;
    applier.flush(
      [weatherVote(makeFeatureEdgeId("weather", "R_MAIN", "J_A"), true)],
      T,
      []
    );
    expect(state.blockedConnections.size).toBe(1);

    applier.flush(
      [weatherVote(makeFeatureEdgeId("weather", "J_A", "R_MAIN"), false)],
      T,
      []
    );
    expect(state.blockedConnections.size).toBe(0);
  });

  it("still drops a pair naming a place that does not exist", () => {
    const { applier, state } = fixture;
    applier.flush([weatherVote("weather:J_A|R_NOWHERE", true)], T, []);

    expect(state.blockedConnections.size).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"weather:J_A|R_NOWHERE" resolves to no edge')
    );
  });

  it("does not read an authored connection id as a pair", () => {
    // `connection.ja.rmain` has no "|", so it can only resolve through the
    // registry — the two id languages never collide.
    expect(parseFeatureEdgeId("connection.ja.rmain")).toBeNull();
    expect(parseFeatureEdgeId("weather:J_A|R_MAIN")).toEqual({
      featureId: "weather",
      a: "J_A",
      b: "R_MAIN",
    });
  });
});

describe("pathfinding refuses the blocked edge and detours", () => {
  const from = { type: "scene", sceneId: "J_A" } as const;
  const to = { type: "scene", sceneId: "J_B" } as const;

  it("takes the direct road while it is open", () => {
    const { topology, state } = fixture;
    const path = findTopologyPath(from, to, topology, state.blockedConnections);
    expect(path?.steps.map((s) => s.id)).toEqual(["R_MAIN"]);
    expect(path?.totalMinutes).toBe(10);
  });

  it("detours once the Engine blocks the direct road", () => {
    const { applier, topology, state } = fixture;
    applier.flush([], T, [
      blockDelta("a1", "connection.ja.rmain", true, "a felled tree"),
    ]);

    const path = findTopologyPath(from, to, topology, state.blockedConnections);
    expect(path).not.toBeNull();
    expect(path?.steps.map((s) => s.id)).toEqual(["R_A_C", "R_C_B"]);
    expect(path?.totalMinutes).toBe(14);
  });
});

describe("one flag per edge — the last writer wins, whoever they are", () => {
  it("a second source overwrites the reason, and a third clears the edge", () => {
    const { dgsm, applier } = fixture;
    applier.flush([], T, [
      blockDelta("a1", "connection.ja.rmain", true, "a felled tree"),
    ]);
    applier.flush([], T, [
      blockDelta("a2", "connection.ja.rmain", true, "a mudslide"),
    ]);
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBe("a mudslide");

    // A third action, a third reason: the edge still opens. Nothing is
    // counted — whoever writes last says what the passage is.
    applier.flush([], T, [
      blockDelta("a3", "connection.ja.rmain", false, "the tree dragged aside"),
    ]);
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBeUndefined();
  });

  it("an Engine delta clears a block a subsystem set", () => {
    const { dgsm, applier } = fixture;
    applier.flush(
      [
        {
          kind: "connection.setBlock",
          connectionId: makeFeatureEdgeId("weather", "J_A", "R_MAIN"),
          blocked: true,
          sourceFeatureId: "weather",
          reason: "snowdrifts",
        },
      ],
      T,
      []
    );
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBe("snowdrifts");

    applier.flush([], T, [
      blockDelta("a1", "connection.ja.rmain", false, "shovelled through"),
    ]);
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBeUndefined();
  });

  it("within one flush the buffered change lands after the Engine's", () => {
    const { dgsm, applier } = fixture;
    applier.flush(
      [
        {
          kind: "connection.setBlock",
          connectionId: makeFeatureEdgeId("weather", "J_A", "R_MAIN"),
          blocked: true,
          sourceFeatureId: "weather",
          reason: "snowdrifts",
        },
      ],
      T,
      [blockDelta("a1", "connection.ja.rmain", false, "shovelled through")]
    );
    // Engine deltas apply first, subsystem changes after: the road is shut.
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBe("snowdrifts");
  });

  it("collapses the two directions' exit ids onto one edge", () => {
    const { dgsm, applier } = fixture;
    // Block through the scene's own exit id...
    applier.flush([], T, [
      blockDelta("a1", "connection.home.junc", true, "door jammed"),
    ]);
    expect(dgsm.getConnectionBlockReason("S_HOME", "J_A")).toBeDefined();

    // ...and lift it through the junction's opposite-direction exit id: same
    // edge, same underlying flag.
    applier.flush([], T, [
      blockDelta("a1", "connection.junc.home", false, "door jammed"),
    ]);
    expect(dgsm.getConnectionBlockReason("S_HOME", "J_A")).toBeUndefined();
  });
});

// `hidden` is the world's answer to "can anyone see this"; `discoveredBy` is
// each viewer's answer to "have I found it". Both live on the passage, so
// nothing has to be kept in step with anything else — and finding is not
// private, so the operation carries a list.
describe("connectionDiscovered", () => {
  const CONN = "connection.home.junc";

  function discovery(characterIds: string[]): SourcedWorldDelta {
    return {
      source: { kind: "action", actionId: "a1" },
      causalBasis: "he prised the panel away and they all saw it",
      delta: {
        domain: "scene",
        sceneId: "S_HOME",
        operation: {
          kind: "connectionDiscovered",
          connectionId: CONN,
          characterIds,
        },
      },
    };
  }

  /** The character-ref guard drops a change naming nobody, so the fixture has
   *  to contain the people who are supposed to find the door. */
  function withCast() {
    const f = makeFixture();
    f.state.npcCharacters.push(
      ...["npc_1", "npc_2", "npc_3"].map(
        (id) => ({ id, name: id, status: { conditions: [] } }) as never
      )
    );
    return f;
  }

  it("records everyone named, on the connection itself", () => {
    const { applier, state } = withCast();
    applier.flush([], T, [discovery(["npc_1", "npc_2"])]);

    const discoveredBy = state.scenes
      .get("S_HOME")
      ?.connections?.find((c) => c.id === CONN)?.discoveredBy;
    expect(discoveredBy).toContain("npc_1");
    expect(discoveredBy).toContain("npc_2");
    // The one who was not in the room learns nothing.
    expect(discoveredBy).not.toContain("npc_3");
  });

  it("is idempotent — finding the same door twice is one discovery", () => {
    const { applier, state } = withCast();
    applier.flush([], T, [discovery(["npc_1"])]);
    applier.flush([], T, [discovery(["npc_1"])]);

    const connection = state.scenes
      .get("S_HOME")
      ?.connections?.find((c) => c.id === CONN);
    expect(connection?.discoveredBy).toEqual(["npc_1"]);
  });
});
