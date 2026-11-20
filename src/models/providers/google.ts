// src/models/providers/google.ts

import {
  type Content,
  type FunctionCall,
  FunctionCallingMode,
  GoogleGenerativeAI,
  type Part,
} from "@google/generative-ai";
import { normalizeUsageMetadata } from "../tokenUsage.js";
import { ModelProviderName } from "../types.js";
import type {
  ChatRequest,
  ChatResponse,
  ContentPart,
  ModelMessage,
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

function toGooglePart(part: ContentPart): Part {
  return part.kind === "text"
    ? { text: part.text }
    : toInlineData(part.dataUrl);
}

type GeminiFunctionCall = FunctionCall & { id?: string };

function toGoogleHistory(messages: ModelMessage[]): Content[] {
  const calls = new Map<string, GeminiFunctionCall>();
  return messages.map((message): Content => {
    if (message.role === "user") {
      return { role: "user", parts: message.content.map(toGooglePart) };
    }

    if (message.role === "assistant") {
      const parts: Part[] = message.geminiParts ?? [
        ...(message.text ? [{ text: message.text }] : []),
        ...message.toolCalls.map(({ name, args }) => ({
          functionCall: { name, args },
        })),
      ];
      const functionParts = parts.flatMap((part) =>
        part.functionCall ? [part.functionCall] : []
      );
      message.toolCalls.forEach((call, index) => {
        calls.set(call.id, functionParts[index]);
      });
      return { role: "model", parts };
    }

    return {
      role: "user",
      parts: message.results.map((result) => {
        const call = calls.get(result.toolCallId);
        if (!call)
          throw new Error(
            `Missing Gemini function call for result ${result.toolCallId}`
          );
        const functionResponse = {
          name: call.name,
          ...(call.id ? { id: call.id } : {}),
          response: { output: result.content },
        };
        return { functionResponse };
      }),
    };
  });
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

    const parts = req.content.map(toGooglePart);
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

  async chatWithTools(req: ToolChatRequest): Promise<ToolChatResponse> {
    const model = this.client().getGenerativeModel({ model: req.modelName });
    // The SDK passes the declarations through to the API. Use its JSON
    // Schema field so the engine's nested unions reach Gemini intact.
    const functionDeclarations = req.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parametersJsonSchema: tool.inputSchema,
    }));
    const result = await model.generateContent({
      contents: toGoogleHistory(req.messages),
      ...(req.system?.length
        ? { systemInstruction: req.system.map((block) => block.text).join("") }
        : {}),
      tools: [{ functionDeclarations }],
      ...(req.toolChoice
        ? {
            toolConfig: {
              functionCallingConfig: {
                mode: FunctionCallingMode.ANY,
                ...(req.toolChoice === "any"
                  ? {}
                  : { allowedFunctionNames: [req.toolChoice.name] }),
              },
            },
          }
        : {}),
      generationConfig: {
        maxOutputTokens: req.maxOutputTokens,
        temperature: req.temperature,
      },
    });
    const parts = result.response.candidates?.[0]?.content?.parts ?? [];
    const toolCalls = parts.flatMap((part, index) => {
      const call: GeminiFunctionCall | undefined = part.functionCall;
      if (!call) return [];
      return [
        {
          id: call.id ?? `gemini_${req.messages.length}_${index}`,
          name: call.name,
          args: (call.args ?? {}) as Record<string, unknown>,
        },
      ];
    });
    return {
      toolCalls,
      text: parts.map((part) => part.text ?? "").join(""),
      geminiParts: parts,
      usage: normalizeUsageMetadata(result.response.usageMetadata),
    };
  }

  async embed(text: string, modelName: string): Promise<number[]> {
    const model = this.client().getGenerativeModel({ model: modelName });
    const result = await model.embedContent(text);
    return result.embedding.values;
  }
}
