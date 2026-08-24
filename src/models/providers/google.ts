// src/models/providers/google.ts

import { GoogleGenerativeAI, type Part } from "@google/generative-ai";
import { normalizeUsageMetadata } from "../tokenUsage.js";
import { ModelProviderName } from "../types.js";
import type {
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ToolChatRequest,
  ToolChatResponse,
} from "./types.js";

/** Splits a `data:<mime>;base64,<payload>` URL into the inlineData shape. */
function toInlineData(dataUrl: string): Part {
  const match = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!match) {
    throw new Error("Google requires image inputs as base64 data URLs.");
  }
  return { inlineData: { mimeType: match[1], data: match[2] } };
}

export class GoogleAdapter implements ProviderAdapter {
  readonly provider = ModelProviderName.GOOGLE;

  private client(): GoogleGenerativeAI {
    return new GoogleGenerativeAI(process.env.GOOGLE_API_KEY ?? "");
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Google has no explicit prompt-cache breakpoints, so cacheControl flags
    // are not rendered here.
    const model = this.client().getGenerativeModel({
      model: req.modelName,
      ...(req.system && req.system.length > 0
        ? {
            systemInstruction: {
              role: "system",
              parts: [{ text: req.system.map((b) => b.text).join("") }],
            },
          }
        : {}),
      generationConfig: {
        ...(req.maxOutputTokens !== undefined
          ? { maxOutputTokens: req.maxOutputTokens }
          : {}),
        ...(req.temperature !== undefined
          ? { temperature: req.temperature }
          : {}),
      },
    });

    const parts: Part[] = req.content.map((part) =>
      part.kind === "text" ? { text: part.text } : toInlineData(part.dataUrl)
    );
    const request = { contents: [{ role: "user", parts }] };

    if (req.onToken) {
      const result = await model.generateContentStream(request);
      let text = "";
      for await (const chunk of result.stream) {
        const piece = chunk.text();
        if (piece) {
          text += piece;
          req.onToken(piece);
        }
      }
      const final = await result.response;
      return { text, usage: normalizeUsageMetadata(final.usageMetadata) };
    }

    const result = await model.generateContent(request);
    return {
      text: result.response.text(),
      usage: normalizeUsageMetadata(result.response.usageMetadata),
    };
  }

  async chatWithTools(_req: ToolChatRequest): Promise<ToolChatResponse> {
    // Google supports function calling, but only OpenAI and Anthropic are
    // first-class for the tool-using call sites. The text path above keeps
    // working for the renderer and daily summarization.
    throw new Error(
      "Native tool calling is not implemented for the Google provider."
    );
  }

  async embed(text: string, modelName: string): Promise<number[]> {
    const model = this.client().getGenerativeModel({ model: modelName });
    const result = await model.embedContent(text);
    return result.embedding.values;
  }
}
