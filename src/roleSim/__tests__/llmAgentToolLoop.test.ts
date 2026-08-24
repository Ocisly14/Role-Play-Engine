import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "../../models/providers/types.js";

const generateToolCalls = vi.fn();
const dispatchInstantTool = vi.fn();

vi.mock("../../models/index.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../models/types.js"
  );
  return { ...actual, generateToolCalls };
});

vi.mock("../toolDispatcher.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../toolDispatcher.js"
  );
  return { ...actual, dispatchInstantTool };
});

const { LLMRoleSimAgent } = await import("../llmAgent.js");

/** One model turn: the calls it made, in provider shape. */
function turn(calls: Array<{ id: string; name: string; args?: object }>) {
  const toolCalls = calls.map((c) => ({ ...c, args: c.args ?? {} }));
  return {
    toolCalls,
    assistantMessage: { role: "assistant" as const, toolCalls },
  };
}

const ctx = {
  npcId: "npc_1",
  currentTime: "1923-04-02T09:15:00",
  currentScene: "SCN_a",
  npcProfile: {
    id: "npc_1",
    name: "Marsh",
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
} as never;

function makeAgent() {
  return new LLMRoleSimAgent({
    memory: {} as never,
    dgsm: {
      getState: () => ({
        npcInventories: {},
        npcRelationshipGraph: {},
        npcCharacters: [],
      }),
      getGameDateTime: () => "1923-04-02T09:15:00",
    } as never,
    sessionId: "s1",
    moduleId: "m1",
    language: "en",
  });
}

// The agent mutates its `messages` array in place, and vitest records
// arguments by reference — so a plain mock.calls read would show every call
// holding the FINAL array. Snapshot at call time instead.
const sent: ModelMessage[][] = [];

/** The messages the agent had sent by the Nth request. */
function messagesOnCall(n: number): ModelMessage[] {
  return sent[n];
}

/** Queues turns and snapshots the history each time the agent asks. */
function queueTurns(...turns: unknown[]) {
  let i = 0;
  generateToolCalls.mockImplementation(
    async (opts: { messages: unknown[] }) => {
      sent.push(structuredClone(opts.messages) as ModelMessage[]);
      return turns[i++];
    }
  );
}

describe("agent tool loop", () => {
  beforeEach(() => {
    generateToolCalls.mockReset();
    dispatchInstantTool.mockReset();
    sent.length = 0;
    dispatchInstantTool.mockResolvedValue({ result: "Found 2 memory(ies)." });
  });

  it("ends the decision on a clean terminal turn", async () => {
    queueTurns(
      turn([{ id: "t1", name: "act", args: { actionText: "[narrative]\nHi" } }])
    );

    const decision = await makeAgent().decideNext(ctx);

    expect(decision).toEqual({ tool: "act", actionText: "[narrative]\nHi" });
    expect(generateToolCalls).toHaveBeenCalledTimes(1);
  });

  it("answers every call in a parallel informational turn", async () => {
    queueTurns(
      turn([
        { id: "t1", name: "recallMemory", args: { query: "a" } },
        { id: "t2", name: "recallMemory", args: { query: "b" } },
      ]),
      turn([{ id: "t3", name: "continue" }])
    );

    await makeAgent().decideNext(ctx);

    expect(dispatchInstantTool).toHaveBeenCalledTimes(2);
    // Anthropic rejects the next request unless every tool_use from the
    // previous turn is answered — in ONE message.
    const second = messagesOnCall(1);
    const toolMessage = second.find((m) => m.role === "tool");
    if (toolMessage?.role !== "tool") throw new Error("expected tool results");
    expect(toolMessage.results.map((r) => r.toolCallId)).toEqual(["t1", "t2"]);
  });

  it("rejects a mixed turn without dropping the terminal call", async () => {
    // Rule B: the terminal call is reported as NOT executed rather than
    // silently discarded, so the model can resubmit it on its own turn.
    queueTurns(
      turn([
        { id: "t1", name: "recallMemory", args: { query: "a" } },
        { id: "t2", name: "act", args: { actionText: "too soon" } },
      ]),
      turn([{ id: "t3", name: "act", args: { actionText: "now" } }])
    );

    const decision = await makeAgent().decideNext(ctx);

    // The mixed turn did not terminate; the later clean turn did.
    expect(decision).toEqual({ tool: "act", actionText: "now" });
    expect(dispatchInstantTool).toHaveBeenCalledTimes(1);

    const toolMessage = messagesOnCall(1).find((m) => m.role === "tool");
    if (toolMessage?.role !== "tool") throw new Error("expected tool results");
    expect(toolMessage.results).toHaveLength(2);
    const actResult = toolMessage.results.find((r) => r.toolCallId === "t2");
    expect(actResult?.content).toMatch(/NOT executed/);
  });

  it("grows the history instead of rebuilding it", async () => {
    // The prefix must stay byte-identical across turns for the cache to hit.
    queueTurns(
      turn([{ id: "t1", name: "getMapSnapshot" }]),
      turn([{ id: "t2", name: "continue" }])
    );

    await makeAgent().decideNext(ctx);

    const first = messagesOnCall(0);
    const second = messagesOnCall(1);
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.length).toBe(first.length + 2);
  });
});
