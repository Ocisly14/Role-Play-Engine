import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelProviderName } from "../../types.js";
import { DeepSeekAdapter, __testing } from "../deepseek.js";
import type { ModelMessage, ToolSpec } from "../types.js";

const {
  completionsUrl,
  readToolCalls,
  toWireMessages,
  toWireTool,
  toWireToolChoice,
} = __testing;

/** Captures the outgoing request and answers with a canned body. */
function stubFetch(body: unknown, init?: { ok?: boolean; status?: number }) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (url: string, options: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(options.body)) });
    return {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      statusText: "OK",
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("DeepSeek wire mapping", () => {
  it("expands a batch of tool results into one message per call id", () => {
    // DeepSeek follows OpenAI here; Anthropic requires the opposite. Collapsing
    // them into one message makes the NEXT request fail, not this one.
    const message: ModelMessage = {
      role: "tool",
      results: [
        { toolCallId: "call_a", content: "ok" },
        { toolCallId: "call_b", content: "also ok" },
      ],
    };

    expect(toWireMessages(message)).toEqual([
      { role: "tool", tool_call_id: "call_a", content: "ok" },
      { role: "tool", tool_call_id: "call_b", content: "also ok" },
    ]);
  });

  it("serializes assistant tool-call args back to a JSON string", () => {
    const [wire] = toWireMessages({
      role: "assistant",
      toolCalls: [{ id: "call_a", name: "damageRoll", args: { dice: "1d6" } }],
    });

    expect(wire.tool_calls?.[0].function).toEqual({
      name: "damageRoll",
      arguments: '{"dice":"1d6"}',
    });
  });

  it("omits assistant content entirely when there is no prose", () => {
    const [wire] = toWireMessages({ role: "assistant", toolCalls: [] });
    expect(wire).not.toHaveProperty("content");
  });

  it("maps both toolChoice forms", () => {
    expect(toWireToolChoice("any")).toBe("required");
    expect(toWireToolChoice({ name: "submit_resolution" })).toEqual({
      type: "function",
      function: { name: "submit_resolution" },
    });
    expect(toWireToolChoice(undefined)).toBeUndefined();
  });

  it("does not forward `strict` — DeepSeek defines no such field", () => {
    const tool: ToolSpec = {
      name: "act",
      description: "d",
      inputSchema: { type: "object", properties: {} },
      strict: true,
    };
    expect(JSON.stringify(toWireTool(tool))).not.toContain("strict");
  });

  it("repairs an argument string the model left broken", () => {
    // Cut off mid-object, trailing comma, raw newline in a string: the three
    // ways a long tool call actually breaks. All three are readable.
    expect(
      readToolCalls([
        {
          id: "c1",
          type: "function",
          function: { name: "act", arguments: "{" },
        },
      ])
    ).toEqual([{ id: "c1", name: "act", args: {} }]);
    expect(
      readToolCalls([
        {
          id: "c2",
          type: "function",
          function: { name: "act", arguments: '{"a": 1, "b": [2, 3,],}' },
        },
      ])[0].args
    ).toEqual({ a: 1, b: [2, 3] });
    expect(
      readToolCalls([
        {
          id: "c3",
          type: "function",
          function: { name: "act", arguments: '{"reason": "line\nbreak"}' },
        },
      ])[0].args
    ).toEqual({ reason: "line\nbreak" });
  });

  it("reports an argument string it cannot read, rather than passing off {}", () => {
    // Silently swallowing this is what let a quarter of one run's engine calls
    // arrive as empty submissions: the model was told it had answered nothing,
    // when what had actually happened was that nobody could read its answer.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls = readToolCalls([
      {
        id: "c1",
        type: "function",
        function: { name: "submit_resolution", arguments: "I'll submit now." },
      },
    ]);
    expect(calls[0].args).toEqual({});
    expect(calls[0].unreadableArgs).toEqual({ rawLength: 16 });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not be read as JSON")
    );
    warn.mockRestore();
  });

  it("treats an empty argument string as an empty call, not a broken one", () => {
    const calls = readToolCalls([
      { id: "c1", type: "function", function: { name: "act", arguments: "" } },
    ]);
    expect(calls[0].args).toEqual({});
    expect(calls[0].unreadableArgs).toBeUndefined();
  });

  it("joins a gateway base onto the path without doubling the slash", () => {
    // The base comes from env at module load, like every other provider's, so
    // this join is the only part of endpoint resolution a test can reach.
    expect(completionsUrl("https://gateway.internal/v1/")).toBe(
      "https://gateway.internal/v1/chat/completions"
    );
    expect(completionsUrl("https://gateway.internal/v1")).toBe(
      "https://gateway.internal/v1/chat/completions"
    );
    expect(completionsUrl(undefined)).toBe(
      "https://api.deepseek.com/v1/chat/completions"
    );
    // A base given without the version segment gets one rather than 404ing on
    // every call.
    expect(completionsUrl("https://gateway.internal")).toBe(
      "https://gateway.internal/v1/chat/completions"
    );
    expect(completionsUrl("https://gateway.internal/v2")).toBe(
      "https://gateway.internal/v2/chat/completions"
    );
  });

  it("drops non-function tool calls", () => {
    expect(
      readToolCalls([
        { id: "c1", type: "other", function: { name: "x", arguments: "{}" } },
      ])
    ).toEqual([]);
  });
});

