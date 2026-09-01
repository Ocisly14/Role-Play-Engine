// Hidden things must not reach perception until revealed — not the perceived
// location (what the renderer narrates) and not the perceivable directory
// (what the actor may cite). `resolvePerceivedLocation` is the single choke
// point: both location kinds filter `hidden` items, and each kind's
// adjacency filters hidden connections (scene exits, node-scene connections,
// road access points). Flipping the flag on the object is the whole reveal —
// the next resolve sees it, and the directory follows.

import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../DynamicGameState.js";
import { buildPerceivableDirectory } from "../perceivableDirectory.js";
import {
  resolveLocationById,
  resolvePerceivedLocation,
} from "../perceivedLocation.js";
import {
  type CharacterPosition,
  type RoadNode,
  buildTopology,
} from "../topologyTypes.js";
import type { DynamicScene } from "../types.js";

interface World {
  dgsm: DynamicGameStateManager;
  scene: DynamicScene;
  junction: DynamicScene;
  road: RoadNode;
  setActorPosition(position: CharacterPosition): void;
}

/** Fresh fixtures per test — reveal tests mutate `hidden` in place. */
function makeWorld(): World {
  const scene: DynamicScene = {
    id: "S_PARLOR",
    name: "Parlour",
    description: "A parlour.",
    parentLocationId: "B_HOUSE",
    items: [
      { id: "ITEM_CHAIR", name: "a chair" },
      { id: "ITEM_DAGGER", name: "a dagger", hidden: true },
    ],
    conditions: [],
    connections: [
      { id: "connection.parlor.shop", targetId: "S_SHOP" },
      { id: "connection.parlor.cellar", targetId: "S_CELLAR", hidden: true },
    ],
  };
  const otherScenes: DynamicScene[] = ["S_SHOP", "S_CELLAR", "S_HUT"].map(
    (id) => ({
      id,
      name: id,
      description: "",
      parentLocationId: "OUTDOOR",
      items: [],
      conditions: [],
      connections: [],
    })
  );

  // Top-level scene (no parentLocationId): a geography node.
  const junction: DynamicScene = {
    id: "J_X",
    name: "Crossing",
    description: "A crossing.",
    items: [
      { id: "ITEM_LAMP", name: "a lamppost" },
      { id: "ITEM_COIN", name: "a buried coin", hidden: true },
    ],
    conditions: [],
    connections: [
      { id: "connection.junc_x.shop", targetId: "S_SHOP" },
      { id: "connection.junc_x.cellar", targetId: "S_CELLAR", hidden: true },
    ],
  };

  const road: RoadNode = {
    id: "R_MAIN",
    name: "Star Avenue",
    description: "A long avenue.",
    connections: [
      { id: "connection.r_main.a", targetId: "J_X", role: "endpointA" },
      { id: "connection.r_main.b", targetId: "J_Y", role: "endpointB" },
      {
        id: "connection.r_main.shop",
        targetId: "S_SHOP",
        role: "access",
        position: 0.3,
      },
      {
        id: "connection.r_main.hut",
        targetId: "S_HUT",
        role: "access",
        position: 0.7,
        hidden: true,
      },
    ],
    endpointA: "J_X",
    endpointB: "J_Y",
    travelTimeMinutes: 10,
    // Derived incl. hidden — the hidden flag lives on the access connection.
    alongConnections: [
      { sceneId: "S_SHOP", position: 0.3 },
      { sceneId: "S_HUT", position: 0.7 },
    ],
    items: [
      { id: "ITEM_GLOVE", name: "a dropped glove" },
      { id: "ITEM_KNIFE", name: "a knife in the ditch", hidden: true },
    ],
    conditions: [],
  };

  const roads = new Map([[road.id, road]]);
  const scenesById = new Map<string, DynamicScene>(
    [scene, junction, ...otherScenes].map((s) => [s.id, s])
  );
  const topology = buildTopology(scenesById, roads);

  let actorPosition: CharacterPosition = { type: "scene", sceneId: scene.id };
  const dgsm = {
    getTopology: () => topology,
    getScene: (id: string) => scenesById.get(id) ?? null,
    getSceneConditions: () => [],
    getNpcProfile: (id: string) => (id === "actor" ? { id } : undefined),
    getNpcInventory: () => [],
    getRelationship: () => undefined,
    getCharacterPosition: (id: string) =>
      id === "actor" ? actorPosition : null,
    getState: () => ({
      npcCharacters: [{ id: "actor" }],
      npcRelationshipGraph: {},
    }),
    isNpcAlive: () => true,
  } as unknown as DynamicGameStateManager;

  return {
    dgsm,
    scene,
    junction,
    road,
    setActorPosition: (position) => {
      actorPosition = position;
    },
  };
}

