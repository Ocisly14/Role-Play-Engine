// The actor's stated route is the only route: initMovementRuntime enforces
// waypoint adjacency (the way between two far places was never stated), and
// advanceMovement plans each leg lazily so a mid-route block interrupts
// where the walker actually stands.

import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { type RoadNode, buildTopology } from "../../../state/topologyTypes.js";
import type { DynamicScene } from "../../../state/types.js";
import { advanceMovement, initMovementRuntime } from "../movementRuntime.js";

// J_A ══ R_MAIN(4′) ══ J_B ══ R_EAST(3′) ══ J_C ; S_HOME hangs off J_A.
const scenes = new Map<string, DynamicScene>([
  [
    "J_A",
    {
      id: "J_A",
      name: "北口",
      connections: [{ id: "connection.ja.home", targetId: "S_HOME" }],
    } as unknown as DynamicScene,
  ],
  ["J_B", { id: "J_B", connections: [] } as unknown as DynamicScene],
  [
    "J_C",
    { id: "J_C", name: "林道口", connections: [] } as unknown as DynamicScene,
  ],
  [
    "S_HOME",
    {
      id: "S_HOME",
      parentLocationId: "B_HOME",
      connections: [{ id: "connection.home.ja", targetId: "J_A" }],
    } as unknown as DynamicScene,
  ],
  [
    "S_CAB",
    {
      id: "S_CAB",
      parentLocationId: "VEH_TRUCK",
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
      travelTimeMinutes: 4,
      driveTimeMinutes: 2,
      alongConnections: [],
      connections: [],
    } as unknown as RoadNode,
  ],
  [
    "R_EAST",
    {
      id: "R_EAST",
      endpointA: "J_B",
      endpointB: "J_C",
      travelTimeMinutes: 3,
      alongConnections: [],
      connections: [],
    } as unknown as RoadNode,
  ],
]);
const topology = buildTopology(scenes, roads);

function makeDgsm() {
  const positions = new Map<string, unknown>([
    ["npc_1", { type: "scene", sceneId: "J_A" }],
  ]);
  const blocked = new Map<string, string>();
  const truck = {
    id: "VEH_TRUCK",
    name: "truck",
    description: "a flatbed truck",
    interiorSceneId: "S_CAB",
    position: { type: "scene", sceneId: "J_A" } as unknown,
  };
  return {
    getVehicles: () => [truck],
    getVehicle: (id: string) => (id === "VEH_TRUCK" ? truck : null),
    getVehicleByInterior: (id: string) => (id === "S_CAB" ? truck : null),
    __truck: truck,
    getState: () => ({ scenes }),
    getScene: (id: string) => scenes.get(id) ?? null,
    getTopology: () => topology,
    getCharacterPosition: (id: string) => positions.get(id) ?? null,
    getBlockedConnections: () => blocked,
    getConnectionBlockReason: (fromId: string, toId: string) => {
      const key = [fromId, toId].sort().join("::");
      return blocked.get(key);
    },
    resolveConnectionEdgeById: (connectionId: string) => {
      if (
        connectionId !== "connection.home.ja" &&
        connectionId !== "connection.ja.home"
      ) {
        return null;
      }
      return {
        key: "scene:J_A::scene:S_HOME",
        a: { type: "scene", id: "S_HOME" },
        b: { type: "scene", id: "J_A" },
      };
    },
    __positions: positions,
    __blocked: blocked,
  } as unknown as DynamicGameStateManager & {
    __positions: Map<string, unknown>;
    __blocked: Map<string, string>;
    __truck: { position: unknown };
  };
}

