/**
 * Game History RAG System
 *
 * Lightweight RAG system for embedding and retrieving game history:
 * - Action logs from gameplay
 * - Turn pairs (user input + narrative response)
 *
 * Used by Memory agent to provide relevant historical context to Keeper agent.
 */

import type { ActionLogEntry } from "../shared/agents/models/gameTypes.js";
import type { CoCDatabase, CoCDatabaseAdapter } from "../shared/agents/memory/database/index.js";
import { EmbeddingClient } from "./embedding.js";
import { ModelProviderName } from "../models/types.js";

/** Relevant history item returned from search */
export interface RelevantHistoryItem {
  type: "action_log" | "turn";
  content: string;
  score: number;
  metadata: {
    timestamp?: string;
    location?: string;
    turnId?: string;
  };
}

/** Search result from history retrieval */
export interface HistorySearchResult {
  items: RelevantHistoryItem[];
  totalResults: number;
}

/**
 * Game History RAG Manager
 * Handles embedding and retrieval of game history for context enrichment
 */
export class GameHistoryRag {
  private embedder: EmbeddingClient;
  private db: CoCDatabase | CoCDatabaseAdapter;

  constructor(db: CoCDatabase | CoCDatabaseAdapter, provider?: ModelProviderName) {
    this.db = db;
    const modelProvider =
      provider ||
      (process.env.MODEL_PROVIDER as ModelProviderName) ||
      ModelProviderName.OPENAI;
    this.embedder = new EmbeddingClient(modelProvider);
  }

  /**
   * Embed a single action log entry and store in database
   */
  async embedActionLog(
    sessionId: string,
    turnId: string,
    actionLog: ActionLogEntry,
    emailId?: string,
    language?: "en" | "zh"
  ): Promise<void> {
    try {
      // Create text representation of action log
      const text = this.formatActionLog(actionLog);

      // Generate embedding with correct language model
      const embedding = await this.embedder.embed(text, {
        language: language || "zh",
      });
      if (!embedding || embedding.length === 0) {
        console.warn(
          "[GameHistoryRag] Failed to generate embedding for action log"
        );
        return;
      }

      // Store in database
      this.db.addActionLogEmbedding({
        sessionId,
        turnId,
        actionLog,
        embedding,
        emailId,
      });
    } catch (error) {
      console.error("[GameHistoryRag] Error embedding action log:", error);
    }
  }

  /**
   * Embed a turn (user input + narrative) and store in database
   */
  async embedTurn(
    sessionId: string,
    turnId: string,
    userInput: string,
    narrative: string,
    emailId?: string,
    language?: "en" | "zh"
  ): Promise<void> {
    try {
      // Combine user input and narrative for embedding
      const text = this.formatTurn(userInput, narrative);

      // Generate embedding with correct language model
      const embedding = await this.embedder.embed(text, {
        language: language || "zh",
      });
      if (!embedding || embedding.length === 0) {
        console.warn("[GameHistoryRag] Failed to generate embedding for turn");
        return;
      }

      // Store in database
      this.db.addTurnEmbedding({
        sessionId,
        turnId,
        userInput,
        narrative,
        embedding,
        emailId,
      });
    } catch (error) {
      console.error("[GameHistoryRag] Error embedding turn:", error);
    }
  }

