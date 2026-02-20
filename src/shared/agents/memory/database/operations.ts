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
      action_analysis: turn.actionAnalysis,
      action_results: turn.actionResults,
      director_decision: turn.directorDecision,
      keeper_narrative: turn.keeperNarrative,
      clue_revelations: turn.clueRevelations,
      scene_id: turn.sceneId,
      scene_name: turn.sceneName,
      location: turn.location,
      status: turn.status,
      error_message: turn.errorMessage,
      started_at: turn.startedAt.toISOString(),
      completed_at: turn.completedAt?.toISOString() || null,
      created_at: turn.createdAt.toISOString(),
      is_simulated: turn.isSimulated,
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
    afterTurnNumber?: number
  ): Promise<any[]> {
    const turns = await this.prisma.gameTurn.findMany({
      where: {
        sessionId,
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

  /**
   * Mark turn as requiring combat response (player must respond to NPC attacks)
   */
  async markTurnRequiresCombatResponse(
    turnId: string,
    npcAttackNarrative: string,
    pendingNpcActions: any[]
  ): Promise<void> {
    await this.prisma.gameTurn.update({
      where: { turnId },
      data: {
        status: "requires_combat_response",
        keeperNarrative: npcAttackNarrative,
        actionResults: pendingNpcActions as any,
      },
    });
  }

  // =====================================================
  // CHECKPOINT MANAGEMENT
  // =====================================================

  /**
   * Save checkpoint
   * Replacement for: db.saveCheckpoint(...)
   */
  async saveCheckpoint(params: {
    checkpointId: string;
    sessionId: string;
    turnNumber: number;
    checkpointName?: string;
    gameState: any;
    currentSceneName?: string;
    isAutoCheckpoint?: boolean;
  }): Promise<void> {
    const sessionScope = await this.prisma.session.findUnique({
      where: { sessionId: params.sessionId },
      select: { moduleId: true, emailId: true },
    });

    await this.prisma.gameCheckpoint.create({
      data: {
        checkpointId: params.checkpointId,
        sessionId: params.sessionId,
        moduleId: sessionScope?.moduleId || null,
        emailId: sessionScope?.emailId || null,
        turnNumber: params.turnNumber,
        checkpointName: params.checkpointName,
        gameState: params.gameState,
        currentSceneName: params.currentSceneName,
        isAutoCheckpoint: params.isAutoCheckpoint || false,
      },
    });
  }

  /**
   * Load checkpoint
   * Replacement for: db.loadCheckpoint(checkpointId)
   */
  async loadCheckpoint(checkpointId: string): Promise<any | null> {
    const checkpoint = await this.prisma.gameCheckpoint.findUnique({
      where: { checkpointId },
    });

    if (!checkpoint) return null;

    return {
      checkpoint_id: checkpoint.checkpointId,
      session_id: checkpoint.sessionId,
      turn_number: checkpoint.turnNumber,
      checkpoint_name: checkpoint.checkpointName,
      game_state: checkpoint.gameState,
      current_scene_name: checkpoint.currentSceneName,
      is_auto_checkpoint: checkpoint.isAutoCheckpoint,
      created_at: checkpoint.createdAt.toISOString(),
    };
  }

  /**
   * List checkpoints
   * Replacement for: db.listCheckpoints(sessionId, limit)
   */
  async listCheckpoints(sessionId: string, limit = 50): Promise<any[]> {
    const checkpoints = await this.prisma.gameCheckpoint.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return checkpoints.map((cp) => ({
      checkpoint_id: cp.checkpointId,
      session_id: cp.sessionId,
      turn_number: cp.turnNumber,
      checkpoint_name: cp.checkpointName,
      current_scene_name: cp.currentSceneName,
      is_auto_checkpoint: cp.isAutoCheckpoint,
      created_at: cp.createdAt.toISOString(),
    }));
  }

  /**
   * Delete checkpoint
   * Replacement for: db.deleteCheckpoint(checkpointId)
   */
  async deleteCheckpoint(checkpointId: string): Promise<void> {
    await this.prisma.gameCheckpoint.delete({
      where: { checkpointId },
    });
  }

  /**
   * Cleanup auto checkpoints
   * Replacement for: db.cleanupAutoCheckpoints(sessionId, keepCount)
   */
  async cleanupAutoCheckpoints(
    sessionId: string,
    keepCount = 10
  ): Promise<void> {
    // Get all auto checkpoints for this session, ordered by creation date
    const autoCheckpoints = await this.prisma.gameCheckpoint.findMany({
      where: {
        sessionId,
        isAutoCheckpoint: true,
      },
      orderBy: { createdAt: "desc" },
    });

    // Delete checkpoints beyond the keep count
    if (autoCheckpoints.length > keepCount) {
      const toDelete = autoCheckpoints.slice(keepCount);
      await this.prisma.gameCheckpoint.deleteMany({
        where: {
          checkpointId: {
            in: toDelete.map((cp) => cp.checkpointId),
          },
        },
      });
    }
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
   * Search similar action logs using vector similarity
   * Replacement for: db.searchActionLogEmbeddings(params)
   *
   * NOTE: Requires pgvector extension and embedding column to be vector type
   */
  async searchActionLogEmbeddings(params: {
    sessionId: string;
    embedding: number[];
    topK?: number;
  }): Promise<any[]> {
    const { sessionId, embedding, topK = 5 } = params;

    // Convert number array to Buffer for PostgreSQL
    const embeddingBuffer = Buffer.from(new Float32Array(embedding).buffer);

    // Use pgvector for similarity search
    try {
      const results = await this.prisma.$queryRaw<any[]>`
        SELECT *,
          1 - (embedding <=> ${embeddingBuffer}::vector) as similarity
        FROM action_log_embeddings
        WHERE session_id = ${sessionId}
        ORDER BY embedding <=> ${embeddingBuffer}::vector
        LIMIT ${topK}
      `;

      return results;
    } catch (error) {
      console.warn(
        "Action log vector similarity search failed (pgvector not installed?)",
        error
      );
      // Fallback to manual cosine similarity (slower)
      return this.fallbackActionLogSimilaritySearch(sessionId, embedding, topK);
    }
  }

  /**
   * Fallback action log similarity search using manual cosine similarity
   * Used when pgvector extension is not available
   */
  private async fallbackActionLogSimilaritySearch(
    sessionId: string,
    queryEmbedding: number[],
    topK: number
  ): Promise<any[]> {
    // Fetch all action log embeddings for this session
    const allEmbeddings = await this.prisma.actionLogEmbedding.findMany({
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
      action_analysis: turn.actionAnalysis,
      action_results: turn.actionResults,
      director_decision: turn.directorDecision,
      keeper_narrative: turn.keeperNarrative,
      clue_revelations: turn.clueRevelations,
      scene_id: turn.sceneId,
      scene_name: turn.sceneName,
      location: turn.location,
      status: turn.status,
      error_message: turn.errorMessage,
      started_at: turn.startedAt.toISOString(),
      completed_at: turn.completedAt?.toISOString() || null,
      created_at: turn.createdAt.toISOString(),
      is_simulated: turn.isSimulated,
      game_day: turn.gameDay,
      game_time: turn.gameTime,
    };
  }
}
