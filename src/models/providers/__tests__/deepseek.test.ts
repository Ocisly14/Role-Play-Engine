import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelProviderName } from "../../types.js";
import { DeepSeekAdapter, __testing } from "../deepseek.js";
import type { ModelMessage } from "../types.js";

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

  it("sends a tool strict even when the caller did not ask for it", () => {
    // `ToolSpec.strict` records an Anthropic constraint, not a contract:
    // submit_effects is false there only because that compiler refuses its
    // anyOf branches. DeepSeek has no such ceiling, so the flag is ignored.
    const wire = toWireTool({
      name: "submit_effects",
      description: "d",
      strict: false,
      inputSchema: {
        type: "object",
        properties: {
          occurrences: { type: "array", items: { type: "string" } },
        },
        required: [],
      },
    });

    expect(wire.function.strict).toBe(true);
    expect(wire.function.parameters).toEqual({
      type: "object",
      properties: {
        occurrences: {
          anyOf: [
            { type: "array", items: { type: "string" } },
            { type: "null" },
          ],
        },
      },
      required: ["occurrences"],
      additionalProperties: false,
    });
  });

  it("honours noGrammar even on a schema it could perfectly well compile", () => {
    // The agent tools carry this: a grammar can only spell their optional
    // strings as required-plus-nullable, and the model then writes `""`.
    const wire = toWireTool({
      name: "act",
      description: "d",
      noGrammar: true,
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string" },
          skillId: { type: "string" },
        },
        required: ["description"],
      },
    });
    expect(wire.function).not.toHaveProperty("strict");
    // Untouched, not merely unflagged — no nullable rewrite either.
    expect(wire.function.parameters).toEqual({
      type: "object",
      properties: {
        description: { type: "string" },
        skillId: { type: "string" },
      },
      required: ["description"],
    });
  });

  it("leaves a schema that declares nothing unstrict rather than 400ing", () => {
    // DeepSeek needs `type`/`anyOf`/`$ref` on every node, the root included.
    // One request is all-or-nothing, so an inexpressible tool sent strict
    // would take the expressible ones down with it.
    const inputSchema = {};
    const wire = toWireTool({ name: "noop", description: "d", inputSchema });
    expect(wire.function).not.toHaveProperty("strict");
    expect(wire.function.parameters).toBe(inputSchema);
  });

  it("forwards `strict` with the schema rewritten into DeepSeek's subset", () => {
    // DeepSeek validates the schema server-side and 400s the whole request on
    // an optional property or a `minItems`, so sending the flag beside the
    // caller's schema would fail every strict call rather than constrain it.
    const wire = toWireTool({
      name: "submit_actions",
      description: "d",
      strict: true,
      inputSchema: {
        type: "object",
        properties: {
          actionId: { type: "string" },
          route: { type: "array", items: { type: "string" }, minItems: 1 },
        },
        required: ["actionId"],
      },
    });

    expect(wire.function.strict).toBe(true);
    expect(wire.function.parameters).toEqual({
      type: "object",
      properties: {
        actionId: { type: "string" },
        route: {
          anyOf: [
            { type: "array", items: { type: "string" } },
            { type: "null" },
          ],
        },
      },
      required: ["actionId", "route"],
      additionalProperties: false,
    });
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

  it("swaps the version segment for /beta when a strict tool is in play", () => {
    // `strict` is honoured on the beta channel and rejected on the general
    // one, so the channel is derived rather than configured.
    expect(completionsUrl(undefined, "beta")).toBe(
      "https://api.deepseek.com/beta/chat/completions"
    );
    expect(completionsUrl("https://api.deepseek.com/v1", "beta")).toBe(
      "https://api.deepseek.com/beta/chat/completions"
    );
    expect(completionsUrl("https://gateway.internal/", "beta")).toBe(
      "https://gateway.internal/beta/chat/completions"
    );
    // Already pointed at beta: one segment, not two.
    expect(completionsUrl("https://api.deepseek.com/beta", "beta")).toBe(
      "https://api.deepseek.com/beta/chat/completions"
    );
    expect(completionsUrl("https://api.deepseek.com/beta")).toBe(
      "https://api.deepseek.com/beta/chat/completions"
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

  it("keeps thinking on and asks rather than demands a tool", async () => {
    // Thinking mode 400s a forced `tool_choice`, and a small model needs the
    // reasoning far more than the callers need the guarantee: with thinking
    // off, flash answered a speech-only tick correctly 2 times in 5 and
    // submitted an empty resolution the rest. `auto` is accepted alongside
    // thinking, so the choice is downgraded instead of the model.
    const calls = stubFetch({ choices: [{ message: { content: "" } }] });
    await adapter.chatWithTools({
      modelName: "deepseek-v4-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "go" }] }],
      tools: [{ name: "act", description: "d", inputSchema: {} }],
      toolChoice: "any",
    });
    expect(calls[0].body.tool_choice).toBe("auto");
    // Never sent: the vendor default (thinking on) is the point.
    expect(calls[0].body).not.toHaveProperty("thinking");
  });

  it("downgrades a NAMED tool choice too — thinking refuses that one alike", async () => {
    const calls = stubFetch({ choices: [{ message: { content: "" } }] });
    await adapter.chatWithTools({
      modelName: "deepseek-v4-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "go" }] }],
      tools: [{ name: "submitWeather", description: "d", inputSchema: {} }],
      toolChoice: { name: "submitWeather" },
    });
    expect(calls[0].body.tool_choice).toBe("auto");
  });

  it("sends no tool_choice at all when the caller named none", async () => {
    const calls = stubFetch({ choices: [{ message: { content: "" } }] });
    await adapter.chatWithTools({
      modelName: "deepseek-v4-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "go" }] }],
      tools: [{ name: "act", description: "d", inputSchema: {} }],
    });
    expect(calls[0].body).not.toHaveProperty("tool_choice");
  });

  it("stays on the general endpoint when no tool can carry a grammar", async () => {
    // Beta exists here only to honour `strict`. Nothing to constrain, no
    // reason to depend on a beta channel.
    const calls = stubFetch({ choices: [{ message: { content: "" } }] });
    await adapter.chatWithTools({
      modelName: "deepseek-v4-flash",
      messages: [{ role: "user", content: [{ kind: "text", text: "go" }] }],
      tools: [{ name: "damageRoll", description: "d", inputSchema: {} }],
    });
    expect(calls[0].url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(JSON.stringify(calls[0].body)).not.toContain("strict");
  });

  it("moves a request carrying a strict tool to the beta endpoint", async () => {
    // The general endpoint rejects `strict`, so the presence of a strict tool
    // is what routes the call — no env var, no operator step.
    const calls = stubFetch({ choices: [{ message: { content: "" } }] });
    await adapter.chatWithTools({
      modelName: "deepseek-chat",
      messages: [{ role: "user", content: [{ kind: "text", text: "go" }] }],
      tools: [
        { name: "damageRoll", description: "d", inputSchema: {} },
        {
          name: "submit_actions",
          description: "d",
          strict: true,
          inputSchema: {
            type: "object",
            properties: {
              starting: { type: "array", items: { type: "string" } },
            },
            required: ["starting"],
          },
        },
      ],
    });

    expect(calls[0].url).toBe("https://api.deepseek.com/beta/chat/completions");
    const tools = calls[0].body.tools as Array<{
      function: { name: string; strict?: boolean };
    }>;
    // Only the tool that asked for it — a code tool riding along stays plain.
    expect(tools.map((t) => t.function.strict)).toEqual([undefined, true]);
  });

  it("strips the nulls the grammar forced, from every tool it constrained", async () => {
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
                  name: "submit_actions",
                  arguments:
                    '{"starting":[{"actionId":"a1","check":null,"movement":null}],"ending":null}',
                },
              },
              {
                id: "call_2",
                type: "function",
                function: {
                  name: "submit_effects",
                  arguments: '{"occurrences":null}',
                },
              },
            ],
          },
        },
      ],
    });

    const result = await adapter.chatWithTools({
      modelName: "deepseek-chat",
      messages: [{ role: "user", content: [{ kind: "text", text: "go" }] }],
      allowParallelCalls: true,
      tools: [
        {
          name: "submit_actions",
          description: "d",
          strict: true,
          inputSchema: {
            type: "object",
            properties: {
              starting: { type: "array", items: { type: "object" } },
            },
            required: ["starting"],
          },
        },
        {
          // Asks for NO grammar and gets one anyway — that is the policy.
          name: "submit_effects",
          description: "d",
          strict: false,
          inputSchema: {
            type: "object",
            properties: {
              occurrences: { type: "array", items: { type: "object" } },
            },
            required: ["occurrences"],
          },
        },
      ],
    });

    // Both halves come back looking exactly like Anthropic's answer: both were
    // constrained, so every null in them was the grammar's doing, not the
    // model's.
    expect(result.toolCalls[0].args).toEqual({
      starting: [{ actionId: "a1" }],
    });
    expect(result.toolCalls[1].args).toEqual({});
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
