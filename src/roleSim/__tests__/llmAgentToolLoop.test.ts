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
const { PLAYER_SYSTEM_PROMPT, SYSTEM_PROMPT } = await import(
  "../systemPrompt.js"
);
const { AGENT_TOOLS, PLAYER_DELEGATED_TOOLS } = await import(
  "../tools/schemas.js"
);

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
  memories: [],
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
      getNpcProfile: () => undefined,
      getCharacterSpot: () => null,
      getScene: () => undefined,
      getTopology: () => ({ junctions: new Map(), roads: new Map() }),
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
    dispatchInstantTool.mockResolvedValue({ result: "Remembered (general)." });
  });

  it("ends the decision on a clean terminal turn", async () => {
    queueTurns(
      turn([
        {
          id: "t1",
          name: "act",
          args: {
            description: "I greet the room.",
            objectRefs: [],
            proposedDurationTicks: 1,
            utterance: "Hi",
          },
        },
      ])
    );

    const decision = await makeAgent().decideNext(ctx);

    expect(decision).toEqual({
      tool: "act",
      description: "I greet the room.",
      objectRefs: [],
      proposedDurationTicks: 1,
      skillId: undefined,
      utterance: "Hi",
    });
    expect(generateToolCalls).toHaveBeenCalledTimes(1);
  });

  it("answers every call on a turn that failed to terminate", async () => {
    queueTurns(
      turn([
        {
          id: "t1",
          name: "writeMemory",
          args: { type: "general", content: "a" },
        },
        {
          id: "t2",
          name: "writeMemory",
          args: { type: "general", content: "b" },
        },
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

  it("lets writeMemory ride along with the terminal call — no extra round trip", async () => {
    // Memory is agent-authored now: recording must not cost the character a
    // turn, or it will simply stop writing.
    queueTurns(
      turn([
        {
          id: "t1",
          name: "writeMemory",
          args: { type: "general", content: "Hollins lied about the harbor." },
        },
        {
          id: "t2",
          name: "act",
          args: {
            description: "I press him further.",
            objectRefs: [],
            proposedDurationTicks: 1,
          },
        },
      ])
    );

    const decision = await makeAgent().decideNext(ctx);

    expect(decision).toMatchObject({
      tool: "act",
      description: "I press him further.",
    });
    // The write executed...
    expect(dispatchInstantTool).toHaveBeenCalledTimes(1);
    expect(dispatchInstantTool.mock.calls[0][0]).toBe("writeMemory");
    // ...and the decision still ended in ONE request.
    expect(generateToolCalls).toHaveBeenCalledTimes(1);
  });

  it("does not let an unknown tool block the terminal call", async () => {
    // The dispatcher whitelist is the guard; a stray name must not cost the
    // character its tick.
    queueTurns(
      turn([
        { id: "t1", name: "getMapSnapshot", args: {} },
        {
          id: "t2",
          name: "act",
          args: {
            description: "I keep walking.",
            objectRefs: [],
            proposedDurationTicks: 1,
          },
        },
      ])
    );

    const decision = await makeAgent().decideNext(ctx);

    expect(decision).toMatchObject({ tool: "act" });
    expect(dispatchInstantTool).not.toHaveBeenCalled();
    expect(generateToolCalls).toHaveBeenCalledTimes(1);
  });

  it("grows the history instead of rebuilding it", async () => {
    // The prefix must stay byte-identical across turns for the cache to hit.
    queueTurns(
      turn([
        {
          id: "t1",
          name: "writeMemory",
          args: { type: "general", content: "the harbour was empty" },
        },
      ]),
      turn([{ id: "t2", name: "continue" }])
    );

    await makeAgent().decideNext(ctx);

    const first = messagesOnCall(0);
    const second = messagesOnCall(1);
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.length).toBe(first.length + 2);
  });
});

describe("the player character's delegated mode", () => {
  const delegatedCtx = {
    ...(ctx as Record<string, unknown>),
    player: { mode: "delegated", friendLog: [] },
  } as never;

  /** What the agent asked the model with on its Nth request. */
  function requestOn(n: number): { customSystemPrompt: string; tools: unknown } {
    return generateToolCalls.mock.calls[n][0];
  }

  beforeEach(() => {
    generateToolCalls.mockReset();
    dispatchInstantTool.mockReset();
    sent.length = 0;
    dispatchInstantTool.mockResolvedValue({ result: "Remembered (general)." });
  });

  it("ends the decision on askFriend and returns the question", async () => {
    queueTurns(
      turn([
        { id: "t1", name: "askFriend", args: { question: "要告诉他吗？" } },
      ])
    );

    const decision = await makeAgent().decideNext(delegatedCtx);

    expect(decision).toEqual({ tool: "askFriend", question: "要告诉他吗？" });
    expect(generateToolCalls).toHaveBeenCalledTimes(1);
  });

  it("asks with the player prompt and the player tools", async () => {
    queueTurns(turn([{ id: "t1", name: "continue" }]));

    await makeAgent().decideNext(delegatedCtx);

    expect(requestOn(0).customSystemPrompt).toBe(PLAYER_SYSTEM_PROMPT);
    expect(requestOn(0).tools).toBe(PLAYER_DELEGATED_TOOLS);
  });

  it("an NPC is asked exactly as before", async () => {
    queueTurns(turn([{ id: "t1", name: "continue" }]));

    await makeAgent().decideNext(ctx);

    expect(requestOn(0).customSystemPrompt).toBe(SYSTEM_PROMPT);
    expect(requestOn(0).tools).toBe(AGENT_TOOLS);
  });

  it("a player in manual mode is not offered the delegated set", async () => {
    queueTurns(turn([{ id: "t1", name: "continue" }]));

    await makeAgent().decideNext({
      ...(ctx as Record<string, unknown>),
      player: { mode: "manual" },
    } as never);

    expect(requestOn(0).customSystemPrompt).toBe(SYSTEM_PROMPT);
    expect(requestOn(0).tools).toBe(AGENT_TOOLS);
  });

  it("an NPC cannot end its decision on askFriend — it is an unknown tool", async () => {
    queueTurns(
      turn([{ id: "t1", name: "askFriend", args: { question: "?" } }]),
      turn([{ id: "t2", name: "continue" }])
    );

    const decision = await makeAgent().decideNext(ctx);

    expect(decision).toMatchObject({ tool: "continue" });
    expect(generateToolCalls).toHaveBeenCalledTimes(2);
    expect(dispatchInstantTool).not.toHaveBeenCalled();
    const toolMessage = messagesOnCall(1).find((m) => m.role === "tool");
    if (toolMessage?.role !== "tool") throw new Error("expected tool results");
    expect(toolMessage.results).toEqual([
      { toolCallId: "t1", content: 'Error: unknown tool "askFriend".' },
    ]);
  });

  it("passes sleep through only when it is the boolean true", async () => {
    const act = (sleep: unknown) =>
      turn([
        {
          id: "t1",
          name: "act",
          args: {
            description: "I lie down for the night.",
            objectRefs: [],
            proposedDurationTicks: 5,
            sleep,
          },
        },
      ]);

    queueTurns(act(true));
    const slept = await makeAgent().decideNext(delegatedCtx);
    expect(slept).toMatchObject({ tool: "act", sleep: true });

    generateToolCalls.mockReset();
    queueTurns(act("yes"));
    const notSlept = await makeAgent().decideNext(delegatedCtx);
    expect(notSlept).not.toHaveProperty("sleep");
  });
});
