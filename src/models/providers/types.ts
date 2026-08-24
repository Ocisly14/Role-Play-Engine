// src/models/providers/types.ts
//
// The provider boundary. An adapter knows exactly one thing: how to talk to
// one vendor's API. It does NOT know about retries, model-class fallback, or
// usage accounting — those are policy and live in the runner (generator.ts),
// so they are written once instead of three times.

import type { TokenUsageTotals } from "../tokenUsage.js";
import type { ModelProviderName } from "../types.js";

/**
 * One block of a system prompt. `cacheControl` requests a provider-native
 * prompt-cache breakpoint at the end of this block, caching everything before
 * it (tool definitions included, since those render ahead of the system
 * prompt). Providers without explicit breakpoints ignore it.
 */
export interface SystemBlock {
  text: string;
  cacheControl?: boolean;
}

/**
 * One piece of user-turn content. Text carries an optional cache breakpoint;
 * images are passed through to providers that accept them.
 */
export type ContentPart =
  | { kind: "text"; text: string; cacheControl?: boolean }
  | { kind: "image"; dataUrl: string };

export interface ChatRequest {
  modelName: string;
  system?: SystemBlock[];
  /** Currently always a single user turn. Sub-project 2 extends this to a
   *  full assistant/tool history for the agent loop. */
  content: ContentPart[];
  maxOutputTokens?: number;
  /** Adapters drop this for models whose API rejects sampling parameters. */
  temperature?: number;
  /** When set, the adapter streams and reports text as it arrives. */
  onToken?: (token: string) => void;
}

export interface ChatResponse {
  text: string;
  /** Raw usage as reported by the provider, normalized to our shape. Null when
   *  the provider returned none. */
  usage: TokenUsageTotals | null;
}

/** One tool the model may call. `inputSchema` is plain JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * Ask the provider to validate arguments against the schema exactly.
   *
   * Off by default: OpenAI's strict mode requires EVERY property to appear in
   * `required`, so any tool with a genuinely optional field cannot use it.
   * Enable only on schemas where all properties are required. The envelope
   * guarantee comes from `toolChoice`, not from this.
   */
  strict?: boolean;
}

export interface ToolCallRecord {
  /** Provider-assigned id, echoed back on the matching tool result. */
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * A turn in a tool-using conversation. The agent loop appends an `assistant`
 * turn and its `tool` results after each round, so the prefix grows
 * monotonically.
 */
export type ModelMessage =
  | { role: "user"; content: ContentPart[] }
  | { role: "assistant"; toolCalls: ToolCallRecord[]; text?: string }
  /**
   * Results for every call in the preceding assistant turn — all of them,
   * always. Anthropic requires the results to arrive in ONE message (it
   * rejects the next request otherwise) while OpenAI requires one message per
   * tool_call_id; adapters own that difference.
   */
  | { role: "tool"; results: ToolResultRecord[] };

export interface ToolResultRecord {
  toolCallId: string;
  content: string;
}

export interface ToolChatRequest {
  modelName: string;
  system?: SystemBlock[];
  messages: ModelMessage[];
  tools: ToolSpec[];
  /**
   * `"any"` forces some tool (OpenAI maps this to `"required"`); `{name}`
   * forces one specific tool, which is how a fixed-schema structured output
   * is expressed. Omitted means the model may answer with plain text.
   */
  toolChoice?: "any" | { name: string };
  /**
   * Let the model emit several calls in one turn. Off by default: the caller
   * must then answer every one of them, and a single-tool call site has
   * nothing to gain. The agent turns it on for its instant-tool queries,
   * which are independent of each other.
   */
  allowParallelCalls?: boolean;
  maxOutputTokens?: number;
  temperature?: number;
}

export interface ToolChatResponse {
  toolCalls: ToolCallRecord[];
  /** Any prose emitted alongside the calls — normally empty when forced. */
  text: string;
  usage: TokenUsageTotals | null;
}

export interface ProviderAdapter {
  readonly provider: ModelProviderName;
  chat(req: ChatRequest): Promise<ChatResponse>;
  /** Native tool calling. The API guarantees the envelope and, with `strict`,
   *  the argument shape — no JSON is parsed out of prose. */
  chatWithTools(req: ToolChatRequest): Promise<ToolChatResponse>;
  /** Single-string embedding — the remote fallback behind local FastEmbed. */
  embed(
    text: string,
    modelName: string,
    dimensions?: number
  ): Promise<number[]>;
}
