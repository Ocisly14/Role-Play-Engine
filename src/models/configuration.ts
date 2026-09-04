/**
 * CoC Agent Model Configuration
 * Default model settings for different providers and sizes
 */

import { ModelClass, ModelProviderName, type Models } from "./types.js";

export const models: Models = {
  [ModelProviderName.OPENAI]: {
    endpoint: process.env.OPENAI_API_URL || "https://api.openai.com/v1",
    model: {
      [ModelClass.SMALL]: {
        name: process.env.SMALL_OPENAI_MODEL || "gpt-4o-mini",
        stop: [],
        maxOutputTokens: 16384,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        temperature: 0.6,
      },
      [ModelClass.MEDIUM]: {
        name: process.env.MEDIUM_OPENAI_MODEL || "gpt-4o",
        stop: [],
        maxOutputTokens: 16384,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        temperature: 0.6,
      },
      [ModelClass.LARGE]: {
        name: process.env.LARGE_OPENAI_MODEL || "gpt-4o",
        stop: [],
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
  /**
   * Anthropic. `maxOutputTokens` is sent as `max_tokens` verbatim — the
   * adapter does not clamp it — and Anthropic answers a value above the
   * model's own cap with a 400, not a truncation. So each entry names the cap
   * of the model IT configures: 128K on the current generation, 64K on Haiku
   * 4.5. Override the model env var with something older and this number
   * needs to move with it, exactly like `temperature` does.
   *
   * `max_tokens` is a ceiling, not a reservation — only generated tokens are
   * billed — so a high one costs nothing per call; what it gives up is the
   * bound on a runaway generation. Call sites that want a short answer pass
   * their own `maxOutputTokens` (the perception compactor does).
   */
  [ModelProviderName.ANTHROPIC]: {
    endpoint: process.env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1",
    model: {
      [ModelClass.SMALL]: {
        name: process.env.SMALL_ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
        stop: [],
        // Haiku 4.5 stops at 64K; 128000 here is a 400, not a shorter answer.
        maxOutputTokens: 64000,
        frequency_penalty: 0.4,
        presence_penalty: 0.4,
        temperature: 0.7,
      },
      [ModelClass.MEDIUM]: {
        name: process.env.MEDIUM_ANTHROPIC_MODEL || "claude-sonnet-5",
        stop: [],
        maxOutputTokens: 128000,
        frequency_penalty: 0.4,
        presence_penalty: 0.4,
        temperature: 0.7,
      },
      [ModelClass.LARGE]: {
        name: process.env.LARGE_ANTHROPIC_MODEL || "claude-opus-5",
        stop: [],
        maxOutputTokens: 128000,
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
        maxOutputTokens: 8192,
        frequency_penalty: 0.4,
        presence_penalty: 0.4,
        temperature: 0.7,
      },
      [ModelClass.MEDIUM]: {
        name: process.env.MEDIUM_GOOGLE_MODEL || "gemini-2.5-flash",
        stop: [],
        maxOutputTokens: 8192,
        frequency_penalty: 0.4,
        presence_penalty: 0.4,
        temperature: 0.7,
      },
      [ModelClass.LARGE]: {
        name: process.env.LARGE_GOOGLE_MODEL || "gemini-2.5-pro",
        stop: [],
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
   * DeepSeek. `deepseek-chat` and `deepseek-reasoner` used to fill all three
   * classes; both are RETIRED — `GET https://api.deepseek.com/models` returns
   * only `deepseek-v4-flash`, `deepseek-v4-pro` and
   * `deepseek-v4-flash-vision-exp`, and a request naming either old id fails.
   * A dead default is worse than no default: it 404s every call in a run
   * whose provider was picked by one env var.
   *
   * Both v4 models call tools, so the old worry (a class that cannot satisfy
   * `tool_choice`) is gone — but they think by DEFAULT, and thinking mode
   * rejects `tool_choice` outright. That is handled once in the adapter
   * (`deepseek.ts`: forcing a choice turns thinking off), not by avoiding a
   * model here.
   *
   * MEDIUM carries everything in this codebase — the World Action Engine, the
   * agent loop, the renderer, the weather judge — and of those four, three are
   * volume. A 5-tick grayhaven run spent 68 of its 74 calls on the agent loop
   * and the renderer, so paying `pro` prices for MEDIUM means paying them
   * mostly to narrate. `flash` takes SMALL and MEDIUM.
   *
   * LARGE stays on `pro` and that is not decoration: `fallbackToLargeOnFailure`
   * escalates MEDIUM to LARGE, so the arrangement is cheap by default and
   * strong on the second try — which is the shape the Engine wants, since the
   * call that fails is the one worth spending on.
   *
   * No EMBEDDING entry: DeepSeek serves no embeddings endpoint, and
   * `rag/embedding.ts` already routes any non-Google remote fallback to
   * OpenAI. No IMAGE entry for the same reason.
   */
  [ModelProviderName.DEEPSEEK]: {
    endpoint: process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/v1",
    model: {
      [ModelClass.SMALL]: {
        name: process.env.SMALL_DEEPSEEK_MODEL || "deepseek-v4-flash",
        stop: [],
        maxOutputTokens: 40960,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        temperature: 0.7,
      },
      [ModelClass.MEDIUM]: {
        name: process.env.MEDIUM_DEEPSEEK_MODEL || "deepseek-v4-flash",
        stop: [],
        maxOutputTokens: 40960,
        frequency_penalty: 0.0,
        presence_penalty: 0.0,
        temperature: 0.7,
      },
      [ModelClass.LARGE]: {
        name: process.env.LARGE_DEEPSEEK_MODEL || "deepseek-v4-pro",
        stop: [],
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
