// src/models/providers/index.ts

import { ModelProviderName } from "../types.js";
import { AnthropicAdapter } from "./anthropic.js";
import { GoogleAdapter } from "./google.js";
import { OpenAIAdapter } from "./openai.js";
import type { ProviderAdapter } from "./types.js";

const adapters: Record<ModelProviderName, ProviderAdapter> = {
  [ModelProviderName.OPENAI]: new OpenAIAdapter(),
  [ModelProviderName.ANTHROPIC]: new AnthropicAdapter(),
  [ModelProviderName.GOOGLE]: new GoogleAdapter(),
};

export function getAdapter(provider: ModelProviderName): ProviderAdapter {
  const adapter = adapters[provider];
  if (!adapter) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return adapter;
}

export type {
  ChatRequest,
  ChatResponse,
  ContentPart,
  ModelMessage,
  ProviderAdapter,
  SystemBlock,
  ToolCallRecord,
  ToolChatRequest,
  ToolChatResponse,
  ToolResultRecord,
  ToolSpec,
} from "./types.js";