describe("hidden items stay out of perception", () => {
  it("filters hidden items in both location kinds", () => {
    const { dgsm } = makeWorld();
    const atScene = resolvePerceivedLocation(
      { type: "scene", sceneId: "S_PARLOR" },
      dgsm
    );
    expect(atScene?.items.map((i) => i.id)).toEqual(["ITEM_CHAIR"]);

    const atJunction = resolvePerceivedLocation(
      { type: "scene", sceneId: "J_X" },
      dgsm
    );
    expect(atJunction?.items.map((i) => i.id)).toEqual(["ITEM_LAMP"]);

    const onRoad = resolvePerceivedLocation(
      { type: "road", roadId: "R_MAIN", position: 0.5 },
      dgsm
    );
    expect(onRoad?.items.map((i) => i.id)).toEqual(["ITEM_GLOVE"]);
  });

  it("keeps hidden items out of the perceivable directory's citable set", () => {
    const { dgsm, setActorPosition } = makeWorld();

    setActorPosition({ type: "scene", sceneId: "S_PARLOR" });
    expect(buildPerceivableDirectory("actor", dgsm).items).toEqual(
      new Set(["ITEM_CHAIR"])
    );

    setActorPosition({ type: "scene", sceneId: "J_X" });
    expect(buildPerceivableDirectory("actor", dgsm).items).toEqual(
      new Set(["ITEM_LAMP"])
    );

    setActorPosition({ type: "road", roadId: "R_MAIN", position: 0.5 });
    expect(buildPerceivableDirectory("actor", dgsm).items).toEqual(
      new Set(["ITEM_GLOVE"])
    );
  });
});

describe("hidden connections stay out of adjacency", () => {
  it("filters a hidden scene exit from adjacentIds", () => {
    const { dgsm } = makeWorld();
    const loc = resolvePerceivedLocation(
      { type: "scene", sceneId: "S_PARLOR" },
      dgsm
    );
    expect(loc?.adjacentIds).toEqual(["S_SHOP"]);
  });

  it("derives node-scene adjacency from non-hidden connections, keeping roads", () => {
    const { dgsm } = makeWorld();
    const loc = resolvePerceivedLocation(
      { type: "scene", sceneId: "J_X" },
      dgsm
    );
    // S_CELLAR's connection is hidden, so it stays out of adjacency.
    expect(loc?.adjacentIds.sort()).toEqual(["R_MAIN", "S_SHOP"]);
  });

  it("filters a hidden road access; endpoints are always visible", () => {
    const { dgsm } = makeWorld();
    const loc = resolvePerceivedLocation(
      { type: "road", roadId: "R_MAIN", position: 0.5 },
      dgsm
    );
    expect(loc?.adjacentIds.sort()).toEqual(["J_X", "J_Y", "S_SHOP"]);
  });

  it("keeps hidden places out of the directory's scene set", () => {
    const { dgsm, setActorPosition } = makeWorld();
    setActorPosition({ type: "scene", sceneId: "S_PARLOR" });
    const directory = buildPerceivableDirectory("actor", dgsm);
    expect(directory.scenes).toEqual(new Set(["S_PARLOR", "S_SHOP"]));
  });

  it("resolveLocationById agrees with resolvePerceivedLocation", () => {
    const { dgsm } = makeWorld();
    for (const id of ["S_PARLOR", "J_X", "R_MAIN"]) {
      const byId = resolveLocationById(id, dgsm);
      expect(byId?.items.every((i) => !i.hidden)).toBe(true);
      expect(byId?.adjacentIds).not.toContain("S_CELLAR");
      expect(byId?.adjacentIds).not.toContain("S_HUT");
    }
  });
});

