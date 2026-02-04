import fs from "fs";
import path from "path";
import { FlagEmbedding, EmbeddingModel } from "fastembed";

/**
 * Thin wrapper around fastembed's BGE-small-en-v1.5 to match senti-agent's local RAG setup.
 * Uses a singleton to avoid re-loading the model repeatedly.
 */
export class LocalEmbeddingManager {
  private static instance: LocalEmbeddingManager | null = null;
  private models = new Map<LocalEmbeddingLanguage, FlagEmbedding>();
  private initializing = new Map<LocalEmbeddingLanguage, Promise<void>>();

  static getInstance(): LocalEmbeddingManager {
    if (!LocalEmbeddingManager.instance) {
      LocalEmbeddingManager.instance = new LocalEmbeddingManager();
    }
    return LocalEmbeddingManager.instance;
  }

  async warmup(languages: LocalEmbeddingLanguage[] = ["en"]): Promise<void> {
    await Promise.all(languages.map((language) => this.ensureModel(language)));
  }

  private async ensureModel(language: LocalEmbeddingLanguage): Promise<void> {
    if (this.models.has(language)) return;

    const existingInit = this.initializing.get(language);
    if (existingInit) {
      await existingInit;
      return;
    }

    const initPromise = (async () => {
      const cacheDir = path.join(process.cwd(), "cache");
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      const modelId = LOCAL_EMBEDDING_MODELS[language];
      const modelDir = path.join(cacheDir, modelId);
      const modelFile = path.join(modelDir, "model_optimized.onnx");
      if (fs.existsSync(modelDir) && !fs.existsSync(modelFile)) {
        console.warn(
          `[RAG] Local model cache incomplete (missing ${path.basename(modelFile)}). Re-downloading...`
        );
        fs.rmSync(modelDir, { recursive: true, force: true });
      }

      const model = await FlagEmbedding.init({
        model: modelId,
        cacheDir,
        maxLength: 512,
      });
      this.models.set(language, model);
    })();

    this.initializing.set(language, initPromise);
    try {
      await initPromise;
    } finally {
      this.initializing.delete(language);
    }
  }

  async embed(text: string, language: LocalEmbeddingLanguage = "en"): Promise<number[]> {
    if (!text?.trim()) return [];
    await this.ensureModel(language);

    const model = this.models.get(language);
    if (!model) {
      throw new Error("Local embedding model failed to initialize");
    }

    const embedding = await model.queryEmbed(text);
    if (Array.isArray(embedding)) {
      return Array.from(embedding as number[]);
    }
    if (ArrayBuffer.isView(embedding)) {
      return Array.from(embedding as ArrayLike<number>);
    }

    return [];
  }
}

export type LocalEmbeddingLanguage = "en" | "zh";

const LOCAL_EMBEDDING_MODELS: Record<LocalEmbeddingLanguage, EmbeddingModel> = {
  en: EmbeddingModel.BGESmallENV15,
  zh: EmbeddingModel.BGESmallZH,
};
