// A tag the actor cannot cite is stripped, and the prose survives — but the
// character silently loses an entity they can see and can no longer act on.
// Observed live: `[ITEM_SCN21_3旁的同伴]`, an item id with a phrase of Chinese
// welded onto it. Worth one more call before settling for the loss.

import { describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
vi.mock("../../../models/index.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../../models/types.js"
  );
  return { ...actual, generateText };
});

const { renderViaLLM, uncitableTags, stripUncitableTags } = await import(
  "../llmRenderer.js"
);

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

const render = () =>
  renderViaLLM({ npcId: "npc_1", bundle, dgsm, language: "zh" });

describe("uncitableTags", () => {
  it("finds a bracket carrying anything but a bare id", () => {
    expect(
      uncitableTags(
        "我猛拽那位老工人[ITEM_SCN21_3旁的同伴]的手臂",
        new Set(["ITEM_SCN21_3"])
      )
    ).toEqual(["ITEM_SCN21_3旁的同伴"]);
  });

  it("passes a bare id through", () => {
    expect(uncitableTags("剪刀 [ITEM_7] 在台上", new Set(["ITEM_7"]))).toEqual(
      []
    );
  });
});

describe("renderViaLLM", () => {
  it("asks again, naming the exact string that was invented", async () => {
    generateText.mockReset();
    generateText
      .mockResolvedValueOnce("我猛拽那位老工人[ITEM_SCN21_3旁的同伴]的手臂")
      .mockResolvedValueOnce("我猛拽那位老工人的手臂");

    const out = await render();

    expect(generateText).toHaveBeenCalledTimes(2);
    const second = generateText.mock.calls[1][0].context as string;
    // The correction quotes what it actually wrote — re-reading the rules
    // would not have caught this, being shown the string does.
    expect(second).toContain("[ITEM_SCN21_3旁的同伴]");
    expect(second).toContain("id and NOTHING else");
    expect(out).toBe("我猛拽那位老工人的手臂");
  });

  it("does not ask again when every tag is citable", async () => {
    generateText.mockReset();
    generateText.mockResolvedValueOnce("平台上空无一人。");

    await render();

    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("falls back to stripping when the second attempt is no better", async () => {
    // One retry, never a loop: a tick must not hang on a small model that
    // keeps making the same mistake.
    generateText.mockReset();
    generateText
      .mockResolvedValueOnce("老工人[BAD_ONE]的手臂")
      .mockResolvedValueOnce("老工人[BAD_TWO]的手臂");

    const out = await render();

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(out).toBe("老工人的手臂");
  });
});

describe("stripUncitableTags", () => {
  it("keeps the prose and drops only the bracket", () => {
    expect(stripUncitableTags("老工人[BAD]的手臂", new Set(), "npc_1")).toBe(
      "老工人的手臂"
    );
  });
});
