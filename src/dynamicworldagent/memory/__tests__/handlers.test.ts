import { describe, it, expect } from "vitest";
import type { NpcMemory } from "@prisma/client";
import { getAllHandlers, getHandler } from "../handlers/index.js";

// ===== Helper =====

function makeMemory(overrides: Partial<NpcMemory> = {}): NpcMemory {
  return {
    id: "mem-1",
    sessionId: "sess-1",
    moduleId: "mod-1",
    npcId: "npc-1",
    type: "event",
    content: "Test content",
    metadata: null,
    tags: [],
    gameDay: 1,
    gameTime: "10:00",
    location: null,
    importance: 1.0,
    baseImportance: 1.0,
    accessCount: 0,
    lastAccessedAt: new Date("2024-01-01T10:00:00Z"),
    embedding: null,
    createdAt: new Date("2024-01-01T10:00:00Z"),
    updatedAt: new Date("2024-01-01T10:00:00Z"),
    decayRateMultiplier: 1.0,
    ...overrides,
  } as unknown as NpcMemory;
}

// ===== Tests =====

describe("getAllHandlers", () => {
  it("returns exactly 9 handlers", () => {
    const handlers = getAllHandlers();
    const keys = Object.keys(handlers);
    expect(keys).toHaveLength(9);
    expect(keys.sort()).toEqual([
      "belief",
      "emotion",
      "event",
      "information",
      "plan",
      "relationship",
      "secret",
      "summary",
      "witness",
    ]);
  });
});

// ===== EventHandler =====

describe("EventHandler", () => {
  const handler = getHandler("event");

  it("has type 'event'", () => {
    expect(handler.type).toBe("event");
  });

  it("prepare returns baseImportance 1.0 and includes 'event' tag", () => {
    const result = handler.prepare("Searched the library", {}, "library");
    expect(result.baseImportance).toBe(1.0);
    expect(result.tags).toContain("event");
    expect(result.tags).toContain("library");
  });

  it("prepare without location only has 'event' tag", () => {
    const result = handler.prepare("Something happened");
    expect(result.tags).toEqual(["event"]);
  });

  it("format returns correct prefix with day/time", () => {
    const mem = makeMemory({ type: "event", content: "Searched the library", gameDay: 1, gameTime: "10:00" });
    expect(handler.format(mem)).toBe("[event] Day1 10:00 - Searched the library");
  });

  it("does not have customDecayRate", () => {
    expect(handler.customDecayRate).toBeUndefined();
  });
});

// ===== WitnessHandler =====

describe("WitnessHandler", () => {
  const handler = getHandler("witness");

  it("has type 'witness'", () => {
    expect(handler.type).toBe("witness");
  });

  it("prepare returns baseImportance 2.0 and includes witness + location + sourceCharacterId tags", () => {
    const result = handler.prepare("Saw John steal", { sourceCharacterId: "john-1" }, "market");
    expect(result.baseImportance).toBe(2.0);
    expect(result.tags).toContain("witness");
    expect(result.tags).toContain("market");
    expect(result.tags).toContain("john-1");
  });

  it("prepare without sourceCharacterId omits it from tags", () => {
    const result = handler.prepare("Saw something", {}, "alley");
    expect(result.tags).toEqual(["witness", "alley"]);
  });

  it("format returns correct prefix with day/time", () => {
    const mem = makeMemory({ type: "witness", content: "Saw John steal", gameDay: 1, gameTime: "10:00" });
    expect(handler.format(mem)).toBe("[witness] Day1 10:00 - Saw John steal");
  });

  it("does not have customDecayRate", () => {
    expect(handler.customDecayRate).toBeUndefined();
  });
});

// ===== InformationHandler =====

describe("InformationHandler", () => {
  const handler = getHandler("information");

  it("has type 'information'", () => {
    expect(handler.type).toBe("information");
  });

  it("prepare returns baseImportance 3.0 and includes information + location + knowledgeId tags", () => {
    const result = handler.prepare("Ritual requires dagger", { knowledgeId: "know-42" }, "library");
    expect(result.baseImportance).toBe(3.0);
    expect(result.tags).toContain("information");
    expect(result.tags).toContain("library");
    expect(result.tags).toContain("know-42");
  });

  it("format omits day/time (bare information format)", () => {
    const mem = makeMemory({ type: "information" as any, content: "Ritual requires dagger", gameDay: 1, gameTime: "10:00" });
    expect(handler.format(mem)).toBe("[information] Ritual requires dagger");
  });

  it("customDecayRate returns 0.5 (slow decay)", () => {
    expect(handler.customDecayRate!()).toBe(0.5);
  });
});

// ===== BeliefHandler =====

