import { vi } from "vitest";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { formatDayPrefix, summarizeDayMemory } from "../dailySummarization.js";

vi.mock("../../models/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../models/index.js")>(
    "../../models/index.js"
  );
  return {
    ...actual,
    generateText: vi.fn(async () =>
      JSON.stringify({
        memories: [{ content: "Mock summary", importance: 3 }],
      })
    ),
  };
});

interface ManagerCalls {
  add: Array<Record<string, unknown>>;
  events: Array<{
    type: string;
    content: string;
    gameDay: number;
    gameTime: string;
  }>;
}

function makeManager(opts?: {
  events?: Array<{
    type: string;
    content: string;
    gameDay: number;
    gameTime: string;
  }>;
}): { manager: NpcMemoryManager; calls: ManagerCalls } {
  const calls: ManagerCalls = { add: [], events: opts?.events ?? [] };
  const manager = {
    add: async (params: Record<string, unknown>) => {
      calls.add.push(params);
      return params;
    },
    getForDayByTypes: async () => calls.events,
  } as unknown as NpcMemoryManager;
  return { manager, calls };
}

function makeDgsm(opts?: {
  alive?: boolean;
  npc?: { id: string; name: string; occupation?: string; age?: number };
}): DynamicGameStateManager {
  const alive = opts?.alive ?? true;
  const npc = opts?.npc ?? { id: "npc1", name: "Alice" };
  return {
    isNpcAlive: () => alive,
    getState: () => ({ npcCharacters: [npc] }),
  } as unknown as DynamicGameStateManager;
}

describe("formatDayPrefix", () => {
  test("returns ISO date when startDate is a valid YYYY-MM-DD", () => {
    expect(formatDayPrefix(1, "1923-10-17")).toBe("[1923-10-17]");
    expect(formatDayPrefix(3, "1923-10-17")).toBe("[1923-10-19]");
  });

  test("falls back to [Day N] when startDate is missing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(formatDayPrefix(3)).toBe("[Day 3]");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("falls back to [Day N] when startDate is invalid", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(formatDayPrefix(2, "not-a-date")).toBe("[Day 2]");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("summarizeDayMemory", () => {
  test("skips dead NPCs", async () => {
    const { manager, calls } = makeManager({
      events: [{ type: "event", content: "x", gameDay: 1, gameTime: "08:00" }],
    });
    await summarizeDayMemory({
      dgsm: makeDgsm({ alive: false }),
      memoryManager: manager,
      sessionId: "s",
      moduleId: "m",
      npcId: "npc1",
      gameDay: 1,
      language: "en",
    });
    expect(calls.add.length).toBe(0);
  });

  test("skips NPCs without event memories", async () => {
    const { manager, calls } = makeManager({ events: [] });
    await summarizeDayMemory({
      dgsm: makeDgsm(),
      memoryManager: manager,
      sessionId: "s",
      moduleId: "m",
      npcId: "npc1",
      gameDay: 1,
      language: "en",
    });
    expect(calls.add.length).toBe(0);
  });

  test("writes only summary memories from LLM output", async () => {
    const { manager, calls } = makeManager({
      events: [
        {
          type: "event",
          content: "found a clue",
          gameDay: 1,
          gameTime: "10:00",
        },
      ],
    });
    await summarizeDayMemory({
      dgsm: makeDgsm(),
      memoryManager: manager,
      sessionId: "s",
      moduleId: "m",
      npcId: "npc1",
      gameDay: 1,
      language: "en",
      startDate: "1923-10-17",
    });
    expect(calls.add.length).toBe(1);
    expect(calls.add[0]).toMatchObject({
      type: "summary",
      content: "Mock summary",
      gameTime: "23:59",
    });
  });
});
