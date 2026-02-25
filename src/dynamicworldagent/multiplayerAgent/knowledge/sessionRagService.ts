import { randomUUID } from "crypto";
import { ModelProviderName } from "../../../models/types.js";
import { EmbeddingClient } from "../../../rag/embedding.js";
import { getPrismaClient } from "../../../shared/agents/memory/database/prismaClient.js";

export type SessionRagChunkType = "turn" | "clue";

export interface SessionRagChunkInput {
  sessionId: string;
  turnId?: string | null;
  turnNumber?: number | null;
  chunkType: SessionRagChunkType;
  role?: "character" | "keeper" | "system";
  content: string;
  metadata?: Record<string, unknown> | null;
  sourceKey: string;
  language?: "en" | "zh";
  emailId?: string | null;
}

export interface RetrievedSessionRagChunk {
  id: string;
  turnNumber: number | null;
  chunkType: SessionRagChunkType;
  content: string;
  metadata: Record<string, unknown> | null;
  sourceKey: string;
  score: number;
}

type ChunkRow = {
  id: string;
  turnNumber: number | null;
  chunkType: SessionRagChunkType;
  content: string;
  metadata: Record<string, unknown> | null;
  sourceKey: string;
  embedding: Buffer;
};

type Bm25Row = {
  id: string;
  bm25Score: number;
};

function normalizeScores(
  entries: Array<{ id: string; score: number }>
): Map<string, number> {
  if (entries.length === 0) return new Map();

  const scores = entries.map((entry) => entry.score);
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const range = max - min || 1;

  const normalized = new Map<string, number>();
  for (const entry of entries) {
    normalized.set(entry.id, (entry.score - min) / range);
  }
  return normalized;
}

