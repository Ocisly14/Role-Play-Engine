import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../DynamicGameState.js";
import {
  charactersAtSameLocation,
  resolveLocationById,
  resolvePerceivedLocation,
} from "../perceivedLocation.js";
import {
  type JunctionNode,
  type RoadNode,
  buildTopology,
} from "../topologyTypes.js";

// Before this resolver, everything below returned nothing for a character on
// a road or at a junction — which is where every traveller spends an entire
// cross-scene trip. Observed live: an NPC citing the road under his feet and
// having the decision rejected, and two NPCs travelling together losing sight
// of each other the moment they left the building.

const junctions = new Map<string, JunctionNode>([
  [
    "J_A",
    {
      id: "J_A",
      name: "Crossing",
      description: "A windswept crossing.",
      items: [{ id: "ITEM_J", name: "a lamppost" }],
      conditions: [{ featureId: "weather", description: "sleet" }],
      // Junction adjacency derives from `connections`; `connectedSceneIds`
      // is only the derived convenience list.
      connections: [{ id: "exit.junc_a.home", targetId: "S_HOME" }],
      connectedSceneIds: ["S_HOME"],
    } as unknown as JunctionNode,
  ],
]);
const roads = new Map<string, RoadNode>([
  [
    "R_MAIN",
    {
      id: "R_MAIN",
      name: "Star Avenue",
      description: "A long avenue.",
      connections: [],
      endpointA: "J_A",
      endpointB: "J_B",
      travelTimeMinutes: 10,
      alongConnections: [{ sceneId: "S_SHOP", position: 0.4 }],
      items: [{ id: "ITEM_R", name: "a dropped glove" }],
      conditions: [{ featureId: "weather", description: "fog" }],
    } as unknown as RoadNode,
  ],
]);
const topology = buildTopology(junctions, roads);

const positions: Record<string, unknown> = {};
const dgsm = {
  getTopology: () => topology,
  getScene: (id: string) =>
    id === "S_HOME"
      ? {
          id: "S_HOME",
          name: "Home",
          description: "A parlour.",
          conditions: [],
          items: [{ id: "ITEM_S", name: "a chair" }],
          connections: [{ id: "exit.home.shop", targetId: "S_SHOP" }],
        }
      : id === "S_SHOP"
        ? { id: "S_SHOP", name: "Shop", conditions: [], items: [] }
        : undefined,
  // Mirrors the real implementation: conditions live on the place object,
  // and `getScene` resolves scenes, junctions and roads alike.
  getSceneConditions: (id: string) =>
    (junctions.get(id) ?? roads.get(id))?.conditions ??
    (id === "S_HOME" || id === "S_SHOP" ? [] : []),
  getCharacterPosition: (id: string) => positions[id] ?? null,
  getState: () => ({
    npcCharacters: [{ id: "A" }, { id: "B" }, { id: "C" }],
  }),
  isNpcAlive: () => true,
} as unknown as DynamicGameStateManager;

describe("resolvePerceivedLocation", () => {
  it("resolves a road into a place with its own name, items and conditions", () => {
    const loc = resolvePerceivedLocation(
      { type: "road", roadId: "R_MAIN", position: 0.5 },
      dgsm
    );
    expect(loc).toMatchObject({
      id: "R_MAIN",
      kind: "road",
      name: "Star Avenue",
    });
    expect(loc?.items.map((i) => i.id)).toEqual(["ITEM_R"]);
    expect(loc?.conditions[0].description).toBe("fog");
    // Both endpoints and every building along the road are one hop away.
    expect(loc?.adjacentIds.sort()).toEqual(["J_A", "J_B", "S_SHOP"]);
  });

  it("resolves a junction, exposing its scenes and roads", () => {
    const loc = resolvePerceivedLocation(
      { type: "junction", junctionId: "J_A" },
      dgsm
    );
    expect(loc).toMatchObject({
      id: "J_A",
      kind: "junction",
      name: "Crossing",
    });
    expect(loc?.items.map((i) => i.id)).toEqual(["ITEM_J"]);
    expect(loc?.adjacentIds.sort()).toEqual(["R_MAIN", "S_HOME"]);
  });

  it("still resolves a scene with its connections", () => {
    const loc = resolvePerceivedLocation(
      { type: "scene", sceneId: "S_HOME" },
      dgsm
    );
    expect(loc).toMatchObject({ id: "S_HOME", kind: "scene" });
    expect(loc?.adjacentIds).toEqual(["S_SHOP"]);
  });

  it("returns null for no position or an unknown place", () => {
    expect(resolvePerceivedLocation(null, dgsm)).toBeNull();
    expect(
      resolvePerceivedLocation({ type: "scene", sceneId: "NOPE" }, dgsm)
    ).toBeNull();
  });
});

describe("resolveLocationById", () => {
  it("finds scenes, junctions and roads by bare id", () => {
    expect(resolveLocationById("S_HOME", dgsm)?.kind).toBe("scene");
    expect(resolveLocationById("J_A", dgsm)?.kind).toBe("junction");
    expect(resolveLocationById("R_MAIN", dgsm)?.kind).toBe("road");
    expect(resolveLocationById("", dgsm)).toBeNull();
    expect(resolveLocationById("NOPE", dgsm)).toBeNull();
  });
});

describe("charactersAtSameLocation", () => {
  it("sees a companion walking the same stretch of road", () => {
    positions.A = { type: "road", roadId: "R_MAIN", position: 0.5 };
    positions.B = { type: "road", roadId: "R_MAIN", position: 0.52 };
    positions.C = { type: "road", roadId: "R_MAIN", position: 0.9 };
    // B is 0.2 min away — together. C is 4 min up the street — not.
    expect(charactersAtSameLocation("A", dgsm)).toEqual(["B"]);
  });

  it("does not see travellers on a different road", () => {
    positions.A = { type: "road", roadId: "R_MAIN", position: 0.5 };
    positions.B = { type: "road", roadId: "R_OTHER", position: 0.5 };
    positions.C = { type: "junction", junctionId: "J_A" };
    expect(charactersAtSameLocation("A", dgsm)).toEqual([]);
  });

  it("matches junctions and scenes exactly", () => {
    positions.A = { type: "junction", junctionId: "J_A" };
    positions.B = { type: "junction", junctionId: "J_A" };
    positions.C = { type: "junction", junctionId: "J_B" };
    expect(charactersAtSameLocation("A", dgsm)).toEqual(["B"]);

    positions.A = { type: "scene", sceneId: "S_HOME" };
    positions.B = { type: "scene", sceneId: "S_HOME" };
    positions.C = { type: "scene", sceneId: "S_SHOP" };
    expect(charactersAtSameLocation("A", dgsm)).toEqual(["B"]);
  });
});
