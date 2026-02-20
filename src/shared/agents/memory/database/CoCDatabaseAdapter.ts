/**
 * CoCDatabase Adapter
 * Provides backward-compatible API using Prisma underneath
 *
 * This adapter allows existing code that depends on CoCDatabase to continue working
 * without modification, while using PostgreSQL + Prisma internally.
 */

import { randomUUID } from "crypto";
import { DatabaseOperations } from "./operations.js";
import { type PrismaClient, getPrismaClient } from "./prismaClient.js";

export class CoCDatabaseAdapter {
  private prisma: PrismaClient;
  private operations: DatabaseOperations;
  private turnCache = new Map<string, any>();
  private sessionTurnIds = new Map<string, string[]>();
  private checkpointCache = new Map<string, any>();
  private sessionCheckpointIds = new Map<string, string[]>();
  private hydratedTurnSessions = new Set<string>();
  private hydratedCheckpointSessions = new Set<string>();

  constructor() {
    this.prisma = getPrismaClient();
    this.operations = new DatabaseOperations(this.prisma);
  }

  private trackSessionTurn(sessionId: string, turnId: string): void {
    const ids = this.sessionTurnIds.get(sessionId) ?? [];
    if (!ids.includes(turnId)) {
      ids.push(turnId);
      this.sessionTurnIds.set(sessionId, ids);
    }
  }

  private updateCachedTurn(
    turnId: string,
    updater: (current: any) => any
  ): void {
    const current = this.turnCache.get(turnId);
    if (!current) return;
    this.turnCache.set(turnId, updater(current));
  }

  private getSessionTurns(sessionId: string): any[] {
    const turnIds = this.sessionTurnIds.get(sessionId) ?? [];
    return turnIds
      .map((id) => this.turnCache.get(id))
      .filter((row): row is any => Boolean(row))
      .sort(
        (a, b) =>
          a.turnNumber - b.turnNumber ||
          String(a.createdAt || "").localeCompare(String(b.createdAt || ""))
      );
  }

  private trackSessionCheckpoint(
    sessionId: string,
    checkpointId: string
  ): void {
    const ids = this.sessionCheckpointIds.get(sessionId) ?? [];
    if (!ids.includes(checkpointId)) {
      ids.push(checkpointId);
      this.sessionCheckpointIds.set(sessionId, ids);
    }
  }

  private toCachedTurn(turn: any): any {
    return {
      turnId: turn.turnId,
      sessionId: turn.sessionId,
      turnNumber: turn.turnNumber,
      characterInput: turn.characterInput,
      characterId: turn.characterId,
      characterName: turn.characterName,
      actionAnalysis: turn.actionAnalysis,
      actionResults: turn.actionResults,
      directorDecision: turn.directorDecision,
      keeperNarrative: turn.keeperNarrative,
      clueRevelations: turn.clueRevelations,
      sceneId: turn.sceneId,
      sceneName: turn.sceneName,
      location: turn.location,
      status: turn.status,
      errorMessage: turn.errorMessage,
      startedAt: turn.startedAt?.toISOString?.() ?? turn.startedAt,
      completedAt:
        turn.completedAt?.toISOString?.() ?? turn.completedAt ?? null,
      createdAt: turn.createdAt?.toISOString?.() ?? turn.createdAt,
      isSimulated: turn.isSimulated,
      gameDay: turn.gameDay,
      gameTime: turn.gameTime,
    };
  }

  /**
   * Preload persisted rows into in-memory cache so legacy sync readers can work
   * after process restart.
   */
  async preloadSessionData(sessionId: string): Promise<void> {
    await Promise.all([
      this.preloadSessionTurns(sessionId),
      this.preloadSessionCheckpoints(sessionId),
    ]);
  }

