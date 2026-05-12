/// <reference types="vitest/globals" />
import { vi } from "vitest";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { formatDatePrefix, summarizeDayMemory } from "../dailySummarization.js";

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
    gameDateTime: string;
  }>;
}

function makeManager(opts?: {
  events?: Array<{
    type: string;
    content: string;
    gameDateTime: string;
  }>;
}): { manager: NpcMemoryManager; calls: ManagerCalls } {
  const calls: ManagerCalls = { add: [], events: opts?.events ?? [] };
  const manager = {
    add: async (params: Record<string, unknown>) => {
      calls.add.push(params);
      return params;
    },
    getForDateByTypes: async () => calls.events,
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

describe("formatDatePrefix", () => {
  test("returns ISO date prefix when gameDate is a valid YYYY-MM-DD", () => {
    expect(formatDatePrefix("1923-10-17")).toBe("[1923-10-17]");
    expect(formatDatePrefix("1923-10-19")).toBe("[1923-10-19]");
  });
});

describe("summarizeDayMemory", () => {
  test("skips dead NPCs", async () => {
    const { manager, calls } = makeManager({
      events: [
        {
          type: "event",
          content: "x",
          gameDateTime: "1923-10-17T08:00:00",
        },
      ],
    });
    await summarizeDayMemory({
      dgsm: makeDgsm({ alive: false }),
      memoryManager: manager,
      sessionId: "s",
      moduleId: "m",
      npcId: "npc1",
      gameDate: "1923-10-17",
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
      gameDate: "1923-10-17",
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
          gameDateTime: "1923-10-17T10:00:00",
        },
      ],
    });
    await summarizeDayMemory({
      dgsm: makeDgsm(),
      memoryManager: manager,
      sessionId: "s",
      moduleId: "m",
      npcId: "npc1",
      gameDate: "1923-10-17",
      language: "en",
    });
    expect(calls.add.length).toBe(1);
    expect(calls.add[0]).toMatchObject({
      type: "summary",
      content: "Mock summary",
      gameDateTime: "1923-10-17T23:59:00",
    });
  });
});
