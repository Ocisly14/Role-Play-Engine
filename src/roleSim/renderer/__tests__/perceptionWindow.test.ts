// The renderer is shown a fixed window of what it has already described, not
// the whole stream. Two things are pinned here, and the second is the one
// worth a test: the window itself, and the fact that no cache breakpoint sits
// on a segment that moves. A breakpoint at the end of a block that grows every
// tick is charged as a write of the entire prefix — measured at an effective
// 1.35x on content that costs 1.0x uncached (userPromptBuilder.ts). This file
// carried exactly that arrangement, on top of an unbounded history.

import { describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
vi.mock("../../../models/index.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../../models/types.js"
  );
  return { ...actual, generateText };
});

const { renderViaLLM } = await import("../llmRenderer.js");

const dgsm = {
  getNpcProfile: () => ({
    id: "npc_1",
    name: "Haran",
    status: { conditions: [] },
  }),
  getState: () => ({ npcRelationshipGraph: {}, npcCharacters: [] }),
  getRelationship: () => undefined,
  getCharactersInScene: () => [],
  getNpcInventory: () => [],
  getScene: () => null,
  getTopology: () => ({
    junctions: new Map(),
    roads: new Map(),
    sceneToParent: new Map(),
  }),
  getCharacterPosition: () => ({ type: "scene", sceneId: "SCN_1" }),
  resolveLocationId: () => "SCN_1",
  getSceneConditions: () => [],
} as never;

const bundle = {
  scene: {
    id: "SCN_1",
    name: "Platform",
    description: "A platform.",
    activeConditions: [],
    items: [],
    adjacentPlaces: [],
  },
  ownConditions: [],
  ownAction: { kind: "idle" },
  occurrences: [],
  charactersInScene: [],
} as never;

/** `count` prior paragraphs, oldest first, each identifiable by its index. */
function history(count: number, location = "SCN_1") {
  return Array.from({ length: count }, (_, i) => ({
    gameDateTime: `1985-12-01T19:${String(i).padStart(2, "0")}:00`,
    location,
    narrative: `段落${i}`,
  }));
}

async function render(count: number, location?: string) {
  generateText.mockReset();
  generateText.mockResolvedValueOnce("平台上空无一人。");
  await renderViaLLM({
    npcId: "npc_1",
    bundle,
    dgsm,
    language: "zh",
    recentPerceptions: history(count, location),
  });
  const args = generateText.mock.calls[0][0] as {
    context: string;
    contextSegments: Array<{ text: string; cache?: boolean }>;
  };
  return args;
}

describe("perception history window", () => {
  it("shows only the most recent five paragraphs", async () => {
    const { context } = await render(9);

    for (const i of [4, 5, 6, 7, 8]) {
      expect(context).toContain(`段落${i}`);
    }
    for (const i of [0, 1, 2, 3]) {
      expect(context).not.toContain(`段落${i}`);
    }
  });

  it("shows everything when the stream is shorter than the window", async () => {
    const { context } = await render(2);

    expect(context).toContain("段落0");
    expect(context).toContain("段落1");
  });

  it("keeps a moved character's earlier paragraphs until the new place fills the window", async () => {
    // No special case on a scene change: the new place's paragraphs push the
    // old ones out on their own, and the mixed window in between is the
    // continuity a character carries through a door.
    const { context } = await render(3, "SCN_OTHER");

    expect(context).toContain("段落0");
    expect(context).toContain("段落2");
  });
});

describe("cache breakpoints", () => {
  it("puts the only breakpoint on the segment that never moves", async () => {
    const { contextSegments } = await render(9);

    const cached = contextSegments.filter((s) => s.cache);
    expect(cached).toHaveLength(1);
    // Identity — name and appearance — is the one thing that does not change
    // between ticks of the same session.
    expect(cached[0].text).toContain("# Viewpoint character");

    const historySegment = contextSegments.find((s) =>
      s.text.includes("# What you have already described")
    );
    expect(historySegment).toBeDefined();
    expect(historySegment?.cache).toBe(false);
  });
});

describe("what the history block is for", () => {
  it("says the old paragraphs are continuity only, and this minute is the world", async () => {
    const { context } = await render(9);

    // The paragraphs carry the tags they carried then. A character who has
    // moved is reading handles that were legal in a room they have left —
    // observed once as a tackle box reached back into from the front gate,
    // copied exactly, as the copy-the-tag rule instructs.
    expect(context).toContain("for CONTINUITY");
    expect(context).toContain("not evidence about now");
    expect(context).toContain("Tag only what appears in THIS");
    // And the original job of the block survives.
    expect(context).toContain("do not\nre-introduce what is unchanged");
  });
});
