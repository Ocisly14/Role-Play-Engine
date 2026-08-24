/**
 * CoC Agent Model Types and Configuration
 * Model selection system with small/medium/large categorization
 */

/**
 * Model size/type classification for different tasks
 */
export enum ModelClass {
  SMALL = "small", // Fast, lightweight models for simple tasks
  MEDIUM = "medium", // Balanced models for general conversational tasks
  LARGE = "large", // Heavy models for complex reasoning and analysis
  EMBEDDING = "embedding", // Specialized for vector embeddings
  IMAGE = "image", // Image generation models
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
  OPENROUTER = "openrouter",
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
 * One piece of the user prompt, optionally ending at a prompt-cache
 * breakpoint. Segments are concatenated with NO separator — a builder that
 * emits them must embed its own separators — so the assembled prompt is
 * byte-identical to the equivalent single `context` string.
 */
export interface PromptSegment {
  text: string;
  /**
   * Place a provider-native prompt-cache breakpoint at the end of this
   * segment, caching everything before it (system prompt included).
   *
   * Only meaningful for providers with explicit breakpoints (Anthropic).
   * OpenAI caches long prefixes automatically and ignores this; other
   * providers ignore it too. Mark only boundaries where the preceding text
   * is genuinely stable across calls — a breakpoint whose prefix changes
   * every request pays the write premium and is never read.
   */
  cache?: boolean;
}

/**
 * Generation options for AI calls
 */
export interface GenerationOptions {
  context: string;
  /**
   * Segmented form of `context`, enabling prompt-cache breakpoints. When
   * present this takes precedence over `context`, and the concatenation of
   * all segment texts is what gets sent. Ignored when `images` are supplied.
   */
  contextSegments?: PromptSegment[];
  /**
   * Place a prompt-cache breakpoint at the end of `customSystemPrompt`,
   * caching it (and any tool definitions) for later calls.
   *
   * Only set this when the system prompt is byte-identical across calls. A
   * system prompt that interpolates per-request state is a new prefix every
   * time: the breakpoint pays the write premium and is never read.
   * Anthropic-only; other providers ignore it.
   */
  cacheSystemPrompt?: boolean;
  modelClass?: ModelClass;
  providerOverride?: ModelProviderName;
  customSystemPrompt?: string;
  maxRetries?: number;
  fallbackToLargeOnFailure?: boolean;
  largeFallbackRetries?: number;
  images?: ImageInput[];
  onToken?: (token: string) => void;
  userId?: string;
  operation?: string;
  temperature?: number;
}
