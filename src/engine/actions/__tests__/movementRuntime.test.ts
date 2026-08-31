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
      connections: [{ id: "exit.ja.home", targetId: "S_HOME" }],
    } as unknown as DynamicScene,
  ],
  ["J_B", { id: "J_B", connections: [] } as unknown as DynamicScene],
  ["J_C", { id: "J_C", connections: [] } as unknown as DynamicScene],
  [
    "S_HOME",
    {
      id: "S_HOME",
      parentLocationId: "B_HOME",
      connections: [{ id: "exit.home.ja", targetId: "J_A" }],
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
