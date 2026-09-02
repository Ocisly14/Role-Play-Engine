// The character consolidates their own memories, under their own prompt.
//
// Pinned: the ceiling fires only when the block is genuinely over budget; the
// prompt is the one they decide under with only the closing swapped and only
// `writeMemory` offered; and the pass is incremental — a call the dispatcher
// rejects fails alone while the rest land.

import { describe, expect, it, vi } from "vitest";
import { memoryHandle } from "../../memory/memoryHandle.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { RoleSimContext } from "../agent.js";

const generateToolCalls = vi.fn();
vi.mock("../../models/index.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../models/types.js"
  );
  return { ...actual, generateToolCalls };
});

const {
  CONSOLIDATION_WRITE_CAP,
  KEEP_RECENT_MEMORIES,
  MEMORY_BUDGET_TOKENS,
  consolidateMemories,
  memoryBlockTokens,
  needsConsolidation,
  protectedFromStamp,
} = await import("../memoryConsolidator.js");

const add = vi.fn(async (_row: unknown) => ({}));
const reviseOwn = vi.fn(async () => true);
const retractOwn = vi.fn(async () => true);
const memory = { add, reviseOwn, retractOwn } as never;

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
  updateRelationship: vi.fn(),
  getRelationship: () => undefined,
} as unknown as DynamicGameStateManager;

