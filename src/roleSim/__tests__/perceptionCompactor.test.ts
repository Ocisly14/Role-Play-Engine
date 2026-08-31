// The character condenses their own stream, under their own prompt.
//
// Two things are pinned: the ceiling only fires when the block is genuinely
// over budget (a compaction call is not free), and the prompt the character
// reads to write the summary is the prompt they decide under — same profile,
// same memories, same present minute — with only the closing instruction
// swapped. If those two ever drift apart, what the summary keeps stops being
// what this character would have kept.

import { describe, expect, it, vi } from "vitest";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { RoleSimContext } from "../agent.js";
import { stamp } from "../userPromptBuilder.js";

const generateText = vi.fn();
vi.mock("../../models/index.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../models/types.js"
  );
  return { ...actual, generateText };
});

const {
  KEEP_RECENT,
  PERCEPTION_BUDGET_TOKENS,
  SUMMARY_MAX_OUTPUT_TOKENS,
  compactPerceptions,
  needsCompaction,
  perceptionBlockTokens,
} = await import("../perceptionCompactor.js");

const dgsm = {
  getState: () => ({
    npcInventories: {},
    npcRelationshipGraph: {},
    npcCharacters: [],
  }),
  getNpcProfile: () => undefined,
  getCharacterSpot: () => null,
  getScene: () => undefined,
  getTopology: () => ({ junctions: new Map(), roads: new Map() }),
} as unknown as DynamicGameStateManager;

/** `count` paragraphs, oldest first, each `chars` ASCII characters — about
 *  `chars / 3` tokens under the estimator. */
function stream(count: number, chars = 60) {
  return Array.from({ length: count }, (_, i) => ({
    gameDateTime: `1923-04-02T${String(9 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`,
    location: "SCN_library",
    narrative: `p${i}-${"x".repeat(chars)}`,
  }));
}

function makeCtx(entries: ReturnType<typeof stream>): RoleSimContext {
  return {
    npcId: "npc_1",
    currentTime: "1923-04-02T11:00:00",
    currentScene: "SCN_library",
    npcProfile: {
      id: "npc_1",
      name: "Marsh",
      occupation: "Librarian",
      status: {
        hp: 10,
        maxHp: 12,
        san: 44,
        maxSan: 55,
        fatigue: 3,
        maxFatigue: 10,
        conditions: [],
      },
    },
    memories: [],
    perception: { narrative: "The lamp gutters.", location: "SCN_library" },
    recentPerceptions: entries,
  } as unknown as RoleSimContext;
}

describe("needsCompaction", () => {
  it("stays out of the way below the keep window", () => {
    // Even absurdly long paragraphs: there would be nothing left to fold.
    expect(needsCompaction(stream(KEEP_RECENT, 400_000))).toBe(false);
  });

  it("stays out of the way under the ceiling", () => {
    const entries = stream(50);
    expect(perceptionBlockTokens(entries)).toBeLessThan(
      PERCEPTION_BUDGET_TOKENS
    );
    expect(needsCompaction(entries)).toBe(false);
  });

  it("fires once the block passes the ceiling", () => {
    const entries = stream(400, 750);
    expect(perceptionBlockTokens(entries)).toBeGreaterThan(
      PERCEPTION_BUDGET_TOKENS
    );
    expect(needsCompaction(entries)).toBe(true);
  });
});

describe("compactPerceptions", () => {
  it("replaces the folded paragraphs and keeps the recent tail verbatim", async () => {
    generateText.mockReset();
    generateText.mockResolvedValueOnce("那天我把账本收进了柜子。");

    const entries = stream(KEEP_RECENT + 5);
    const result = await compactPerceptions({
      ctx: makeCtx(entries),
      dgsm,
      language: "zh",
    });

    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.entries).toHaveLength(KEEP_RECENT + 1);
    expect(result.entries[0].narrative).toBe("那天我把账本收进了柜子。");
    // The summary stands where the last paragraph it speaks for stood, so the
    // stream stays in order and the reload path has a cutoff to compare.
    expect(result.coversThroughGameDateTime).toBe(entries[4].gameDateTime);
    expect(result.entries[0].gameDateTime).toBe(entries[4].gameDateTime);
    expect(result.entries.slice(1).map((e) => e.narrative)).toEqual(
      entries.slice(5).map((e) => e.narrative)
    );
  });

  it("asks under the character's own prompt, with the cutoff named and no decide instruction", async () => {
    generateText.mockReset();
    generateText.mockResolvedValueOnce("summary");

    const entries = stream(KEEP_RECENT + 5);
    await compactPerceptions({ ctx: makeCtx(entries), dgsm, language: "en" });

    const args = generateText.mock.calls[0][0] as {
      context: string;
      maxOutputTokens: number;
    };
    // Same prompt they decide under...
    expect(args.context).toContain("# You are Marsh");
    expect(args.context).toContain("## What you have lived through so far");
    expect(args.context).toContain("## What you perceive now");
    // ...with only the closing swapped.
    expect(args.context).toContain("## Condense what you have lived through");
    expect(args.context).not.toContain("## Decide");
    // The cutoff is named by a stamp the character can find in the block
    // above — the same renderer, so the two strings cannot disagree.
    const cutoff = stamp(entries[4].gameDateTime, entries[4].location, dgsm);
    expect(args.context).toContain(`\`${cutoff}\``);
    expect(args.context.indexOf(cutoff)).toBeLessThan(
      args.context.lastIndexOf(cutoff)
    );
    expect(args.maxOutputTokens).toBe(SUMMARY_MAX_OUTPUT_TOKENS);
  });

  it("keeps the long stream when the call comes back empty", async () => {
    generateText.mockReset();
    generateText.mockResolvedValueOnce("   ");

    expect(
      await compactPerceptions({
        ctx: makeCtx(stream(KEEP_RECENT + 5)),
        dgsm,
        language: "en",
      })
    ).toBeNull();
  });

  it("keeps the long stream when the call throws", async () => {
    generateText.mockReset();
    generateText.mockRejectedValueOnce(new Error("upstream is down"));

    expect(
      await compactPerceptions({
        ctx: makeCtx(stream(KEEP_RECENT + 5)),
        dgsm,
        language: "en",
      })
    ).toBeNull();
  });
});

