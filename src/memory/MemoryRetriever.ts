import type { NpcMemory } from "@prisma/client";
import type { DecayEngine } from "./DecayEngine.js";
import type { MemoryStore } from "./MemoryStore.js";
import { getHandler } from "./handlers/index.js";
import type { QueryMemoryParams, ScoredMemory } from "./types.js";
import { CANDIDATE_CAP } from "./types.js";

export class MemoryRetriever {
  private store: MemoryStore;
  private decayEngine: DecayEngine;

  constructor(store: MemoryStore, decayEngine: DecayEngine) {
    this.store = store;
    this.decayEngine = decayEngine;
  }

  async query(params: QueryMemoryParams): Promise<ScoredMemory[]> {
    const now = new Date();
    const limit = params.limit ?? 20;

    const candidates = await this.store.findCandidates({
      sessionId: params.sessionId,
      npcId: params.npcId,
      filters: params.filters,
      limit: CANDIDATE_CAP,
    });

    if (candidates.length === 0) return [];

    if (!params.query) {
      return this.rankWithoutSemantic(candidates, now, limit);
    }

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.store.embedQuery(params.query);
    } catch {
      return this.rankWithoutSemantic(candidates, now, limit);
    }

    const scored = candidates.map((memory) => {
      const similarity = memory.embedding
        ? this.cosineSimilarity(
            queryEmbedding,
            this.bytesToFloatArray(memory.embedding as Buffer)
          )
        : 0;

      const handler = getHandler(memory.type);
      const decayRateMultiplier = handler.customDecayRate?.() ?? 1.0;

      const finalScore = this.decayEngine.computeFinalScore(
        {
          similarity,
          baseImportance: memory.baseImportance,
          accessCount: memory.accessCount,
          lastAccessedAt: memory.lastAccessedAt,
          decayRateMultiplier,
        },
        now
      );

      return {
        ...memory,
        similarityScore: similarity,
        finalScore,
      } as ScoredMemory;
    });

    scored.sort((a, b) => b.finalScore - a.finalScore);
    const results = scored.slice(0, limit);
    this.reinforceResults(results, now);
    return results;
  }

  private rankWithoutSemantic(
    candidates: NpcMemory[],
    now: Date,
    limit: number
  ): ScoredMemory[] {
    const scored = candidates.map((memory) => {
      const handler = getHandler(memory.type);
      const decayRateMultiplier = handler.customDecayRate?.() ?? 1.0;

      const finalScore = this.decayEngine.computeFinalScoreWithoutSemantic(
        {
          baseImportance: memory.baseImportance,
          accessCount: memory.accessCount,
          lastAccessedAt: memory.lastAccessedAt,
          decayRateMultiplier,
        },
        now
      );

      return { ...memory, similarityScore: 0, finalScore } as ScoredMemory;
    });

    scored.sort((a, b) => b.finalScore - a.finalScore);
    const results = scored.slice(0, limit);
    this.reinforceResults(results, now);
    return results;
  }

  private reinforceResults(results: ScoredMemory[], now: Date): void {
    for (const r of results) {
      const handler = getHandler(r.type);
      const decayRateMultiplier = handler.customDecayRate?.() ?? 1.0;
      const newImportance = this.decayEngine.computeEffectiveImportance(
        {
          baseImportance: r.baseImportance,
          accessCount: r.accessCount + 1,
          lastAccessedAt: now,
          decayRateMultiplier,
        },
        now
      );
      this.store.reinforce(r.id, newImportance).catch(() => {});
    }
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  private bytesToFloatArray(buffer: Buffer): number[] {
    const float32 = new Float32Array(
      buffer.buffer,
      buffer.byteOffset,
      buffer.byteLength / 4
    );
    return Array.from(float32);
  }
}
