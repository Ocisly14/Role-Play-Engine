/**
 * CoC Agent Model Generation System
 * Handles model selection and text generation with appropriate model classes
 */

import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import { models } from "./configuration.js";
import { attachUsageTracking } from "./tokenUsage.js";
import {
  type GenerationOptions,
  type ImageInput,
  ModelClass,
  ModelProviderName,
  type ModelSettings,
  type PromptSegment,
} from "./types.js";

/**
 * Model class usage guidelines:
 * - SMALL: Quick responses, simple classifications, basic conversational turns
 * - MEDIUM: Standard gameplay interactions, character agent responses, memory queries
 * - LARGE: Complex reasoning, rule interpretations, and narrative-heavy outputs
 */

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
 * Gets the endpoint for a specific provider
 */
export function getEndpoint(provider: ModelProviderName): string | undefined {
  return models[provider]?.endpoint;
}

function isOpenAIFixedParameterModel(modelName: string): boolean {
  const normalizedModelName = modelName.toLowerCase();
  return (
    normalizedModelName.startsWith("gpt-5") ||
    normalizedModelName.startsWith("o1") ||
    normalizedModelName.startsWith("o3") ||
    normalizedModelName.startsWith("o4")
  );
}

/**
 * Anthropic removed the sampling parameters (`temperature`, `top_p`, `top_k`)
 * on the Claude 4.6+ generation — sending any of them returns a 400
 * (`\`temperature\` is deprecated for this model`, `\`top_p\` cannot be set to
 * -1 for this model`). Verified live: claude-sonnet-5 rejects,
 * claude-haiku-4-5 accepts.
 *
 * Mirrors `isOpenAIFixedParameterModel` above. Matching is on the family
 * prefix so dated snapshots (e.g. `claude-sonnet-5-20260115`) are covered.
 */
function isAnthropicFixedParameterModel(modelName: string): boolean {
  const normalized = modelName.toLowerCase();
  return (
    normalized.startsWith("claude-opus-4-6") ||
    normalized.startsWith("claude-opus-4-7") ||
    normalized.startsWith("claude-opus-4-8") ||
    normalized.startsWith("claude-opus-5") ||
    normalized.startsWith("claude-sonnet-4-6") ||
    normalized.startsWith("claude-sonnet-5") ||
    normalized.startsWith("claude-fable-5") ||
    normalized.startsWith("claude-mythos-5")
  );
}

/**
 * The Anthropic SDK appends its own `/v1/messages` to `baseURL`, so a
 * configured endpoint that already ends in `/v1` produces `/v1/v1/messages`
 * and a 404 `not_found_error` on every call. (OpenAI is the opposite — its
 * SDK expects the `/v1` to be part of baseURL — which is why only this
 * provider needs the trim.)
 */