describe("handles in the condensed account", () => {
  /** Folded paragraphs carrying two real handles the character read. */
  function taggedStream() {
    const entries = stream(KEEP_RECENT + 3);
    entries[0].narrative =
      "The clerk [stranger_a] sets a brass key [ITEM_7] on the counter.";
    entries[1].narrative = "I stepped into the reading room [SCN_LIBRARY].";
    return entries;
  }

  it("keeps a handle the character read, even though nothing is perceivable now", async () => {
    // The allowed set comes from the folded paragraphs, not from what is in
    // front of them this minute — the dgsm stub perceives nothing at all, and
    // the handles must survive that.
    generateText.mockReset();
    generateText.mockResolvedValueOnce(
      "I took the brass key [ITEM_7] from the clerk [stranger_a] and went in."
    );

    const result = await compactPerceptions({
      ctx: makeCtx(taggedStream()),
      dgsm,
      language: "en",
    });

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result?.summary).toContain("[ITEM_7]");
    expect(result?.summary).toContain("[stranger_a]");
  });

  it("repairs an invented handle incrementally, without rewriting the account", async () => {
    generateText.mockReset();
    generateText
      .mockResolvedValueOnce(
        "I took the brass key [ITEM_TWELVE] and went into the reading room [SCN_LIBRARY]."
      )
      .mockResolvedValueOnce("ITEM_TWELVE => ITEM_7");

    const result = await compactPerceptions({
      ctx: makeCtx(taggedStream()),
      dgsm,
      language: "en",
    });

    expect(generateText).toHaveBeenCalledTimes(2);
    // The repair call sees the handles and nothing else — not the account, and
    // not the eighty thousand tokens that produced it.
    const repair = generateText.mock.calls[1][0] as { context: string };
    expect(repair.context).toContain("ITEM_TWELVE");
    expect(repair.context).toContain("- ITEM_7");
    expect(repair.context).not.toContain("I took the brass key");
    // Only the bracket changed; every word the character wrote is still there.
    expect(result?.summary).toBe(
      "I took the brass key [ITEM_7] and went into the reading room [SCN_LIBRARY]."
    );
  });

  it("drops the bracket and keeps the prose when nothing real matches", async () => {
    generateText.mockReset();
    generateText
      .mockResolvedValueOnce("I pocketed a tin whistle [ITEM_99].")
      .mockResolvedValueOnce("ITEM_99 => none");

    const result = await compactPerceptions({
      ctx: makeCtx(taggedStream()),
      dgsm,
      language: "en",
    });

    expect(result?.summary).toBe("I pocketed a tin whistle.");
  });

  it("strips what the repair could not place", async () => {
    generateText.mockReset();
    generateText
      .mockResolvedValueOnce("I pocketed a tin whistle [ITEM_99].")
      .mockRejectedValueOnce(new Error("upstream is down"));

    const result = await compactPerceptions({
      ctx: makeCtx(taggedStream()),
      dgsm,
      language: "en",
    });

    expect(result?.summary).toBe("I pocketed a tin whistle.");
  });

  it("refuses a replacement that is not itself a real handle", async () => {
    generateText.mockReset();
    generateText
      .mockResolvedValueOnce("I pocketed a tin whistle [ITEM_99].")
      .mockResolvedValueOnce("ITEM_99 => ITEM_ALSO_INVENTED");

    const result = await compactPerceptions({
      ctx: makeCtx(taggedStream()),
      dgsm,
      language: "en",
    });

    expect(result?.summary).toBe("I pocketed a tin whistle.");
  });
});
