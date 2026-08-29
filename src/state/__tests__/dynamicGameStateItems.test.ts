import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../DynamicGameState.js";
import type { JunctionNode, RoadNode } from "../topologyTypes.js";
import type { DynamicScene } from "../types.js";

// Items used to live only in scenes as far as the mutators were concerned:
// a glove dropped on a road was perceivable but could never be picked up,
// because five write paths scanned `state.scenes` alone. These tests pin the
// unified container primitives: scene, junction, road and NPC inventory are
// all one id-space of holders.

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
    items: [{ id: "item_chair", name: "a chair" }],
    conditions: [],
    connections: [
      { id: "exit.home.junc", targetId: "J_A" },
      { id: "exit.home.secret", targetId: "R_MAIN", hidden: true },
    ],
  };

  const junction: JunctionNode = {
    id: "J_A",
    name: "Crossing",
    description: "A windswept crossing.",
    parentLocationId: "OUTDOOR",
    items: [{ id: "item_lamppost", name: "a lamppost" }],
    conditions: [],
    connections: [
      { id: "exit.junc.home", targetId: "S_HOME" },
      { id: "exit.junc.road", targetId: "R_MAIN" },
    ],
    connectedSceneIds: ["S_HOME"],
  };

  const junctionB: JunctionNode = {
    id: "J_B",
    name: "Far Corner",
    description: "The far corner.",
    parentLocationId: "OUTDOOR",
    items: [],
    conditions: [],
    connections: [],
    connectedSceneIds: [],
  };

  const road: RoadNode = {
    id: "R_MAIN",
    name: "Star Avenue",
    description: "A long avenue.",
    parentLocationId: "OUTDOOR",
    connections: [
      { id: "exit.road.a", targetId: "J_A", role: "endpointA" },
      { id: "exit.road.b", targetId: "J_B", role: "endpointB" },
    ],
    endpointA: "J_A",
    endpointB: "J_B",
    travelTimeMinutes: 10,
    alongConnections: [],
    items: [{ id: "item_glove", name: "a dropped glove" }],
    conditions: [],
  };

  state.scenes.set(scene.id, scene);
  state.junctions.set(junction.id, junction);
  state.junctions.set(junctionB.id, junctionB);
  state.roads.set(road.id, road);
  state.npcInventories = { npc_ann: [{ id: "item_coin", name: "a coin" }] };

  return { dgsm: new DynamicGameStateManager(state), scene, junction, road };
}

let dgsm: DynamicGameStateManager;
let scene: DynamicScene;
let junction: JunctionNode;
let road: RoadNode;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  ({ dgsm, scene, junction, road } = makeFixture());
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

describe("item containers across place kinds and inventories", () => {
  it("finds items held by scenes, junctions, roads and NPCs", () => {
    expect(dgsm.hasItem("item_chair")).toBe(true);
    expect(dgsm.hasItem("item_lamppost")).toBe(true);
    expect(dgsm.hasItem("item_glove")).toBe(true);
    expect(dgsm.hasItem("item_coin")).toBe(true);
    expect(dgsm.hasItem("item_nope")).toBe(false);

    expect(dgsm.getItemHolder("item_chair")).toBe("scene:S_HOME");
    expect(dgsm.getItemHolder("item_lamppost")).toBe("scene:J_A");
    expect(dgsm.getItemHolder("item_glove")).toBe("scene:R_MAIN");
    expect(dgsm.getItemHolder("item_coin")).toBe("npc_ann");
    expect(dgsm.getItemHolder("item_nope")).toBeUndefined();
  });

  it("creates items in all three place kinds and in an inventory", () => {
    const inJunction = dgsm.createItem("a bottle", "scene:J_A");
    expect(inJunction?.id).toBe("item_a_bottle");
    expect(dgsm.getItemHolder("item_a_bottle")).toBe("scene:J_A");
    expect(junction.items).toContain(inJunction);

    const onRoad = dgsm.createItem("a milestone", "scene:R_MAIN", "Mile 3.");
    expect(onRoad?.description).toBe("Mile 3.");
    expect(dgsm.getItemHolder(onRoad?.id ?? "")).toBe("scene:R_MAIN");
    expect(road.items).toContain(onRoad);

    const inScene = dgsm.createItem("a candle", "scene:S_HOME");
    expect(dgsm.getItemHolder(inScene?.id ?? "")).toBe("scene:S_HOME");
    expect(scene.items).toContain(inScene);

    // A holder with no inventory yet gets one on demand.
    const held = dgsm.createItem("a key", "npc_bob");
    expect(dgsm.getItemHolder(held?.id ?? "")).toBe("npc_bob");

    expect(dgsm.createItem("nothing", "scene:NOPE")).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('location "scene:NOPE" not found')
    );
  });

  it("moves an item from a road into an inventory, keeping object identity", () => {
    const glove = road.items[0];
    expect(dgsm.moveItem("item_glove", "scene:R_MAIN", "npc_ann")).toBe(true);
    expect(road.items).toHaveLength(0);
    const held = dgsm
      .getState()
      .npcInventories.npc_ann.find((i) => i.id === "item_glove");
    expect(held).toBe(glove); // the same object, not a copy

    // Junction -> scene, and scene -> road, through the same primitives.
    expect(dgsm.moveItem("item_lamppost", "scene:J_A", "scene:S_HOME")).toBe(
      true
    );
    expect(dgsm.getItemHolder("item_lamppost")).toBe("scene:S_HOME");
    expect(dgsm.moveItem("item_chair", "scene:S_HOME", "scene:R_MAIN")).toBe(
      true
    );
    expect(dgsm.getItemHolder("item_chair")).toBe("scene:R_MAIN");

    // A bad source or destination moves nothing and loses nothing.
    expect(dgsm.moveItem("item_coin", "npc_ann", "scene:NOPE")).toBe(false);
    expect(dgsm.getItemHolder("item_coin")).toBe("npc_ann");
    expect(dgsm.moveItem("item_coin", "npc_bob", "scene:S_HOME")).toBe(false);
    expect(dgsm.getItemHolder("item_coin")).toBe("npc_ann");
  });

  it("destroys items wherever they are held", () => {
    expect(dgsm.destroyItem("item_lamppost")).toBe(true);
    expect(dgsm.hasItem("item_lamppost")).toBe(false);
    expect(dgsm.destroyItem("item_glove")).toBe(true);
    expect(dgsm.destroyItem("item_coin")).toBe(true);
    expect(dgsm.destroyItem("item_nope")).toBe(false);
  });
});

