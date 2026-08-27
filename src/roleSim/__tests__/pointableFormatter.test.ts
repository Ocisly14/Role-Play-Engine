// The actor's address book. Two things are load-bearing here: a person is
// only ever addressable by an opaque handle (never the real id, which would
// hand over a name they may not have earned), and the handle a viewpoint gets
// for a person is the same one every tick — memory is filed under it.

import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { formatPointables } from "../pointableFormatter.js";

const scenes = new Map([
  [
    "SCN_library",
    {
      id: "SCN_library",
      name: "The Library",
      description: "",
      conditions: [],
      items: [{ id: "ITEM_ledger", name: "leather ledger" }],
      connections: [{ targetId: "SCN_hall" }],
    },
  ],
  [
    "SCN_hall",
    {
      id: "SCN_hall",
      name: "The Hall",
      description: "",
      conditions: [],
      items: [],
      connections: [],
    },
  ],
]);

const profiles: Record<string, Record<string, unknown>> = {
  npc_1: { id: "npc_1", name: "Marsh" },
  npc_hollins: {
    id: "npc_hollins",
    name: "Hollins",
    appearance: "tall and pale, in a long black overcoat",
  },
  npc_abbott: { id: "npc_abbott", name: "Abbott" },
};

const positions: Record<string, string> = {
  npc_1: "SCN_library",
  npc_hollins: "SCN_library",
  npc_abbott: "SCN_hall",
};

type RelationshipGraph = Record<
  string,
  Record<string, { score: number; note: string }>
>;

/** Knowing lives in the relationship graph — the live one the engine grows —
 *  not in the profile, which is only its load-time seed. `extraCast` adds
 *  people to the library for the cases that need a specific crowd. */
function makeDgsm(
  graph: RelationshipGraph,
  extraCast: Record<string, Record<string, unknown>> = {}
): DynamicGameStateManager {
  const cast = { ...profiles, ...extraCast };
  const where: Record<string, string> = { ...positions };
  for (const id of Object.keys(extraCast)) where[id] = "SCN_library";
  return {
    getState: () => ({
      scenes,
      npcCharacters: Object.values(cast),
      npcInventories: {},
      npcRelationshipGraph: graph,
    }),
    getRelationship: (npcId: string, targetId: string) =>
      graph[npcId]?.[targetId],
    getScene: (id: string) => scenes.get(id),
    getTopology: () => ({
      junctions: new Map(),
      roads: new Map(),
      junctionToRoads: new Map(),
    }),
    getSceneConditions: () => [],
    getNpcProfile: (id: string) => cast[id],
    isNpcAlive: () => true,
    getCharacterPosition: (id: string) =>
      where[id] ? { type: "scene", sceneId: where[id] } : null,
    resolveLocationId: (p: { sceneId: string }) => p.sceneId,
    getNpcInventory: (id: string) =>
      id === "npc_1" ? [{ id: "ITEM_picks", name: "lockpicks" }] : [],
  } as unknown as DynamicGameStateManager;
}

// Marsh knows Abbott by name; Hollins is a stranger standing in the room.
const dgsm = makeDgsm({
  npc_1: { npc_abbott: { score: 10, note: "colleague" } },
});

describe("formatPointables", () => {
  const block = formatPointables("npc_1", dgsm) ?? "";

  it("addresses a stranger by alias and never by their real id", () => {
    expect(block).toContain("stranger_a — the tall and pale");
    expect(block).not.toContain("npc_hollins");
  });

  it("shows a stranger by description and an acquaintance by name", () => {
    // Hollins is co-located but unknown: Marsh may point at him without
    // being told what he is called.
    expect(block).toContain("tall and pale");
    expect(block).not.toContain("Hollins");
    // Abbott is in the relationship graph — Marsh knows the name.
    expect(block).toContain("Abbott");
  });

  it("keeps real ids for items and places, marking where the actor is", () => {
    expect(block).toContain("ITEM_ledger — leather ledger");
    expect(block).toContain("ITEM_picks — lockpicks");
    expect(block).toContain("SCN_library — The Library (where you are)");
    expect(block).toContain("SCN_hall — The Hall");
  });

  it("gives the same person the same handle on every call", () => {
    expect(formatPointables("npc_1", dgsm)).toBe(block);
  });

  it("switches to the real id and name once the engine records a relationship", () => {
    // The graph is what grows as characters deal with each other. Reading the
    // static profile instead left the profile block calling him "Hollins"
    // while this block still called him "the tall pale man". Once he is known
    // there is nothing left to hide, so the alias gives way to his real id.
    const after =
      formatPointables(
        "npc_1",
        makeDgsm({ npc_1: { npc_hollins: { score: -10, note: "wary" } } })
      ) ?? "";
    expect(after).toContain("npc_hollins — Hollins");
    expect(after).not.toContain("tall and pale");
    expect(after).not.toContain("stranger_");
  });

  it("keeps two indistinguishable strangers apart", () => {
    // Neither has anything to describe, so both render as the same phrase.
    // The description cannot tell them apart; the alias is what does.
    const crowd =
      formatPointables(
        "npc_1",
        makeDgsm(
          {},
          {
            npc_x: { id: "npc_x", name: "Unnamed One" },
            npc_y: { id: "npc_y", name: "Unnamed Two" },
          }
        )
      ) ?? "";
    expect(crowd).toContain("stranger_b — an unfamiliar person");
    expect(crowd).toContain("stranger_c — an unfamiliar person");
    expect(crowd).not.toContain("Unnamed");
  });
});
