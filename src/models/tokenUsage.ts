import { AsyncLocalStorage } from "async_hooks";
import { CoCDatabaseAdapter } from "../shared/agents/memory/database/CoCDatabaseAdapter.js";
import type { ModelClass } from "./types.js";
// Value import (not `import type`): uncachedInputTokens branches on the
// enum member at runtime.
import { ModelProviderName } from "./types.js";

export type TokenUsageContext = {
  email?: string;
  turnId?: string;
  usageTotals?: TokenUsageTotals;
};

export type TokenUsageTotals = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** Input tokens served from the provider's prompt cache (a cache HIT).
   *  Optional because not every provider/shape reports it. */
  cache_read_tokens?: number;
  /** Input tokens written to the provider's prompt cache (a cache WRITE).
   *  Anthropic-only — OpenAI's automatic caching exposes no write counter,
   *  so this stays 0 there even when a cache entry is created. */
  cache_creation_tokens?: number;
};

/** Per-(provider, model, operation) rollup accumulated in-process. Unlike
 *  `recordTokenUsage`'s DB write this needs no email and no database, so it
 *  works in the simulation / script path where neither exists. */
export type UsageAggregate = {
  provider: ModelProviderName;
  modelName: string;
  operation: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
};

type TokenUsageRecord = TokenUsageTotals & {
  email?: string;
  provider: ModelProviderName;
  modelClass: ModelClass;
  modelName?: string;
  operation?: string;
};

const storage = new AsyncLocalStorage<TokenUsageContext>();
let tokenUsageDb: CoCDatabaseAdapter | null = null;
const tokenUsageWrapped = Symbol.for("coc.tokenUsageWrapped");

export function configureTokenUsageDatabase(db: CoCDatabaseAdapter): void {
  tokenUsageDb = db;
}

export function runWithTokenContext<T>(
  context: TokenUsageContext,
  fn: () => T
): T {
  return storage.run(context, fn);
}

export function getTokenContext(): TokenUsageContext | undefined {
  return storage.getStore();
}

export function getCurrentUsageTotals(): TokenUsageTotals | null {
  const store = storage.getStore();
  if (!store?.usageTotals) {
    return null;
  }
  return {
    input_tokens: store.usageTotals.input_tokens,
    output_tokens: store.usageTotals.output_tokens,
    total_tokens: store.usageTotals.total_tokens,
    cache_read_tokens: store.usageTotals.cache_read_tokens ?? 0,
    cache_creation_tokens: store.usageTotals.cache_creation_tokens ?? 0,
  };
}

function getUsageDb(): CoCDatabaseAdapter | null {
  if (tokenUsageDb) return tokenUsageDb;
  try {
    tokenUsageDb = new CoCDatabaseAdapter();
    return tokenUsageDb;
  } catch (error) {
    console.warn("[TokenUsage] Failed to initialize database:", error);
    return null;
  }
}

function toNumber(value: unknown): number | null {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

export function normalizeUsageMetadata(payload: any): TokenUsageTotals | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const input =
    toNumber(
      payload.input_tokens ??
        payload.promptTokens ??
        payload.prompt_tokens ??
        payload.promptTokenCount ??
        payload.prompt_token_count
    ) ?? 0;
  const output =
    toNumber(
      payload.output_tokens ??
        payload.completionTokens ??
        payload.completion_tokens ??
        payload.candidatesTokenCount ??
        payload.candidateTokenCount ??
        payload.candidates_token_count
    ) ?? 0;
  const total =
    toNumber(
      payload.total_tokens ??
        payload.totalTokens ??
        payload.total_tokens ??
        payload.totalTokenCount ??
        payload.total_token_count
    ) ?? input + output;

  // Prompt-cache counters. LangChain normalizes both providers into
  // `usage_metadata.input_token_details` (verified against @langchain/anthropic
  // utils/message_outputs.js and @langchain/openai chat_models.js); the raw
  // provider shapes are kept as fallbacks for payloads that skip LangChain
  // (e.g. imageGenerator's direct fetch).
  const details = payload.input_token_details ?? payload.inputTokenDetails;
  const cacheRead =
    toNumber(
      details?.cache_read ??
        payload.cache_read_input_tokens ??
        payload.prompt_tokens_details?.cached_tokens ??
        payload.promptTokensDetails?.cachedTokens ??
        payload.cached_content_token_count ??
        payload.cachedContentTokenCount
    ) ?? 0;
  const cacheCreation =
    toNumber(details?.cache_creation ?? payload.cache_creation_input_tokens) ??
    0;

  if (
    input === 0 &&
    output === 0 &&
    total === 0 &&
    cacheRead === 0 &&
    cacheCreation === 0
  ) {
    return null;
  }

  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: cacheCreation,
  };
}