function toFloatArray(buffer: Buffer): number[] {
  if (!buffer || buffer.length === 0) return [];
  const floatArray = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    Math.floor(buffer.byteLength / 4)
  );
  return Array.from(floatArray);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class SessionRagService {
  private static ensurePromise: Promise<void> | null = null;
  private prisma = getPrismaClient();
  private embedder: EmbeddingClient;

  constructor(provider?: ModelProviderName) {
    const modelProvider =
      provider ||
      (process.env.MODEL_PROVIDER as ModelProviderName) ||
      ModelProviderName.OPENAI;
    this.embedder = new EmbeddingClient(modelProvider);
  }

  private async ensureInfrastructure(): Promise<void> {
    if (!SessionRagService.ensurePromise) {
      SessionRagService.ensurePromise = (async () => {
        await this.prisma.$executeRawUnsafe(`
          CREATE TABLE IF NOT EXISTS session_rag_chunks (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            turn_id TEXT,
            turn_number INTEGER,
            chunk_type TEXT NOT NULL,
            role TEXT,
            content TEXT NOT NULL,
            metadata JSONB,
            source_key TEXT NOT NULL,
            embedding BYTEA NOT NULL,
            language TEXT,
            created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            email_id TEXT
          )
        `);

        await this.prisma.$executeRawUnsafe(
          `CREATE UNIQUE INDEX IF NOT EXISTS session_rag_chunks_session_source_key_key ON session_rag_chunks(session_id, source_key)`
        );
        await this.prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS idx_session_rag_chunks_session_created ON session_rag_chunks(session_id, created_at)`
        );
        await this.prisma.$executeRawUnsafe(
          `CREATE INDEX IF NOT EXISTS idx_session_rag_chunks_session_type ON session_rag_chunks(session_id, chunk_type)`
        );
      })();
    }

    await SessionRagService.ensurePromise;
  }

  async upsertChunks(chunks: SessionRagChunkInput[]): Promise<void> {
    if (!Array.isArray(chunks) || chunks.length === 0) return;

    await this.ensureInfrastructure();

    for (const chunk of chunks) {
      const content = chunk.content?.trim();
      if (!content || !chunk.sessionId || !chunk.sourceKey) {
        continue;
      }

      try {
        const embedding = await this.embedder.embed(content, {
          language: chunk.language || "zh",
        });

        if (!embedding || embedding.length === 0) {
          continue;
        }

        const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);
        const metadataJson = JSON.stringify(chunk.metadata ?? null);

        await this.prisma.$executeRaw`
          INSERT INTO session_rag_chunks (
            id,
            session_id,
            turn_id,
            turn_number,
            chunk_type,
            role,
            content,
            metadata,
            source_key,
            embedding,
            language,
            email_id
          )
          VALUES (
            ${randomUUID()},
            ${chunk.sessionId},
            ${chunk.turnId ?? null},
            ${chunk.turnNumber ?? null},
            ${chunk.chunkType},
            ${chunk.role ?? null},
            ${content},
            ${metadataJson}::jsonb,
            ${chunk.sourceKey},
            ${embeddingBuffer},
            ${chunk.language ?? null},
            ${chunk.emailId ?? null}
          )
          ON CONFLICT (session_id, source_key) DO NOTHING
        `;
      } catch (error) {
        console.warn("[SessionRagService] failed to upsert chunk", {
          sessionId: chunk.sessionId,
          sourceKey: chunk.sourceKey,
          chunkType: chunk.chunkType,
          error,
        });
      }
    }
  }

  async searchHybrid(params: {
    sessionId: string;
    ragQuery: string;
    topK?: number;
    semanticWeight?: number;
    bm25Weight?: number;
    language?: "en" | "zh";
    chunkType?: "turn" | "clue";
    segmentType?: "narrative" | "actionlog";
  }): Promise<RetrievedSessionRagChunk[]> {
    const {
      sessionId,
      ragQuery,
      topK = 8,
      semanticWeight = 0.7,
      bm25Weight = 0.3,
      language = "zh",
      chunkType,
      segmentType,
    } = params;

    const query = ragQuery.trim();
    if (!sessionId || !query) return [];

    await this.ensureInfrastructure();

    const queryEmbedding = await this.embedder.embed(query, { language });
    if (!queryEmbedding || queryEmbedding.length === 0) {
      return [];
    }

    const chunkTypeFilter = chunkType ?? null;
    const segmentTypeFilter = segmentType ?? null;

    const rows = await this.prisma.$queryRaw<ChunkRow[]>`
      SELECT
        id,
        turn_number AS "turnNumber",
        chunk_type AS "chunkType",
        content,
        metadata,
        source_key AS "sourceKey",
        embedding
      FROM session_rag_chunks
      WHERE session_id = ${sessionId}
        AND language = ${language}
        AND (${chunkTypeFilter}::text IS NULL OR chunk_type = ${chunkTypeFilter}::text)
        AND (${segmentTypeFilter}::text IS NULL OR metadata->>'segmentType' = ${segmentTypeFilter}::text)
    `;

    if (!rows.length) {
      return [];
    }

    const candidateK = Math.max(topK * 6, 24);

    const semanticScored = rows
      .map((row) => {
        const similarity = cosineSimilarity(
          queryEmbedding,
          toFloatArray(row.embedding)
        );
        return { id: row.id, score: similarity };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, candidateK);

    let bm25Scored: Bm25Row[] = [];
    try {
      bm25Scored = await this.prisma.$queryRaw<Bm25Row[]>`
        SELECT
          id,
          ts_rank_cd(
            to_tsvector('simple', content),
            plainto_tsquery('simple', ${query})
          ) AS "bm25Score"
        FROM session_rag_chunks
        WHERE session_id = ${sessionId}
          AND language = ${language}
          AND (${chunkTypeFilter}::text IS NULL OR chunk_type = ${chunkTypeFilter}::text)
          AND (${segmentTypeFilter}::text IS NULL OR metadata->>'segmentType' = ${segmentTypeFilter}::text)
          AND to_tsvector('simple', content) @@ plainto_tsquery('simple', ${query})
        ORDER BY "bm25Score" DESC
        LIMIT ${candidateK}
      `;
    } catch (error) {
      console.warn(
        "[SessionRagService] BM25 query failed, fallback semantic only",
        error
      );
    }

    const semanticMap = normalizeScores(semanticScored);
    const bm25Map = normalizeScores(
      bm25Scored.map((row) => ({
        id: row.id,
        score: Number(row.bm25Score || 0),
      }))
    );

    const rowMap = new Map(rows.map((row) => [row.id, row]));
    const allIds = new Set<string>([...semanticMap.keys(), ...bm25Map.keys()]);

    const fused: RetrievedSessionRagChunk[] = [];
    for (const id of allIds) {
      const row = rowMap.get(id);
      if (!row) continue;

      const semantic = semanticMap.get(id) ?? 0;
      const bm25 = bm25Map.get(id) ?? 0;
      const score = semanticWeight * semantic + bm25Weight * bm25;

      fused.push({
        id: row.id,
        turnNumber: row.turnNumber ?? null,
        chunkType: row.chunkType,
        content: row.content,
        metadata: row.metadata ?? null,
        sourceKey: row.sourceKey,
        score,
      });
    }

    return fused.sort((a, b) => b.score - a.score).slice(0, topK);
  }
}