function uuid(i: number): string {
  const h = i.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${h}`;
}

/** `count` rows, oldest first, one minute apart, each `chars` ASCII chars. */
function rows(count: number, chars = 60) {
  return Array.from({ length: count }, (_, i) => {
    const id = uuid(i);
    return {
      id,
      handle: memoryHandle(id),
      type: "general",
      content: `m${i}-${"x".repeat(chars)}`,
      gameDateTime: `1923-04-02T${String(8 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00`,
    };
  });
}

function makeCtx(memories: ReturnType<typeof rows>): RoleSimContext {
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
    memories,
    perception: { narrative: "The lamp gutters.", location: "SCN_library" },
    recentPerceptions: [],
  } as unknown as RoleSimContext;
}

function run(memories: ReturnType<typeof rows>) {
  return consolidateMemories({
    ctx: makeCtx(memories),
    dgsm,
    memory,
    sessionId: "sess_1",
    moduleId: "mod_1",
    language: "en",
  });
}

describe("needsConsolidation", () => {
  it("stays out of the way at or below the keep window", () => {
    expect(needsConsolidation(rows(KEEP_RECENT_MEMORIES, 400_000))).toBe(false);
  });

  it("stays out of the way under the ceiling", () => {
    const list = rows(200);
    expect(memoryBlockTokens(list)).toBeLessThan(MEMORY_BUDGET_TOKENS);
    expect(needsConsolidation(list)).toBe(false);
  });

  it("fires once the block passes the ceiling", () => {
    const list = rows(400, 750);
    expect(memoryBlockTokens(list)).toBeGreaterThan(MEMORY_BUDGET_TOKENS);
    expect(needsConsolidation(list)).toBe(true);
  });
});

describe("protectedFromStamp", () => {
  it("is the stamp of the oldest of the newest KEEP_RECENT_MEMORIES rows", () => {
    const list = rows(KEEP_RECENT_MEMORIES + 5);
    // Passed shuffled: the boundary is by time, not by input order.
    const shuffled = [...list].reverse();
    expect(protectedFromStamp(shuffled)).toBe("1923-04-02 08:05");
  });
});

describe("consolidateMemories", () => {
  it("asks under the character's own prompt with only writeMemory on offer", async () => {
    generateToolCalls.mockReset();
    generateToolCalls.mockResolvedValueOnce({
      toolCalls: [
        {
          id: "c1",
          name: "writeMemory",
          args: { op: "delete", ref: memoryHandle(uuid(0)) },
        },
      ],
      assistantMessage: { role: "assistant", content: [] },
    });

    const list = rows(KEEP_RECENT_MEMORIES + 5);
    const result = await run(list);
    expect(result).toEqual({ applied: 1, skipped: 0, errors: [] });

    const args = generateToolCalls.mock.calls[0][0] as {
      tools: { name: string }[];
      toolChoice: unknown;
      allowParallelCalls: boolean;
      messages: { content: { text: string }[] }[];
    };
    expect(args.tools.map((t) => t.name)).toEqual(["writeMemory"]);
    expect(args.toolChoice).toBe("any");
    expect(args.allowParallelCalls).toBe(true);
    const prompt = args.messages[0].content.map((c) => c.text).join("");
    expect(prompt).toContain("# You are Marsh");
    expect(prompt).toContain("## What you remember");
    expect(prompt).toContain("## What you perceive now");
    expect(prompt).toContain(
      "## Bring what you remember down to what you can carry"
    );
    expect(prompt).not.toContain("## Decide");
    expect(prompt).toContain("`[1923-04-02 08:05]` or later");
  });

  it("applies every valid call and skips the bad ones alone", async () => {
    generateToolCalls.mockReset();
    retractOwn.mockClear();
    reviseOwn.mockClear();
    add.mockClear();
    const list = rows(KEEP_RECENT_MEMORIES + 5);
    generateToolCalls.mockResolvedValueOnce({
      toolCalls: [
        {
          id: "c1",
          name: "writeMemory",
          args: { op: "delete", ref: memoryHandle(uuid(0)) },
        },
        // A handle that was never in the prompt.
        { id: "c2", name: "writeMemory", args: { op: "delete", ref: "Mnope" } },
        {
          id: "c3",
          name: "writeMemory",
          args: {
            op: "replace",
            ref: memoryHandle(uuid(1)),
            content: "merged",
          },
        },
        // replace without content.
        {
          id: "c4",
          name: "writeMemory",
          args: { op: "replace", ref: memoryHandle(uuid(2)) },
        },
        {
          id: "c5",
          name: "writeMemory",
          args: { type: "general", content: "the week in one line" },
        },
        { id: "c6", name: "act", args: {} },
      ],
      assistantMessage: { role: "assistant", content: [] },
    });

    const result = await run(list);
    expect(result).not.toBeNull();
    expect(result?.applied).toBe(3);
    expect(result?.skipped).toBe(3);
    expect(retractOwn).toHaveBeenCalledTimes(1);
    expect(reviseOwn).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(add.mock.calls[0][0]).toMatchObject({
      npcId: "npc_1",
      sessionId: "sess_1",
      moduleId: "mod_1",
      content: "the week in one line",
    });
  });

  it("stops at the write cap", async () => {
    generateToolCalls.mockReset();
    retractOwn.mockClear();
    const list = rows(CONSOLIDATION_WRITE_CAP + 30);
    generateToolCalls.mockResolvedValueOnce({
      toolCalls: list.slice(0, CONSOLIDATION_WRITE_CAP + 10).map((m, i) => ({
        id: `c${i}`,
        name: "writeMemory",
        args: { op: "delete", ref: m.handle },
      })),
      assistantMessage: { role: "assistant", content: [] },
    });
    const result = await run(list);
    expect(result?.applied).toBe(CONSOLIDATION_WRITE_CAP);
    expect(result?.skipped).toBe(10);
    expect(retractOwn).toHaveBeenCalledTimes(CONSOLIDATION_WRITE_CAP);
  });

  it("keeps the full list when nothing lands", async () => {
    generateToolCalls.mockReset();
    generateToolCalls.mockResolvedValueOnce({
      toolCalls: [
        { id: "c1", name: "writeMemory", args: { op: "delete", ref: "Mnope" } },
      ],
      assistantMessage: { role: "assistant", content: [] },
    });
    expect(await run(rows(KEEP_RECENT_MEMORIES + 5))).toBeNull();
  });

  it("keeps the full list when the call throws", async () => {
    generateToolCalls.mockReset();
    generateToolCalls.mockRejectedValueOnce(new Error("upstream is down"));
    expect(await run(rows(KEEP_RECENT_MEMORIES + 5))).toBeNull();
  });
});
