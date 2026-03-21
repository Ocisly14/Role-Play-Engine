/**
 * Database Operations Abstraction Layer
 * Reimplements CoCDatabase methods using Prisma ORM
 *
 * This layer provides backward-compatible methods on top of Prisma + PostgreSQL.
 */

import { randomUUID } from "crypto";
import type { PrismaClient } from "./prismaClient.js";

export class DatabaseOperations {
  constructor(private prisma: PrismaClient) {}

  // =====================================================
  // CORE DATABASE METHODS
  // =====================================================

  /**
   * Get Prisma Client instance
   * Replacement for: db.getDatabase()
   */
  getDatabase(): PrismaClient {
    return this.prisma;
  }

  /**
   * Transaction wrapper
   * Usage: await operations.transaction(async (tx) => { ... })
   */
  async transaction<T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      return fn(tx as PrismaClient);
    });
  }

  // =====================================================
  // USER TOKEN USAGE TRACKING
  // =====================================================

  /**
   * Record user token usage
   * Replacement for: db.recordUserTokenUsage(payload)
   */
  async recordUserTokenUsage(payload: {
    email: string;
    provider: string;
    modelName: string;
    modelClass: string;
    operation: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }): Promise<void> {
    await this.prisma.userTokenUsage.create({
      data: {
        id: randomUUID(),
        emailId: payload.email,
        provider: payload.provider,
        modelName: payload.modelName,
        modelClass: payload.modelClass,
        operation: payload.operation,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        totalTokens: payload.totalTokens,
      },
    });
  }

  // =====================================================
  // TURN MANAGEMENT
  // =====================================================

  /**
   * Get turn by ID
   * Replacement for: db.getTurn(turnId)
   */
  async getTurn(turnId: string): Promise<any | null> {
    const turn = await this.prisma.gameTurn.findUnique({
      where: { turnId },
    });

    if (!turn) return null;

    // Convert to format expected by existing code
    return {
      turn_id: turn.turnId,
      session_id: turn.sessionId,
      turn_number: turn.turnNumber,
      character_input: turn.characterInput,
      character_id: turn.characterId,
      character_name: turn.characterName,
      scene_room_id: turn.sceneRoomId ?? null,
      action_analysis: turn.actionAnalysis,
      action_results: turn.actionResults,
      director_decision: turn.directorDecision,
      keeper_narrative: turn.keeperNarrative,
      scene_id: turn.sceneId,
      scene_name: turn.sceneName,
      location: turn.location,
      status: turn.status,
      error_message: turn.errorMessage,
      started_at: turn.startedAt.toISOString(),
      completed_at: turn.completedAt?.toISOString() || null,
      created_at: turn.createdAt.toISOString(),
      game_day: turn.gameDay,
      game_time: turn.gameTime,
    };
  }

  /**
   * Get latest turn for a session
   * Replacement for: db.getLatestTurn(sessionId)
   */
  async getLatestTurn(sessionId: string): Promise<any | null> {
    const turn = await this.prisma.gameTurn.findFirst({
      where: { sessionId },
      orderBy: { turnNumber: "desc" },
    });

    if (!turn) return null;

    return this.formatTurn(turn);
  }

  /**
   * Get turn history
   * Replacement for: db.getTurnHistory(sessionId, limit, afterTurnNumber)
   */
  async getTurnHistory(
    sessionId: string,
    limit = 20,
    afterTurnNumber?: number,
    sceneRoomId?: string | string[]
  ): Promise<any[]> {
    const sceneRoomFilter = Array.isArray(sceneRoomId)
      ? { sceneRoomId: { in: sceneRoomId } }
      : sceneRoomId
        ? { sceneRoomId }
        : {};
    const turns = await this.prisma.gameTurn.findMany({
      where: {
        sessionId,
        ...sceneRoomFilter,
        ...(afterTurnNumber ? { turnNumber: { gt: afterTurnNumber } } : {}),
      },
      orderBy: { turnNumber: "asc" },
      take: limit,
    });

    return turns.map((turn) => this.formatTurn(turn));
  }

  /**
   * Get next turn number
   * Replacement for: db.getNextTurnNumber(sessionId)
   */
  async getNextTurnNumber(sessionId: string): Promise<number> {
    const latest = await this.prisma.gameTurn.findFirst({
      where: { sessionId },
      orderBy: { turnNumber: "desc" },
      select: { turnNumber: true },
    });

    return latest ? latest.turnNumber + 1 : 1;
  }

  /**
   * Mark turn as error
   * Replacement for: db.markTurnError(turnId, errorMessage)
   */
  async markTurnError(turnId: string, errorMessage: string): Promise<void> {
    await this.prisma.gameTurn.update({
      where: { turnId },
      data: {
        status: "error",
        errorMessage,
        completedAt: new Date(),
      },
    });
  }

  /**
   * Mark turn as requiring skill selection
   * Replacement for: db.markTurnRequiresSkillSelection(turnId, actionAnalysis)
   */
  async markTurnRequiresSkillSelection(
    turnId: string,
    actionAnalysis: any
  ): Promise<void> {
    await this.prisma.gameTurn.update({
      where: { turnId },
      data: {
        status: "requires_skill_selection",
        actionAnalysis,
      },
    });
  }

  // =====================================================
  // FULL-TEXT SEARCH (PostgreSQL)
  // =====================================================

  /**
   * Search game events using PostgreSQL full-text search
   * Replacement for: db.searchEvents(sessionId, query, limit)
   *
   * NOTE: Requires search_vector column to be populated
   */
  async searchEvents(
    sessionId: string,
    query: string,
    limit = 10
  ): Promise<any[]> {
    // Use PostgreSQL full-text search with tsvector
    const results = await this.prisma.$queryRaw<any[]>`
      SELECT *
      FROM game_events
      WHERE session_id = ${sessionId}
        AND to_tsvector('english', details::text) @@ plainto_tsquery('english', ${query})
      ORDER BY ts_rank(to_tsvector('english', details::text), plainto_tsquery('english', ${query})) DESC
      LIMIT ${limit}
    `;

    return results;
  }

  // =====================================================
  // EMBEDDING SIMILARITY SEARCH
  // =====================================================

  /**
   * Search similar turns using vector similarity
   * Replacement for: db.searchTurnEmbeddings(params)
   *
   * NOTE: Requires pgvector extension and embedding column to be vector type
   */
  async searchTurnEmbeddings(params: {
    sessionId: string;
    embedding: number[];
    topK?: number;
  }): Promise<any[]> {
    const { sessionId, embedding, topK = 5 } = params;

    // Convert number array to Buffer for PostgreSQL
    const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);

    // Use pgvector for similarity search
    // NOTE: This requires pgvector extension to be installed
    try {
      const results = await this.prisma.$queryRaw<any[]>`
        SELECT *,
          1 - (embedding <=> ${embeddingBuffer}::vector) as similarity
        FROM turn_embeddings
        WHERE session_id = ${sessionId}
        ORDER BY embedding <=> ${embeddingBuffer}::vector
        LIMIT ${topK}
      `;

      return results;
    } catch (error) {
      console.warn(
        "Vector similarity search failed (pgvector not installed?)",
        error
      );
      // Fallback to manual cosine similarity (slower)
      return this.fallbackSimilaritySearch(sessionId, embedding, topK);
    }
  }

  /**
   * Fallback similarity search using manual cosine similarity
   * Used when pgvector extension is not available
   */
  private async fallbackSimilaritySearch(
    sessionId: string,
    queryEmbedding: number[],
    topK: number
  ): Promise<any[]> {
    // Fetch all embeddings for this session
    const allEmbeddings = await this.prisma.turnEmbedding.findMany({
      where: { sessionId },
    });

    // Calculate cosine similarity for each
    const scored = allEmbeddings.map((item) => {
      const embedding = this.deserializeEmbedding(item.embedding);
      const similarity = this.cosineSimilarity(queryEmbedding, embedding);
      return { ...item, similarity };
    });

    // Sort by similarity and take top K
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    const dotProduct = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dotProduct / (magA * magB);
  }

  /**
   * Deserialize embedding from Buffer to number array
   */
  private deserializeEmbedding(buffer: Buffer | Uint8Array): number[] {
    const float32Array = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength / 4
    );
    return Array.from(float32Array);
  }

  // =====================================================
  // HELPER METHODS
  // =====================================================

  /**
   * Format turn object to match old schema format
   */
  private formatTurn(turn: any): any {
    return {
      turn_id: turn.turnId,
      session_id: turn.sessionId,
      turn_number: turn.turnNumber,
      character_input: turn.characterInput,
      character_id: turn.characterId,
      character_name: turn.characterName,
      scene_room_id: turn.sceneRoomId ?? null,
      action_analysis: turn.actionAnalysis,
      action_results: turn.actionResults,
      director_decision: turn.directorDecision,
      keeper_narrative: turn.keeperNarrative,
      scene_id: turn.sceneId,
      scene_name: turn.sceneName,
      location: turn.location,
      status: turn.status,
      error_message: turn.errorMessage,
      started_at: turn.startedAt.toISOString(),
      completed_at: turn.completedAt?.toISOString() || null,
      created_at: turn.createdAt.toISOString(),
      game_day: turn.gameDay,
      game_time: turn.gameTime,
    };
  }
}
