import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../DynamicGameState.js";
import type { RoadNode } from "../topologyTypes.js";
import type { DynamicScene } from "../types.js";

// Items used to live only in scenes as far as the mutators were concerned:
// a glove dropped on a road was perceivable but could never be picked up,
// because five write paths scanned `state.scenes` alone. These tests pin the
// unified container primitives: scene, road and NPC inventory are all one
// id-space of holders.

function makeFixture() {
  const state = initialDynamicGameState();

  const scene: DynamicScene = {
    id: "S_HOME",
    name: "Home",
    setting: "A parlour.",
    parentLocationId: "LOC_TOWN",
    items: [{ id: "item_chair", name: "a chair" }],
    conditions: [],
    connections: [
      { id: "connection.home.junc", targetId: "J_A" },
      { id: "connection.home.secret", targetId: "R_MAIN", concealed: true },
    ],
  };

  // Top-level scenes (no parentLocationId): geography nodes.
  const junction: DynamicScene = {
    id: "J_A",
    name: "Crossing",
    setting: "A windswept crossing.",
    items: [{ id: "item_lamppost", name: "a lamppost" }],
    conditions: [],
    connections: [
      { id: "connection.junc.home", targetId: "S_HOME" },
      { id: "connection.junc.road", targetId: "R_MAIN" },
    ],
  };

  const junctionB: DynamicScene = {
    id: "J_B",
    name: "Far Corner",
    setting: "The far corner.",
    items: [],
    conditions: [],
    connections: [],
  };

  const road: RoadNode = {
    id: "R_MAIN",
    name: "Star Avenue",
    setting: "A long avenue.",
    connections: [
      { id: "connection.road.a", targetId: "J_A", role: "endpointA" },
      { id: "connection.road.b", targetId: "J_B", role: "endpointB" },
    ],
    endpointA: "J_A",
    endpointB: "J_B",
    travelTimeMinutes: 10,
    alongConnections: [],
    items: [{ id: "item_glove", name: "a dropped glove" }],
    conditions: [],
  };

  state.scenes.set(scene.id, scene);
  state.scenes.set(junction.id, junction);
  state.scenes.set(junctionB.id, junctionB);
  state.roads.set(road.id, road);
  state.npcInventories = { npc_ann: [{ id: "item_coin", name: "a coin" }] };

  return { dgsm: new DynamicGameStateManager(state), scene, junction, road };
}

