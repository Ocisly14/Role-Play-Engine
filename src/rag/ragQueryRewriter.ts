import { generateText, ModelClass } from "../models/index.js";
import {
  buildRagQueryTemplate,
  type BuildRagQueryTemplateInput,
} from "./templates/buildRagQueryTemplate.js";

export interface RagQueryRewriteInput
  extends BuildRagQueryTemplateInput {}

export interface RagQueryRewriteOutput {
  ragQuery: string;
  keywords: string[];
  entities: {
    sceneNames: string[];
    npcNames: string[];
  };
  rawQuestion: string;
}

type PartialRewriteOutput = {
  ragQuery?: unknown;
  keywords?: unknown;
  entities?: {
    sceneNames?: unknown;
    npcNames?: unknown;
  };
};

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    const fenced = fencedMatch[1].trim();
    if (fenced.startsWith("{") && fenced.endsWith("}")) {
      return fenced;
    }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0)
    )
  ).slice(0, 12);
}

function parseRewriteOutput(raw: string): PartialRewriteOutput | null {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) return null;

  try {
    const parsed = JSON.parse(jsonText) as PartialRewriteOutput;
    return parsed;
  } catch {
    return null;
  }
}

export class RagQueryRewriter {
  async rewrite(input: RagQueryRewriteInput): Promise<RagQueryRewriteOutput> {
    const rawQuestion = input.question.trim();
    const fallback: RagQueryRewriteOutput = {
      ragQuery: rawQuestion,
      keywords: [],
      entities: {
        sceneNames: input.sceneName ? [input.sceneName] : [],
        npcNames: toStringArray(input.npcNames || []),
      },
      rawQuestion,
    };

    if (!rawQuestion) {
      return fallback;
    }

    const prompt = buildRagQueryTemplate(input);

    try {
      const raw = await generateText({
        runtime: {},
        context: prompt,
        modelClass: ModelClass.SMALL,
        operation: "rag_query_rewrite",
        temperature: 0.1,
      });

      const parsed = parseRewriteOutput(raw);
      if (!parsed) {
        return fallback;
      }

      const ragQuery =
        typeof parsed.ragQuery === "string" && parsed.ragQuery.trim()
          ? parsed.ragQuery.trim()
          : rawQuestion;

      const keywords = toStringArray(parsed.keywords);
      const sceneNames = toStringArray(parsed.entities?.sceneNames);
      const npcNames = toStringArray(parsed.entities?.npcNames);

      return {
        ragQuery,
        keywords,
        entities: {
          sceneNames,
          npcNames,
        },
        rawQuestion,
      };
    } catch (error) {
      console.warn("[RagQueryRewriter] rewrite failed, fallback to raw question", error);
      return fallback;
    }
  }
}
