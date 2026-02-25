import { ModelClass, generateText } from "../../../models/index.js";
import {
  type BuildRagQueryTemplateInput,
  buildRagQueryTemplate,
} from "./buildRagQueryTemplate.js";

export type { RecentTurnContext } from "./buildRagQueryTemplate.js";
export interface RagQueryRewriteInput extends BuildRagQueryTemplateInput {}

export interface RagQueryRewriteOutput {
  ragQuery: string;
  rawQuestion: string;
}

function extractRagQuery(text: string): string | null {
  const trimmed = text.trim();

  // Try fenced code block first
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() ?? trimmed;

  // Find JSON object bounds
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;

  try {
    const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1)) as {
      ragQuery?: unknown;
    };
    return typeof parsed.ragQuery === "string" && parsed.ragQuery.trim()
      ? parsed.ragQuery.trim()
      : null;
  } catch {
    return null;
  }
}

export class RagQueryRewriter {
  async rewrite(input: RagQueryRewriteInput): Promise<RagQueryRewriteOutput> {
    const rawQuestion = input.question.trim();

    if (!rawQuestion) {
      return { ragQuery: rawQuestion, rawQuestion };
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

      const ragQuery = extractRagQuery(raw) ?? rawQuestion;
      return { ragQuery, rawQuestion };
    } catch (error) {
      console.warn(
        "[RagQueryRewriter] rewrite failed, fallback to raw question",
        error
      );
      return { ragQuery: rawQuestion, rawQuestion };
    }
  }
}