  async preloadSessionTurns(sessionId: string): Promise<void> {
    if (!sessionId || this.hydratedTurnSessions.has(sessionId)) {
      return;
    }

    const turns = await this.prisma.gameTurn.findMany({
      where: { sessionId },
      orderBy: [{ turnNumber: "asc" }, { createdAt: "asc" }],
    });

    for (const turn of turns) {
      if (!this.turnCache.has(turn.turnId)) {
        this.turnCache.set(turn.turnId, this.toCachedTurn(turn));
      }
      this.trackSessionTurn(sessionId, turn.turnId);
    }

    this.hydratedTurnSessions.add(sessionId);
  }

  async preloadSessionCheckpoints(sessionId: string): Promise<void> {
    if (!sessionId || this.hydratedCheckpointSessions.has(sessionId)) {
      return;
    }

    const checkpoints = await this.prisma.gameCheckpoint.findMany({
      where: { sessionId },
      orderBy: { createdAt: "desc" },
    });

    for (const cp of checkpoints) {
      if (!this.checkpointCache.has(cp.checkpointId)) {
        const gameState = cp.gameState as any;
        this.checkpointCache.set(cp.checkpointId, {
          checkpointId: cp.checkpointId,
          sessionId: cp.sessionId,
          turnNumber: cp.turnNumber,
          checkpointName: cp.checkpointName,
          gameState: cp.gameState,
          currentSceneName: cp.currentSceneName,
          isAutoCheckpoint: cp.isAutoCheckpoint,
          createdAt: cp.createdAt.toISOString(),
          metadata: {
            gameDay: gameState?.gameDay ?? null,
            gameTime: gameState?.timeOfDay ?? gameState?.gameTime ?? null,
          },
        });
      }
      this.trackSessionCheckpoint(sessionId, cp.checkpointId);
    }

    this.hydratedCheckpointSessions.add(sessionId);
  }

  /**
   * Get underlying Prisma client
   * Replacement for: db.getDatabase()
   */
  getDatabase(): PrismaClient {
    return this.prisma;
  }

  /**
   * Close database connection
   */
  close(): void {
    // Prisma close is async, but old API is sync
    // We'll handle this in shutdown
    console.log(
      "CoCDatabaseAdapter: close() called (async close handled separately)"
    );
  }

  /**
   * Transaction wrapper
   */
  transaction<T>(fn: () => T): T {
    // This is a synchronous API, but Prisma transactions are async
    // For now, we'll throw an error - callers should use async version
    throw new Error(
      "Synchronous transactions not supported. Use async DatabaseOperations.transaction()"
    );
  }

  // =====================================================
  // USER TOKEN USAGE
  // =====================================================

  recordUserTokenUsage(payload: {
    email: string;
    provider: string;
    modelName: string;
    modelClass: string;
    operation: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }): void {
    // Fire-and-forget async operation
    this.operations.recordUserTokenUsage(payload).catch((error) => {
      console.error("Failed to record token usage:", error);
    });
  }

  // =====================================================
  // TURN MANAGEMENT (SYNC WRAPPERS - NOT RECOMMENDED)
  // =====================================================

  /**
   * Create a new turn - writes to cache and awaits Prisma write before returning
   */
  async createTurn(
    turnId: string,
    sessionId: string,
    turnNumber: number,
    characterInput: string,
    characterId?: string | null,
    characterName?: string | null,
    sceneId?: string | null,
    sceneName?: string | null,
    location?: string | null,
    isSimulated?: boolean,
    gameDay?: number | null,
    gameTime?: string | null
  ): Promise<void> {
    const startedAt = new Date();
    this.turnCache.set(turnId, {
      turnId,
      sessionId,
      turnNumber,
      characterInput,
      characterId: characterId || null,
      characterName: characterName || null,
      actionAnalysis: null,
      actionResults: null,
      keeperNarrative: null,
      clueRevelations: null,
      sceneId: sceneId || null,
      sceneName: sceneName || null,
      location: location || null,
      status: "processing",
      errorMessage: null,
      startedAt: startedAt.toISOString(),
      completedAt: null,
      createdAt: startedAt.toISOString(),
      isSimulated: isSimulated || false,
      gameDay: gameDay ?? null,
      gameTime: gameTime ?? null,
    });
    this.trackSessionTurn(sessionId, turnId);

    const sessionScope = await this.prisma.session.findUnique({
      where: { sessionId },
      select: { moduleId: true, emailId: true },
    });
    await this.prisma.gameTurn.create({
      data: {
        turnId,
        sessionId,
        moduleId: sessionScope?.moduleId || null,
        emailId: sessionScope?.emailId || null,
        turnNumber,
        characterInput,
        characterId: characterId || null,
        characterName: characterName || null,
        sceneId: sceneId || null,
        sceneName: sceneName || null,
        location: location || null,
        status: "processing",
        startedAt,
        isSimulated: isSimulated || false,
        gameDay: gameDay ?? null,
        gameTime: gameTime ?? null,
      },
    });
  }

