import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { RoleSimContext } from "../agent.js";
import {
  buildUserPrompt,
  buildUserPromptSegments,
} from "../userPromptBuilder.js";

// Minimal DGSM stand-in: formatProfile only reads npcInventories,
// npcRelationshipGraph and npcCharacters off the state.
const dgsm = {
  getState: () => ({
    npcInventories: {},
    npcRelationshipGraph: {},
    npcCharacters: [],
  }),
} as unknown as DynamicGameStateManager;

function makeCtx(overrides: Partial<RoleSimContext> = {}): RoleSimContext {
  return {
    npcId: "npc_1",
    currentTime: "1923-04-02T09:15:00",
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
    recentMemory: [],
    ...overrides,
  } as unknown as RoleSimContext;
}

const opts = { language: "en", dgsm };

describe("buildUserPromptSegments", () => {
  it("concatenates to exactly what buildUserPrompt returns", () => {
    const ctx = makeCtx({
      longTermIntent: "Find the missing ledger",
      perception: { narrative: "Dust hangs in the lamplight." },
      currentAction: { actionText: "searching the shelves" },
    });
    const transcript = ['{"tool":"recallMemory"} -> 2 hits'];

    const joined = buildUserPromptSegments(ctx, transcript, opts)
      .map((s) => s.text)
      .join("");

    expect(joined).toBe(buildUserPrompt(ctx, transcript, opts));
  });

  it("preserves the exact section layout and \\n\\n separators", () => {
    // Byte-level guard: segmentation must not shift a single separator.
    // Written out in full rather than derived, so a drift in either the
    // grouping or the join shows up here.
    const text = buildUserPrompt(makeCtx(), [], opts);

    expect(text).toBe(
      [
        "# You are Marsh",
        "## Who you are\nName: Marsh\nOccupation: Librarian\nStatus: HP 10/12, SAN 44/55, Fatigue 3/10",
        "## Right now\nToday: 1923-04-02 09:15\nScene: SCN_library",
        text.slice(text.indexOf("## Decide")),
      ].join("\n\n")
    );
  });

  it("tells the model not to answer in the [narrative] shape", () => {
    // Regression guard for the ~50% no-tool-call rate: the perception blocks
    // above are themselves [narrative]/[references], and the model mirrored
    // them instead of calling a tool. The API now enforces the envelope, but
    // the narrative still has to land inside the `actionText` argument.
    const text = buildUserPrompt(makeCtx(), [], opts);
    const decide = text.slice(text.indexOf("## Decide"));

    expect(decide).toContain("Do not\nanswer in that shape");
    expect(decide).toContain("`actionText`");
    expect(decide).toContain("Write content in English.");
  });

  it("enables no breakpoint while decide() is single-iteration", () => {
    // Measured: every decide() in a 5-tick run terminated at iteration 0, so
    // nothing would ever read a breakpoint here and each one would cost a
    // 1.25x write. If this flips to true again, the loop must first be shown
    // to run multiple iterations (or identity must become tick-stable).
    const segments = buildUserPromptSegments(makeCtx(), ["a", "b"], opts);
    expect(segments.every((s) => s.cache === false)).toBe(true);
  });

  it("keeps the non-transcript prefix byte-identical as the transcript grows", () => {
    // The property any future breakpoint here would rest on: within one
    // decide() loop only the trailing segment changes. Guarding it now means
    // the boundary stays valid until the loop is worth caching.
    const ctx = makeCtx();
    const prefix = (transcript: string[]) =>
      buildUserPromptSegments(ctx, transcript, opts)
        .slice(0, -1)
        .map((s) => s.text)
        .join("");

    expect(prefix([])).toBe(prefix(["tool call 1"]));
    expect(prefix(["tool call 1"])).toBe(prefix(["tool call 1", "tc 2"]));
  });

  it("still round-trips when optional sections are absent", () => {
    const segments = buildUserPromptSegments(makeCtx(), [], opts);
    expect(segments.map((s) => s.text).join("")).toBe(
      buildUserPrompt(makeCtx(), [], opts)
    );
    expect(segments.some((s) => s.text.includes("\n\n\n"))).toBe(false);
  });
});

describe("SYSTEM_PROMPT — cacheability invariant", () => {
  it("is a module-level constant, identical on every read", async () => {
    // `llmAgent` passes cacheSystemPrompt: true, which is only correct while
    // this is byte-stable. Interpolating anything per-NPC or per-tick here
    // turns every call into a fresh cache write that is never read.
    const a = (await import("../systemPrompt.js")).SYSTEM_PROMPT;
    const b = (await import("../systemPrompt.js")).SYSTEM_PROMPT;
    expect(a).toBe(b);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    // Comfortably over Sonnet 5's 1024-token minimum cacheable prefix.
    expect(a.length).toBeGreaterThan(4000);
  });
});