describe("revealing (flipping the hidden flag) restores visibility", () => {
  it("a revealed item appears in the location and the directory", () => {
    const { dgsm, scene, junction, road, setActorPosition } = makeWorld();

    const dagger = scene.items.find((i) => i.id === "ITEM_DAGGER");
    if (dagger) dagger.hidden = false;
    const coin = junction.items.find((i) => i.id === "ITEM_COIN");
    if (coin) coin.hidden = false;
    const knife = road.items.find((i) => i.id === "ITEM_KNIFE");
    if (knife) knife.hidden = false;

    expect(
      resolvePerceivedLocation(
        { type: "scene", sceneId: "S_PARLOR" },
        dgsm
      )?.items.map((i) => i.id)
    ).toEqual(["ITEM_CHAIR", "ITEM_DAGGER"]);
    expect(
      resolvePerceivedLocation(
        { type: "scene", sceneId: "J_X" },
        dgsm
      )?.items.map((i) => i.id)
    ).toEqual(["ITEM_LAMP", "ITEM_COIN"]);
    expect(
      resolvePerceivedLocation(
        { type: "road", roadId: "R_MAIN", position: 0.5 },
        dgsm
      )?.items.map((i) => i.id)
    ).toEqual(["ITEM_GLOVE", "ITEM_KNIFE"]);

    setActorPosition({ type: "scene", sceneId: "S_PARLOR" });
    expect(buildPerceivableDirectory("actor", dgsm).items).toEqual(
      new Set(["ITEM_CHAIR", "ITEM_DAGGER"])
    );
  });

  it("a revealed connection joins adjacency and the directory", () => {
    const { dgsm, scene, junction, road, setActorPosition } = makeWorld();

    const cellarExit = scene.connections.find(
      (c) => c.id === "connection.parlor.cellar"
    );
    if (cellarExit) cellarExit.hidden = false;
    const junctionCellar = junction.connections.find(
      (c) => c.id === "connection.junc_x.cellar"
    );
    if (junctionCellar) junctionCellar.hidden = false;
    const hutAccess = road.connections.find(
      (c) => c.id === "connection.r_main.hut"
    );
    if (hutAccess) hutAccess.hidden = false;

    expect(
      resolvePerceivedLocation({ type: "scene", sceneId: "S_PARLOR" }, dgsm)
        ?.adjacentIds
    ).toEqual(["S_SHOP", "S_CELLAR"]);
    expect(
      resolvePerceivedLocation(
        { type: "scene", sceneId: "J_X" },
        dgsm
      )?.adjacentIds.sort()
    ).toEqual(["R_MAIN", "S_CELLAR", "S_SHOP"]);
    expect(
      resolvePerceivedLocation(
        { type: "road", roadId: "R_MAIN", position: 0.5 },
        dgsm
      )?.adjacentIds.sort()
    ).toEqual(["J_X", "J_Y", "S_HUT", "S_SHOP"]);

    setActorPosition({ type: "scene", sceneId: "S_PARLOR" });
    expect(buildPerceivableDirectory("actor", dgsm).scenes).toEqual(
      new Set(["S_PARLOR", "S_SHOP", "S_CELLAR"])
    );
  });
});

// `hidden` is the world's answer to "can anyone see this"; `discoveredBy` is
// this viewer's answer to "have I found it". One passage, both facts on it —
// so nothing has to be kept in step with anything else.
describe("a passage one character has found", () => {
  function world() {
    const scenes = new Map<string, DynamicScene>([
      [
        "SCN_A",
        {
          id: "SCN_A",
          name: "Dock",
          description: "d",
          conditions: [],
          items: [],
          connections: [
            {
              id: "connection.a.inner",
              targetId: "SCN_B",
              hidden: true,
              discoveredBy: ["npc_finder"],
            },
          ],
        } as unknown as DynamicScene,
      ],
      [
        "SCN_B",
        {
          id: "SCN_B",
          name: "Hall",
          description: "d",
          conditions: [],
          items: [],
          connections: [],
        } as unknown as DynamicScene,
      ],
    ]);
    return {
      getScene: (id: string) => scenes.get(id) ?? null,
      getState: () => ({ scenes, roads: new Map(), characterPositions: {} }),
      getSceneConditions: () => [],
      getTopology: () => ({
        nodeSceneIds: new Set(),
        roads: new Map(),
        sceneToRoads: new Map(),
        sceneToParent: new Map(),
      }),
      getVehicleByInterior: () => null,
      getVehicles: () => [],
    } as unknown as DynamicGameStateManager;
  }
  const at = { type: "scene" as const, sceneId: "SCN_A" };

  it("is in the finder's perception", () => {
    const loc = resolvePerceivedLocation(at, world(), "npc_finder");
    expect(loc?.adjacentIds).toContain("SCN_B");
  });

  it("is not in anyone else's", () => {
    const loc = resolvePerceivedLocation(at, world(), "npc_other");
    expect(loc?.adjacentIds).not.toContain("SCN_B");
  });

  it("is not there for a viewerless read — naming a place is not looking", () => {
    const loc = resolvePerceivedLocation(at, world());
    expect(loc?.adjacentIds).not.toContain("SCN_B");
  });
});
