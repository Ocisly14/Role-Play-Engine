// src/models/providers/deepseek.ts
//
// DeepSeek, spoken directly.
//
// DeepSeek's wire format is OpenAI-shaped, and the obvious move is to point
// the `openai` SDK at their base URL. This adapter deliberately doesn't. The
// shapes agree until they don't — usage counters are already reported under
// DeepSeek's own names, `strict` is not a field DeepSeek defines, and the
// reasoner family adds `reasoning_content` — and every one of those
// divergences would arrive as a silently wrong value rather than a type
// error. Owning the request means each difference is a line of code here with
// a reason next to it, and it means the OpenAI adapter can change (or the SDK
// major-bump) without a second vendor riding along on its assumptions.
//
// The cost of owning it is small: one JSON POST, no streaming (`onToken` is
// wired for Google alone — see generator.ts), and no embeddings.

import { getEndpoint } from "../configuration.js";
import { normalizeUsageMetadata } from "../tokenUsage.js";
import { ModelProviderName } from "../types.js";
import type {
  ChatRequest,
  ChatResponse,
  ContentPart,
  ModelMessage,
  ProviderAdapter,
  SystemBlock,
  ToolCallRecord,
  ToolChatRequest,
  ToolChatResponse,
  ToolSpec,
} from "./types.js";

const CHAT_COMPLETIONS_PATH = "/chat/completions";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

/** Joins the configured base onto the completions path. Split out from the
 *  adapter because the base is read from env at module load (like every other
 *  provider's), so this is the only part a test can reach. */
function completionsUrl(base: string | undefined): string {
  return `${(base ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}${CHAT_COMPLETIONS_PATH}`;
}

/** How much of an error body to quote back. Enough to name the cause, short
 *  enough that a retry loop's logs stay readable. */
const ERROR_BODY_LIMIT = 500;

// ─── Wire shapes ───────────────────────────────────────────────────
// Only the fields this adapter reads or writes. Anything DeepSeek adds that
// we don't name is ignored rather than mistranslated.

interface WireToolCall {
  id: string;
  type: string;
  function: { name: string; arguments: string };
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: WireToolCall[];
}

interface WireResponse {
  choices?: Array<{
    message?: { content?: string | null; tool_calls?: WireToolCall[] };
  }>;
  usage?: unknown;
  error?: { message?: string };
}

type WireToolChoice =
  | "required"
  | { type: "function"; function: { name: string } };

// ─── Request construction ──────────────────────────────────────────

/**
 * DeepSeek caches long prefixes automatically and exposes no explicit
 * breakpoint, so `cacheControl` flags are read and dropped here — the same
 * treatment OpenAI gets. The blocks still concatenate byte-identically to the
 * single string a caller would otherwise have passed.
 */
function systemMessage(blocks: SystemBlock[] | undefined): WireMessage | null {
  if (!blocks || blocks.length === 0) return null;
  return { role: "system", content: blocks.map((b) => b.text).join("") };
}

/** Images never reach this adapter — `buildContentParts` rejects them for any
 *  provider but Google and OpenAI — so non-text parts are dropped rather than
 *  guessed at. */
function flattenContent(parts: ContentPart[]): string {
  return parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
}

/**
 * DeepSeek follows OpenAI in wanting one `role: "tool"` message per
 * tool_call_id, so a batch of results expands into several messages. (Anthropic
 * requires the opposite — all results in one message — which is exactly the
 * kind of difference each adapter is here to own.)
 */
function toWireMessages(message: ModelMessage): WireMessage[] {
  if (message.role === "tool") {
    return message.results.map((result) => ({
      role: "tool" as const,
      tool_call_id: result.toolCallId,
      content: result.content,
    }));
  }

  if (message.role === "assistant") {
    return [
      {
        role: "assistant" as const,
        ...(message.text ? { content: message.text } : {}),
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      },
    ];
  }

  return [{ role: "user" as const, content: flattenContent(message.content) }];
}

/**
 * `strict` is intentionally not forwarded: it is an OpenAI extension DeepSeek
 * does not define, and sending an undefined field to get schema enforcement
 * that isn't there would be worse than not asking. The envelope guarantee
 * comes from `toolChoice` either way — see the note on `ToolSpec.strict`.
 */
