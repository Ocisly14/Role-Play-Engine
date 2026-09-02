/**
 * CoC Agent Model Generation System
 * Handles model selection and text generation with appropriate model classes
 */

import { getEndpoint, models } from "./configuration.js";
import { getAdapter } from "./providers/index.js";
import type { ContentPart, SystemBlock } from "./providers/types.js";
import { type TokenUsageTotals, recordTokenUsage } from "./tokenUsage.js";
import { traceModelCall } from "./trace.js";
import {
  type GenerationOptions,
  type ImageInput,
  ModelClass,
  ModelProviderName,
  type ModelSettings,
  type PromptSegment,
  type ToolCallOptions,
  type ToolCallResult,
} from "./types.js";

/**
 * Model class usage guidelines:
 * - SMALL: Quick responses, simple classifications, basic conversational turns
 * - MEDIUM: Standard gameplay interactions, character agent responses, memory queries
 * - LARGE: Complex reasoning, rule interpretations, and narrative-heavy outputs
 */

export { getEndpoint };

/**
 * Resolves the effective model class based on runtime settings and overrides
 */
export function resolveModelClass(
  requested: ModelClass = ModelClass.MEDIUM
): ModelClass {
  return requested;
}

/**
 * Gets model settings for a specific provider and class
 */
export function getModelSettings(
  provider: ModelProviderName,
  modelClass: ModelClass
): ModelSettings | undefined {
  return models[provider]?.model[modelClass] as ModelSettings | undefined;
}

/**
 * Download image from URL and convert to base64 data URL
 */
async function downloadImageAsBase64(url: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64 = buffer.toString("base64");

    // Try to detect MIME type from response headers
    const contentType = response.headers.get("content-type") || "image/jpeg";

    return `data:${contentType};base64,${base64}`;
  } catch (error) {
    throw new Error(`Failed to download image from URL ${url}: ${error}`);
  }
}

/**
 * Normalize image inputs to data URLs or pass-through URLs so providers receive a consistent payload.
 */
async function formatImageInput(
  image: ImageInput,
  provider: ModelProviderName
): Promise<string> {
  if ("url" in image) {
    // Google requires base64 data URLs, not regular URLs
    if (provider === ModelProviderName.GOOGLE) {
      // If it's already a data URL, return as-is
      if (image.url.startsWith("data:")) {
        return image.url;
      }
      // Otherwise download and convert to base64
      return await downloadImageAsBase64(image.url);
    }
    // Other providers can use URLs directly
    return image.url;
  }

  const mimeType = image.mimeType || "image/png";

  if ("data" in image) {
    const base64 = image.data.toString("base64");
    return `data:${mimeType};base64,${base64}`;
  }

  const sanitized = image.base64Data.replace(/^data:[^;]+;base64,/, "");
  return `data:${mimeType};base64,${sanitized}`;
}

/**
 * Anthropic allows at most 4 cache breakpoints per request; extra `cache`
 * flags are dropped (keeping the earliest, which cover the longest-lived
 * prefixes) rather than failing the request.
 */
const MAX_CACHE_BREAKPOINTS = 4;

/**
 * Build the provider-neutral user-turn content.
 *
 * Segments become separate text parts so a cache breakpoint can sit at a
 * segment boundary. Adapters that have no explicit breakpoints simply
 * concatenate the parts, which reproduces the single string a caller would
 * otherwise have passed — byte for byte, since segments carry their own
 * separators.
 */
async function buildContentParts(
  provider: ModelProviderName,
  segments: PromptSegment[] | undefined,
  text: string,
  images?: ImageInput[]
): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];

  if (segments && segments.length > 0) {
    let remaining = MAX_CACHE_BREAKPOINTS;
    for (const segment of segments) {
      if (segment.text.length === 0) continue;
      const useCache = segment.cache === true && remaining > 0;
      if (useCache) remaining -= 1;
      parts.push({ kind: "text", text: segment.text, cacheControl: useCache });
    }
  } else if (text.length > 0) {
    parts.push({ kind: "text", text });
  }

  if (images && images.length > 0) {
    if (
      provider !== ModelProviderName.GOOGLE &&
      provider !== ModelProviderName.OPENAI
    ) {
      throw new Error(
        `Image inputs are only supported for Google or OpenAI providers (received ${provider}).`
      );
    }
    const formatted = await Promise.all(
      images.map((image) => formatImageInput(image, provider))
    );
    for (const dataUrl of formatted) {
      parts.push({ kind: "image", dataUrl });
    }
  }

  return parts;
}

/**
 * Generates text using the appropriate model class for CoC scenarios
 */
