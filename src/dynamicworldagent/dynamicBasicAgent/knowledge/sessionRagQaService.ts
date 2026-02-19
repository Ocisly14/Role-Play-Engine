import { generateText, ModelClass } from "../../../models/index.js";
import {
  RagQueryRewriter,
  type RagQueryRewriteOutput,
} from "./ragQueryRewriter.js";
import {
  SessionRagService,
  type RetrievedSessionRagChunk,
} from "./sessionRagService.js";

export interface RecentTurn {
  turnNumber: number;
  playerInput: string;
  keeperNarrative: string;
}

export interface SessionRagQaRequest {
  sessionId: string;
  question: string;
  topK?: number;
  language?: "en" | "zh";
  sceneName?: string | null;
  sceneLocation?: string | null;
  npcNames?: string[];
  recentTurns?: RecentTurn[];
}

export interface SessionRagCitation {
  chunkId: string;
  turnNumber: number | null;
  chunkType: "turn" | "clue";
  snippet: string;
  score: number;
}

export interface SessionRagQaResponse {
  answer: string;
  citations: SessionRagCitation[];
  retrievedCount: number;
  ragQuery: string;
  rewrite: RagQueryRewriteOutput;
}

function buildEvidenceBlock(chunks: RetrievedSessionRagChunk[]): string {
  return chunks
    .map((chunk, index) => {
      const tag = `E${index + 1}`;
      return [
        `[${tag}]`,
        `turnNumber: ${chunk.turnNumber ?? "unknown"}`,
        `chunkType: ${chunk.chunkType}`,
        `content: ${chunk.content}`,
      ].join("\n");
    })
    .join("\n\n");
}

function buildCitation(chunk: RetrievedSessionRagChunk): SessionRagCitation {
  return {
    chunkId: chunk.id,
    turnNumber: chunk.turnNumber,
    chunkType: chunk.chunkType,
    snippet:
      chunk.content.length > 180
        ? `${chunk.content.slice(0, 180)}...`
        : chunk.content,
    score: Number(chunk.score.toFixed(4)),
  };
}

export class SessionRagQaService {
  private rewriter = new RagQueryRewriter();
  private ragService = new SessionRagService();

  async ask(request: SessionRagQaRequest): Promise<SessionRagQaResponse> {
    const question = request.question.trim();
    const language = request.language === "en" ? "en" : "zh";

    const rewrite = await this.rewriter.rewrite({
      question,
      sceneName: request.sceneName,
      sceneLocation: request.sceneLocation,
      npcNames: request.npcNames,
      language,
      recentTurns: request.recentTurns,
    });

    const retrieved = await this.ragService.searchHybrid({
      sessionId: request.sessionId,
      ragQuery: rewrite.ragQuery,
      topK: request.topK ?? 4,
      semanticWeight: 0.7,
      bm25Weight: 0.3,
    });

    const citations = retrieved.map(buildCitation);

    if (retrieved.length === 0) {
      return {
        answer:
          language === "en"
            ? "I cannot determine this from the current session records."
            : "基于当前会话记录，我无法确定这个问题的答案。",
        citations,
        retrievedCount: 0,
        ragQuery: rewrite.ragQuery,
        rewrite,
      };
    }

    const evidenceBlock = buildEvidenceBlock(retrieved);

    const recentTurns = request.recentTurns ?? [];
    const recentTurnsBlock =
      recentTurns.length > 0
        ? recentTurns
            .map(
              (t) =>
                `[Turn ${t.turnNumber}]\nPlayer: ${t.playerInput}\nKeeper: ${t.keeperNarrative}`
            )
            .join("\n\n")
        : null;

    const answerPrompt = `You are a session-memory assistant for a Call of Cthulhu RPG game.
Answer the player's question primarily based on the Retrieved Evidence below.

Rules:
1. Retrieved Evidence is the primary source of truth. Base your answer on it.
2. Recent Turns are provided only as conversational context to help you understand references or pronouns in the question — do NOT treat them as the answer source.
3. Answer ONLY using provided context. Do not invent facts.
4. If evidence is insufficient, say so explicitly.
5. Always include relevant details: WHO was involved (character/NPC names), WHERE it happened (location), and WHAT happened (actions and outcomes).
6. Keep the answer concise but informative — 2 to 4 sentences.
7. Respond in ${language === "en" ? "English" : "Chinese"}.
8. Do NOT include source tags like [E1], [E2] in your answer.

Player Question:
${question}
${
  recentTurnsBlock
    ? `
Recent Turns (for context only, last ${recentTurns.length} turns):
${recentTurnsBlock}
`
    : ""
}
Retrieved Evidence (primary source):
${evidenceBlock}

Answer:`;

    let answer: string;
    try {
      answer = (await generateText({
        runtime: {},
        context: answerPrompt,
        modelClass: ModelClass.SMALL,
        operation: "rag_answer",
        temperature: 0.2,
      })).trim();
    } catch (error) {
      console.warn("[SessionRagQaService] answer generation failed", error);
      answer =
        language === "en"
          ? "I found relevant records, but failed to generate an answer."
          : "我找到了相关记录，但生成回答失败。";
    }

    return {
      answer,
      citations,
      retrievedCount: retrieved.length,
      ragQuery: rewrite.ragQuery,
      rewrite,
    };
  }
}
