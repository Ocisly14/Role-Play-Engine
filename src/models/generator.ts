/**
 * CoC Agent Model Generation System
 * Handles model selection and text generation with appropriate model classes
 */

import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { models } from "./configuration.js";
import {
  ModelClass,
  ModelProviderName,
  GenerationOptions,
  ImageInput,
  ModelSettings,
} from "./types.js";
import { attachUsageTracking } from "./tokenUsage.js";

/**
 * Model class usage guidelines:
 * - SMALL: Quick responses, simple classifications, basic conversational turns
 * - MEDIUM: Standard gameplay interactions, character agent responses, memory queries
 * - LARGE: Complex reasoning, rule interpretations, comprehensive analysis, keeper responses
 */

/**
 * Resolves the effective model class based on runtime settings and overrides
 */
export function resolveModelClass(
  runtime: any,
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
  options?: { streaming?: boolean; operation?: string; userId?: string }
): any {
  const settings = getModelSettings(provider, modelClass);
  const endpoint = getEndpoint(provider);

  if (!settings) {
    throw new Error(
      `No settings found for provider ${provider} and model class ${modelClass}`
    );
  }

  let model: any;

  switch (provider) {
    case ModelProviderName.OPENAI:
      model = new ChatOpenAI({
        modelName: settings.name,
        temperature: settings.temperature,
        maxTokens: settings.maxOutputTokens,
        openAIApiKey: process.env.OPENAI_API_KEY,
        configuration: {
          baseURL: endpoint,
        },
      });
      break;

    case ModelProviderName.ANTHROPIC:
      model = new ChatAnthropic({
        modelName: settings.name,
        temperature: settings.temperature,
        maxTokens: settings.maxOutputTokens,
        anthropicApiKey: process.env.ANTHROPIC_API_KEY,
        clientOptions: {
          baseURL: endpoint,
        },
      });
      break;

    case ModelProviderName.GOOGLE:
      model = new ChatGoogleGenerativeAI({
        modelName: settings.name,
        temperature: settings.temperature,
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
    runtime,
    context,
    modelClass = ModelClass.MEDIUM,
    customSystemPrompt,
    maxRetries = 3,
    fallbackToLargeOnFailure = true,
    largeFallbackRetries = 3,
    images,
    onToken,
  } = options;

  // Get provider from environment variable, runtime, or default to OpenAI
  const envProvider = process.env.MODEL_PROVIDER as ModelProviderName;
  const provider =
    envProvider || runtime.modelProvider || ModelProviderName.OPENAI;

  // Resolve effective model class
  const effectiveModelClass = resolveModelClass(runtime, modelClass);

  // Prepare messages
  const messages: Array<{
    role: "system" | "user";
    content: string | Array<Record<string, unknown>>;
  }> = [];

  if (customSystemPrompt) {
    messages.push({
      role: "system",
      content: customSystemPrompt,
    });
  }

  // Build user content (may need to download images for Google)
  const userContent = await buildUserContent(provider, context, images);

  messages.push({
    role: "user",
    content: userContent,
  });

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

  const totalPlannedAttempts = phases.reduce(
    (sum, phase) => sum + phase.retries,
    0
  );
  let globalAttempt = 0;
  let lastErrorMessage = "Unknown error";
  let lastAttemptedModelClass: ModelClass = effectiveModelClass;

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

  const invokeModel = async (chatModel: any): Promise<string> => {
    if (
      onToken &&
      provider === ModelProviderName.GOOGLE &&
      typeof chatModel.stream === "function"
    ) {
      let fullContent = "";
      const stream = await chatModel.stream(messages);

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

    const response = await chatModel.invoke(messages);
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

    console.log(
      `✅ Generated text successfully (${responseText.length} characters)`
    );
    return responseText;
  };

  for (const phase of phases) {
    if (phase.label === "large_fallback") {
      console.warn(
        `⚠️ Primary model failed. Switching to ${provider}/${phase.modelClass} fallback (${phase.retries} retries).`
      );
    }

    const chatModel = createChatModel(provider, phase.modelClass, {
      streaming: provider === ModelProviderName.GOOGLE && Boolean(onToken),
      operation: options.operation,
      userId: options.userId,
    });

    for (let attempt = 1; attempt <= phase.retries; attempt++) {
      globalAttempt += 1;
      lastAttemptedModelClass = phase.modelClass;

      try {
        console.log(
          `🤖 Generating text (attempt ${globalAttempt}/${totalPlannedAttempts}, phase ${phase.label} ${attempt}/${phase.retries}) using ${provider}/${phase.modelClass}`
        );
        return await invokeModel(chatModel);
      } catch (error) {
        lastErrorMessage = toErrorMessage(error);
        console.error(
          `❌ Generation attempt ${globalAttempt} failed (${provider}/${phase.modelClass}):`,
          error
        );

        if (attempt < phase.retries) {
          const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
  }

  if (lastAttemptedModelClass === ModelClass.LARGE) {
    console.warn(
      `⚠️ ${provider}/${ModelClass.LARGE} exhausted retries. Waiting 30s before one final attempt.`
    );
    await new Promise((resolve) => setTimeout(resolve, 30000));

    const finalLargeModel = createChatModel(provider, ModelClass.LARGE, {
      streaming: provider === ModelProviderName.GOOGLE && Boolean(onToken),
      operation: options.operation,
      userId: options.userId,
    });

    try {
      console.log(
        `🤖 Generating text (final attempt after 30s) using ${provider}/${ModelClass.LARGE}`
      );
      return await invokeModel(finalLargeModel);
    } catch (error) {
      lastErrorMessage = toErrorMessage(error);
      console.error(
        `❌ Final attempt failed (${provider}/${ModelClass.LARGE}):`,
        error
      );
    }
  }

  throw new Error(
    `Failed to generate text after ${totalPlannedAttempts}${lastAttemptedModelClass === ModelClass.LARGE ? " + final large retry" : ""} attempts: ${lastErrorMessage}`
  );
}
