import { afterEach, expect, it, vi } from "vitest";
import { GoogleAdapter } from "../google.js";
import type { ToolChatRequest } from "../types.js";

afterEach(() => vi.unstubAllGlobals());

it("replays Gemini's signed parts and returns IDs for parallel tool results", async () => {
  const parts = [
    {
      functionCall: { id: "call_a", name: "inspect", args: { item: "cup" } },
      thoughtSignature: "opaque-provider-signature",
    },
    {
      functionCall: { id: "call_b", name: "inspect", args: { item: "plate" } },
    },
  ];
  const payloads: unknown[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    payloads.push(JSON.parse(String(init.body)));
    return new Response(
      JSON.stringify({
        candidates: [
          { content: { role: "model", parts }, finishReason: "STOP" },
        ],
      })
    );
  });
  vi.stubGlobal("fetch", fetch);

  const adapter = new GoogleAdapter();
  const request: ToolChatRequest = {
    modelName: "gemini-4-hydrogen",
    messages: [
      { role: "user", content: [{ kind: "text", text: "Inspect the table." }] },
    ],
    tools: [
      {
        name: "inspect",
        description: "Inspect an item.",
        inputSchema: {
          type: "object",
          properties: { item: { type: "string" } },
        },
      },
    ],
    toolChoice: { name: "inspect" },
    allowParallelCalls: true,
  };
  const result = await adapter.chatWithTools(request);
  expect(result.toolCalls.map((call) => call.id)).toEqual(["call_a", "call_b"]);
  expect(payloads[0]).toMatchObject({
    tools: [
      {
        functionDeclarations: [
          {
            name: "inspect",
            parametersJsonSchema: request.tools[0].inputSchema,
          },
        ],
      },
    ],
    toolConfig: {
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["inspect"] },
    },
  });

  await adapter.chatWithTools({
    ...request,
    messages: [
      ...request.messages,
      {
        role: "assistant",
        toolCalls: result.toolCalls,
        geminiParts: result.geminiParts,
      },
      {
        role: "tool",
        results: [
          { toolCallId: "call_a", content: "white" },
          { toolCallId: "call_b", content: "blue" },
        ],
      },
    ],
  });
  expect(payloads[1]).toMatchObject({
    contents: [
      { role: "user" },
      { role: "model", parts },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call_a",
              name: "inspect",
              response: { output: "white" },
            },
          },
          {
            functionResponse: {
              id: "call_b",
              name: "inspect",
              response: { output: "blue" },
            },
          },
        ],
      },
    ],
  });
});
