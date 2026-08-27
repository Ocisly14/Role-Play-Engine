import { describe, expect, it } from "vitest";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { RoleSimContext } from "../agent.js";
import {
  buildUserPrompt,
  buildUserPromptSegments,
} from "../userPromptBuilder.js";

// Minimal DGSM stand-in: formatProfile reads npcInventories,
// npcRelationshipGraph and npcCharacters off the state; the pointable list
// bails out on a viewpoint with no profile; and an unresolvable scene id
// makes the perception stamp fall back to the raw id.
const dgsm = {
  getState: () => ({
    npcInventories: {},
    npcRelationshipGraph: {},
    npcCharacters: [],
  }),
  getNpcProfile: () => undefined,
  getScene: () => undefined,
  getTopology: () => ({ junctions: new Map(), roads: new Map() }),
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
    memories: [],
    ...overrides,
  } as unknown as RoleSimContext;
}

const opts = { language: "en", dgsm };

describe("buildUserPromptSegments", () => {
  it("concatenates to exactly what buildUserPrompt returns", () => {
    const ctx = makeCtx({
      longTermIntent: "Find the missing ledger",
      perception: { narrative: "Dust hangs in the lamplight." },
      currentAction: { description: "searching the shelves" },
    });
    const joined = buildUserPromptSegments(ctx, opts)
      .map((s) => s.text)
      .join("");

    expect(joined).toBe(buildUserPrompt(ctx, opts));
  });

  it("preserves the exact section layout and \\n\\n separators", () => {
    // Byte-level guard: segmentation must not shift a single separator.
    // Written out in full rather than derived, so a drift in either the
    // grouping or the join shows up here.
    const text = buildUserPrompt(makeCtx(), opts);

    expect(text).toBe(
      [
        "# You are Marsh",
        "## Who you are\nName: Marsh\nOccupation: Librarian\nStatus: HP 10/12, SAN 44/55, Fatigue 3/10",
        text.slice(text.indexOf("## Decide")),
      ].join("\n\n")
    );
  });

  it("stamps each perception with when and where it reached the character", () => {
    // There is no separate "right now" block any more — this line is the only
    // thing telling the character what minute it is and where they stand.
    const text = buildUserPrompt(
      makeCtx({
        perception: { narrative: "Dust hangs in the lamplight." },
        recentPerceptions: [
          {
            gameDateTime: "1923-04-02T09:14:00",
            location: "SCN_hall",
            narrative: "A door closes somewhere behind you.",
          },
        ],
      }),
      opts
    );

    expect(text).toContain("--- 1923-04-02 09:14 · SCN_hall ---");
    expect(text).toContain("--- 1923-04-02 09:15 · SCN_library ---");
    expect(text).not.toContain("## Right now");
  });

  it("routes prose to description and entity ids to objectRefs", () => {
    // Regression guard for the ~50% no-tool-call rate: the perception blocks
    // above may carry narrative scaffolding, and the model used to mirror
    // them instead of calling a tool. The API now enforces the envelope, but
    // the instruction still has to route prose into `description` and ids
    // into `objectRefs`.
    const text = buildUserPrompt(makeCtx(), opts);
    const decide = text.slice(text.indexOf("## Decide"));

    expect(decide).toContain("`description`");
    expect(decide).toContain("`objectRefs`");
    expect(decide).toContain("Write content in English.");
  });

  it("enables no breakpoint while decide() is single-iteration", () => {
    // Measured: every decide() in a 5-tick run terminated at iteration 0, so
    // nothing would ever read a breakpoint here and each one would cost a
    // 1.25x write. If this flips to true again, the loop must first be shown
    // to run multiple iterations (or identity must become tick-stable).
    const segments = buildUserPromptSegments(makeCtx(), opts);
    expect(segments.every((s) => s.cache === false)).toBe(true);
  });

  it("still round-trips when optional sections are absent", () => {
    const segments = buildUserPromptSegments(makeCtx(), opts);
    expect(segments.map((s) => s.text).join("")).toBe(
      buildUserPrompt(makeCtx(), opts)
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