describe("createItem explicit id", () => {
  it("uses the caller's id when free", () => {
    const item = dgsm.createItem(
      "Repair Ledger",
      "scene:S_HOME",
      undefined,
      "item.home.ledger"
    );
    expect(item?.id).toBe("item.home.ledger");
    expect(dgsm.hasItem("item.home.ledger")).toBe(true);
  });

  it("warns and falls back to a generated id on conflict", () => {
    dgsm.createItem("Ledger", "scene:S_HOME", undefined, "item.home.ledger");
    const dup = dgsm.createItem(
      "Ledger",
      "scene:J_A",
      undefined,
      "item.home.ledger"
    );
    expect(dup?.id).toBe("item_ledger");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('id "item.home.ledger" already exists')
    );
    // The original stayed where it was.
    expect(dgsm.getItemHolder("item.home.ledger")).toBe("scene:S_HOME");
    expect(dgsm.getItemHolder("item_ledger")).toBe("scene:J_A");
  });
});

describe("setItem hidden patch", () => {
  it("sets and clears the hidden flag", () => {
    expect(dgsm.setItem("item_chair", { hidden: true })).toBe(true);
    const chair = scene.items.find((i) => i.id === "item_chair");
    expect(chair?.hidden).toBe(true);
    expect(dgsm.hasItem("item_chair")).toBe(true); // hidden still exists

    expect(dgsm.setItem("item_chair", { hidden: false })).toBe(true);
    expect(chair?.hidden).toBe(false);

    // Works on non-scene holders too.
    expect(dgsm.setItem("item_glove", { hidden: true })).toBe(true);
    expect(road.items[0].hidden).toBe(true);
  });
});

describe("scene condition ids", () => {
  it("mints cond_<featureId>_<n> ids unique within the place", () => {
    dgsm.appendSceneCondition("S_HOME", {
      featureId: "fire",
      description: "small fire",
    });
    dgsm.appendSceneCondition("S_HOME", {
      featureId: "fire",
      description: "spreading fire",
    });
    dgsm.appendSceneCondition("S_HOME", {
      description: "smashed door",
    });
    const ids = dgsm.getSceneConditions("S_HOME").map((c) => c.id);
    expect(ids).toEqual(["cond_fire_1", "cond_fire_2", "cond_engine_1"]);
  });

  it("drops a condition whose explicit id already exists at the place", () => {
    dgsm.appendSceneCondition("J_A", {
      id: "cond.junc.sleet",
      description: "sleet",
    });
    dgsm.appendSceneCondition("J_A", {
      id: "cond.junc.sleet",
      description: "sleet again",
    });
    expect(dgsm.getSceneConditions("J_A")).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('duplicate condition id "cond.junc.sleet"')
    );
  });

  it("removes a single condition by id, across place kinds", () => {
    dgsm.appendSceneCondition("R_MAIN", {
      id: "cond.road.fog",
      description: "fog",
    });
    dgsm.appendSceneCondition("R_MAIN", {
      featureId: "weather",
      description: "drizzle",
    });

    expect(dgsm.removeSceneConditionById("R_MAIN", "cond.road.fog")).toBe(true);
    expect(dgsm.getSceneConditions("R_MAIN").map((c) => c.id)).toEqual([
      "cond_weather_1",
    ]);
    expect(dgsm.removeSceneConditionById("R_MAIN", "cond.road.fog")).toBe(
      false
    );
    expect(dgsm.removeSceneConditionById("NOPE", "cond.road.fog")).toBe(false);
  });
});

describe("setConnectionHiddenById", () => {
  it("reveals a hidden scene connection in place", () => {
    expect(dgsm.setConnectionHiddenById("exit.home.secret", false)).toBe(true);
    const conn = scene.connections.find((c) => c.id === "exit.home.secret");
    expect(conn?.hidden).toBe(false);
  });

  it("hides a junction connection", () => {
    expect(dgsm.setConnectionHiddenById("exit.junc.road", true)).toBe(true);
    const conn = junction.connections.find((c) => c.id === "exit.junc.road");
    expect(conn?.hidden).toBe(true);
  });

  it("hides a road connection", () => {
    expect(dgsm.setConnectionHiddenById("exit.road.a", true)).toBe(true);
    const conn = road.connections.find((c) => c.id === "exit.road.a");
    expect(conn?.hidden).toBe(true);
  });

  it("returns false and warns for an unknown connection id", () => {
    expect(dgsm.setConnectionHiddenById("exit.nowhere.door", true)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown connection id "exit.nowhere.door"')
    );
  });

  it("resolves two directions of the same passage onto one edge", () => {
    const there = dgsm.resolveConnectionEdgeById("exit.home.junc");
    const back = dgsm.resolveConnectionEdgeById("exit.junc.home");
    expect(there?.key).toBeDefined();
    expect(there?.key).toBe(back?.key);
    expect(dgsm.resolveConnectionEdgeById("exit.nowhere.door")).toBeNull();
  });
});