export function extractUsageMetadata(response: any): TokenUsageTotals | null {
  if (!response || typeof response !== "object") {
    return null;
  }

  const direct = normalizeUsageMetadata(
    response.usage_metadata ?? response.usageMetadata
  );
  if (direct) {
    return direct;
  }

  const responseMeta = normalizeUsageMetadata(
    response.response_metadata?.usage_metadata ??
      response.response_metadata?.usage ??
      response.response_metadata?.tokenUsage
  );
  if (responseMeta) {
    return responseMeta;
  }

  const llmUsage = normalizeUsageMetadata(response.llmOutput?.tokenUsage);
  if (llmUsage) {
    return llmUsage;
  }

  return null;
}

export function mergeUsageTotals(
  target: TokenUsageTotals,
  next: TokenUsageTotals
): TokenUsageTotals {
  target.input_tokens += next.input_tokens ?? 0;
  target.output_tokens += next.output_tokens ?? 0;
  target.total_tokens += next.total_tokens ?? 0;
  target.cache_read_tokens =
    (target.cache_read_tokens ?? 0) + (next.cache_read_tokens ?? 0);
  target.cache_creation_tokens =
    (target.cache_creation_tokens ?? 0) + (next.cache_creation_tokens ?? 0);
  return target;
}

// ===== In-process usage aggregation =====
//
// `recordTokenUsage` writes to the DB and needs an email from the auth
// middleware's AsyncLocalStorage context. The simulation / script path has
// neither, so nothing was observable there. These aggregates accumulate
// unconditionally, keyed by (provider, model, operation) — the four LLM call
// sites already pass distinct `operation` labels, which is what makes a
// per-call-site cache breakdown possible.

const usageAggregates = new Map<string, UsageAggregate>();

function aggregateKey(
  provider: ModelProviderName,
  modelName: string,
  operation: string
): string {
  return `${provider}\u0000${modelName}\u0000${operation}`;
}

/** Clear the in-process aggregates. Call at the start of a measured run. */
export function resetUsageStats(): void {
  usageAggregates.clear();
}

/** Snapshot of the in-process aggregates, heaviest (by total tokens) first. */
export function getUsageStats(): UsageAggregate[] {
  return [...usageAggregates.values()]
    .map((entry) => ({ ...entry }))
    .sort((a, b) => b.total_tokens - a.total_tokens);
}

/**
 * Input tokens that were actually billed at full price.
 *
 * The two providers define `input_tokens` differently and LangChain passes
 * each through unchanged:
 *   - Anthropic: already the uncached remainder — cache_read and
 *     cache_creation are reported as separate counters alongside it.
 *   - OpenAI: `prompt_tokens` INCLUDES `cached_tokens`, so the cached portion
 *     must be subtracted. (OpenAI reports no cache-write counter.)
 *
 * Getting this wrong silently doubles Anthropic's input or understates
 * OpenAI's cache benefit, so every report must go through this helper.
 */
export function uncachedInputTokens(
  totals: Pick<UsageAggregate, "input_tokens" | "cache_read_tokens">,
  provider: ModelProviderName
): number {
  if (provider === ModelProviderName.OPENAI) {
    return Math.max(0, totals.input_tokens - totals.cache_read_tokens);
  }
  return totals.input_tokens;
}

/** Total prompt tokens sent, cached or not — the denominator for hit rate. */
export function promptTokensSent(
  totals: Pick<
    UsageAggregate,
    "input_tokens" | "cache_read_tokens" | "cache_creation_tokens"
  >,
  provider: ModelProviderName
): number {
  return (
    uncachedInputTokens(totals, provider) +
    totals.cache_read_tokens +
    totals.cache_creation_tokens
  );
}

function accumulateUsageStats(params: TokenUsageRecord): void {
  const modelName = params.modelName ?? "unknown";
  const operation = params.operation ?? "chat";
  const key = aggregateKey(params.provider, modelName, operation);

  let entry = usageAggregates.get(key);
  if (!entry) {
    entry = {
      provider: params.provider,
      modelName,
      operation,
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    };
    usageAggregates.set(key, entry);
  }

  entry.calls += 1;
  entry.input_tokens += params.input_tokens ?? 0;
  entry.output_tokens += params.output_tokens ?? 0;
  entry.total_tokens +=
    params.total_tokens ??
    (params.input_tokens ?? 0) + (params.output_tokens ?? 0);
  entry.cache_read_tokens += params.cache_read_tokens ?? 0;
  entry.cache_creation_tokens += params.cache_creation_tokens ?? 0;
}

/**
 * Printable cache report. `cached%` is cache_read / prompt tokens sent — the
 * share of the prompt that was served from cache. A run with no caching wired
 * up shows 0% everywhere, which is the point: it is the baseline to beat.
 */
