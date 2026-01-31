import { OpenAIEmbeddings } from "@langchain/openai";
import { GoogleGenerativeAIEmbeddings } from "@langchain/google-genai";
import { getModelSettings } from "../models/generator.js";
import { ModelClass, ModelProviderName, type EmbeddingModelSettings } from "../models/types.js";
import { LocalEmbeddingManager } from "./localEmbeddingManager.js";

export class EmbeddingClient {
  private provider: ModelProviderName;
  private local = LocalEmbeddingManager.getInstance();

  constructor(provider: ModelProviderName) {
    this.provider = provider || ModelProviderName.OPENAI;
  }

  async embed(text: string): Promise<number[]> {
    const normalized = text?.trim();
    if (!normalized) return [];

    // Prefer local BGE embeddings to mirror senti-agent behaviour
    try {
      return await this.local.embed(normalized);
    } catch (error) {
      console.warn("[RAG] Local embedding failed, falling back to remote provider", error);
    }

    const settings = getModelSettings(this.provider, ModelClass.EMBEDDING) as EmbeddingModelSettings | undefined;

    if (this.provider === ModelProviderName.GOOGLE) {
      const model = new GoogleGenerativeAIEmbeddings({
        model: settings?.name || "text-embedding-004",
        apiKey: process.env.GOOGLE_API_KEY,
      });
      return model.embedQuery(normalized);
    }

    const model = new OpenAIEmbeddings({
      model: settings?.name || "text-embedding-3-small",
      apiKey: process.env.OPENAI_API_KEY,
      dimensions: settings?.dimensions,
    });

    return model.embedQuery(normalized);
  }
}
