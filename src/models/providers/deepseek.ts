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

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseJsonResponse } from "../../engine/shared/jsonParse.js";
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
export function completionsUrl(base: string | undefined): string {
  const trimmed = (base ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  // A gateway base given without the version segment would otherwise POST to
  // `<host>/chat/completions` and 404 on every call. Anthropic's adapter trims
  // a `/v1` the SDK adds for itself; this is the same repair from the other
  // side — the version belongs in the path exactly once.
  const versioned = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  return `${versioned}${CHAT_COMPLETIONS_PATH}`;
}

/** How much of an error body to quote back. Enough to name the cause, short
 *  enough that a retry loop's logs stay readable. */
const ERROR_BODY_LIMIT = 500;

/** DeepSeek's own default is 4096 — low enough that a full world resolution
 *  runs off the end of it and arrives as unparseable half-JSON. Every other
 *  adapter names a default rather than letting the vendor pick one (Anthropic:
 *  `max_tokens: req.maxOutputTokens ?? 8192`), so this one does too. */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

/** No timeout at all is what a bare `fetch` gives you: a connection that
 *  stalls holds the tick forever, and the retry policy above never gets its
 *  turn because nothing ever throws. Matches the Anthropic SDK's own default. */
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

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
    /** "stop" | "length" | "tool_calls" | "content_filter" | "insufficient_system_resource". */
    finish_reason?: string;
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
/** The first rewrite `parseJsonResponse` performs — mirrored here so the
 *  reported offset and the quoted window count the same characters. */
function repairedForReading(text: string): string {
  return text.trim().replace(/\\([^"\\/bfnrtu])/g, "$1");
}

/**
 * The 200 characters around wherever the parser gave up. The head and tail of
 * a broken argument string are almost always well-formed — a resolution opens
 * `{"starting": [...` and closes `...]}` even when something in the middle is
 * unreadable — so quoting the ends says nothing about the break. V8 puts the
 * offset in the message ("... at position 1234"); when it doesn't, fall back
 * to the head.
 */
function describeBreak(text: string, failure: string): string {
  const at = failure.match(/position (\d+)/);
  if (!at) return `head: ${JSON.stringify(text.slice(0, 200))}`;
  const pos = Number(at[1]);
  const from = Math.max(0, pos - 100);
  return `around it: ${JSON.stringify(text.slice(from, pos + 100))}`;
}

/** The exact bytes the parser gave up on, saved beside the traces so a broken
 *  argument string can be read whole instead of through a 200-character
 *  window. Only when `LLM_TRACE_DIR` is already collecting. */
function saveBrokenArgs(toolName: string, text: string): string {
  const dir = process.env.LLM_TRACE_DIR;
  if (!dir) return "";
  try {
    const file = path.join(dir, `broken-args-${Date.now()}-${toolName}.txt`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text, "utf8");
    return ` Full string: ${file}`;
  } catch {
    return "";
  }
}

function readToolCallArgs(
  toolName: string,
  raw: string | undefined
): { args: Record<string, unknown>; unreadableArgs?: { rawLength: number } } {
  const text = raw ?? "";
  if (text.trim() === "") return { args: {} };
  let failure = "";
  try {
    const parsed = parseJsonResponse<unknown>(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown> };
    }
    failure = "parsed, but not into an object";
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
  }
  console.warn(
    // The window is cut from `repairedForReading`, not from `text`:
    // `parseJsonResponse` rewrites the string before parsing it, so the
    // offset in the parser's message counts characters in ITS copy. Slicing
    // the raw string by that offset drifts by however much the rewrite
    // removed — which put four of nineteen reported breaks in the middle of
    // a key name, and made the diagnosis of the other fifteen guesswork.
    `[deepseek] tool call "${toolName}": ${text.length} characters of arguments could not be read as JSON — ${failure}. ${describeBreak(repairedForReading(text), failure)}${saveBrokenArgs(toolName, text)}`
  );
  return { args: {}, unreadableArgs: { rawLength: text.length } };
}

/**
 * `finish_reason: "length"` means the answer was cut at the token budget. Left
 * unreported it looks exactly like a model that wrote broken JSON — which is
 * how a run can spend a quarter of its engine calls on unreadable arguments
 * without anything in the log saying "you ran out of room".
 */
function warnIfTruncated(
  response: WireResponse,
  maxOutputTokens?: number
): void {
  if (response.choices?.[0]?.finish_reason !== "length") return;
  console.warn(
    `[deepseek] answer was cut off at the output limit (max_tokens=${
      maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS
    }) — whatever it was writing is incomplete.`
  );
}

function readToolCalls(calls: WireToolCall[] | undefined): ToolCallRecord[] {
  return (calls ?? []).flatMap((call) => {
    if (call.type !== "function") return [];
    return [
      {
        id: call.id,
        name: call.function.name,
        ...readToolCallArgs(call.function.name, call.function.arguments),
      },
    ];
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

    let response: Response;
    try {
      response = await fetch(this.endpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ ...body, stream: false }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // A timeout arrives here as a bare `TimeoutError`, which says nothing
      // about who timed out. Name the provider and the budget so the retry
      // log is readable.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `DeepSeek request failed before a response (${detail}) — timeout is ${REQUEST_TIMEOUT_MS / 1000}s`
      );
    }

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
    // Same reasoning one step further: a 200 with no choice at all is a failed
    // call, and returning "" from it spends the caller's turn on nothing. A
    // throw is what puts the retry policy back in play.
    if (!parsed.choices?.[0]?.message) {
      throw new Error("DeepSeek returned no completion (empty `choices`).");
    }
    return parsed;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Named rather than dropped, exactly as the Anthropic adapter does it: a
    // silently discarded image is a request the caller thinks it made.
    if (req.content.some((part) => part.kind !== "text")) {
      throw new Error(
        "Image inputs are only supported for Google or OpenAI providers (received deepseek)."
      );
    }

    const messages: WireMessage[] = [];
    const system = systemMessage(req.system);
    if (system) messages.push(system);
    messages.push({ role: "user", content: flattenContent(req.content) });

    const response = await this.post({
      model: req.modelName,
      messages,
      max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
    });
    warnIfTruncated(response, req.maxOutputTokens);

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
      // Asked for, not relied on: DeepSeek honours `tool_choice` most of the
      // time and ignores it the rest — measured, it answered a round that
      // demanded `repair_resolution` with `submit_resolution` instead. A
      // caller that must have one specific tool has to tolerate the other.
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      ...(req.temperature !== undefined
        ? { temperature: req.temperature }
        : {}),
    });
    warnIfTruncated(response, req.maxOutputTokens);

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