export function formatUsageReport(
  stats: UsageAggregate[] = getUsageStats()
): string {
  if (stats.length === 0) {
    return "No LLM usage recorded.";
  }

  const rows = stats.map((entry) => {
    const sent = promptTokensSent(entry, entry.provider);
    const pct = sent > 0 ? (entry.cache_read_tokens / sent) * 100 : 0;
    return {
      operation: entry.operation,
      model: entry.modelName,
      calls: String(entry.calls),
      sent: String(sent),
      cacheRead: String(entry.cache_read_tokens),
      cacheWrite: String(entry.cache_creation_tokens),
      out: String(entry.output_tokens),
      cached: `${pct.toFixed(1)}%`,
    };
  });

  const headers = {
    operation: "operation",
    model: "model",
    calls: "calls",
    sent: "prompt_in",
    cacheRead: "cache_read",
    cacheWrite: "cache_write",
    out: "output",
    cached: "cached%",
  };

  const columns = Object.keys(headers) as Array<keyof typeof headers>;
  const widths: Record<string, number> = {};
  for (const col of columns) {
    widths[col] = Math.max(
      headers[col].length,
      ...rows.map((r) => r[col].length)
    );
  }
  const line = (cells: Record<keyof typeof headers, string>) =>
    columns
      .map((col) =>
        col === "operation" || col === "model"
          ? cells[col].padEnd(widths[col])
          : cells[col].padStart(widths[col])
      )
      .join("  ");

  const totals = stats.reduce(
    (acc, entry) => {
      acc.calls += entry.calls;
      acc.sent += promptTokensSent(entry, entry.provider);
      acc.cacheRead += entry.cache_read_tokens;
      acc.cacheWrite += entry.cache_creation_tokens;
      acc.out += entry.output_tokens;
      return acc;
    },
    { calls: 0, sent: 0, cacheRead: 0, cacheWrite: 0, out: 0 }
  );
  const totalPct = totals.sent > 0 ? (totals.cacheRead / totals.sent) * 100 : 0;

  return [
    line(headers),
    line({
      operation: "TOTAL",
      model: "",
      calls: String(totals.calls),
      sent: String(totals.sent),
      cacheRead: String(totals.cacheRead),
      cacheWrite: String(totals.cacheWrite),
      out: String(totals.out),
      cached: `${totalPct.toFixed(1)}%`,
    }),
    ...rows.map(line),
  ].join("\n");
}

export function recordTokenUsage(params: TokenUsageRecord): void {
  // In-process aggregation first: it needs neither an email nor a database,
  // so the simulation path stays observable even though every guard below
  // short-circuits there.
  accumulateUsageStats(params);

  const store = storage.getStore();
  const resolvedEmail = params.email || store?.email;
  if (!resolvedEmail) {
    return;
  }

  const db = getUsageDb();
  if (!db) {
    return;
  }

  const totalTokens =
    params.total_tokens ?? params.input_tokens + params.output_tokens;
  if (totalTokens <= 0) {
    return;
  }

  if (store?.usageTotals) {
    mergeUsageTotals(store.usageTotals, {
      input_tokens: params.input_tokens ?? 0,
      output_tokens: params.output_tokens ?? 0,
      total_tokens: totalTokens,
      cache_read_tokens: params.cache_read_tokens ?? 0,
      cache_creation_tokens: params.cache_creation_tokens ?? 0,
    });
  }

  try {
    db.recordUserTokenUsage({
      email: resolvedEmail,
      provider: params.provider,
      modelName: params.modelName ?? "unknown",
      modelClass: params.modelClass,
      operation: params.operation ?? "chat",
      inputTokens: params.input_tokens,
      outputTokens: params.output_tokens,
      totalTokens,
    });
  } catch (error) {
    console.warn("[TokenUsage] Failed to record token usage:", error);
  }
}

export function attachUsageTracking<T extends { invoke: any; stream?: any }>(
  model: T,
  info: {
    provider: ModelProviderName;
    modelClass: ModelClass;
    modelName?: string;
    operation?: string;
    email?: string;
  }
): T {
  const marker = tokenUsageWrapped as unknown as keyof T;
  if ((model as any)[marker]) {
    return model;
  }
  (model as any)[marker] = true;

  if (typeof model.invoke === "function") {
    const originalInvoke = model.invoke.bind(model);
    model.invoke = async (...args: any[]) => {
      const response = await originalInvoke(...args);
      const usage = extractUsageMetadata(response);
      if (usage) {
        recordTokenUsage({
          email: info.email,
          provider: info.provider,
          modelClass: info.modelClass,
          modelName: info.modelName,
          operation: info.operation,
          ...usage,
        });
      }
      return response;
    };
  }

  if (typeof model.stream === "function") {
    const originalStream = model.stream.bind(model);
    model.stream = async (...args: any[]) => {
      const rawStream = await originalStream(...args);
      const totals: TokenUsageTotals = {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
      };

      const wrapped = async function* () {
        try {
          for await (const chunk of rawStream) {
            const usage = extractUsageMetadata(chunk);
            if (usage) {
              mergeUsageTotals(totals, usage);
            }
            yield chunk;
          }
        } finally {
          if (totals.total_tokens > 0) {
            recordTokenUsage({
              email: info.email,
              provider: info.provider,
              modelClass: info.modelClass,
              modelName: info.modelName,
              operation: info.operation,
              ...totals,
            });
          }
        }
      };

      return wrapped();
    };
  }

  return model;
}