/** Everything the retry/fallback policy needs, independent of what is being
 *  generated. */
interface PolicyOptions {
  providerOverride?: ModelProviderName;
  modelClass?: ModelClass;
  maxRetries?: number;
  fallbackToLargeOnFailure?: boolean;
  largeFallbackRetries?: number;
  operation?: string;
  userId?: string;
}

interface AttemptContext {
  provider: ModelProviderName;
  modelClass: ModelClass;
  settings: ModelSettings;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && typeof error.message === "string") {
    return error.message;
  }
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Runs `attempt` under the shared generation policy: primary model class with
 * retries and exponential backoff, plus an optional LARGE-class second phase.
 *
 * There is deliberately NO cross-provider fallback. It existed and was
 * removed: when the configured provider was exhausted it silently reran the
 * call on OpenAI, so a run that looked like it measured one provider had in
 * fact billed another for its most expensive calls — and a switch made to cut
 * cost quietly spent more. The retries below already absorb the transient
 * failures worth absorbing; a provider that is genuinely down should surface
 * as a failed action, not as someone else's answer.
 *
 * Kept generic over the result so text generation and tool calling share one
 * copy of this policy instead of two that drift apart.
 */
async function runWithPolicy<T>(
  options: PolicyOptions,
  attempt: (ctx: AttemptContext) => Promise<T>
): Promise<T> {
  const envProvider = process.env.MODEL_PROVIDER as ModelProviderName;
  const provider =
    options.providerOverride || envProvider || ModelProviderName.OPENAI;
  const effectiveModelClass = resolveModelClass(options.modelClass);

  const phases: Array<{
    modelClass: ModelClass;
    retries: number;
    label: "primary" | "large_fallback";
  }> = [
    {
      modelClass: effectiveModelClass,
      retries: Math.max(1, options.maxRetries ?? 3),
      label: "primary",
    },
  ];

  if (
    options.fallbackToLargeOnFailure &&
    effectiveModelClass !== ModelClass.LARGE &&
    (options.largeFallbackRetries ?? 3) > 0
  ) {
    phases.push({
      modelClass: ModelClass.LARGE,
      retries: Math.max(1, options.largeFallbackRetries ?? 3),
      label: "large_fallback",
    });
  }

  const runWithProvider = async (
    providerForRun: ModelProviderName
  ): Promise<T> => {
    const totalPlannedAttempts = phases.reduce(
      (sum, phase) => sum + phase.retries,
      0
    );
    let globalAttempt = 0;
    let lastErrorMessage = "Unknown error";

    for (const phase of phases) {
      if (phase.label === "large_fallback") {
        console.warn(
          `⚠️ Primary model failed. Switching to ${providerForRun}/${phase.modelClass} fallback (${phase.retries} retries).`
        );
      }

      const settings = getModelSettings(providerForRun, phase.modelClass);
      if (!settings) {
        throw new Error(
          `No model settings for ${providerForRun}/${phase.modelClass}`
        );
      }

      for (let tries = 1; tries <= phase.retries; tries++) {
        globalAttempt += 1;

        try {
          console.log(
            `🤖 Generating (attempt ${globalAttempt}/${totalPlannedAttempts}, phase ${phase.label} ${tries}/${phase.retries}) using ${providerForRun}/${phase.modelClass}`
          );
          return await attempt({
            provider: providerForRun,
            modelClass: phase.modelClass,
            settings,
          });
        } catch (error) {
          lastErrorMessage = toErrorMessage(error);
          console.error(
            `❌ Generation attempt ${globalAttempt} failed (${providerForRun}/${phase.modelClass}):`,
            error
          );

          if (tries < phase.retries) {
            const delay = 2 ** tries * 1000; // Exponential backoff
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
    }

    throw new Error(
      `Failed to generate after ${totalPlannedAttempts} attempts with ${providerForRun}: ${lastErrorMessage}`
    );
  };

  return runWithProvider(provider);
}

/** Records usage for one completed call. Shared by both entry points. */
function record(
  ctx: AttemptContext,
  options: PolicyOptions,
  usage: TokenUsageTotals | null
): void {
  if (!usage) return;
  recordTokenUsage({
    email: options.userId,
    provider: ctx.provider,
    modelClass: ctx.modelClass,
    modelName: ctx.settings.name,
    operation: options.operation,
    ...usage,
  });
}

/**
 * Generates text using the appropriate model class for CoC scenarios
 */
export async function generateText(
  options: GenerationOptions
): Promise<string> {
  const {
    context,
    customSystemPrompt,
    images,
    onToken,
    temperature,
    contextSegments,
    cacheSystemPrompt,
    maxOutputTokens,
  } = options;

  // Adapters that lack explicit breakpoints ignore `cacheControl`, so this is
  // provider-neutral.
  const system: SystemBlock[] | undefined = customSystemPrompt
    ? [{ text: customSystemPrompt, cacheControl: cacheSystemPrompt === true }]
    : undefined;

  const segments =
    contextSegments && contextSegments.length > 0 ? contextSegments : undefined;
  // Segments concatenate with no separator, so this is byte-identical to the
  // `context` string the caller would otherwise have passed.
  const joinedContext = segments
    ? segments.map((segment) => segment.text).join("")
    : context;
  // Anthropic rejects an empty user turn outright
  // (`messages.0: user messages must have non-empty content`), while OpenAI
  // tolerates it. Substitute a minimal instruction so every provider gets a
  // valid turn.
  const effectiveContext =
    joinedContext && joinedContext.trim().length > 0
      ? joinedContext
      : "Proceed with the instructions above.";

  // Built per provider (image handling differs) and reused across retries so
  // a remote image is not re-downloaded on every attempt.
  const contentByProvider = new Map<ModelProviderName, ContentPart[]>();

  return runWithPolicy(options, async (ctx) => {
    let content = contentByProvider.get(ctx.provider);
    if (!content) {
      content = await buildContentParts(
        ctx.provider,
        segments,
        effectiveContext,
        images
      );
      contentByProvider.set(ctx.provider, content);
    }

    const response = await getAdapter(ctx.provider).chat({
      modelName: ctx.settings.name,
      system,
      content,
      maxOutputTokens: maxOutputTokens ?? ctx.settings.maxOutputTokens,
      temperature,
      // Streaming exists only to feed onToken, and only Google wired it up.
      onToken:
        onToken && ctx.provider === ModelProviderName.GOOGLE
          ? onToken
          : undefined,
    });

    if (!response.text) {
      throw new Error("Empty response from model");
    }

    record(ctx, options, response.usage);
    traceModelCall({
      operation: options.operation,
      provider: ctx.provider,
      modelClass: ctx.modelClass,
      modelName: ctx.settings.name,
      system,
      request: content,
      response: response.text,
      usage: response.usage,
    });
    console.log(
      `✅ Generated text successfully (${response.text.length} characters, input tokens: ${response.usage?.input_tokens ?? "?"})`
    );
    return response.text;
  });
}

/**
 * Generates a native tool call.
 *
 * Unlike `generateText`, the envelope is enforced by the provider: with
 * `toolChoice` set the API must return a tool call, and `strict` schemas
 * guarantee the arguments parse. No JSON is extracted from prose.
 */
export async function generateToolCalls(
  options: ToolCallOptions
): Promise<ToolCallResult> {
  const system: SystemBlock[] | undefined = options.customSystemPrompt
    ? [
        {
          text: options.customSystemPrompt,
          cacheControl: options.cacheSystemPrompt === true,
        },
      ]
    : undefined;

  return runWithPolicy(options, async (ctx) => {
    const response = await getAdapter(ctx.provider).chatWithTools({
      modelName: ctx.settings.name,
      system,
      messages: options.messages,
      tools: options.tools,
      toolChoice: options.toolChoice,
      allowParallelCalls: options.allowParallelCalls,
      maxOutputTokens: ctx.settings.maxOutputTokens,
      temperature: options.temperature,
    });

    record(ctx, options, response.usage);

    if (response.toolCalls.length === 0) {
      // Only reachable when toolChoice was omitted, or a provider ignored it.
      throw new Error(
        `Model returned no tool call (text: ${response.text.slice(0, 120)})`
      );
    }

    // When parallel calls were not requested, keep only the first even if the
    // provider ignored the flag: the history stays answerable either way.
    const toolCalls = options.allowParallelCalls
      ? response.toolCalls
      : response.toolCalls.slice(0, 1);

    traceModelCall({
      operation: options.operation,
      provider: ctx.provider,
      modelClass: ctx.modelClass,
      modelName: ctx.settings.name,
      system,
      request: options.messages,
      response: { text: response.text, toolCalls },
      usage: response.usage,
      tools: options.tools,
    });
    console.log(
      `✅ Tool call ${toolCalls.map((c) => c.name).join(", ")} (input tokens: ${response.usage?.input_tokens ?? "?"})`
    );
    return {
      toolCalls,
      assistantMessage: {
        role: "assistant" as const,
        toolCalls,
        ...(response.text ? { text: response.text } : {}),
      },
    };
  });
}