describe("route-of-waypoints movement", () => {
  it("rejects a route with an unstated stretch between waypoints", () => {
    const dgsm = makeDgsm();
    const result = initMovementRuntime(dgsm, "npc_1", ["J_A", "J_C"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("not a single stretch");
    // Names, not bare ids: this string is read by a person in the log, and the
    // pair rides along so the actor can be told which two places their
    // remembered way ran between.
    expect(result.reason).toContain("北口 (J_A)");
    expect(result.reason).toContain("林道口 (J_C)");
    expect(result.unstatedHop).toEqual({ fromId: "J_A", toId: "J_C" });
  });

  it("walks the joined prefix and stops where the stated route breaks", () => {
    const dgsm = makeDgsm();
    // J_A → J_B is one road; J_B → S_HOME was never stated. The walk is worth
    // making anyway: it puts the walker at J_B, where they can look around,
    // instead of leaving them at J_A with a complaint.
    const result = initMovementRuntime(dgsm, "npc_1", ["J_B", "S_HOME"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.route).toEqual(["J_B"]);
    expect(result.state.destinationId).toBe("J_B");
    expect(result.state.unstatedHopAhead).toEqual({
      fromId: "J_B",
      toId: "S_HOME",
    });
    // The clock is the prefix's, not the stated route's.
    expect(result.totalMinutes).toBe(4);

    let status = "moving";
    for (let i = 0; i < 6 && status === "moving"; i += 1) {
      status = advanceMovement(dgsm, "npc_1", result.state).status;
    }
    expect(status).toBe("arrived");
  });

  it("driving moves the vehicle at road drive speed and leaves the driver put", () => {
    const dgsm = makeDgsm();
    // Driver sits in the cab; the truck stands at J_A.
    dgsm.__positions.set("npc_1", { type: "scene", sceneId: "S_CAB" });
    const result = initMovementRuntime(dgsm, "npc_1", ["J_B"], "VEH_TRUCK");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 4′ walk becomes 2′ drive.
    expect(result.totalMinutes).toBe(2);

    let status = "moving";
    let guard = 0;
    while (status === "moving" && guard < 10) {
      const advanced = advanceMovement(dgsm, "npc_1", result.state);
      status = advanced.status;
      for (const change of advanced.stateChanges) {
        expect(change.kind).toBe("vehicle.position");
        if (change.kind === "vehicle.position") {
          dgsm.__truck.position = change.position;
        }
      }
      guard += 1;
    }
    expect(status).toBe("arrived");
    expect(dgsm.__truck.position).toEqual({ type: "scene", sceneId: "J_B" });
    // The driver never moved: the cab is their position.
    expect(dgsm.__positions.get("npc_1")).toEqual({
      type: "scene",
      sceneId: "S_CAB",
    });
  });

  it("refuses to drive a road with no drive time", () => {
    const dgsm = makeDgsm();
    dgsm.__positions.set("npc_1", { type: "scene", sceneId: "S_CAB" });
    dgsm.__truck.position = { type: "scene", sceneId: "J_B" };
    const result = initMovementRuntime(dgsm, "npc_1", ["J_C"], "VEH_TRUCK");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("takes no vehicles");
  });

  it("refuses the wheel at first advance when the driver is not inside", () => {
    const dgsm = makeDgsm();
    // Init succeeds — the same-tick board-and-drive resolution has not
    // flushed yet, so the runtime cannot demand the driver be seated here.
    const result = initMovementRuntime(dgsm, "npc_1", ["J_B"], "VEH_TRUCK");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // But the wheels refuse to turn while npc_1 stands at J_A.
    const advanced = advanceMovement(dgsm, "npc_1", result.state);
    expect(advanced.status).toBe("blocked");
    expect(advanced.blockedReason).toContain("not inside");
  });

  it("walks stated adjacent hops leg by leg to the destination", () => {
    const dgsm = makeDgsm();
    const result = initMovementRuntime(dgsm, "npc_1", ["J_B", "J_C"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // ETA covers both stated hops: 4′ + 3′.
    expect(result.totalMinutes).toBe(7);

    const state = result.state;
    let status = "moving";
    let guard = 0;
    while (status === "moving" && guard < 20) {
      const advanced = advanceMovement(dgsm, "npc_1", state);
      status = advanced.status;
      const last = advanced.stateChanges.at(-1);
      if (last?.kind === "character.position") {
        dgsm.__positions.set("npc_1", last.position);
      }
      guard += 1;
    }
    expect(status).toBe("arrived");
    // Walked through the second stated leg, not just the first.
    expect(state.currentLegIndex).toBe(1);
    expect(dgsm.__positions.get("npc_1")).toEqual({
      type: "scene",
      sceneId: "J_C",
    });
  });
});

describe("passBlockedConnectionId", () => {
  // A blocked passage is a world fact the runtime enforces at the step that
  // reaches it. The Engine may let ONE walk through — the character climbs
  // the fallen tree, wades the ford — without opening the passage for anyone
  // else: that is one exact `passBlockedConnectionId`, consumed at that edge.
  it("lets one walk cross only the named blocked passage", () => {
    const dgsm = makeDgsm();
    dgsm.__positions.set("npc_1", { type: "scene", sceneId: "S_HOME" });
    dgsm.__blocked.set(["S_HOME", "J_A"].sort().join("::"), "snowdrifts");

    const stopped = initMovementRuntime(dgsm, "npc_1", ["J_A"]);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(advanceMovement(dgsm, "npc_1", stopped.state)).toMatchObject({
      status: "blocked",
      blockedReason: "blocked: snowdrifts",
    });

    const through = initMovementRuntime(
      dgsm,
      "npc_1",
      ["J_A"],
      undefined,
      "connection.home.ja"
    );
    expect(through.ok).toBe(true);
    if (!through.ok) return;
    expect(through.state.passBlockedConnectionId).toBe("connection.home.ja");
    const advanced = advanceMovement(dgsm, "npc_1", through.state);
    expect(advanced.status).toBe("arrived");
    expect(through.state.passBlockedConnectionId).toBeUndefined();
    expect(advanced.stateChanges.at(-1)).toMatchObject({
      kind: "character.position",
      position: { type: "scene", sceneId: "J_A" },
    });
  });

  it("does not bypass a different blocked passage", () => {
    const dgsm = makeDgsm();
    dgsm.__blocked.set(["J_A", "R_MAIN"].sort().join("::"), "washed out");

    const through = initMovementRuntime(
      dgsm,
      "npc_1",
      ["J_B"],
      undefined,
      "connection.home.ja"
    );
    expect(through.ok).toBe(true);
    if (!through.ok) return;
    const advanced = advanceMovement(dgsm, "npc_1", through.state);
    expect(advanced).toMatchObject({
      status: "blocked",
      blockedReason: "blocked: washed out",
    });
    expect(through.state.passBlockedConnectionId).toBe("connection.home.ja");
  });
});