function anthropicBaseUrl(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  return endpoint.replace(/\/+(v1)?\/*$/, "") || undefined;
}

function getOpenAITokenConfig(
  modelName: string,
  maxOutputTokens?: number
): Record<string, unknown> {
  if (maxOutputTokens === undefined) {
    return {};
  }

  if (isOpenAIFixedParameterModel(modelName)) {
    return {
      modelKwargs: {
        max_completion_tokens: maxOutputTokens,
      },
    };
  }

  return { maxTokens: maxOutputTokens };
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
 * Render segmented user content for providers with explicit prompt-cache
 * breakpoints (Anthropic today).
 *
 * Each segment becomes its own `text` content block, and a segment marked
 * `cache` carries `cache_control: {type: "ephemeral"}`, which caches
 * everything before it — tools, system prompt, and preceding blocks.
 * @langchain/anthropic forwards `cache_control` verbatim off the content part
 * (see utils/message_inputs.js `_formatContent`).
 *
 * Anthropic allows at most 4 breakpoints per request; extra `cache` flags are
 * dropped (keeping the earliest, which cover the longest-lived prefixes)
 * rather than failing the request.
 */
const MAX_CACHE_BREAKPOINTS = 4;

function buildSegmentedContent(
  segments: PromptSegment[]
): Array<Record<string, unknown>> {
  let remaining = MAX_CACHE_BREAKPOINTS;
  return segments
    .filter((segment) => segment.text.length > 0)
    .map((segment) => {
      const useCache = segment.cache === true && remaining > 0;
      if (useCache) remaining -= 1;
      return {
        type: "text",
        text: segment.text,
        ...(useCache ? { cache_control: { type: "ephemeral" } } : {}),
      };
    });
}

/**
 * Build the user message content, attaching images for providers that support vision input.
 */
async function buildUserContent(
  provider: ModelProviderName,
  text: string,
  images?: ImageInput[]
): Promise<string | Array<Record<string, unknown>>> {
  if (!images || images.length === 0) {
    return text;
  }

  const formattedImages = await Promise.all(
    images.map((image) => formatImageInput(image, provider))
  );
  const textPart = text ? [{ type: "text", text }] : [];

  if (provider === ModelProviderName.GOOGLE) {
    return [
      ...textPart,
      ...formattedImages.map((imageUrl) => ({
        type: "image_url",
        image_url: imageUrl,
      })),
    ];
  }

  if (provider === ModelProviderName.OPENAI) {
    return [
      ...textPart,
      ...formattedImages.map((imageUrl) => ({
        type: "image_url",
        image_url: { url: imageUrl },
      })),
    ];
  }

  throw new Error(
    `Image inputs are only supported for Google or OpenAI providers (received ${provider}).`
  );
}

/**
 * Creates the appropriate chat model based on provider and settings
 */
export function createChatModel(
  provider: ModelProviderName,
  modelClass: ModelClass,
  options?: {
    streaming?: boolean;
    operation?: string;
    userId?: string;
    temperature?: number;
  }
): any {
  const settings = getModelSettings(provider, modelClass);
  const endpoint = getEndpoint(provider);

  if (!settings) {
    throw new Error(
      `No settings found for provider ${provider} and model class ${modelClass}`
    );
  }

  const temperature = options?.temperature ?? settings.temperature;

  let model: any;

  switch (provider) {
    case ModelProviderName.OPENAI: {
      const openAITokenConfig = getOpenAITokenConfig(
        settings.name,
        settings.maxOutputTokens
      );
      const openAITemperatureConfig = isOpenAIFixedParameterModel(settings.name)
        ? {}
        : { temperature };
      model = new ChatOpenAI({
        modelName: settings.name,
        ...openAITemperatureConfig,
        openAIApiKey: process.env.OPENAI_API_KEY,
        configuration: {
          baseURL: endpoint,
        },
        ...openAITokenConfig,
      });
      break;
    }

    case ModelProviderName.ANTHROPIC: {
      // LangChain's ChatAnthropic unconditionally sends temperature/top_k/top_p
      // (class defaults 1 / -1 / -1) for models it doesn't recognize, and the
      // 4.6+ generation rejects all three. `invocationKwargs` is spread last
      // into the request body, so setting them to undefined there removes the
      // keys (JSON.stringify drops undefined) — verified live against
      // claude-sonnet-5.
      const anthropicSamplingConfig = isAnthropicFixedParameterModel(
        settings.name
      )
        ? {
            invocationKwargs: {
              temperature: undefined,
              top_k: undefined,
              top_p: undefined,
            },
          }
        : { temperature };
      model = new ChatAnthropic({
        modelName: settings.name,
        ...anthropicSamplingConfig,
        maxTokens: settings.maxOutputTokens,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        clientOptions: {
          baseURL: anthropicBaseUrl(endpoint),
        },
      });
      break;
    }

    case ModelProviderName.GOOGLE:
      model = new ChatGoogleGenerativeAI({
        modelName: settings.name,
        temperature,
        maxOutputTokens: settings.maxOutputTokens,
        apiKey: process.env.GOOGLE_API_KEY,
        streaming: options?.streaming ?? false,
      });
      break;

    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }

  return attachUsageTracking(model, {
    provider,
    modelClass,
    modelName: settings.name,
    operation: options?.operation,
    email: options?.userId,
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
    modelClass = ModelClass.MEDIUM,
    providerOverride,
    customSystemPrompt,
    maxRetries = 3,
    fallbackToLargeOnFailure = false,
    largeFallbackRetries = 3,
    images,
    onToken,
    temperature,
    contextSegments,
    cacheSystemPrompt,
  } = options;

  // Get provider from environment variable or default to OpenAI
  const envProvider = process.env.MODEL_PROVIDER as ModelProviderName;
  const provider = providerOverride || envProvider || ModelProviderName.OPENAI;

  // Resolve effective model class
  const effectiveModelClass = resolveModelClass(modelClass);

  // Prepare messages
  const messages: Array<{
    role: "system" | "user";
    content: string | Array<Record<string, unknown>>;
  }> = [];

  // The provider is resolved above; only Anthropic understands an explicit
  // breakpoint, and only a block-shaped system message can carry one.
  const systemPromptIsCached =
    cacheSystemPrompt === true && provider === ModelProviderName.ANTHROPIC;

  if (customSystemPrompt) {
    messages.push({
      role: "system",
      content: systemPromptIsCached
        ? [
            {
              type: "text",
              text: customSystemPrompt,
              cache_control: { type: "ephemeral" },
            },
          ]
        : customSystemPrompt,
    });
  }

  const phases: Array<{
    modelClass: ModelClass;
    retries: number;
    label: "primary" | "large_fallback";
  }> = [
    {
      modelClass: effectiveModelClass,
      retries: Math.max(1, maxRetries),
      label: "primary",
    },
  ];

  if (
    fallbackToLargeOnFailure &&
    effectiveModelClass !== ModelClass.LARGE &&
    largeFallbackRetries > 0
  ) {
    phases.push({
      modelClass: ModelClass.LARGE,
      retries: Math.max(1, largeFallbackRetries),
      label: "large_fallback",
    });
  }

  const toErrorMessage = (error: unknown): string => {
    if (error instanceof Error && typeof error.message === "string") {
      return error.message;
    }
    if (typeof error === "string") return error;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  };

  const runWithProvider = async (
    providerForRun: ModelProviderName
  ): Promise<string> => {
    const totalPlannedAttempts = phases.reduce(
      (sum, phase) => sum + phase.retries,
      0
    );
    let globalAttempt = 0;
    let lastErrorMessage = "Unknown error";
    let lastAttemptedModelClass: ModelClass = effectiveModelClass;

    // Anthropic rejects an empty user turn outright
    // (`messages.0: user messages must have non-empty content`), while OpenAI
    // tolerates it. Callers that put the entire prompt in `customSystemPrompt`
    // and pass `context: ""` (the state resolver does) would therefore fail on
    // Anthropic only. Substitute a minimal instruction so every provider gets
    // a valid turn. (The better long-term shape is to move each caller's
    // volatile tail into the user turn — that also makes the system prefix
    // cacheable — but that changes prompt content, so it is not done here.)
    const segments =
      contextSegments && contextSegments.length > 0
        ? contextSegments
        : undefined;
    // Segments concatenate with no separator, so this is byte-identical to
    // the `context` string the caller would otherwise have passed.
    const joinedContext = segments
      ? segments.map((segment) => segment.text).join("")
      : context;
    const effectiveContext =
      joinedContext && joinedContext.trim().length > 0
        ? joinedContext
        : "Proceed with the instructions above.";

    // Explicit cache breakpoints are Anthropic-only, and the segmented shape
    // is incompatible with the image path (which builds its own block array),
    // so every other case sends the plain joined string exactly as before.
    const useSegmentedContent =
      segments !== undefined &&
      providerForRun === ModelProviderName.ANTHROPIC &&
      (!images || images.length === 0) &&
      segments.some((segment) => segment.cache === true);

    const userContent = useSegmentedContent
      ? buildSegmentedContent(segments)
      : await buildUserContent(providerForRun, effectiveContext, images);
    const providerMessages = [...messages];
    providerMessages.push({
      role: "user" as const,
      content: userContent,
    });

    const invokeModel = async (chatModel: any): Promise<string> => {
      if (
        onToken &&
        providerForRun === ModelProviderName.GOOGLE &&
        typeof chatModel.stream === "function"
      ) {
        let fullContent = "";
        const stream = await chatModel.stream(providerMessages);

        for await (const chunk of stream) {
          const content =
            (chunk as any)?.content ?? (chunk as any)?.message?.content ?? "";
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map((part: any) => part?.text ?? "").join("")
                : String(content ?? "");

          if (text) {
            fullContent += text;
            onToken(text);
          }
        }

        if (!fullContent) {
          throw new Error("Empty response from model");
        }

        console.log(
          `✅ Generated text successfully (${fullContent.length} characters)`
        );
        return fullContent;
      }

      const response = await chatModel.invoke(providerMessages);
      const content = (response as any)?.content;
      const responseText =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((part: any) => part?.text ?? "").join("")
            : "";

      if (!responseText) {
        throw new Error("Empty response from model");
      }

      const inputTokens = (response as any).usage_metadata?.input_tokens ?? "?";
      console.log(
        `✅ Generated text successfully (${responseText.length} characters, input tokens: ${inputTokens})`
      );
      return responseText;
    };

    for (const phase of phases) {
      if (phase.label === "large_fallback") {
        console.warn(
          `⚠️ Primary model failed. Switching to ${providerForRun}/${phase.modelClass} fallback (${phase.retries} retries).`
        );
      }

      const chatModel = createChatModel(providerForRun, phase.modelClass, {
        streaming:
          providerForRun === ModelProviderName.GOOGLE && Boolean(onToken),
        operation: options.operation,
        temperature,
        userId: options.userId,
      });

      for (let attempt = 1; attempt <= phase.retries; attempt++) {
        globalAttempt += 1;
        lastAttemptedModelClass = phase.modelClass;

        try {
          console.log(
            `🤖 Generating text (attempt ${globalAttempt}/${totalPlannedAttempts}, phase ${phase.label} ${attempt}/${phase.retries}) using ${providerForRun}/${phase.modelClass}`
          );
          return await invokeModel(chatModel);
        } catch (error) {
          lastErrorMessage = toErrorMessage(error);
          console.error(
            `❌ Generation attempt ${globalAttempt} failed (${providerForRun}/${phase.modelClass}):`,
            error
          );

          if (attempt < phase.retries) {
            const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      }
    }

    throw new Error(
      `Failed to generate text after ${totalPlannedAttempts} attempts with ${providerForRun}: ${lastErrorMessage}`
    );
  };

  try {
    return await runWithProvider(provider);
  } catch (primaryError) {
    const primaryErrorMessage = toErrorMessage(primaryError);
    const canFallbackToOpenAI =
      provider !== ModelProviderName.OPENAI &&
      Boolean(process.env.OPENAI_API_KEY?.trim());

    if (!canFallbackToOpenAI) {
      throw primaryError;
    }

    console.warn(
      `⚠️ ${provider} exhausted retry limits. Switching provider fallback to openai...`
    );

    try {
      return await runWithProvider(ModelProviderName.OPENAI);
    } catch (openaiError) {
      const openaiErrorMessage = toErrorMessage(openaiError);
      throw new Error(
        `Primary provider failed (${provider}): ${primaryErrorMessage}; OpenAI fallback failed: ${openaiErrorMessage}`
      );
    }
  }
}
