import { beforeEach, describe, expect, it, vi } from "vitest";

const chatWithTools = vi.fn();

vi.mock("../providers/index.js", () => ({
  getAdapter: () => ({
    provider: "anthropic",
    chat: vi.fn(),
    chatWithTools,
    embed: vi.fn(),
  }),
}));

const { generateToolCalls } = await import("../generator.js");
const { ModelClass, ModelProviderName } = await import("../types.js");

const tools = [
  { name: "act", description: "act", inputSchema: { type: "object" } },
];

describe("generateToolCalls", () => {
  beforeEach(() => chatWithTools.mockReset());

  it("returns the call's name and args", async () => {
    chatWithTools.mockResolvedValue({
      toolCalls: [{ id: "t1", name: "act", args: { actionText: "hi" } }],
      text: "",
      usage: null,
    });

    const result = await generateToolCalls({
      messages: [{ role: "user", content: [{ kind: "text", text: "go" }] }],
      tools,
      toolChoice: "any",
      modelClass: ModelClass.MEDIUM,
      providerOverride: ModelProviderName.ANTHROPIC,
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("act");
    expect(result.toolCalls[0].args).toEqual({ actionText: "hi" });
  });

  it("keeps only the first call when parallel was not requested", async () => {
    // Both providers hard-fail the NEXT request if an assistant turn holds a
    // tool call the following message does not answer. Observed live: the
    // model emitted parallel calls, the loop answered only the first, and
    // every subsequent request 400'd. Adapters disable parallel tool use, but
    // the history must stay valid even if a provider ignores that.
    chatWithTools.mockResolvedValue({
      toolCalls: [
        { id: "t1", name: "recallMemory", args: {} },
        { id: "t2", name: "getMapSnapshot", args: {} },
      ],
      text: "",
      usage: null,
    });

    const result = await generateToolCalls({
      messages: [{ role: "user", content: [{ kind: "text", text: "go" }] }],
      tools,
      toolChoice: "any",
      providerOverride: ModelProviderName.ANTHROPIC,
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("recallMemory");
    const assistant = result.assistantMessage;
    if (assistant.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.toolCalls).toHaveLength(1);
    expect(assistant.toolCalls[0].id).toBe("t1");
  });

  it("throws when the model returned no tool call", async () => {
    chatWithTools.mockResolvedValue({
      toolCalls: [],
      text: "I would rather explain myself in prose.",
      usage: null,
    });

    await expect(
      generateToolCalls({
        messages: [{ role: "user", content: [{ kind: "text", text: "go" }] }],
        tools,
        toolChoice: "any",
        maxRetries: 1,
        providerOverride: ModelProviderName.ANTHROPIC,
      })
    ).rejects.toThrow(/no tool call/i);
  });

  it("returns every call when parallel was requested", async () => {
    // The caller opted in, so it is on the hook for answering all of them.
    chatWithTools.mockResolvedValue({
      toolCalls: [
        { id: "t1", name: "recallMemory", args: { query: "a" } },
        { id: "t2", name: "recallMemory", args: { query: "b" } },
      ],
      text: "",
      usage: null,
    });

    const result = await generateToolCalls({
      messages: [{ role: "user", content: [{ kind: "text", text: "go" }] }],
      tools,
      toolChoice: "any",
      allowParallelCalls: true,
      providerOverride: ModelProviderName.ANTHROPIC,
    });

    expect(result.toolCalls).toHaveLength(2);
    const assistant = result.assistantMessage;
    if (assistant.role !== "assistant") throw new Error("expected assistant");
    expect(assistant.toolCalls.map((c) => c.id)).toEqual(["t1", "t2"]);
  });
});
