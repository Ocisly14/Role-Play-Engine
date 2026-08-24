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
};

/**
 * Gets the configured API endpoint for a provider.
 */
export function getEndpoint(provider: ModelProviderName): string | undefined {
  return models[provider]?.endpoint;
}
