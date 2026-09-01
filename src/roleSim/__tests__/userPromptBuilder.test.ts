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
  getCharacterSpot: () => null,
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
      perception: { narrative: "Dust hangs in the lamplight." },
      currentAction: { description: "searching the shelves" },
    });
    const joined = buildUserPromptSegments(ctx, opts)
      .map((s) => s.text)
      .join("");

    expect(joined).toBe(buildUserPrompt(ctx, opts));
  });

  it("preserves the exact section order and \\n\\n separators", () => {
    // Guards the grouping and the join, not the content: a drift in either
    // shows up as a section out of order or a doubled separator. What each
    // section SAYS is asserted where that section is tested.
    const text = buildUserPrompt(makeCtx(), opts);

    expect(text.startsWith("# You are Marsh\n\n")).toBe(true);
    expect([...text.matchAll(/^## .+$/gm)].map((m) => m[0])).toEqual([
      "## Who you are",
      "## What you can do",
      "## How you are right now",
      "## Decide",
    ]);
    expect(text).not.toContain("\n\n\n");
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

  it("keeps map memories outside the cached block", () => {
    // A breakpoint at the end of an append-only block still MOVES every tick,
    // and the provider charges a cache write for the whole new prefix, not the
    // increment. Measured: 343k read against 655k written — worse than not
    // caching at all. So exactly one breakpoint, and it sits behind content
    // that never changes.
    const segments = buildUserPromptSegments(
      makeCtx({
        memories: [
          {
            id: "aaaaaaaa-1111-1111-1111-111111111111",
            handle: "Maaaaaaaa",
            type: "map",
            content: "The bakery is on Mill Street.",
            gameDateTime: "1923-04-01T00:00:00",
          },
          {
            id: "bbbbbbbb-2222-2222-2222-222222222222",
            handle: "Mbbbbbbbb",
            type: "general",
            content: "Hollins lied about the harbour.",
            gameDateTime: "1923-04-02T09:10:00",
          },
        ],
      }),
      opts
    );

    expect(segments.filter((s) => s.cache)).toHaveLength(1);
    expect(segments[0].cache).toBe(true);
    expect(segments[segments.length - 1].cache).toBe(false);
    expect(segments[0].text).not.toContain("The bakery is on Mill Street");
  });

  it("keeps written memory and perception OUT of the cached block", () => {
    // Both grow every tick. Inside the breakpoint they would move it; outside,
    // they ride at full price behind a block that is written once.
    const segments = buildUserPromptSegments(
      makeCtx({
        memories: [
          {
            id: "aaaaaaaa-1111-1111-1111-111111111111",
            handle: "Maaaaaaaa",
            type: "map",
            content: "The bakery is on Mill Street.",
            gameDateTime: "1923-04-01T00:00:00",
          },
          {
            id: "bbbbbbbb-2222-2222-2222-222222222222",
            handle: "Mbbbbbbbb",
            type: "general",
            content: "Hollins lied about the harbour.",
            gameDateTime: "1923-04-02T09:10:00",
          },
        ],
        recentPerceptions: [
          {
            gameDateTime: "1923-04-02T09:14:00",
            location: "SCN_hall",
            narrative: "A door closes behind you.",
          },
        ],
      }),
      opts
    );
    const cached = segments
      .filter((s) => s.cache)
      .map((s) => s.text)
      .join("");

    expect(cached).toContain("## Who you are");
    expect(cached).not.toContain("The bakery is on Mill Street");
    expect(cached).not.toContain("Hollins lied");
    expect(cached).not.toContain("A door closes");
  });

  it("puts everything that changes every tick behind the breakpoint", () => {
    // Prefix caching matches from byte 0: one volatile section placed early
    // discards every stable byte behind it. Vitals move on most ticks (the
    // stamina subsystem) and the perception is new by definition.
    const segments = buildUserPromptSegments(
      makeCtx({ perception: { narrative: "Dust hangs in the lamplight." } }),
      opts
    );
    const cached = segments
      .filter((s) => s.cache)
      .map((s) => s.text)
      .join("");

    expect(cached).toContain("## Who you are");
    expect(cached).not.toContain("## How you are right now");
    expect(cached).not.toContain("## What you perceive now");
    expect(cached).not.toContain("## Decide");
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

describe("the life goal is a memory, not a section of its own", () => {
  // It used to be fetched by its own `findLatestByType` query and rendered as
  // `## Your long-term goal`. Now it rides in the memory block: one less
  // query, and one less section whose presence depended on a separate lookup.
  it("renders inside What you remember and nowhere else", () => {
    const text = buildUserPrompt(
      makeCtx({
        memories: [
          {
            id: "aaaaaaaa-1111-1111-1111-111111111111",
            handle: "Maaaaaaaa",
            type: "long_term_intent",
            content: "Keep the shop open through the winter.",
            gameDateTime: "1923-04-02T08:00:00",
          },
          {
            id: "bbbbbbbb-2222-2222-2222-222222222222",
            handle: "Mbbbbbbbb",
            type: "secret",
            content: "I owe Kovind money.",
            gameDateTime: "1923-04-01T20:00:00",
          },
        ],
      }),
      opts
    );

    expect(text).not.toContain("## Your long-term goal");
    const remembered = text.slice(
      text.indexOf("## What you remember"),
      text.indexOf("## How you are right now")
    );
    expect(remembered).toContain("(long_term_intent) Keep the shop open");
    // Chronological with everything else — the older secret comes first.
    expect(remembered.indexOf("I owe Kovind")).toBeLessThan(
      remembered.indexOf("Keep the shop open")
    );
  });
});

describe("where in the room the character is standing", () => {
  const withSpot = {
    ...(dgsm as unknown as object),
    getCharacterSpot: () => "at the workbench, back to the door",
  } as unknown as typeof dgsm;

  it("renders the spot inside How you are right now", () => {
    // Proprioception: you always know where you put yourself. It rides with
    // HP and the inventory, not with the frozen profile.
    const text = buildUserPrompt(makeCtx(), { language: "en", dgsm: withSpot });

    const block = text.slice(
      text.indexOf("## How you are right now"),
      text.indexOf("## Decide")
    );
    expect(block).toContain(
      "Where you are: at the workbench, back to the door"
    );
  });

  it("keeps the spot OUT of the cached block", () => {
    // A spot in the frozen prefix would be a place the character believes
    // they are standing an hour after they left it — and would poison the
    // cached prefix on the tick it changes.
    const segments = buildUserPromptSegments(makeCtx(), {
      language: "en",
      dgsm: withSpot,
    });
    const cached = segments
      .filter((s) => s.cache)
      .map((s) => s.text)
      .join("");

    expect(cached).not.toContain("Where you are:");
  });

  it("emits no line at all when there is no spot", () => {
    const text = buildUserPrompt(makeCtx(), opts);
    expect(text).not.toContain("Where you are:");
  });
});

describe("a character knows their own hands", () => {
  // Withholding the numbers left the agent deciding whether to declare a skill
  // with no idea whether it was a strength. It declared none: 25 of 25.
  it("lists every domain, best first, inside the cached block", () => {
    const segments = buildUserPromptSegments(makeCtx(), opts);
    const cached = segments
      .filter((s) => s.cache)
      .map((s) => s.text)
      .join("");

    expect(cached).toContain("## What you can do");
    const listed = [...cached.matchAll(/^- (.+?) (\d+)$/gm)].map((m) => [
      m[1],
      Number(m[2]),
    ]) as Array<[string, number]>;
    // 16, not 17: Languages has no single value and is listed separately, by
    // tongue, when the character has any.
    expect(listed).toHaveLength(16);
    expect(listed.map(([name]) => name)).not.toContain("Languages");
    expect(listed.map(([, v]) => v)).toEqual(
      [...listed.map(([, v]) => v)].sort((a, b) => b - a)
    );
  });

  it("shows the values the dice will actually use", () => {
    // Two sources for one number is how the prompt ends up promising
    // something the roll then contradicts, so this reads the intake's own
    // resolver rather than recomputing.
    const text = buildUserPrompt(
      makeCtx({
        npcProfile: {
          ...makeCtx().npcProfile,
          skills: { Social: 65 },
        },
      } as never),
      opts
    );
    expect(text).toContain("- Social 65");
    // Untrained domains fall back to the catalog's base, not to zero.
    expect(text).toContain("- Investigation 20");
  });

  it("keeps skills in the frozen block — no delta operation can change them", () => {
    const segments = buildUserPromptSegments(makeCtx(), opts);
    expect(segments[0].cache).toBe(true);
    expect(segments[0].text).toContain("## What you can do");
  });
});

describe("memory handles stay stable", () => {
  // Map and general memories share one block. Stored handles make a collision
  // harmless because the formatter never derives them from the rendered set.
  const colliding = [
    {
      id: "aaaaaaaa-0000-0000-0000-000000000001",
      handle: "Maaaaaaaa",
      type: "map",
      content: "The bakery is on Mill Street.",
      gameDateTime: "1923-04-01T00:00:00",
    },
    {
      id: "aaaaaaaa-0000-0000-0000-000000000002",
      handle: "Maaaaaaaa00",
      type: "general",
      content: "Hollins lied about the harbour.",
      gameDateTime: "1923-04-02T09:10:00",
    },
  ];

  it("prints each stored handle distinctly", () => {
    const text = buildUserPrompt(makeCtx({ memories: colliding }), opts);
    const handles = [...text.matchAll(/^- #(M[0-9a-f]+)/gm)].map((m) => m[1]);

    expect(handles).toEqual(["Maaaaaaaa", "Maaaaaaaa00"]);
    const cached = buildUserPromptSegments(
      makeCtx({ memories: colliding }),
      opts
    )
      .filter((s) => s.cache)
      .map((s) => s.text)
      .join("");
    expect(cached).not.toContain("#Maaaaaaaa ");
    expect(cached).not.toContain("Maaaaaaaa00");
  });
});

describe("the standing over memory", () => {
  // Two characters in two runs held only CORRECT memories and joined two of
  // them into a way that does not exist. Both then doubted their own heads.
  // The block has to say the memories may be stale AND that joining two of
  // them invents nothing.
  it("qualifies the memory block against live perception and against joining", () => {
    const text = buildUserPrompt(
      makeCtx({
        memories: [
          {
            id: "m1",
            handle: "M1",
            type: "map",
            content:
              "the lane from my gate reaches Main Street in twenty minutes",
            gameDateTime: "1923-04-01T09:00:00",
          },
        ],
      }),
      { language: "en", dgsm }
    );

    expect(text).toContain("## What you remember");
    expect(text).toContain("what you perceive is what is true");
    expect(text).toContain(
      "two things you remember separately do not join into one way"
    );
    // The memories themselves still follow the heading.
    expect(text).toContain("reaches Main Street in twenty minutes");
  });

  it("says nothing about memory when the character holds none", () => {
    const text = buildUserPrompt(makeCtx({ memories: [] }), {
      language: "en",
      dgsm,
    });
    expect(text).not.toContain("## What you remember");
    expect(text).not.toContain("do not join into one way");
  });
});
