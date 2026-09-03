// src/models/providers/openai.ts

import OpenAI from "openai";
import { parseJsonResponse } from "../../engine/shared/jsonParse.js";
import { getEndpoint } from "../configuration.js";
import { normalizeUsageMetadata } from "../tokenUsage.js";
import { ModelProviderName } from "../types.js";
import type {
  ChatRequest,
  ChatResponse,
  ModelMessage,
  ProviderAdapter,
  ToolChatRequest,
  ToolChatResponse,
} from "./types.js";

/**
 * The reasoning-model family fixes `temperature` and takes the output cap as
 * `max_completion_tokens` rather than `max_tokens`.
 */
export function isFixedParameterModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  );
}

/**
 * OpenAI wants one `role: "tool"` message per tool_call_id, so a batch of
 * results expands into several messages (Anthropic collapses them into one
 * instead — see that adapter).
 */
function toOpenAIMessages(
  message: ModelMessage
): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (message.role === "tool") {
    return message.results.map((result) => ({
      role: "tool" as const,
      tool_call_id: result.toolCallId,
      content: result.content,
    }));
  }
  return [toOpenAIMessage(message)];
}

function toOpenAIMessage(
  message: ModelMessage
): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      ...(message.text ? { content: message.text } : {}),
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    };
  }

  if (message.role === "tool") {
    // Unreachable: toOpenAIMessages intercepts this variant.
    throw new Error("tool results must go through toOpenAIMessages");
  }

  return {
    role: "user",
    content: message.content
      .map((p) => (p.kind === "text" ? p.text : ""))
      .join(""),
  };
}

/**
 * Read a provider's tool-call argument string. A bare `JSON.parse` is not
 * enough: models emit trailing commas, bare newlines inside strings and, when
 * a generation stops early, an unclosed object — `parseJsonResponse` repairs
 * all three, and the engine already reads model JSON through it elsewhere.
 *
 * A string that survives none of that is reported, never swallowed: `args`
 * stays empty but `unreadableArgs` says so, and the warning carries enough of
 * the raw text to see what the provider actually sent.
 */
function readToolCallArgs(
  toolName: string,
  raw: string | undefined
): { args: Record<string, unknown>; unreadableArgs?: { rawLength: number } } {
  const text = raw ?? "";
  if (text.trim() === "") return { args: {} };
  try {
    const parsed = parseJsonResponse<unknown>(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> };
    }
  } catch {
    // Fall through to the report below.
  }
  console.warn(
    `[openai] tool call "${toolName}": ${text.length} characters of arguments could not be read as JSON — head: ${JSON.stringify(text.slice(0, 200))} … tail: ${JSON.stringify(text.slice(-200))}`
  );
  return { args: {}, unreadableArgs: { rawLength: text.length } };
}

export class OpenAIAdapter implements ProviderAdapter {
  readonly provider = ModelProviderName.OPENAI;

  private client(): OpenAI {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: getEndpoint(ModelProviderName.OPENAI),
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // OpenAI caches long prefixes automatically; it has no explicit
    // breakpoint, so cacheControl flags are simply not rendered here.
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];

    if (req.system && req.system.length > 0) {
      messages.push({
        role: "system",
        content: req.system.map((b) => b.text).join(""),
      });
    }

    const hasImages = req.content.some((p) => p.kind === "image");
    if (hasImages) {
      messages.push({
        role: "user",
        content: req.content.map((part) =>
          part.kind === "text"
            ? { type: "text" as const, text: part.text }
            : { type: "image_url" as const, image_url: { url: part.dataUrl } }
        ),
      });
    } else {
      messages.push({
        role: "user",
        content: req.content
          .map((p) => (p.kind === "text" ? p.text : ""))
          .join(""),
      });
    }

    const fixed = isFixedParameterModel(req.modelName);
    const response = await this.client().chat.completions.create({
      model: req.modelName,
      messages,
      ...(req.maxOutputTokens !== undefined
        ? fixed
          ? { max_completion_tokens: req.maxOutputTokens }
          : { max_tokens: req.maxOutputTokens }
        : {}),
      ...(req.temperature !== undefined && !fixed
        ? { temperature: req.temperature }
        : {}),
    });

    return {
      text: response.choices[0]?.message?.content ?? "",
      usage: normalizeUsageMetadata(response.usage),
    };
  }

  async chatWithTools(req: ToolChatRequest): Promise<ToolChatResponse> {
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    if (req.system && req.system.length > 0) {
      messages.push({
        role: "system",
        content: req.system.map((b) => b.text).join(""),
      });
    }
    messages.push(...req.messages.flatMap(toOpenAIMessages));

    const fixed = isFixedParameterModel(req.modelName);
    const response = await this.client().chat.completions.create({
      model: req.modelName,
      messages,
      tools: req.tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
          // OpenAI's strict mode is narrower than Anthropic's: every property
          // must be required. A tool that asks for strict but has optional
          // fields (the engine tools) is sent unstrict rather than 400ing.
          ...(tool.strict && allPropertiesRequired(tool.inputSchema)
            ? { strict: true }
            : {}),
        },
      })),
      // See the Anthropic adapter: opt-in, and the caller must then answer
      // every returned call or the next request fails.
      parallel_tool_calls: req.allowParallelCalls === true,
      ...(req.toolChoice
        ? {
            tool_choice:
              req.toolChoice === "any"
                ? ("required" as const)
                : {
                    type: "function" as const,
                    function: { name: req.toolChoice.name },
                  },
          }
        : {}),
      ...(req.maxOutputTokens !== undefined
        ? fixed
          ? { max_completion_tokens: req.maxOutputTokens }
          : { max_tokens: req.maxOutputTokens }
        : {}),
      ...(req.temperature !== undefined && !fixed
        ? { temperature: req.temperature }
        : {}),
    });

    const choice = response.choices[0]?.message;
    const toolCalls = (choice?.tool_calls ?? []).flatMap((call) => {
      if (call.type !== "function") return [];
      return [
        {
          id: call.id,
          name: call.function.name,
          ...readToolCallArgs(call.function.name, call.function.arguments),
        },
      ];
    });

    return {
      toolCalls,
      text: choice?.content ?? "",
      usage: normalizeUsageMetadata(response.usage),
    };
  }

  async embed(
    text: string,
    modelName: string,
    dimensions?: number
  ): Promise<number[]> {
    const response = await this.client().embeddings.create({
      model: modelName,
      input: text,
      ...(dimensions !== undefined ? { dimensions } : {}),
    });
    return response.data[0]?.embedding ?? [];
  }
}

/** OpenAI's strict-mode precondition: in every object of the schema, every
 *  property is listed under `required`. Anthropic has no such rule. */
export function allPropertiesRequired(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return true;
  if (Array.isArray(schema)) return schema.every(allPropertiesRequired);
  const o = schema as Record<string, unknown>;
  if (o.type === "object" && o.properties && typeof o.properties === "object") {
    const props = Object.keys(o.properties as Record<string, unknown>);
    const required = new Set((o.required as string[] | undefined) ?? []);
    if (!props.every((p) => required.has(p))) return false;
  }
  return Object.values(o).every(allPropertiesRequired);
}
