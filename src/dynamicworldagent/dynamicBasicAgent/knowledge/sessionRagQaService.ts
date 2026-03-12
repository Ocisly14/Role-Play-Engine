import { ModelClass, generateText } from "../../../models/index.js";
import { getPrismaClient } from "../../../shared/agents/memory/database/prismaClient.js";
import {
  type RagQueryRewriteOutput,
  RagQueryRewriter,
} from "./ragQueryRewriter.js";
import {
  type RetrievedSessionRagChunk,
  SessionRagService,
} from "./sessionRagService.js";

export interface RecentTurn {
  turnNumber: number;
  playerInput: string;
  keeperNarrative: string;
}

export interface SceneInfo {
  name: string;
  description: string;
}

export interface SessionRagQaRequest {
  sessionId: string;
  question: string;
  topK?: number;
  language?: "en" | "zh";
  sceneRoomId?: string | null;
  sceneName?: string | null;
  sceneLocation?: string | null;
  npcNames?: string[];
  playerName?: string | null;
  recentTurns?: RecentTurn[];
  allScenes?: SceneInfo[];
}

export interface SessionRagCitation {
  chunkId: string;
  turnNumber: number | null;
  chunkType: "turn" | "discovery";
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

/** Extract turnId from sourceKey format: turn:{turnId}:narrative:{i} */
function parseTurnId(sourceKey: string): string | null {
  const match = sourceKey.match(/^turn:([^:]+):/);
  return match?.[1] ?? null;
}

interface FullTurnNarrative {
  turnNumber: number;
  playerInput: string;
  keeperNarrative: string;
  sceneName: string | null;
  location: string | null;
  gameDay: number | null;
  gameTime: string | null;
}

async function fetchFullNarratives(
  chunks: RetrievedSessionRagChunk[]
): Promise<Map<string, FullTurnNarrative>> {
  const turnIdList = Array.from(
    new Set(
      chunks
        .map((c) => parseTurnId(c.sourceKey))
        .filter((id): id is string => id !== null)
    )
  );
  if (turnIdList.length === 0) return new Map();

  const prisma = getPrismaClient();
  const rows = await prisma.gameTurn.findMany({
    where: { turnId: { in: turnIdList } },
    select: {
      turnId: true,
      turnNumber: true,
      characterInput: true,
      keeperNarrative: true,
      sceneName: true,
      location: true,
      gameDay: true,
      gameTime: true,
    },
  });

  const result = new Map<string, FullTurnNarrative>();
  for (const r of rows) {
    if (r.turnId) {
      result.set(r.turnId, {
        turnNumber: r.turnNumber,
        playerInput: r.characterInput ?? "",
        keeperNarrative: r.keeperNarrative ?? "",
        sceneName: r.sceneName ?? null,
        location: r.location ?? null,
        gameDay: r.gameDay ?? null,
        gameTime: r.gameTime ?? null,
      });
    }
  }
  return result;
}

function buildEvidenceBlock(
  chunks: RetrievedSessionRagChunk[],
  fullNarrativeMap: Map<string, FullTurnNarrative>
): string {
  if (chunks.length === 0) return "";
  const entries = chunks.map((chunk, i) => {
    // For narrative chunks, use the full turn content from DB
    if (chunk.metadata?.segmentType === "narrative") {
      const turnId = parseTurnId(chunk.sourceKey);
      const full = turnId ? fullNarrativeMap.get(turnId) : null;
      if (full) {
        const timeParts = [
          full.gameDay != null ? `Day ${full.gameDay}` : null,
          full.gameTime || null,
        ].filter(Boolean);
        const timeStr =
          timeParts.length > 0 ? ` | time: ${timeParts.join(" ")}` : "";
        return [
          `[Memory${i + 1}]`,
          `turn: ${full.turnNumber}${timeStr}${full.sceneName ? ` | scene: ${full.sceneName}` : ""}${full.location ? ` | location: ${full.location}` : ""}`,
          `Player: ${full.playerInput || "(empty)"}`,
          `Keeper: ${full.keeperNarrative || "(empty)"}`,
        ].join("\n");
      }
    }
    // For actionlog and discovery chunks, use chunk content directly
    return [
      `[Memory${i + 1}]`,
      `turn: ${chunk.turnNumber ?? "unknown"}`,
      chunk.content,
    ].join("\n");
  });
  return entries.join("\n\n");
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
      playerName: request.playerName,
      language,
      recentTurns: request.recentTurns,
      allScenes: request.allScenes,
    });

    const retrieved = await this.ragService.searchHybrid({
      sessionId: request.sessionId,
      ragQuery: rewrite.ragQuery,
      topK: 5,
      semanticWeight: 0.7,
      bm25Weight: 0.3,
      language,
      sceneRoomId: request.sceneRoomId ?? null,
    });

    const citations = retrieved.map(buildCitation);

    if (retrieved.length === 0) {
      return {
        answer:
          language === "en"
            ? "The mists of memory offer nothing on that. Perhaps it hasn't come to pass yet — or the details were lost to the dark."
            : "记忆的迷雾中，关于这件事没有留下任何痕迹。也许还未发生，也许细节已消散于黑暗之中。",
        citations,
        retrievedCount: 0,
        ragQuery: rewrite.ragQuery,
        rewrite,
      };
    }

    const narrativeChunks = retrieved.filter(
      (c) => c.metadata?.segmentType === "narrative"
    );
    const fullNarrativeMap = await fetchFullNarratives(narrativeChunks);

    const evidenceSections = buildEvidenceBlock(retrieved, fullNarrativeMap);

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

    const answerPrompt = `You are the Keeper in a Call of Cthulhu RPG session, helping the player recall what has happened in their adventure.

Speak naturally in the voice of a Keeper recounting past events — immersive, atmospheric, and direct. Do NOT say phrases like "based on the records", "according to the evidence", or "the logs show". Just tell it as it happened.

Rules:
1. Only recall what is supported by the provided memory. Do not invent facts.
2. If the memory is insufficient to answer, say so briefly and in character.
3. Always capture: who was involved, where it happened, what occurred.
4. Keep it concise — 2 to 4 sentences.
5. Respond in ${language === "en" ? "English" : "Chinese"}.
6. Do NOT include source tags like [Memory1] in your answer.

Player Question:
${question}
${recentTurnsBlock ? `\nRecent Turns (context only, last ${recentTurns.length} turns):\n${recentTurnsBlock}\n` : ""}
Retrieved Evidence:
${evidenceSections}

Answer:`;

    let answer: string;
    try {
      answer = (
        await generateText({
          runtime: {},
          context: answerPrompt,
          modelClass: ModelClass.SMALL,
          operation: "rag_answer",
          temperature: 0.2,
        })
      ).trim();
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