let dgsm: DynamicGameStateManager;
let scene: DynamicScene;
let junction: DynamicScene;
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
  it("finds items held by scenes (node scenes included), roads and NPCs", () => {
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

// Items have no hidden flag any more — whether an item is in plain view is
// whether its place's description cites it — so the patch carries only what
// the item is like.
describe("setItem patch", () => {
  it("appends to the description and sets lighting, on any holder", () => {
    expect(
      dgsm.setItem("item_chair", { appendDescription: "One leg is cracked." })
    ).toBe(true);
    const chair = scene.items.find((i) => i.id === "item_chair");
    expect(chair?.description).toBe("One leg is cracked.");

    // Works on non-scene holders too.
    expect(
      dgsm.setItem("item_glove", { isLightSource: false, lightLevel: 0 })
    ).toBe(true);
    expect(road.items[0].isLightSource).toBe(false);
    expect(road.items[0].lightLevel).toBe(0);
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

describe("setConnectionConcealedById", () => {
  it("exposes a concealed scene connection in place", () => {
    expect(
      dgsm.setConnectionConcealedById("connection.home.secret", false)
    ).toBe(true);
    const conn = scene.connections.find(
      (c) => c.id === "connection.home.secret"
    );
    expect(conn?.concealed).toBe(false);
  });

  it("conceals a node-scene connection", () => {
    expect(dgsm.setConnectionConcealedById("connection.junc.road", true)).toBe(
      true
    );
    const conn = junction.connections.find(
      (c) => c.id === "connection.junc.road"
    );
    expect(conn?.concealed).toBe(true);
  });

  it("conceals a road connection", () => {
    expect(dgsm.setConnectionConcealedById("connection.road.a", true)).toBe(
      true
    );
    const conn = road.connections.find((c) => c.id === "connection.road.a");
    expect(conn?.concealed).toBe(true);
  });

  it("returns false and warns for an unknown connection id", () => {
    expect(
      dgsm.setConnectionConcealedById("connection.nowhere.door", true)
    ).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown connection id "connection.nowhere.door"')
    );
  });

  it("resolves two directions of the same passage onto one edge", () => {
    const there = dgsm.resolveConnectionEdgeById("connection.home.junc");
    const back = dgsm.resolveConnectionEdgeById("connection.junc.home");
    expect(there?.key).toBeDefined();
    expect(there?.key).toBe(back?.key);
    expect(
      dgsm.resolveConnectionEdgeById("connection.nowhere.door")
    ).toBeNull();
  });
});

describe("holder grammar hardening — no phantom inventories", () => {
  it("refuses a bare place id as a move destination", () => {
    const { dgsm } = makeFixture();
    const ok = dgsm.moveItem("item_chair", "scene:S_HOME", "J_A");
    expect(ok).toBe(false);
    // The item stayed where it was; no inventory keyed "J_A" was minted.
    expect(
      dgsm.getScene("S_HOME")?.items?.some((i) => i.id === "item_chair")
    ).toBe(true);
    expect(dgsm.getState().npcInventories.J_A).toBeUndefined();
  });

  it("refuses an unknown prefix like npc:<id>", () => {
    const { dgsm } = makeFixture();
    const ok = dgsm.moveItem("item_chair", "scene:S_HOME", "npc:npc_someone");
    expect(ok).toBe(false);
    expect(dgsm.getState().npcInventories["npc:npc_someone"]).toBeUndefined();
  });
});

describe("placement and containers (schema v3)", () => {
  function stockTill() {
    // till ⊃ cash ⊃ coin roll, all at S_HOME.
    scene.items.push(
      { id: "item_till", name: "a till", placement: "on the counter" },
      {
        id: "item_cash",
        name: "cash",
        placement: "in the till drawer",
        container: "item_till",
      },
      {
        id: "item_roll",
        name: "a coin roll",
        placement: "in the cash tray",
        container: "item_cash",
      }
    );
  }
  const find = (id: string) =>
    [
      ...scene.items,
      ...(dgsm.getState().npcInventories.npc_ann ?? []),
    ].find((i) => i.id === id);

  it("moving a container carries its contents, nested, links kept", () => {
    stockTill();
    expect(dgsm.moveItem("item_till", "scene:S_HOME", "npc_ann")).toBe(true);
    expect(dgsm.getItemHolder("item_cash")).toBe("npc_ann");
    expect(dgsm.getItemHolder("item_roll")).toBe("npc_ann");
    expect(find("item_cash")?.container).toBe("item_till");
    expect(find("item_roll")?.container).toBe("item_cash");
  });

  it("moving to a character clears placement and container", () => {
    stockTill();
    dgsm.moveItem("item_cash", "scene:S_HOME", "npc_ann");
    expect(find("item_cash")).not.toHaveProperty("placement");
    expect(find("item_cash")).not.toHaveProperty("container");
  });

  it("moving to a place sets placement and container from `where`", () => {
    stockTill();
    dgsm.moveItem("item_coin", "npc_ann", "scene:S_HOME", {
      placement: "in the [till] drawer",
      container: "item_till",
    });
    expect(find("item_coin")).toMatchObject({
      placement: "in the till drawer",
      container: "item_till",
    });
  });

  it("createItem at a place records `where`; on a person it does not", () => {
    const loose = dgsm.createItem("a cup", "scene:S_HOME", undefined, "item_cup", {
      placement: "by the window",
    });
    expect(loose?.placement).toBe("by the window");
    const held = dgsm.createItem("a pen", "npc_ann", undefined, "item_pen", {
      placement: "ignored",
    });
    expect(held).not.toHaveProperty("placement");
  });

  it("destroying a container leaves its contents loose, placement kept", () => {
    stockTill();
    dgsm.destroyItem("item_till");
    expect(find("item_cash")?.container).toBeUndefined();
    expect(find("item_cash")?.placement).toBe("in the till drawer");
  });

  it("setItem moves a thing within its place; container '' takes it out", () => {
    stockTill();
    dgsm.setItem("item_cash", { placement: "on the counter", container: "" });
    expect(find("item_cash")).toMatchObject({ placement: "on the counter" });
    expect(find("item_cash")).not.toHaveProperty("container");
    expect(dgsm.getItemContents("item_till")).toEqual([]);
  });
});

describe("contents never end up nowhere", () => {
  it("contents carried by a person and set down again regain a placement", () => {
    scene.items.push(
      { id: "item_box", name: "工具箱", placement: "门边" },
      { id: "item_torch", name: "手电", placement: "箱底", container: "item_box" }
    );
    dgsm.moveItem("item_box", "scene:S_HOME", "npc_ann");
    dgsm.moveItem("item_box", "npc_ann", "scene:J_A", { placement: "墙角" });
    const torch = junction.items.find((i) => i.id === "item_torch");
    expect(torch).toMatchObject({ container: "item_box", placement: "工具箱里" });
  });

  it("a destroyed container's unplaced contents take its placement", () => {
    scene.items.push(
      { id: "item_box", name: "box", placement: "by the door" },
      { id: "item_torch", name: "torch", container: "item_box" }
    );
    dgsm.destroyItem("item_box");
    expect(scene.items.find((i) => i.id === "item_torch")).toMatchObject({
      placement: "by the door",
    });
  });
});

describe("quantity", () => {
  it("setItem counts a stack down; 1 clears the field", () => {
    scene.items.push({ id: "item_tarts", name: "tarts", placement: "in the case", quantity: 18 });
    dgsm.setItem("item_tarts", { quantity: 16 });
    expect(scene.items.find((i) => i.id === "item_tarts")?.quantity).toBe(16);
    dgsm.setItem("item_tarts", { quantity: 1 });
    expect(scene.items.find((i) => i.id === "item_tarts")).not.toHaveProperty("quantity");
  });

  it("createItem records a quantity above one", () => {
    const made = dgsm.createItem("tarts", "npc_ann", undefined, "item_two", undefined, 2);
    expect(made?.quantity).toBe(2);
  });
});
