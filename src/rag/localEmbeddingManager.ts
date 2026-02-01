import fs from "fs";
import path from "path";
import { FlagEmbedding, EmbeddingModel } from "fastembed";

/**
 * Thin wrapper around fastembed's BGE-small-en-v1.5 to match senti-agent's local RAG setup.
 * Uses a singleton to avoid re-loading the model repeatedly.
 */
export class LocalEmbeddingManager {
  private static instance: LocalEmbeddingManager | null = null;
  private model: FlagEmbedding | null = null;
  private initializing = false;

  static getInstance(): LocalEmbeddingManager {
    if (!LocalEmbeddingManager.instance) {
      LocalEmbeddingManager.instance = new LocalEmbeddingManager();
    }
    return LocalEmbeddingManager.instance;
  }

  async warmup(): Promise<void> {
    await this.ensureModel();
  }

  private async ensureModel(): Promise<void> {
    if (this.model || this.initializing) {
      while (this.initializing && !this.model) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return;
    }

    this.initializing = true;
    try {
      const cacheDir = path.join(process.cwd(), "cache");
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }

      const modelDir = path.join(cacheDir, EmbeddingModel.BGESmallENV15);
      const modelFile = path.join(modelDir, "model_optimized.onnx");
      if (fs.existsSync(modelDir) && !fs.existsSync(modelFile)) {
        console.warn(
          `[RAG] Local model cache incomplete (missing ${path.basename(modelFile)}). Re-downloading...`
        );
        fs.rmSync(modelDir, { recursive: true, force: true });
      }

      this.model = await FlagEmbedding.init({
        model: EmbeddingModel.BGESmallENV15,
        cacheDir,
        maxLength: 512,
      });
    } finally {
      this.initializing = false;
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!text?.trim()) return [];
    await this.ensureModel();

    if (!this.model) {
      throw new Error("Local embedding model failed to initialize");
    }

    const embedding = await this.model.queryEmbed(text);
    if (Array.isArray(embedding)) {
      return Array.from(embedding as number[]);
    }
    if (ArrayBuffer.isView(embedding)) {
      return Array.from(embedding as ArrayLike<number>);
    }

    return [];
  }
}