  /**
   * Search for relevant history using HYBRID retrieval (BM25 + Vector)
   * Combines keyword matching with semantic similarity
   *
   * @param alpha - Weight for BM25 (0-1), remaining weight goes to vector similarity
   *                Default 0.3 means 30% BM25 + 70% Vector
   */
  async searchRelevantHistoryHybrid(
    sessionId: string,
    query: string,
    options: {
      topKActionLogs?: number;
      topKTurns?: number;
      alpha?: number;
      emailId?: string;
      // NEW OPTIONS
      targetCharacters?: string[]; // Filter action logs by these characters
      topKPerCharacter?: number; // Top K per character (default: 3)
      currentLocation?: string; // Boost logs matching this location
      locationBoostFactor?: number; // Boost multiplier (default: 1.5)
    } = {}
  ): Promise<HistorySearchResult> {
    const {
      topKActionLogs = 3,
      topKTurns = 3,
      alpha = 0.3,
      emailId,
      targetCharacters,
      topKPerCharacter = 5,
      currentLocation,
      locationBoostFactor = 1.2,
    } = options;

    try {
      // Generate query embedding for vector search
      const queryEmbedding = await this.embedder.embed(query);
      if (!queryEmbedding || queryEmbedding.length === 0) {
        console.warn("[GameHistoryRag] Failed to generate query embedding");
        return { items: [], totalResults: 0 };
      }

      // 1. Vector search for action logs
      const vectorActionLogs = this.db.searchActionLogEmbeddings({
        sessionId,
        queryEmbedding,
        topK: topKActionLogs * 2, // Get more for fusion
        emailId,
      });

      // 2. BM25 search for action logs
      let bm25ActionLogs: Array<{
        id: string;
        turnId: string;
        actionLog: any;
        bm25Score: number;
      }> = [];
      try {
        bm25ActionLogs = this.db.searchActionLogsByKeywords({
          sessionId,
          query,
          topK: topKActionLogs * 2, // Get more for fusion
          emailId,
        });
      } catch (error) {
        console.warn("[GameHistoryRag] BM25 action log search failed:", error);
      }

      // 3. Vector search for turns
      const vectorTurns = this.db.searchTurnEmbeddings({
        sessionId,
        queryEmbedding,
        topK: topKTurns * 2, // Get more for fusion
        emailId,
      });

      // 4. BM25 search for turns
      let bm25Turns: Array<{
        id: string;
        turnId: string;
        userInput: string;
        narrative: string;
        bm25Score: number;
      }> = [];
      try {
        bm25Turns = this.db.searchTurnsByKeywords({
          sessionId,
          query,
          topK: topKTurns * 2, // Get more for fusion
          emailId,
        });
      } catch (error) {
        console.warn("[GameHistoryRag] BM25 turn search failed:", error);
      }

      // 5. Fuse action logs
      const fusedActionLogs = this.fuseResults(
        vectorActionLogs.map((r) => ({
          id: r.id,
          score: r.similarity,
          data: r as any,
        })),
        bm25ActionLogs.map((r) => ({
          id: r.id,
          score: r.bm25Score,
          data: r as any,
        })),
        alpha
      );

      // NEW: Apply location boosting to action logs
      if (currentLocation && currentLocation.trim()) {
        for (const item of fusedActionLogs) {
          const actionLog = item.data.actionLog;
          if (actionLog.location && actionLog.location === currentLocation) {
            item.hybridScore *= locationBoostFactor;
          }
        }
        // Re-sort after boosting
        fusedActionLogs.sort((a, b) => b.hybridScore - a.hybridScore);
      }

      // NEW: Per-character retrieval mode
      let selectedActionLogs: typeof fusedActionLogs;

      if (targetCharacters && targetCharacters.length > 0) {
        // Increase pool size for per-character retrieval
        const poolSize = topKPerCharacter * targetCharacters.length * 2;
        const pool = fusedActionLogs.slice(0, poolSize);

        // Group by character
        const byCharacter = new Map<string, typeof pool>();

        for (const item of pool) {
          const char = item.data.actionLog.character;
          if (!char) continue; // Skip logs without character field
          if (!targetCharacters.includes(char)) continue; // Filter by target characters

          if (!byCharacter.has(char)) {
            byCharacter.set(char, []);
          }
          byCharacter.get(char)!.push(item);
        }

        // Take top K per character and merge
        selectedActionLogs = [];
        for (const [char, items] of byCharacter.entries()) {
          const topK = items.slice(0, topKPerCharacter);
          selectedActionLogs.push(...topK);
          console.debug(
            `[GameHistoryRag] Selected ${topK.length} action logs for character: ${char}`
          );
        }

        // Re-sort merged results by hybrid score
        selectedActionLogs.sort((a, b) => b.hybridScore - a.hybridScore);

        console.log(
          `🎯 [GameHistoryRag] Per-character retrieval: ${selectedActionLogs.length} action logs ` +
            `(${targetCharacters.length} characters × ${topKPerCharacter} per character)`
        );
      } else {
        // Global retrieval mode (existing behavior)
        selectedActionLogs = fusedActionLogs.slice(0, topKActionLogs);
      }

      // 6. Fuse turns
      const fusedTurns = this.fuseResults(
        vectorTurns.map((r) => ({
          id: r.id,
          score: r.similarity,
          data: r as any,
        })),
        bm25Turns.map((r) => ({
          id: r.id,
          score: r.bm25Score,
          data: r as any,
        })),
        alpha
      ).slice(0, topKTurns);

      // 7. Convert to RelevantHistoryItem format
      const results: RelevantHistoryItem[] = [];

      for (const item of selectedActionLogs) {
        const data = item.data as any;
        results.push({
          type: "action_log",
          content: this.formatActionLog(data.actionLog),
          score: item.hybridScore,
          metadata: {
            timestamp: data.actionLog.time,
            location: data.actionLog.location,
            turnId: data.turnId,
          },
        });
      }

      for (const item of fusedTurns) {
        const data = item.data as any;
        results.push({
          type: "turn",
          content: this.formatTurn(data.userInput || "", data.narrative || ""),
          score: item.hybridScore,
          metadata: {
            turnId: data.turnId,
          },
        });
      }

      return {
        items: results,
        totalResults: results.length,
      };
    } catch (error) {
      console.error("[GameHistoryRag] Error in hybrid search:", error);
      return { items: [], totalResults: 0 };
    }
  }

