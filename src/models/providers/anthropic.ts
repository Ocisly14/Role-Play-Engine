// src/models/providers/anthropic.ts

import Anthropic from "@anthropic-ai/sdk";
import { getEndpoint } from "../configuration.js";
import { normalizeUsageMetadata } from "../tokenUsage.js";
import { ModelProviderName } from "../types.js";
import type {
  ChatRequest,
  ChatResponse,
  ModelMessage,
  ProviderAdapter,
  SystemBlock,
  ToolChatRequest,
  ToolChatResponse,
} from "./types.js";

/**
 * Anthropic removed the sampling parameters (`temperature`, `top_p`, `top_k`)
 * on the Claude 4.6+ generation — sending any of them returns a 400
 * (`\`temperature\` is deprecated for this model`). Verified live:
 * claude-sonnet-5 rejects, claude-haiku-4-5 accepts.
 *
 * Matching is on the family prefix so dated snapshots (e.g.
 * `claude-sonnet-5-20260115`) are covered.
 */
export function rejectsSamplingParams(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized.startsWith("claude-opus-4-6") ||
    normalized.startsWith("claude-opus-4-7") ||
    normalized.startsWith("claude-opus-4-8") ||
    normalized.startsWith("claude-opus-5") ||
    normalized.startsWith("claude-sonnet-4-6") ||
    normalized.startsWith("claude-sonnet-5") ||
    normalized.startsWith("claude-fable-5") ||
    normalized.startsWith("claude-mythos-5")
  );
}

/**
 * The cap on the current generation (Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5),
 * and the default when a caller names no budget of its own. Which models
 * actually allow it is `configuration.ts`'s business — whatever arrives here
 * is sent as `max_tokens` unexamined, so a value above the model's own cap
 * comes back as a 400 rather than a shorter answer.
 *
 * This number is also why every call streams. The SDK refuses outright to
 * send a non-streaming request whose `max_tokens` could outrun the 10-minute
 * request timeout (`calculateNonstreamingTimeout`: the threshold works out at
 * ~21K tokens), and it is only the streaming path that keeps reading after
 * the headers arrive — `fetchWithTimeout` clears its abort timer once the
 * response resolves, so a long body is never cut off mid-generation.
 */
export const MAX_OUTPUT_TOKENS = 128000;

/**
 * The SDK appends its own `/v1/messages` to `baseURL`, so a configured
 * endpoint that already ends in `/v1` produces `/v1/v1/messages` and a 404 on
 * every call. (OpenAI is the opposite — its SDK expects `/v1` to be part of
 * baseURL — which is why only this provider trims.)
 */
export function normalizeBaseUrl(
  endpoint: string | undefined
): string | undefined {
  if (!endpoint) return undefined;
  return endpoint.replace(/\/+(v1)?\/*$/, "") || undefined;
}

function toSystemParam(
  system: SystemBlock[] | undefined
): Anthropic.Messages.MessageCreateParams["system"] {
  if (!system || system.length === 0) return undefined;
  return system.map((block) => ({
    type: "text" as const,
    text: block.text,
    ...(block.cacheControl
      ? { cache_control: { type: "ephemeral" as const } }
      : {}),
  }));
}

/**
 * Anthropic carries tool results as `tool_result` blocks inside a USER turn,
 * not a dedicated role — so a `tool` message becomes a user message here.
 */
function toAnthropicMessage(
  message: ModelMessage
): Anthropic.Messages.MessageParam {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: [
        ...(message.text
          ? [{ type: "text" as const, text: message.text }]
          : []),
        ...message.toolCalls.map((call) => ({
          type: "tool_use" as const,
          id: call.id,
          name: call.name,
          input: call.args,
        })),
      ],
    };
  }

  if (message.role === "tool") {
    // Every result in one user turn — Anthropic rejects the request if a
    // tool_use from the previous turn is not answered in the next message.
    return {
      role: "user",
      content: message.results.map((result) => ({
        type: "tool_result" as const,
        tool_use_id: result.toolCallId,
        content: result.content,
      })),
    };
  }

  return {
    role: "user",
    content: message.content.map((part) => {
      if (part.kind === "image") {
        throw new Error("Image inputs are not supported on the tool path.");
      }
      return {
        type: "text" as const,
        text: part.text,
        ...(part.cacheControl
          ? { cache_control: { type: "ephemeral" as const } }
          : {}),
      };
    }),
  };
}

export class AnthropicAdapter implements ProviderAdapter {
  readonly provider = ModelProviderName.ANTHROPIC;

  private client(): Anthropic {
    return new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: normalizeBaseUrl(getEndpoint(ModelProviderName.ANTHROPIC)),
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const textParts = req.content.filter((p) => p.kind === "text");
    if (textParts.length !== req.content.length) {
      throw new Error(
        "Image inputs are only supported for Google or OpenAI providers (received anthropic)."
      );
    }

    const content = textParts.map((part) => ({
      type: "text" as const,
      text: part.text,
      ...(part.cacheControl
        ? { cache_control: { type: "ephemeral" as const } }
        : {}),
    }));

    const stream = this.client().messages.stream({
      model: req.modelName,
      max_tokens: req.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
      system: toSystemParam(req.system),
      messages: [{ role: "user", content }],
      // Omitted entirely for 4.6+; sending it is a hard 400 there.
      ...(req.temperature !== undefined && !rejectsSamplingParams(req.modelName)
        ? { temperature: req.temperature }
        : {}),
    });

    if (req.onToken) {
      const emit = req.onToken;
      stream.on("text", (delta) => emit(delta));
    }

    // Awaiting the stream is also what registers a rejection handler on it,
    // so a mid-stream API error surfaces here instead of as an unhandled
    // rejection. Everything below reads the same assembled `Message` the
    // non-streaming call used to return.
    const response = await stream.finalMessage();

    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");

    return { text, usage: normalizeUsageMetadata(response.usage) };
  }

  async chatWithTools(req: ToolChatRequest): Promise<ToolChatResponse> {
    const stream = this.client().messages.stream({
      model: req.modelName,
      max_tokens: req.maxOutputTokens ?? MAX_OUTPUT_TOKENS,
      system: toSystemParam(req.system),
      messages: req.messages.map(toAnthropicMessage),
      tools: req.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Messages.Tool.InputSchema,
        ...(tool.strict ? { strict: true } : {}),
      })) as Anthropic.Messages.ToolUnion[],
      // Parallel calls are opt-in: whoever allows them must answer every
      // returned call, or the next request 400s on the unanswered tool_use.
      ...(req.toolChoice
        ? {
            tool_choice:
              req.toolChoice === "any"
                ? {
                    type: "any" as const,
                    disable_parallel_tool_use: !req.allowParallelCalls,
                  }
                : {
                    type: "tool" as const,
                    name: req.toolChoice.name,
                    disable_parallel_tool_use: !req.allowParallelCalls,
                  },
          }
        : {}),
      ...(req.temperature !== undefined && !rejectsSamplingParams(req.modelName)
        ? { temperature: req.temperature }
        : {}),
    });

    const response = await stream.finalMessage();

    const toolCalls = response.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id,
        name: block.name,
        args: (block.input ?? {}) as Record<string, unknown>,
      }));

    const text = response.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");

    return { toolCalls, text, usage: normalizeUsageMetadata(response.usage) };
  }

  async embed(): Promise<number[]> {
    throw new Error("Anthropic does not provide an embeddings endpoint.");
  }
}