describe("DeepSeekAdapter", () => {
  const adapter = new DeepSeekAdapter();

  beforeEach(() => {
    process.env.DEEPSEEK_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("declares itself as the deepseek provider", () => {
    expect(adapter.provider).toBe(ModelProviderName.DEEPSEEK);
  });

  it("posts to the configured endpoint with streaming off", async () => {
    const calls = stubFetch({ choices: [{ message: { content: "hi" } }] });

    const result = await adapter.chat({
      modelName: "deepseek-chat",
      system: [{ text: "you are ", cacheControl: true }, { text: "someone" }],
      content: [{ kind: "text", text: "hello" }],
      maxOutputTokens: 256,
      temperature: 0.7,
    });

    expect(result.text).toBe("hi");
    expect(calls[0].url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(calls[0].body).toMatchObject({
      model: "deepseek-chat",
      stream: false,
      max_tokens: 256,
      temperature: 0.7,
      // System blocks concatenate byte-identically; cacheControl is dropped
      // because DeepSeek has no explicit breakpoint.
      messages: [
        { role: "system", content: "you are someone" },
        { role: "user", content: "hello" },
      ],
    });
  });

  it("reads DeepSeek's cache-hit counter off a tool call", async () => {
    stubFetch({
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: {
                  name: "submit_resolution",
                  arguments: '{"ok":true}',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 30,
        prompt_cache_hit_tokens: 1216,
        prompt_cache_miss_tokens: 784,
      },
    });

    const result = await adapter.chatWithTools({
      modelName: "deepseek-chat",
      messages: [{ role: "user", content: [{ kind: "text", text: "go" }] }],
      tools: [{ name: "submit_resolution", description: "d", inputSchema: {} }],
      toolChoice: { name: "submit_resolution" },
    });

    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "submit_resolution", args: { ok: true } },
    ]);
    expect(result.usage?.cache_read_tokens).toBe(1216);
  });

  it("defaults parallel tool calls off", async () => {
    const calls = stubFetch({ choices: [{ message: { content: "" } }] });
    await adapter.chatWithTools({
      modelName: "deepseek-chat",
      messages: [{ role: "user", content: [{ kind: "text", text: "go" }] }],
      tools: [],
    });
    expect(calls[0].body.parallel_tool_calls).toBe(false);
  });

  it("names the status and body when the request fails", async () => {
    stubFetch(
      { error: { message: "Insufficient Balance" } },
      {
        ok: false,
        status: 402,
      }
    );

    await expect(
      adapter.chat({
        modelName: "deepseek-chat",
        content: [{ kind: "text", text: "x" }],
      })
    ).rejects.toThrow(/402.*Insufficient Balance/s);
  });

  it("throws on a 200 that carries an error object", async () => {
    // Otherwise this surfaces as an empty completion and the caller retries
    // three times against a request that will never succeed.
    stubFetch({ error: { message: "model not found" } });

    await expect(
      adapter.chat({
        modelName: "deepseek-chat",
        content: [{ kind: "text", text: "x" }],
      })
    ).rejects.toThrow(/model not found/);
  });

  it("fails loudly without an API key rather than sending a bare request", async () => {
    process.env.DEEPSEEK_API_KEY = "";
    await expect(
      adapter.chat({
        modelName: "deepseek-chat",
        content: [{ kind: "text", text: "x" }],
      })
    ).rejects.toThrow(/DEEPSEEK_API_KEY/);
  });

  it("sends a max_tokens even when the caller names none", async () => {
    // DeepSeek's own default is 4096 — a full world resolution runs off the
    // end of it and comes back as half-written JSON.
    const calls = stubFetch({ choices: [{ message: { content: "hi" } }] });
    await adapter.chat({
      modelName: "deepseek-chat",
      content: [{ kind: "text", text: "hello" }],
    });
    expect(calls[0].body.max_tokens).toBe(8192);
  });

  it("says so when the answer was cut at the output limit", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch({
      choices: [{ message: { content: "half a th" }, finish_reason: "length" }],
    });
    await adapter.chat({
      modelName: "deepseek-chat",
      content: [{ kind: "text", text: "hello" }],
      maxOutputTokens: 64,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("cut off"));
    warn.mockRestore();
  });

  it("throws on a 200 that carries no completion at all", async () => {
    stubFetch({ choices: [] });
    await expect(
      adapter.chat({
        modelName: "deepseek-chat",
        content: [{ kind: "text", text: "hello" }],
      })
    ).rejects.toThrow(/no completion/);
  });

  it("names an image input instead of dropping it", async () => {
    stubFetch({ choices: [{ message: { content: "hi" } }] });
    await expect(
      adapter.chat({
        modelName: "deepseek-chat",
        content: [
          { kind: "text", text: "what is this" },
          { kind: "image", data: "x", mimeType: "image/png" } as never,
        ],
      })
    ).rejects.toThrow(/Image inputs/);
  });

  it("refuses to embed instead of returning an empty vector", async () => {
    await expect(adapter.embed()).rejects.toThrow(/no embeddings endpoint/);
  });
});