  /**
   * Update turn processing
   */
  updateTurnProcessing(
    turnId: string,
    actionAnalysis?: any,
    actionResults?: any[]
  ): void {
    this.updateCachedTurn(turnId, (current) => ({
      ...current,
      actionAnalysis: actionAnalysis ?? null,
      actionResults: actionResults ?? null,
    }));

    this.prisma.gameTurn
      .update({
        where: { turnId },
        data: {
          actionAnalysis: actionAnalysis || null,
          actionResults: actionResults || undefined,
        },
      })
      .catch((error) => {
        console.error(`Failed to update turn ${turnId}:`, error);
      });
  }

  /**
   * Complete a turn
   */
  completeTurn(
    turnId: string,
    keeperNarrative: string,
    clueRevelations?: any,
    gameDay?: number | null,
    gameTime?: string | null
  ): void {
    const completedAt = new Date();
    this.updateCachedTurn(turnId, (current) => ({
      ...current,
      keeperNarrative,
      clueRevelations: clueRevelations ?? null,
      gameDay: gameDay ?? null,
      gameTime: gameTime ?? null,
      status: "completed",
      completedAt: completedAt.toISOString(),
    }));

    this.prisma.gameTurn
      .update({
        where: { turnId },
        data: {
          keeperNarrative,
          clueRevelations: clueRevelations ?? null,
          gameDay: gameDay ?? null,
          gameTime: gameTime ?? null,
          status: "completed",
          completedAt,
        },
      })
      .catch((error) => {
        console.error(`Failed to complete turn ${turnId}:`, error);
      });
  }

  /**
   * Mark turn as error
   */
  markTurnError(turnId: string, errorMessage: string): void {
    this.updateCachedTurn(turnId, (current) => ({
      ...current,
      status: "error",
      errorMessage,
      completedAt: new Date().toISOString(),
    }));

    this.operations.markTurnError(turnId, errorMessage).catch((error) => {
      console.error(`Failed to mark turn error ${turnId}:`, error);
    });
  }

  /**
   * Mark turn as requiring skill selection
   */
  markTurnRequiresSkillSelection(turnId: string, actionAnalysis: any): void {
    this.updateCachedTurn(turnId, (current) => ({
      ...current,
      status: "requires_skill_selection",
      actionAnalysis: actionAnalysis ?? null,
    }));

    this.operations
      .markTurnRequiresSkillSelection(turnId, actionAnalysis)
      .catch((error) => {
        console.error(`Failed to mark turn skill selection ${turnId}:`, error);
      });
  }

  /**
   * Mark turn as requiring combat response
   */
  markTurnRequiresCombatResponse(
    turnId: string,
    npcAttackNarrative: string,
    pendingNpcActions: any[]
  ): void {
    this.updateCachedTurn(turnId, (current) => ({
      ...current,
      status: "requires_combat_response",
      keeperNarrative: npcAttackNarrative,
      actionResults: pendingNpcActions,
    }));

    this.operations
      .markTurnRequiresCombatResponse(
        turnId,
        npcAttackNarrative,
        pendingNpcActions
      )
      .catch((error) => {
        console.error(`Failed to mark turn combat response ${turnId}:`, error);
      });
  }

