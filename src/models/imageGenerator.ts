import { getEndpoint } from "./generator.js";
import { ModelClass, ModelProviderName } from "./types.js";
import { normalizeUsageMetadata, recordTokenUsage } from "./tokenUsage.js";

export interface GeneratedImage {
  mimeType: string;
  base64Data: string;
  dataUrl: string;
  model: string;
  prompt: string;
}

export interface ImageGenerationOptions {
  model?: string;
  aspectRatio?: string;
}

export async function generateGeminiImage(
  prompt: string,
  options: ImageGenerationOptions = {}
): Promise<GeneratedImage> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GOOGLE_API_KEY for Gemini image generation");
  }

  const model = options.model || process.env.GOOGLE_IMAGE_MODEL || "gemini-2.5-flash-image";
  const endpoint =
    getEndpoint(ModelProviderName.GOOGLE) || "https://generativelanguage.googleapis.com";
  const url = `${endpoint}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const aspectRatio = options.aspectRatio || process.env.GOOGLE_IMAGE_ASPECT_RATIO || "16:9";

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio },
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini image generation failed: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const usage = normalizeUsageMetadata(
    data?.usageMetadata || data?.usage_metadata || data?.usage
  );
  if (usage) {
    recordTokenUsage({
      provider: ModelProviderName.GOOGLE,
      modelClass: ModelClass.IMAGE,
      modelName: model,
      operation: "image",
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
    });
  }
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((part: any) => part?.inlineData?.data || part?.inline_data?.data);

  if (!imagePart) {
    throw new Error("Gemini image generation returned no image data");
  }

  const inlineData = imagePart.inlineData || imagePart.inline_data;
  const base64Data = inlineData?.data;
  const mimeType = inlineData?.mimeType || inlineData?.mime_type || "image/png";

  if (!base64Data) {
    throw new Error("Gemini image generation returned empty image data");
  }

  return {
    mimeType,
    base64Data,
    dataUrl: `data:${mimeType};base64,${base64Data}`,
    model,
    prompt,
  };
}
