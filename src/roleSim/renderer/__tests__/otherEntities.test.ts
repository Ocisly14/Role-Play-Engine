// A participant who is not in the viewpoint's place used to reach the
// renderer as a name and an appearance and nothing else — no place, no
// relation to here. Measured: a doorway conversation rendered for fifty
// minutes as everyone in one room, and the actor then acted on that room.
// The section now says where they are, how that place stands to this one,
// and what the place looks like, so the geometry is the renderer's to read.

import { describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
vi.mock("../../../models/index.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../../models/types.js"
  );
  return { ...actual, generateText };
});

const { renderViaLLM } = await import("../llmRenderer.js");

const profiles: Record<string, unknown> = {
  npc_1: { id: "npc_1", name: "Susan", status: { conditions: [] } },
  npc_2: {
    id: "npc_2",
    name: "Denny",
    appearance: "thin, oversized jacket",
    status: { conditions: [] },
  },
};
const positions: Record<string, unknown> = {
  npc_1: { type: "scene", sceneId: "SCN_common" },
  npc_2: { type: "scene", sceneId: "SCN_denny" },
};
const scenes: Record<string, unknown> = {
  SCN_common: { id: "SCN_common", name: "Common room", description: "" },
  SCN_denny: {
    id: "SCN_denny",
    name: "Denny's room",
    description: "A small room; a towel is wedged under the door.",
  },
};

const dgsm = {
  getNpcProfile: (id: string) => profiles[id] ?? null,
  getState: () => ({
    npcRelationshipGraph: {
      npc_1: { npc_2: { score: 90, note: "", knownAs: "Denny" } },
    },
    npcCharacters: [],
  }),
  getRelationship: () => undefined,
  getCharactersInScene: () => [],
  getNpcInventory: () => [],
  getScene: (id: string) => scenes[id] ?? null,
  getTopology: () => ({
    junctions: new Map(),
    roads: new Map(),
    sceneToParent: new Map(),
  }),
  getCharacterPosition: (id: string) => positions[id] ?? null,
  isNpcAlive: () => true,
  getCharactersAtLocation: () => [],
  getSceneItems: () => [],
  getItem: () => null,
  resolveLocationId: () => "SCN_common",
  getSceneConditions: () => [],
} as never;

function bundleWith(adjacent: boolean) {
  return {
    scene: {
      id: "SCN_common",
      name: "Common room",
      description: "A wide room.",
      activeConditions: [],
      items: [],
      adjacentPlaces: adjacent
        ? [{ id: "SCN_denny", name: "Denny's room" }]
        : [],
    },
    ownConditions: [],
    ownAction: { kind: "idle" },
    occurrences: [
      {
        id: "occ_1",
        tickId: "t1",
        sourceActionIds: [],
        locationId: "SCN_denny",
        facts: [
          {
            id: "occ_1#f0",
            type: "speech",
            content: "Denny says he is doing homework.",
            entityRefs: [],
          },
        ],
        participants: [{ characterId: "npc_2", role: "actor" }],
        perceivers: [
          { characterId: "npc_1", clarity: "full" },
          { characterId: "npc_2", clarity: "full" },
        ],
        signals: [{ factIds: ["occ_1#f0"], channel: "sound" }],
      },
    ],
    charactersInScene: [],
  } as never;
}

async function render(adjacent: boolean) {
  generateText.mockReset();
  generateText.mockResolvedValueOnce("门那边传来丹尼的声音。");
  await renderViaLLM({
    npcId: "npc_1",
    bundle: bundleWith(adjacent),
    dgsm,
    language: "zh",
    recentPerceptions: [],
  });
  return (generateText.mock.calls[0][0] as { context: string }).context;
}

describe("other entities carry their place", () => {
  it("says a participant in the next room is NOT here, names the way, and shows that room", async () => {
    const context = await render(true);
    const section = context.split("# Other entities involved in events")[1];
    expect(section).toContain("Where they are: NOT here");
    expect(section).toContain("the next place along");
    expect(section).toContain(
      "Neighbouring place (NOT where you are): Denny's room"
    );
    expect(section).toContain("a towel is wedged under the door");
    // The occurrence itself is placed against here, not left as a bare id.
    expect(context).toContain(
      "Occurrence NOT here — in the next place along (SCN_denny)"
    );
  });

  it("marks a participant with no way between as out of reach", async () => {
    const context = await render(false);
    expect(context).toContain("out of sight and beyond earshot");
    expect(context).toContain(
      "Distant place (NOT where you are): Denny's room"
    );
  });
});
