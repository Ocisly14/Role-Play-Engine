// src/roleSim/__tests__/userPromptBuilder.test.ts

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { RoleSimContext } from "../agent.js";
import { buildUserPrompt } from "../userPromptBuilder.js";

function makeCtx(overrides: Partial<RoleSimContext> = {}): RoleSimContext {
  return {
    npcId: "npc1",
    currentTime: "1923-10-17T08:15:00",
    npcProfile: {
      id: "npc1",
      name: "Alice",
      attributes: {
        STR: 50,
        CON: 50,
        DEX: 50,
        APP: 50,
        POW: 50,
        SIZ: 50,
        INT: 50,
        EDU: 50,
      },
      status: {
        hp: 12,
        maxHp: 12,
        san: 50,
        maxSan: 50,
        fatigue: 0,
        maxFatigue: 100,
        luck: 50,
        conditions: [],
      },
      inventory: [],
      skills: {},
      longTermIntent: "",
      relationships: [],
    },
    currentScene: "library",
    recentMemory: [],
    longTermIntent: "",
    perception: { narrative: "You are in Library." },
    ...overrides,
  };
}

function makeDgsm(): DynamicGameStateManager {
  return {
    getState: () => ({
      npcInventories: {},
      npcRelationshipGraph: {},
      npcCharacters: [],
    }),
  } as unknown as DynamicGameStateManager;
}

describe("buildUserPrompt", () => {
  test("includes always-on sections", () => {
    const out = buildUserPrompt(makeCtx(), [], {
      language: "en",
      dgsm: makeDgsm(),
    });
    expect(out).toContain("# You are Alice");
    expect(out).toContain("## Who you are");
    expect(out).toContain("## Right now");
    expect(out).toContain("1923-10-17 08:15");
    expect(out).toContain("Scene: library");
    expect(out).toContain("## What you perceive");
    expect(out).toContain("You are in Library.");
    expect(out).toContain("## Decide");
  });

  test("omits 'Currently doing' when no currentAction", () => {
    const out = buildUserPrompt(makeCtx(), [], {
      language: "en",
      dgsm: makeDgsm(),
    });
    expect(out).not.toContain("## Currently doing");
  });

  test("includes 'Currently doing' when currentAction set", () => {
    const ctx = makeCtx({
      currentAction: { actionText: "reading the journal" },
    });
    const out = buildUserPrompt(ctx, [], { language: "en", dgsm: makeDgsm() });
    expect(out).toContain("## Currently doing");
    expect(out).toContain('"reading the journal"');
  });

  test("omits 'Today's memories' when empty", () => {
    const out = buildUserPrompt(makeCtx(), [], {
      language: "en",
      dgsm: makeDgsm(),
    });
    expect(out).not.toContain("## Today's memories");
  });

  test("includes 'Today's memories' when populated", () => {
    const ctx = makeCtx({
      recentMemory: [
        {
          type: "event",
          content: "saw a stranger by the well",
          gameDateTime: "1923-10-17T07:42:00",
        },
      ],
    });
    const out = buildUserPrompt(ctx, [], { language: "en", dgsm: makeDgsm() });
    expect(out).toContain("## Today's memories");
    expect(out).toContain("- [07:42] (event) saw a stranger by the well");
  });

  test("omits 'Tool calls so far' when transcript empty", () => {
    const out = buildUserPrompt(makeCtx(), [], {
      language: "en",
      dgsm: makeDgsm(),
    });
    expect(out).not.toContain("## Tool calls so far this decision");
  });

  test("includes transcript when populated", () => {
    const transcript = [
      `→ Called: {"tool":"recallMemory","query":"smith"}`,
      `← Result: No memories matched.`,
    ];
    const out = buildUserPrompt(makeCtx(), transcript, {
      language: "en",
      dgsm: makeDgsm(),
    });
    expect(out).toContain("## Tool calls so far this decision");
    expect(out).toContain(`→ Called: {"tool":"recallMemory","query":"smith"}`);
    expect(out).toContain("← Result: No memories matched.");
  });

  test("language switch: en", () => {
    const out = buildUserPrompt(makeCtx(), [], {
      language: "en",
      dgsm: makeDgsm(),
    });
    expect(out).toContain("Write content in English");
  });

  test("language switch: zh", () => {
    const out = buildUserPrompt(makeCtx(), [], {
      language: "zh",
      dgsm: makeDgsm(),
    });
    expect(out).toContain("Write content in Chinese");
  });

  test("language switch: zh-CN matches Chinese", () => {
    const out = buildUserPrompt(makeCtx(), [], {
      language: "zh-CN",
      dgsm: makeDgsm(),
    });
    expect(out).toContain("Write content in Chinese");
  });

  test("includes longTermIntent section when set", () => {
    const ctx = makeCtx({ longTermIntent: "Find the truth." });
    const out = buildUserPrompt(ctx, [], { language: "en", dgsm: makeDgsm() });
    expect(out).toContain("## Your long-term goal");
    expect(out).toContain("Find the truth.");
  });

  test("omits longTermIntent section when empty", () => {
    const out = buildUserPrompt(makeCtx(), [], {
      language: "en",
      dgsm: makeDgsm(),
    });
    expect(out).not.toContain("## Your long-term goal");
  });
});
