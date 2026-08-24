import { getModelSettings } from "../models/generator.js";
import { getAdapter } from "../models/providers/index.js";
import {
  type EmbeddingModelSettings,
  ModelClass,
  ModelProviderName,
} from "../models/types.js";
import {
  type LocalEmbeddingLanguage,
  LocalEmbeddingManager,
} from "./localEmbeddingManager.js";

const DEFAULT_EMBEDDING_MODEL: Partial<Record<ModelProviderName, string>> = {
  [ModelProviderName.GOOGLE]: "text-embedding-004",
  [ModelProviderName.OPENAI]: "text-embedding-3-small",
};

export class EmbeddingClient {
  private provider: ModelProviderName;
  private local = LocalEmbeddingManager.getInstance();

  constructor(provider: ModelProviderName) {
    this.provider = provider || ModelProviderName.OPENAI;
  }

  async embed(
    text: string,
    options?: { language?: LocalEmbeddingLanguage; skipLocal?: boolean }
  ): Promise<number[]> {
    const normalized = text?.trim();
    if (!normalized) return [];

    // Prefer local BGE embeddings to mirror senti-agent behaviour
    try {
      if (!options?.skipLocal) {
        return await this.local.embed(normalized, options?.language);
      }
    } catch (error) {
      console.warn(
        "[RAG] Local embedding failed, falling back to remote provider",
        error
      );
    }

    const settings = getModelSettings(this.provider, ModelClass.EMBEDDING) as
      | EmbeddingModelSettings
      | undefined;

    // Anthropic has no embeddings endpoint, so the remote fallback resolves to
    // OpenAI unless Google is explicitly configured — same as before.
    const provider =
      this.provider === ModelProviderName.GOOGLE
        ? ModelProviderName.GOOGLE
        : ModelProviderName.OPENAI;

    const modelName = settings?.name ?? DEFAULT_EMBEDDING_MODEL[provider] ?? "";

    return getAdapter(provider).embed(
      normalized,
      modelName,
      provider === ModelProviderName.OPENAI ? settings?.dimensions : undefined
    );
  }
}