describe("BeliefHandler", () => {
  const handler = getHandler("belief");

  it("has type 'belief'", () => {
    expect(handler.type).toBe("belief");
  });

  it("prepare returns baseImportance 2.5 and includes belief + location tags", () => {
    const result = handler.prepare("John is suspicious", { confidence: 0.7, reasoningChain: "because X" }, "office");
    expect(result.baseImportance).toBe(2.5);
    expect(result.tags).toContain("belief");
    expect(result.tags).toContain("office");
  });

  it("format includes confidence and reasoning", () => {
    const mem = makeMemory({
      type: "belief",
      content: "John is suspicious",
      metadata: { confidence: 0.7, reasoningChain: "because X" },
    });
    const formatted = handler.format(mem);
    expect(formatted).toContain("[belief] John is suspicious (confidence: 0.7)");
    expect(formatted).toContain("Reasoning: because X");
  });

  it("format works without reasoning chain", () => {
    const mem = makeMemory({
      type: "belief",
      content: "Something is off",
      metadata: { confidence: 0.5 },
    });
    const formatted = handler.format(mem);
    expect(formatted).toBe("[belief] Something is off (confidence: 0.5)");
  });

  it("customDecayRate returns 0.5 (slow decay)", () => {
    expect(handler.customDecayRate!()).toBe(0.5);
  });
});

// ===== EmotionHandler =====

describe("EmotionHandler", () => {
  const handler = getHandler("emotion");

  it("has type 'emotion'", () => {
    expect(handler.type).toBe("emotion");
  });

  it("prepare returns baseImportance 2.0 and includes emotion + location tags", () => {
    const result = handler.prepare("Afraid after seeing creature", { emotionType: "fear", intensity: 3 }, "basement");
    expect(result.baseImportance).toBe(2.0);
    expect(result.tags).toContain("emotion");
    expect(result.tags).toContain("basement");
  });

  it("format includes emotionType and intensity", () => {
    const mem = makeMemory({
      type: "emotion",
      content: "Afraid after seeing creature",
      metadata: { emotionType: "fear", intensity: 3 },
    });
    expect(handler.format(mem)).toBe("[emotion] fear (intensity: 3): Afraid after seeing creature");
  });

  it("customDecayRate returns 2.0 (fast decay)", () => {
    expect(handler.customDecayRate!()).toBe(2.0);
  });
});

// ===== PlanHandler =====

describe("PlanHandler", () => {
  const handler = getHandler("plan");

  it("has type 'plan'", () => {
    expect(handler.type).toBe("plan");
  });

  it("prepare returns baseImportance 1.5 and includes plan + location tags", () => {
    const result = handler.prepare("Plan to investigate library", { planType: "daily" }, "office");
    expect(result.baseImportance).toBe(1.5);
    expect(result.tags).toContain("plan");
    expect(result.tags).toContain("office");
  });

  it("format includes planType", () => {
    const mem = makeMemory({
      type: "plan",
      content: "Plan to investigate library",
      metadata: { planType: "daily" },
    });
    expect(handler.format(mem)).toBe("[plan:daily] Plan to investigate library");
  });

  it("format defaults to 'daily' when planType missing", () => {
    const mem = makeMemory({
      type: "plan",
      content: "Do something",
      metadata: {},
    });
    expect(handler.format(mem)).toBe("[plan:daily] Do something");
  });

  it("format works with long_term planType", () => {
    const mem = makeMemory({
      type: "plan",
      content: "Uncover the cult",
      metadata: { planType: "long_term" },
    });
    expect(handler.format(mem)).toBe("[plan:long_term] Uncover the cult");
  });

  it("customDecayRate returns 1.5 (fast decay)", () => {
    expect(handler.customDecayRate!()).toBe(1.5);
  });
});

// ===== SecretHandler =====

describe("SecretHandler", () => {
  const handler = getHandler("secret");

  it("has type 'secret'", () => {
    expect(handler.type).toBe("secret");
  });

  it("prepare returns baseImportance 3.0 and includes secret + location tags", () => {
    const result = handler.prepare("I killed the professor", {}, "study");
    expect(result.baseImportance).toBe(3.0);
    expect(result.tags).toContain("secret");
    expect(result.tags).toContain("study");
  });

  it("prepare without location only has 'secret' tag", () => {
    const result = handler.prepare("Hidden truth");
    expect(result.tags).toEqual(["secret"]);
  });

  it("format returns correct prefix", () => {
    const mem = makeMemory({ type: "secret", content: "I killed the professor" });
    expect(handler.format(mem)).toBe("[secret] I killed the professor");
  });

  it("customDecayRate returns 0.3 (slowest decay)", () => {
    expect(handler.customDecayRate!()).toBe(0.3);
  });
});
