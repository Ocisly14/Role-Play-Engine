import { beforeEach, describe, expect, it } from "vitest";
import {
  formatUsageReport,
  getUsageStats,
  normalizeUsageMetadata,
  promptTokensSent,
  recordTokenUsage,
  resetUsageStats,
  uncachedInputTokens,
} from "../tokenUsage.js";
import { ModelClass, ModelProviderName } from "../types.js";

describe("normalizeUsageMetadata — prompt cache counters", () => {
  it("reads LangChain's normalized input_token_details (Anthropic shape)", () => {
    // @langchain/anthropic passes Anthropic's raw usage through: input_tokens
    // is the UNCACHED remainder, cache counters sit beside it.
    const usage = normalizeUsageMetadata({
      input_tokens: 120,
      output_tokens: 40,
      total_tokens: 160,
      input_token_details: { cache_read: 900, cache_creation: 512 },
    });

    expect(usage).toEqual({
      input_tokens: 120,
      output_tokens: 40,
      total_tokens: 160,
      cache_read_tokens: 900,
      cache_creation_tokens: 512,
    });
  });

  it("reads LangChain's normalized input_token_details (OpenAI shape)", () => {
    // @langchain/openai sets input_tokens = prompt_tokens, which INCLUDES
    // cached_tokens, and reports no cache-write counter.
    const usage = normalizeUsageMetadata({
      input_tokens: 1500,
      output_tokens: 60,
      total_tokens: 1560,
      input_token_details: { cache_read: 1024 },
    });

    expect(usage?.cache_read_tokens).toBe(1024);
    expect(usage?.cache_creation_tokens).toBe(0);
  });

  it("falls back to raw provider shapes when LangChain is bypassed", () => {
    expect(
      normalizeUsageMetadata({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 700,
        cache_creation_input_tokens: 300,
      })
    ).toMatchObject({ cache_read_tokens: 700, cache_creation_tokens: 300 });

    expect(
      normalizeUsageMetadata({
        prompt_tokens: 2000,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 1024 },
      })
    ).toMatchObject({ input_tokens: 2000, cache_read_tokens: 1024 });
  });

  it("defaults cache counters to 0 when the provider reports none", () => {
    expect(
      normalizeUsageMetadata({ input_tokens: 10, output_tokens: 5 })
    ).toMatchObject({ cache_read_tokens: 0, cache_creation_tokens: 0 });
  });

  it("still returns null for a fully empty payload", () => {
    expect(normalizeUsageMetadata({})).toBeNull();
    expect(normalizeUsageMetadata(null)).toBeNull();
  });

  it("returns a record when only cache counters are present", () => {
    expect(
      normalizeUsageMetadata({ cache_read_input_tokens: 512 })
    ).toMatchObject({ cache_read_tokens: 512 });
  });
});

describe("uncachedInputTokens — provider-dependent input_tokens semantics", () => {
  const totals = { input_tokens: 1500, cache_read_tokens: 1024 };

  it("subtracts the cached portion for OpenAI (prompt_tokens includes it)", () => {
    expect(uncachedInputTokens(totals, ModelProviderName.OPENAI)).toBe(476);
  });

  it("leaves Anthropic's input_tokens alone (already the remainder)", () => {
    expect(uncachedInputTokens(totals, ModelProviderName.ANTHROPIC)).toBe(1500);
  });

  it("never goes negative on inconsistent provider data", () => {
    expect(
      uncachedInputTokens(
        { input_tokens: 100, cache_read_tokens: 900 },
        ModelProviderName.OPENAI
      )
    ).toBe(0);
  });

  it("computes the same prompt size for both providers' reporting styles", () => {
    // Same underlying request — 1500 prompt tokens, 1024 of them cached —
    // reported two different ways. promptTokensSent must agree.
    const openai = {
      input_tokens: 1500,
      cache_read_tokens: 1024,
      cache_creation_tokens: 0,
    };
    const anthropic = {
      input_tokens: 476,
      cache_read_tokens: 1024,
      cache_creation_tokens: 0,
    };

    expect(promptTokensSent(openai, ModelProviderName.OPENAI)).toBe(1500);
    expect(promptTokensSent(anthropic, ModelProviderName.ANTHROPIC)).toBe(1500);
  });
});

describe("in-process aggregation", () => {
  beforeEach(() => resetUsageStats());

  it("accumulates without an email or database", () => {
    // recordTokenUsage's DB write needs an auth email; the simulation path has
    // none. Aggregation must happen anyway — that is the whole point of A.
    for (let i = 0; i < 3; i++) {
      recordTokenUsage({
        provider: ModelProviderName.OPENAI,
        modelClass: ModelClass.MEDIUM,
        modelName: "gpt-4o",
        operation: "game-interpreter",
        input_tokens: 1000,
        output_tokens: 50,
        total_tokens: 1050,
        cache_read_tokens: 800,
        cache_creation_tokens: 0,
      });
    }

    const stats = getUsageStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      operation: "game-interpreter",
      calls: 3,
      input_tokens: 3000,
      cache_read_tokens: 2400,
    });
  });

  it("keys separately per operation so call sites stay distinguishable", () => {
    const base = {
      provider: ModelProviderName.OPENAI,
      modelClass: ModelClass.MEDIUM,
      modelName: "gpt-4o",
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
    };
    recordTokenUsage({ ...base, operation: "state-resolver" });
    recordTokenUsage({ ...base, operation: "role-sim-agent" });

    expect(
      getUsageStats()
        .map((s) => s.operation)
        .sort()
    ).toEqual(["role-sim-agent", "state-resolver"]);
  });

  it("reports a readable baseline when nothing was cached", () => {
    recordTokenUsage({
      provider: ModelProviderName.ANTHROPIC,
      modelClass: ModelClass.MEDIUM,
      modelName: "claude-sonnet-5",
      operation: "state-resolver",
      input_tokens: 2000,
      output_tokens: 100,
      total_tokens: 2100,
    });

    const report = formatUsageReport();
    expect(report).toContain("state-resolver");
    expect(report).toContain("0.0%");
  });

  it("says so when there is no usage at all", () => {
    expect(formatUsageReport()).toBe("No LLM usage recorded.");
  });
});
