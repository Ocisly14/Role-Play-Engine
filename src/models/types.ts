/**
 * CoC Agent Model Types and Configuration
 * Model selection system with small/medium/large categorization
 */

/**
 * Model size/type classification for different tasks
 */
export enum ModelClass {
  SMALL = "small",   // Fast, lightweight models for simple tasks
  MEDIUM = "medium", // Balanced models for general conversational tasks
  LARGE = "large",   // Heavy models for complex reasoning and analysis
  EMBEDDING = "embedding", // Specialized for vector embeddings
  IMAGE = "image"    // Image generation models
}

/**
 * Supported AI providers
 */
export enum ModelProviderName {
  OPENAI = "openai",
  ANTHROPIC = "anthropic",
  GOOGLE = "google",
  GROQ = "groq",
  OLLAMA = "ollama",
  OPENROUTER = "openrouter"
}

/**
 * Model settings interface
 */
export interface ModelSettings {
  name: string;
  stop?: string[];
  maxInputTokens?: number;
  maxOutputTokens?: number;
  temperature?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
}

/**
 * Embedding model settings
 */
export interface EmbeddingModelSettings {
  name: string;
  dimensions?: number;
}

/**
 * Image model settings
 */
export interface ImageModelSettings {
  name: string;
  steps?: number;
}

/**
 * Provider configuration
 */
export interface ProviderConfig {
  endpoint?: string;
  model: {
    [ModelClass.SMALL]?: ModelSettings;
    [ModelClass.MEDIUM]?: ModelSettings;
    [ModelClass.LARGE]?: ModelSettings;
    [ModelClass.EMBEDDING]?: EmbeddingModelSettings;
    [ModelClass.IMAGE]?: ImageModelSettings;
  };
}

/**
 * Complete models configuration
 */
export interface Models {
  [key: string]: ProviderConfig;
}

/**
 * Image inputs for vision-capable models.
 * - Use `url` for public URLs or prebuilt data URLs.
 * - Use `base64Data` (with optional mimeType) for raw base64 payloads that need data URL wrapping.
 * - Use `data` when you have a Buffer and want the helper to handle encoding.
 */
export type ImageInput =
  | { url: string }
  | { base64Data: string; mimeType?: string }
  | { data: Buffer; mimeType?: string };

/**
 * Generation options for AI calls
 */
export interface GenerationOptions {
  runtime: any; // CoC runtime interface
  context: string;
  modelClass?: ModelClass;
  customSystemPrompt?: string;
  maxRetries?: number;
  images?: ImageInput[];
  onToken?: (token: string) => void;
  userId?: string;
  operation?: string;
}