  /**
   * Get turn by ID
   */
  getTurn(turnId: string): any | null {
    return this.turnCache.get(turnId) ?? null;
  }

  /**
   * Get latest turn
   */
  getLatestTurn(sessionId: string): any | null {
    const turns = this.getSessionTurns(sessionId);
    return turns.length > 0 ? turns[turns.length - 1] : null;
  }

  /**
   * Get turn history
   */
  getTurnHistory(
    sessionId: string,
    limit = 20,
    afterTurnNumber?: number
  ): any[] {
    const turns = this.getSessionTurns(sessionId);
    if (typeof afterTurnNumber === "number") {
      // Incremental fetch: return newer turns in ascending order.
      return turns
        .filter((turn) => turn.turnNumber > afterTurnNumber)
        .slice(0, limit);
    }
    // Default fetch: return latest turns in descending order (legacy behavior).
    return turns
      .slice()
      .sort((a, b) => b.turnNumber - a.turnNumber)
      .slice(0, limit);
  }

  /**
   * Get next turn number
   */
  getNextTurnNumber(sessionId: string): number {
    const latestTurn = this.getLatestTurn(sessionId);
    return latestTurn ? latestTurn.turnNumber + 1 : 1;
  }

  /**
   * Get pending turns
   */
  getPendingTurns(sessionId: string): any[] {
    return this.getSessionTurns(sessionId).filter(
      (turn) => turn.status === "processing"
    );
  }

  // =====================================================
  // CHECKPOINT MANAGEMENT
  // =====================================================

  saveCheckpoint(params: {
    checkpointId: string;
    sessionId: string;
    turnNumber: number;
    checkpointName?: string;
    gameState: any;
    currentSceneName?: string;
    isAutoCheckpoint?: boolean;
  }): void {
    const createdAt = new Date().toISOString();
    const cached = {
      checkpointId: params.checkpointId,
      sessionId: params.sessionId,
      turnNumber: params.turnNumber,
      checkpointName: params.checkpointName || null,
      gameState: params.gameState,
      currentSceneName: params.currentSceneName || null,
      isAutoCheckpoint: params.isAutoCheckpoint || false,
      createdAt,
      metadata: {
        gameDay: params.gameState?.gameDay ?? null,
        gameTime:
          params.gameState?.timeOfDay ?? params.gameState?.gameTime ?? null,
      },
    };
    this.checkpointCache.set(params.checkpointId, cached);
    this.trackSessionCheckpoint(params.sessionId, params.checkpointId);

    this.operations.saveCheckpoint(params).catch((error) => {
      console.error(`Failed to save checkpoint ${params.checkpointId}:`, error);
    });
  }

  loadCheckpoint(checkpointId: string): any | null {
    return this.checkpointCache.get(checkpointId) ?? null;
  }

