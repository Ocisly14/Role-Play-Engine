/**
 * CoC Agent Model Configuration
 * Default model settings for different providers and sizes
 */

import { ModelClass, ModelProviderName, type Models } from "./types.js";

/**
 * DeepSeek's context window, overridable because DeepSeek has raised it more
 * than once. A non-numeric or non-positive value falls back rather than
 * propagating NaN into every prompt-budget decision downstream.
 */
const DEEPSEEK_MAX_INPUT_TOKENS = (() => {
  const raw = Number(process.env.DEEPSEEK_MAX_TOKENS);
  return Number.isFinite(raw) && raw > 0 ? raw : 64000;
})();

export const models: Models = {
  [ModelProviderName.OPENAI]: {
    endpoint: process.env.OPENAI_API_URL || "https://api.openai.com/v1",
    model: {
      [ModelClass.SMALL]: {
        name: process.env.SMALL_OPENAI_MODEL || "gpt-4o-mini",
        stop: [],
        maxInputTokens: 128000,
        maxOutputTokens: 16384,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        temperature: 0.6,
      },
      [ModelClass.MEDIUM]: {
        name: process.env.MEDIUM_OPENAI_MODEL || "gpt-4o",
        stop: [],
        maxInputTokens: 128000,
        maxOutputTokens: 16384,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        temperature: 0.6,
      },
      [ModelClass.LARGE]: {
        name: process.env.LARGE_OPENAI_MODEL || "gpt-4o",
        stop: [],
        maxInputTokens: 128000,
        maxOutputTokens: 16384,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        temperature: 0.6,
      },
      [ModelClass.EMBEDDING]: {
        name: process.env.EMBEDDING_OPENAI_MODEL || "text-embedding-3-small",
        dimensions: 1536,
      },
      [ModelClass.IMAGE]: {
        name: process.env.IMAGE_OPENAI_MODEL || "dall-e-3",
      },
    },
  },
  [ModelProviderName.ANTHROPIC]: {
    endpoint: process.env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1",
    model: {
      [ModelClass.SMALL]: {
        name: process.env.SMALL_ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
        stop: [],
        maxInputTokens: 200000,
        maxOutputTokens: 8192,
        frequency_penalty: 0.4,
        presence_penalty: 0.4,
        temperature: 0.7,
      },
      [ModelClass.MEDIUM]: {
        name: process.env.MEDIUM_ANTHROPIC_MODEL || "claude-sonnet-5",
        stop: [],
        maxInputTokens: 200000,
        maxOutputTokens: 8192,
        frequency_penalty: 0.4,
        presence_penalty: 0.4,
        temperature: 0.7,
      },
      [ModelClass.LARGE]: {
        name: process.env.LARGE_ANTHROPIC_MODEL || "claude-opus-5",
        stop: [],
        maxInputTokens: 200000,
        maxOutputTokens: 8192,
        frequency_penalty: 0.4,
        presence_penalty: 0.4,
        temperature: 0.7,
      },
    },
  },
  [ModelProviderName.GOOGLE]: {
    endpoint: "https://generativelanguage.googleapis.com",
    model: {
      [ModelClass.SMALL]: {
        name: process.env.SMALL_GOOGLE_MODEL || "gemini-2.0-flash",
        stop: [],
        maxInputTokens: 128000,
        maxOutputTokens: 8192,
        frequency_penalty: 0.4,
        presence_penalty: 0.4,
        temperature: 0.7,
      },
      [ModelClass.MEDIUM]: {
        name: process.env.MEDIUM_GOOGLE_MODEL || "gemini-2.5-flash",
        stop: [],
        maxInputTokens: 128000,
        maxOutputTokens: 8192,
        frequency_penalty: 0.4,
        presence_penalty: 0.4,
        temperature: 0.7,
      },
      [ModelClass.LARGE]: {
        name: process.env.LARGE_GOOGLE_MODEL || "gemini-2.5-pro",
        stop: [],
        maxInputTokens: 128000,
        maxOutputTokens: 8192,
        frequency_penalty: 0.4,
        presence_penalty: 0.4,
        temperature: 0.7,
      },
      [ModelClass.EMBEDDING]: {
        name: process.env.EMBEDDING_GOOGLE_MODEL || "text-embedding-004",
      },
    },
  },
  /**
   * DeepSeek. `deepseek-chat` fills all three classes: it is the only model
   * here with function calling, and every seam in this codebase forces a tool
   * call. `deepseek-reasoner` is deliberately absent — a class that cannot
   * satisfy `tool_choice` would fail the World Action Engine's
   * `submit_resolution` on the LARGE fallback, which is the worst place to
   * discover it. Override per class if that changes.
   *
   * No EMBEDDING entry: DeepSeek serves no embeddings endpoint, and
   * `rag/embedding.ts` already routes any non-Google remote fallback to
   * OpenAI. No IMAGE entry for the same reason.
   *
   * `DEEPSEEK_MAX_TOKENS` sets the INPUT budget (context window), not the
   * output cap — the two are separate fields here and only the input one is
   * plausibly six digits. It is read once at module load, like every other
   * provider's env.
   */
  [ModelProviderName.DEEPSEEK]: {
    endpoint: process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/v1",
    model: {
      [ModelClass.SMALL]: {
        name: process.env.SMALL_DEEPSEEK_MODEL || "deepseek-chat",
        stop: [],
        maxInputTokens: DEEPSEEK_MAX_INPUT_TOKENS,
        maxOutputTokens: 40960,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        temperature: 0.7,
      },
      [ModelClass.MEDIUM]: {
        name: process.env.MEDIUM_DEEPSEEK_MODEL || "deepseek-chat",
        stop: [],
        maxInputTokens: DEEPSEEK_MAX_INPUT_TOKENS,
        maxOutputTokens: 40960,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        temperature: 0.7,
      },
      [ModelClass.LARGE]: {
        name: process.env.LARGE_DEEPSEEK_MODEL || "deepseek-chat",
        stop: [],
        maxInputTokens: DEEPSEEK_MAX_INPUT_TOKENS,
        maxOutputTokens: 40960,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        temperature: 0.7,
      },
    },
  },
};

/**
 * Gets the configured API endpoint for a provider.
 */
export function getEndpoint(provider: ModelProviderName): string | undefined {
  return models[provider]?.endpoint;
}
