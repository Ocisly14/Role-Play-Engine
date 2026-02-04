import { AsyncLocalStorage } from "async_hooks";
import { CoCDatabase } from "../shared/agents/memory/database/schema.js";
import { ModelClass, ModelProviderName } from "./types.js";

export type TokenUsageContext = {
  email?: string;
  turnId?: string;
  usageTotals?: TokenUsageTotals;
};

export type TokenUsageTotals = {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

type TokenUsageRecord = TokenUsageTotals & {
  email?: string;
  provider: ModelProviderName;
  modelClass: ModelClass;
  modelName?: string;
  operation?: string;
};

const storage = new AsyncLocalStorage<TokenUsageContext>();
let tokenUsageDb: CoCDatabase | null = null;
const tokenUsageWrapped = Symbol.for("coc.tokenUsageWrapped");

export function configureTokenUsageDatabase(db: CoCDatabase): void {
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
  };
}

function getUsageDb(): CoCDatabase | null {
  if (tokenUsageDb) return tokenUsageDb;
  try {
    tokenUsageDb = new CoCDatabase();
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

  if (input === 0 && output === 0 && total === 0) {
    return null;
  }

  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: total,
  };
}

export function extractUsageMetadata(response: any): TokenUsageTotals | null {
  if (!response || typeof response !== "object") {
    return null;
  }

  const direct = normalizeUsageMetadata(response.usage_metadata ?? response.usageMetadata);
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
  return target;
}

export function recordTokenUsage(params: TokenUsageRecord): void {
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