function toWireTool(tool: ToolSpec) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toWireToolChoice(
  choice: ToolChatRequest["toolChoice"]
): WireToolChoice | undefined {
  if (!choice) return undefined;
  if (choice === "any") return "required";
  return { type: "function", function: { name: choice.name } };
}

// ─── Response reading ──────────────────────────────────────────────

function readToolCalls(calls: WireToolCall[] | undefined): ToolCallRecord[] {
  return (calls ?? []).flatMap((call) => {
    if (call.type !== "function") return [];
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      // A malformed argument string must not take down the whole turn; the
      // caller sees an empty-args call and can reject it on its own terms.
      args = {};
    }
    return [{ id: call.id, name: call.function.name, args }];
  });
}

export class DeepSeekAdapter implements ProviderAdapter {
  readonly provider = ModelProviderName.DEEPSEEK;

  private endpoint(): string {
    return completionsUrl(getEndpoint(ModelProviderName.DEEPSEEK));
  }

  /**
   * The one place a request leaves the process. Errors are thrown with the
   * status and a slice of the body: `runWithPolicy` retries on any throw and
   * logs the message, so a 401 that reads "401 Unauthorized" instead of
   * "Invalid API key" costs three retries and a provider fallback to find out.
   */
  private async post(body: Record<string, unknown>): Promise<WireResponse> {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("DEEPSEEK_API_KEY is not set.");
    }

    const response = await fetch(this.endpoint(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ ...body, stream: false }),
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(
        0,
        ERROR_BODY_LIMIT
      );
      throw new Error(
        `DeepSeek request failed (${response.status} ${response.statusText})${
          detail ? `: ${detail}` : ""
        }`
      );
    }

    const parsed = (await response.json()) as WireResponse;
    // A 200 carrying an `error` object is rarer than a non-2xx but just as
    // fatal, and it would otherwise surface as an empty completion.
    if (parsed.error) {
      throw new Error(
        `DeepSeek returned an error: ${parsed.error.message ?? "unknown"}`
      );
    }
    return parsed;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages: WireMessage[] = [];
    const system = systemMessage(req.system);
    if (system) messages.push(system);
    messages.push({ role: "user", content: flattenContent(req.content) });

    const response = await this.post({
      model: req.modelName,
      messages,
      ...(req.maxOutputTokens !== undefined
        ? { max_tokens: req.maxOutputTokens }
        : {}),
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
    });

    return {
      text: response.choices?.[0]?.message?.content ?? "",
      usage: normalizeUsageMetadata(response.usage),
    };
  }

  async chatWithTools(req: ToolChatRequest): Promise<ToolChatResponse> {
    const messages: WireMessage[] = [];
    const system = systemMessage(req.system);
    if (system) messages.push(system);
    messages.push(...req.messages.flatMap(toWireMessages));

    const toolChoice = toWireToolChoice(req.toolChoice);
    const response = await this.post({
      model: req.modelName,
      messages,
      tools: req.tools.map(toWireTool),
      // Opt-in, and the caller must then answer every returned call or the
      // next request fails — same contract as the other two adapters.
      parallel_tool_calls: req.allowParallelCalls === true,
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      ...(req.maxOutputTokens !== undefined
        ? { max_tokens: req.maxOutputTokens }
        : {}),
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
    });

    const message = response.choices?.[0]?.message;
    return {
      toolCalls: readToolCalls(message?.tool_calls),
      text: message?.content ?? "",
      usage: normalizeUsageMetadata(response.usage),
    };
  }

  async embed(): Promise<number[]> {
    // DeepSeek serves no embeddings endpoint. This is unreachable through
    // `rag/embedding.ts`, which routes every non-Google remote fallback to
    // OpenAI — but the interface demands the method, and a silent empty
    // vector would poison a similarity search rather than fail it.
    throw new Error(
      "DeepSeek has no embeddings endpoint; use the local embedder or OpenAI."
    );
  }
}

export const __testing = {
  completionsUrl,
  flattenContent,
  readToolCalls,
  systemMessage,
  toWireMessages,
  toWireTool,
  toWireToolChoice,
};