  /**
   * Fuse BM25 and Vector search results using weighted combination
   *
   * @param vectorResults - Results from vector similarity search
   * @param bm25Results - Results from BM25 keyword search
   * @param alpha - Weight for BM25 (0-1), remaining goes to vector
   * @returns Fused results sorted by hybrid score
   */
  private fuseResults<T>(
    vectorResults: Array<{ id: string; score: number; data: T }>,
    bm25Results: Array<{ id: string; score: number; data: T }>,
    alpha: number
  ): Array<{ id: string; hybridScore: number; data: T }> {
    // Normalize scores to [0, 1]
    const normalizeScores = (
      results: Array<{ id: string; score: number; data: T }>
    ) => {
      if (results.length === 0) return [];
      const scores = results.map((r) => r.score);
      const maxScore = Math.max(...scores);
      const minScore = Math.min(...scores);
      const range = maxScore - minScore || 1;

      return results.map((r) => ({
        ...r,
        normalizedScore: (r.score - minScore) / range,
      }));
    };

    const vectorNormalized = normalizeScores(vectorResults);
    const bm25Normalized = normalizeScores(bm25Results);

    // Fuse scores: Hybrid = alpha * BM25 + (1 - alpha) * Vector
    const fusedMap = new Map<
      string,
      { id: string; hybridScore: number; data: T }
    >();

    for (const item of vectorNormalized) {
      fusedMap.set(item.id, {
        id: item.id,
        hybridScore: (1 - alpha) * item.normalizedScore,
        data: item.data,
      });
    }

    for (const item of bm25Normalized) {
      const existing = fusedMap.get(item.id);
      if (existing) {
        existing.hybridScore += alpha * item.normalizedScore;
      } else {
        fusedMap.set(item.id, {
          id: item.id,
          hybridScore: alpha * item.normalizedScore,
          data: item.data,
        });
      }
    }

    // Sort by hybrid score (descending)
    return Array.from(fusedMap.values()).sort(
      (a, b) => b.hybridScore - a.hybridScore
    );
  }

  /**
   * Search for relevant history based on user input (LEGACY - pure vector search)
   * Use searchRelevantHistoryHybrid for better results
   */
  async searchRelevantHistory(
    sessionId: string,
    query: string,
    options: {
      topK?: number;
      includeActionLogs?: boolean;
      includeTurns?: boolean;
      emailId?: string;
    } = {}
  ): Promise<HistorySearchResult> {
    const {
      topK = 5,
      includeActionLogs = true,
      includeTurns = true,
      emailId,
    } = options;

    try {
      // Generate query embedding
      const queryEmbedding = await this.embedder.embed(query);
      if (!queryEmbedding || queryEmbedding.length === 0) {
        console.warn("[GameHistoryRag] Failed to generate query embedding");
        return { items: [], totalResults: 0 };
      }

      const results: RelevantHistoryItem[] = [];

      // Search action logs
      if (includeActionLogs) {
        const actionLogResults = this.db.searchActionLogEmbeddings({
          sessionId,
          queryEmbedding,
          topK,
          emailId,
        });

        for (const result of actionLogResults) {
          results.push({
            type: "action_log",
            content: this.formatActionLog(result.actionLog),
            score: result.similarity,
            metadata: {
              timestamp: result.actionLog.time,
              location: result.actionLog.location,
              turnId: result.turnId,
            },
          });
        }
      }

      // Search turns
      if (includeTurns) {
        const turnResults = this.db.searchTurnEmbeddings({
          sessionId,
          queryEmbedding,
          topK,
          emailId,
        });

        for (const result of turnResults) {
          results.push({
            type: "turn",
            content: this.formatTurn(result.userInput, result.narrative),
            score: result.similarity,
            metadata: {
              turnId: result.turnId,
            },
          });
        }
      }

      // Sort by similarity score (descending) and take topK
      results.sort((a, b) => b.score - a.score);
      const topResults = results.slice(0, topK);

      return {
        items: topResults,
        totalResults: results.length,
      };
    } catch (error) {
      console.error("[GameHistoryRag] Error searching history:", error);
      return { items: [], totalResults: 0 };
    }
  }

  /**
   * Format action log for embedding and display
   */
  private formatActionLog(actionLog: ActionLogEntry): string {
    const parts: string[] = [];

    if (actionLog.character) {
      parts.push(`Character: ${actionLog.character}`);
    }

    parts.push(`Time: ${actionLog.time}`);
    parts.push(`Location: ${actionLog.location}`);
    parts.push(`Action: ${actionLog.summary}`);

    if (actionLog.successLevel) {
      parts.push(`Result: ${actionLog.successLevel}`);
    }

    return parts.join(" | ");
  }

  /**
   * Format turn (user input + narrative) for embedding and display
   */
  private formatTurn(userInput: string, narrative: string): string {
    return `Player: ${userInput}\n\nGM: ${narrative}`;
  }
}