  listCheckpoints(sessionId: string, limit = 50): any[] {
    const ids = this.sessionCheckpointIds.get(sessionId) ?? [];
    return ids
      .map((id) => this.checkpointCache.get(id))
      .filter((row): row is any => Boolean(row))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, limit);
  }

  deleteCheckpoint(checkpointId: string): void {
    const cached = this.checkpointCache.get(checkpointId);
    if (cached?.sessionId) {
      const ids = this.sessionCheckpointIds.get(cached.sessionId) ?? [];
      this.sessionCheckpointIds.set(
        cached.sessionId,
        ids.filter((id) => id !== checkpointId)
      );
    }
    this.checkpointCache.delete(checkpointId);

    this.operations.deleteCheckpoint(checkpointId).catch((error) => {
      console.error(`Failed to delete checkpoint ${checkpointId}:`, error);
    });
  }

  cleanupAutoCheckpoints(sessionId: string, keepCount = 10): void {
    const checkpoints = this.listCheckpoints(
      sessionId,
      Number.MAX_SAFE_INTEGER
    );
    const auto = checkpoints.filter((cp) => cp.isAutoCheckpoint);
    if (auto.length > keepCount) {
      const toDelete = auto.slice(keepCount);
      for (const cp of toDelete) {
        this.deleteCheckpoint(cp.checkpointId);
      }
    }

    this.operations
      .cleanupAutoCheckpoints(sessionId, keepCount)
      .catch((error) => {
        console.error(
          `Failed to cleanup auto checkpoints for ${sessionId}:`,
          error
        );
      });
  }

  // =====================================================
  // EMBEDDING & RAG
  // =====================================================

  addTurnEmbedding(params: {
    sessionId: string;
    turnId: string;
    userInput: string;
    narrative: string;
    embedding: number[];
    emailId?: string;
  }): void {
    const id = randomUUID();
    // Convert embedding array to Buffer for BLOB storage
    const embeddingBuffer = Buffer.from(
      new Float32Array(params.embedding).buffer
    );
    this.prisma.turnEmbedding
      .create({
        data: {
          id,
          sessionId: params.sessionId,
          turnId: params.turnId,
          userInput: params.userInput,
          narrative: params.narrative,
          embedding: embeddingBuffer,
          emailId: params.emailId || null,
        },
      })
      .catch((error) => {
        console.error(`Failed to add turn embedding:`, error);
      });
  }

  addActionLogEmbedding(params: {
    sessionId: string;
    turnId: string;
    actionLog: any;
    embedding: number[];
    emailId?: string;
  }): void {
    const id = randomUUID();
    // Convert embedding array to Buffer for BLOB storage
    const embeddingBuffer = Buffer.from(
      new Float32Array(params.embedding).buffer
    );
    this.prisma.actionLogEmbedding
      .create({
        data: {
          id,
          sessionId: params.sessionId,
          turnId: params.turnId,
          actionLog: params.actionLog,
          embedding: embeddingBuffer,
          emailId: params.emailId || null,
        },
      })
      .catch((error) => {
        console.error(`Failed to add action log embedding:`, error);
      });
  }

  searchActionLogEmbeddings(params: {
    sessionId: string;
    queryEmbedding: number[];
    topK?: number;
    emailId?: string;
  }): Array<{
    id: string;
    turnId: string;
    actionLog: any;
    similarity: number;
  }> {
    // Sync API cannot await Prisma query. Return empty to avoid blocking event loop.
    return [];
  }

  searchTurnEmbeddings(params: {
    sessionId: string;
    queryEmbedding: number[];
    topK?: number;
    emailId?: string;
  }): Array<{
    id: string;
    turnId: string;
    userInput: string;
    narrative: string;
    similarity: number;
  }> {
    // Sync API cannot await Prisma query. Return empty to avoid blocking event loop.
    return [];
  }

  searchActionLogsByKeywords(params: {
    sessionId: string;
    query: string;
    topK?: number;
    emailId?: string;
  }): Array<{
    id: string;
    turnId: string;
    actionLog: any;
    bm25Score: number;
  }> {
    // BM25/FTS5 search is not available via Prisma/PostgreSQL adapter
    // Return empty results - hybrid search will fall back to vector-only
    console.warn(
      "[CoCDatabaseAdapter] searchActionLogsByKeywords not implemented for Prisma adapter"
    );
    return [];
  }

  searchTurnsByKeywords(params: {
    sessionId: string;
    query: string;
    topK?: number;
    emailId?: string;
  }): Array<{
    id: string;
    turnId: string;
    userInput: string;
    narrative: string;
    bm25Score: number;
  }> {
    // BM25/FTS5 search is not available via Prisma/PostgreSQL adapter
    // Return empty results - hybrid search will fall back to vector-only
    console.warn(
      "[CoCDatabaseAdapter] searchTurnsByKeywords not implemented for Prisma adapter"
    );
    return [];
  }

  // =====================================================
  // HELPER METHODS
  // =====================================================

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

/**
 * This adapter keeps a backward-compatible sync API by serving reads from
 * in-memory caches and writing through to Prisma asynchronously.
 */
