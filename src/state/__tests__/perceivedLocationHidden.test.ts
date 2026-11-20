// Unnoticed things must not reach perception — not the perceived location
// (what the renderer narrates) and not the perceivable directory (what the
// actor may cite). There is no hidden flag: an item is IN PLAIN VIEW iff its
// place's description cites it as `[id]`; an uncited item is there but not
// yet noticed. A passage marked `concealed` is physically obscured, the same
// for everyone. `resolvePerceivedLocation` is the single choke point: both
// location kinds filter uncited items, and each kind's adjacency filters
// concealed connections (scene exits, node-scene connections, road access
// points) — unless THIS viewer noticed the thing this minute (`noticed`).
// Exposing something for everyone is a change to the world: cite the item in
// the description, or flip `concealed` to false.

import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../DynamicGameState.js";
import { buildPerceivableDirectory } from "../perceivableDirectory.js";
import {
  citedIds,
  resolveLocationById,
  resolvePerceivedLocation,
  unnoticedCandidates,
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

/** Fresh fixtures per test — exposure tests mutate descriptions and
 *  `concealed` in place. */
function makeWorld(): World {
  const scene: DynamicScene = {
    id: "S_PARLOR",
    name: "Parlour",
    setting: "A parlour with [ITEM_CHAIR] by the hearth.",
    parentLocationId: "B_HOUSE",
    items: [
      { id: "ITEM_CHAIR", name: "a chair" },
      { id: "ITEM_DAGGER", name: "a dagger" }, // uncited: unnoticed
    ],
    conditions: [],
    connections: [
      { id: "connection.parlor.shop", targetId: "S_SHOP" },
      { id: "connection.parlor.cellar", targetId: "S_CELLAR", concealed: true },
    ],
  };
  const otherScenes: DynamicScene[] = ["S_SHOP", "S_CELLAR", "S_HUT"].map(
    (id) => ({
      id,
      name: id,
      setting: "",
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
    setting: "A crossing under [ITEM_LAMP].",
    items: [
      { id: "ITEM_LAMP", name: "a lamppost" },
      { id: "ITEM_COIN", name: "a buried coin" }, // uncited: unnoticed
    ],
    conditions: [],
    connections: [
      { id: "connection.junc_x.shop", targetId: "S_SHOP" },
      { id: "connection.junc_x.cellar", targetId: "S_CELLAR", concealed: true },
    ],
  };

  const road: RoadNode = {
    id: "R_MAIN",
    name: "Star Avenue",
    setting: "A long avenue; [ITEM_GLOVE] lies in the gutter.",
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
        concealed: true,
      },
    ],
    endpointA: "J_X",
    endpointB: "J_Y",
    travelTimeMinutes: 10,
    // Derived incl. concealed — the flag lives on the access connection.
    alongConnections: [
      { sceneId: "S_SHOP", position: 0.3 },
      { sceneId: "S_HUT", position: 0.7 },
    ],
    items: [
      { id: "ITEM_GLOVE", name: "a dropped glove" },
      { id: "ITEM_KNIFE", name: "a knife in the ditch" }, // uncited
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
      scenes: scenesById,
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

const PARLOR = { type: "scene", sceneId: "S_PARLOR" } as const;
const JUNCTION = { type: "scene", sceneId: "J_X" } as const;
const MID_ROAD = { type: "road", roadId: "R_MAIN", position: 0.5 } as const;

const items = (ids: string[]) => ({ itemIds: new Set(ids) });
const passages = (ids: string[]) => ({ connectionIds: new Set(ids) });

describe("citedIds", () => {
  it("reads every [id] in a piece of prose", () => {
    expect(citedIds("a [ITEM_A] and [SCN_B], not [two words]")).toEqual(
      new Set(["ITEM_A", "SCN_B"])
    );
    expect(citedIds(undefined)).toEqual(new Set());
  });
});

describe("uncited items stay out of perception", () => {
  it("keeps only the cited items in both location kinds", () => {
    const { dgsm } = makeWorld();
    expect(
      resolvePerceivedLocation(PARLOR, dgsm)?.items.map((i) => i.id)
    ).toEqual(["ITEM_CHAIR"]);
    expect(
      resolvePerceivedLocation(JUNCTION, dgsm)?.items.map((i) => i.id)
    ).toEqual(["ITEM_LAMP"]);
    expect(
      resolvePerceivedLocation(MID_ROAD, dgsm)?.items.map((i) => i.id)
    ).toEqual(["ITEM_GLOVE"]);
  });

  it("adds an item this viewer noticed this minute — and only for that read", () => {
    const { dgsm } = makeWorld();
    expect(
      resolvePerceivedLocation(
        PARLOR,
        dgsm,
        "actor",
        items(["ITEM_DAGGER"])
      )?.items.map((i) => i.id)
    ).toEqual(["ITEM_CHAIR", "ITEM_DAGGER"]);
    expect(
      resolvePerceivedLocation(
        MID_ROAD,
        dgsm,
        "actor",
        items(["ITEM_KNIFE"])
      )?.items.map((i) => i.id)
    ).toEqual(["ITEM_GLOVE", "ITEM_KNIFE"]);
    // Noticing something somewhere else adds nothing here.
    expect(
      resolvePerceivedLocation(
        JUNCTION,
        dgsm,
        "actor",
        items(["ITEM_DAGGER"])
      )?.items.map((i) => i.id)
    ).toEqual(["ITEM_LAMP"]);
  });

  it("keeps uncited items out of the legacy (unscoped) directory", () => {
    const { dgsm, setActorPosition } = makeWorld();
    // Without a scope the directory falls back to every item in plain view
    // anywhere — it does NOT vary with position, but it never contains an
    // uncited thing, because that is not "can you get to it" but "do you
    // know it is there".
    const everywhere = new Set(["ITEM_CHAIR", "ITEM_LAMP", "ITEM_GLOVE"]);
    for (const at of [PARLOR, JUNCTION, MID_ROAD]) {
      setActorPosition(at);
      const set = buildPerceivableDirectory("actor", dgsm).items;
      expect(set).toEqual(everywhere);
      expect(set.has("ITEM_DAGGER")).toBe(false);
      expect(set.has("ITEM_COIN")).toBe(false);
      expect(set.has("ITEM_KNIFE")).toBe(false);
    }
  });
});

describe("the scoped directory: only what the actor was shown", () => {
  it("is the current place, its visible ways out, and its plain-view items", () => {
    const { dgsm, setActorPosition } = makeWorld();
    setActorPosition(PARLOR);
    const directory = buildPerceivableDirectory("actor", dgsm, {
      knownIds: new Set(),
    });
    expect(directory.items).toEqual(new Set(["ITEM_CHAIR"]));
    expect(directory.scenes).toEqual(new Set(["S_PARLOR", "S_SHOP"]));
  });

  it("adds what was noticed this minute — the item, and the place a concealed passage leads to", () => {
    const { dgsm, setActorPosition } = makeWorld();
    setActorPosition(PARLOR);
    const directory = buildPerceivableDirectory("actor", dgsm, {
      knownIds: new Set(),
      noticed: {
        itemIds: new Set(["ITEM_DAGGER"]),
        connectionIds: new Set(["connection.parlor.cellar"]),
      },
    });
    expect(directory.items.has("ITEM_DAGGER")).toBe(true);
    expect(directory.scenes.has("S_CELLAR")).toBe(true);
  });

  it("adds real ids from the actor's own stream/memories and this minute's occurrences, never guesses", () => {
    const { dgsm, setActorPosition } = makeWorld();
    setActorPosition(PARLOR);
    const directory = buildPerceivableDirectory("actor", dgsm, {
      knownIds: new Set(["ITEM_KNIFE", "S_HUT", "ITEM_NOT_REAL", "S_NOWHERE"]),
      shownIds: new Set(["ITEM_COIN"]),
    });
    expect(directory.items.has("ITEM_KNIFE")).toBe(true);
    expect(directory.items.has("ITEM_COIN")).toBe(true);
    expect(directory.scenes.has("S_HUT")).toBe(true);
    expect(directory.items.has("ITEM_NOT_REAL")).toBe(false);
    expect(directory.scenes.has("S_NOWHERE")).toBe(false);
    // Uncited and never shown: still refused.
    expect(directory.items.has("ITEM_DAGGER")).toBe(false);
    expect(directory.scenes.has("S_CELLAR")).toBe(false);
  });
});

describe("concealed connections stay out of adjacency", () => {
  it("filters a concealed scene exit from adjacentIds", () => {
    const { dgsm } = makeWorld();
    expect(resolvePerceivedLocation(PARLOR, dgsm)?.adjacentIds).toEqual([
      "S_SHOP",
    ]);
  });

  it("derives node-scene adjacency from unconcealed connections, keeping roads", () => {
    const { dgsm } = makeWorld();
    // S_CELLAR's connection is concealed, so it stays out of adjacency.
    expect(
      resolvePerceivedLocation(JUNCTION, dgsm)?.adjacentIds.sort()
    ).toEqual(["R_MAIN", "S_SHOP"]);
  });

  it("filters a concealed road access; endpoints are always visible", () => {
    const { dgsm } = makeWorld();
    expect(
      resolvePerceivedLocation(MID_ROAD, dgsm)?.adjacentIds.sort()
    ).toEqual(["J_X", "J_Y", "S_SHOP"]);
  });

  it("the legacy directory names every place; the renderer's adjacency still drops the concealed one", () => {
    const { dgsm, setActorPosition } = makeWorld();
    setActorPosition(PARLOR);
    const directory = buildPerceivableDirectory("actor", dgsm);
    expect(directory.scenes.has("S_PARLOR")).toBe(true);
    expect(directory.scenes.has("S_SHOP")).toBe(true);
    // Adjacency — what the RENDERER shows — drops the concealed door, so the
    // actor is never handed the cellar's id in the first place.
    expect(resolvePerceivedLocation(PARLOR, dgsm)?.adjacentIds).toEqual([
      "S_SHOP",
    ]);
  });

  it("resolveLocationById agrees with resolvePerceivedLocation", () => {
    const { dgsm } = makeWorld();
    for (const id of ["S_PARLOR", "J_X", "R_MAIN"]) {
      const byId = resolveLocationById(id, dgsm);
      expect(
        byId?.items.every((i) => byId?.setting.includes(`[${i.id}]`))
      ).toBe(true);
      expect(byId?.adjacentIds).not.toContain("S_CELLAR");
      expect(byId?.adjacentIds).not.toContain("S_HUT");
    }
  });
});

describe("exposing something changes the world for everyone", () => {
  it("an item cited into the description appears in the location and the directory", () => {
    const { dgsm, scene, junction, road, setActorPosition } = makeWorld();

    scene.setting += " A [ITEM_DAGGER] lies on the mantel.";
    junction.setting += " A [ITEM_COIN] glints in the dirt.";
    road.setting += " A [ITEM_KNIFE] shows in the ditch.";

    expect(
      resolvePerceivedLocation(PARLOR, dgsm)?.items.map((i) => i.id)
    ).toEqual(["ITEM_CHAIR", "ITEM_DAGGER"]);
    expect(
      resolvePerceivedLocation(JUNCTION, dgsm)?.items.map((i) => i.id)
    ).toEqual(["ITEM_LAMP", "ITEM_COIN"]);
    expect(
      resolvePerceivedLocation(MID_ROAD, dgsm)?.items.map((i) => i.id)
    ).toEqual(["ITEM_GLOVE", "ITEM_KNIFE"]);

    setActorPosition(PARLOR);
    const exposed = buildPerceivableDirectory("actor", dgsm).items;
    expect(exposed.has("ITEM_DAGGER")).toBe(true);
    expect(exposed.has("ITEM_COIN")).toBe(true);
    expect(exposed.has("ITEM_KNIFE")).toBe(true);
  });

  it("an unconcealed connection joins adjacency and the scoped directory", () => {
    const { dgsm, scene, junction, road, setActorPosition } = makeWorld();

    for (const c of [
      ...scene.connections,
      ...junction.connections,
      ...road.connections,
    ]) {
      if (c.concealed) c.concealed = false;
    }

    expect(resolvePerceivedLocation(PARLOR, dgsm)?.adjacentIds).toEqual([
      "S_SHOP",
      "S_CELLAR",
    ]);
    expect(
      resolvePerceivedLocation(JUNCTION, dgsm)?.adjacentIds.sort()
    ).toEqual(["R_MAIN", "S_CELLAR", "S_SHOP"]);
    expect(
      resolvePerceivedLocation(MID_ROAD, dgsm)?.adjacentIds.sort()
    ).toEqual(["J_X", "J_Y", "S_HUT", "S_SHOP"]);

    setActorPosition(PARLOR);
    expect(
      buildPerceivableDirectory("actor", dgsm, { knownIds: new Set() }).scenes.has(
        "S_CELLAR"
      )
    ).toBe(true);
  });
});

// A concealed passage is the same for everyone; what differs between viewers
// is only whether THIS one noticed it this minute. There is no per-viewer
// "found by" list on the passage.
describe("a concealed passage one viewer noticed", () => {
  it("is in the perception of the viewer who noticed it", () => {
    const { dgsm } = makeWorld();
    expect(
      resolvePerceivedLocation(
        PARLOR,
        dgsm,
        "npc_finder",
        passages(["connection.parlor.cellar"])
      )?.adjacentIds
    ).toContain("S_CELLAR");
    expect(
      resolvePerceivedLocation(
        MID_ROAD,
        dgsm,
        "npc_finder",
        passages(["connection.r_main.hut"])
      )?.adjacentIds
    ).toContain("S_HUT");
  });

  it("is not in anyone else's", () => {
    const { dgsm } = makeWorld();
    expect(
      resolvePerceivedLocation(PARLOR, dgsm, "npc_other")?.adjacentIds
    ).not.toContain("S_CELLAR");
  });

  it("is not there for a viewerless read — naming a place is not looking", () => {
    const { dgsm } = makeWorld();
    expect(resolvePerceivedLocation(PARLOR, dgsm)?.adjacentIds).not.toContain(
      "S_CELLAR"
    );
  });
});

describe("unnoticedCandidates", () => {
  it("lists the uncited items and concealed passages where the viewer stands", () => {
    const { dgsm } = makeWorld();
    const parlor = unnoticedCandidates(PARLOR, dgsm);
    expect(parlor.items.map((i) => i.id)).toEqual(["ITEM_DAGGER"]);
    expect(parlor.connectionIds).toEqual(["connection.parlor.cellar"]);

    const road = unnoticedCandidates(MID_ROAD, dgsm);
    expect(road.items.map((i) => i.id)).toEqual(["ITEM_KNIFE"]);
    expect(road.connectionIds).toEqual(["connection.r_main.hut"]);
  });

  it("is empty where everything is in plain view — no request needed", () => {
    const { dgsm } = makeWorld();
    expect(
      unnoticedCandidates({ type: "scene", sceneId: "S_SHOP" }, dgsm)
    ).toEqual({ items: [], connectionIds: [] });
    expect(unnoticedCandidates(null, dgsm)).toEqual({
      items: [],
      connectionIds: [],
    });
  });
});
