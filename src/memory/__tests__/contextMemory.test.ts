// What a character starts the session knowing about the town. Three things
// are load-bearing: the memories are cut to what this character knows (an
// unknown building must not be named, not even as somewhere a door leads),
// the topology memory comes last because it is the layer that only makes
// sense once the places have names, and a junction's connections are read
// through the accessor that tolerates both shapes modules author them in.

import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { buildMapMemoryEntries } from "../contextMemory.js";
import type { KnownMapIds } from "../types.js";

const scenarioOutlines = [
  { id: "OUTDOOR", name: "Outdoors", description: "", subSceneCount: 0 },
  {
    id: "B_HOSP",
    name: "St. Mary's Hospital",
    description: "Two storeys of soot-stained brick.",
    subSceneCount: 2,
    entrySceneId: "SCN_HOSP_LOBBY",
  },
  {
    id: "B_MILL",
    name: "The Mill",
    description: "Shut since the strike.",
    subSceneCount: 1,
    entrySceneId: "SCN_MILL_FLOOR",
  },
  {
    id: "B_VAULT",
    name: "The Vault",
    description: "Nobody goes in.",
    subSceneCount: 1,
    entrySceneId: "SCN_VAULT",
  },
];

const scenes = new Map<string, Record<string, unknown>>([
  [
    "SCN_HOSP_LOBBY",
    {
      id: "SCN_HOSP_LOBBY",
      name: "Lobby",
      description: "A counter and a row of chairs.",
      parentLocationId: "B_HOSP",
      items: [],
      conditions: [],
      connections: [
        { targetId: "SCN_HOSP_WARD", description: "double doors" },
        { targetId: "ROAD_1", description: "the front steps" },
        { targetId: "SCN_VAULT", description: "a locked side door", hidden: true },
      ],
    },
  ],
  [
    "SCN_HOSP_WARD",
    {
      id: "SCN_HOSP_WARD",
      name: "Ward",
      description: "Six beds, four of them empty.",
      parentLocationId: "B_HOSP",
      items: [],
      conditions: [],
      connections: [{ targetId: "SCN_HOSP_LOBBY" }],
    },
  ],
  [
    "SCN_MILL_FLOOR",
    {
      id: "SCN_MILL_FLOOR",
      name: "Mill Floor",
      description: "Looms under dust sheets.",
      parentLocationId: "B_MILL",
      items: [],
      conditions: [],
      connections: [{ targetId: "JUNC_N", description: "the loading door" }],
    },
  ],
  [
    "SCN_VAULT",
    {
      id: "SCN_VAULT",
      name: "Vault Floor",
      description: "Never described to anyone.",
      parentLocationId: "B_VAULT",
      items: [],
      conditions: [],
      connections: [],
    },
  ],
]);

const junctions = new Map<string, Record<string, unknown>>([
  [
    "JUNC_N",
    {
      id: "JUNC_N",
      name: "North Corner",
      description: "",
      parentLocationId: "OUTDOOR",
      items: [],
      conditions: [],
      // Newer modules author this as objects rather than bare ids.
      connectedSceneIds: [
        { targetId: "SCN_MILL_FLOOR", description: "gravel track west" },
        { targetId: "SCN_VAULT", description: "an iron gate" },
      ],
    },
  ],
  [
    "JUNC_S",
    {
      id: "JUNC_S",
      name: "South Corner",
      description: "",
      parentLocationId: "OUTDOOR",
      items: [],
      conditions: [],
      connectedSceneIds: [],
    },
  ],
]);

const roads = new Map<string, Record<string, unknown>>([
  [
    "ROAD_1",
    {
      id: "ROAD_1",
      name: "Chapel Street",
      description: "",
      parentLocationId: "OUTDOOR",
      endpointA: "JUNC_N",
      endpointB: "JUNC_S",
      travelTimeMinutes: 6,
      alongConnections: [{ sceneId: "SCN_HOSP_LOBBY", position: 0.4 }],
      items: [],
      conditions: [],
    },
  ],
]);

const dgsm = {
  getState: () => ({ scenes, junctions, roads, scenarioOutlines }),
  getTopology: () => ({
    junctions,
    roads,
    junctionToRoads: new Map([
      ["JUNC_N", [roads.get("ROAD_1")]],
      ["JUNC_S", [roads.get("ROAD_1")]],
    ]),
    sceneToParent: new Map(),
  }),
} as unknown as DynamicGameStateManager;

/** Everything except the Vault — which the character has never heard of. */
const knownIds: KnownMapIds = {
  sceneIds: ["SCN_HOSP_LOBBY", "SCN_HOSP_WARD", "SCN_MILL_FLOOR"],
  junctionIds: ["JUNC_N", "JUNC_S"],
  roadIds: ["ROAD_1"],
  scenarioOutlineIds: ["B_HOSP", "B_MILL", "OUTDOOR"],
};

describe("buildMapMemoryEntries", () => {
  const entries = buildMapMemoryEntries(dgsm, knownIds, "en");

  it("writes one macro memory per building, listing the rooms inside it", () => {
    const macro = entries.filter((e) => e.scope === "macro");
    expect(macro.map((e) => e.locationId)).toEqual(["B_HOSP", "B_MILL"]);
    expect(macro[0].content).toContain("Two storeys of soot-stained brick.");
    expect(macro[0].content).toContain("Lobby");
    expect(macro[0].content).toContain("Ward");
  });

  it("gives OUTDOOR no macro memory of its own", () => {
    expect(
      entries.some((e) => e.scope === "macro" && e.locationId === "OUTDOOR")
    ).toBe(false);
  });

  it("writes one interior memory per scene, with the ways out of it", () => {
    const lobby = entries.find((e) => e.locationId === "SCN_HOSP_LOBBY");
    expect(lobby?.scope).toBe("interior");
    expect(lobby?.content).toContain("A counter and a row of chairs.");
    expect(lobby?.content).toContain("double doors → Ward");
    expect(lobby?.content).toContain("the front steps → Chapel Street");
  });

  it("leaves out a hidden exit — it has not been found yet", () => {
    const lobby = entries.find((e) => e.locationId === "SCN_HOSP_LOBBY");
    expect(lobby?.content).not.toContain("locked side door");
  });

  it("never names a place the character does not know", () => {
    const all = entries.map((e) => e.content).join("\n");
    expect(all).not.toContain("The Vault");
    expect(all).not.toContain("Vault Floor");
    expect(all).not.toContain("Nobody goes in");
  });

  it("closes with a single topology memory, written after the places", () => {
    const topology = entries.filter((e) => e.scope === "topology");
    expect(topology).toHaveLength(1);
    expect(entries[entries.length - 1].scope).toBe("topology");
  });

  it("says which building stands on which street, and where streets meet", () => {
    const topology = entries[entries.length - 1].content;
    expect(topology).toContain(
      "Chapel Street runs between North Corner and South Corner (~6 min on foot)."
    );
    expect(topology).toContain("On it: St. Mary's Hospital");
    expect(topology).toContain("Streets at North Corner: Chapel Street.");
  });

  it("reads a junction authored as objects, not bare ids", () => {
    // buildTopology and everything downstream assume `string[]`; a module
    // using the `{ targetId }` shape would otherwise lose every building at
    // the corner.
    const topology = entries[entries.length - 1].content;
    expect(topology).toContain("At the junction: The Mill");
  });
});
