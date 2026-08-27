import type { NpcMemory, NpcMemoryType, PrismaClient } from "@prisma/client";
import type { EmbeddingClient } from "../rag/embedding.js";
import { DecayEngine } from "./DecayEngine.js";
import { MemoryRetriever } from "./MemoryRetriever.js";
import { MemoryStore } from "./MemoryStore.js";
import { getAllHandlers, getHandler } from "./handlers/index.js";
import { buildContextMemoryEntries } from "./contextMemory.js";
import { resolveKnownLocationIds } from "./knownLocations.js";
import {
  type AddMemoryParams,
  CONTEXT_PROFILES,
  type EnsureContextMemoriesParams,
  type GetContextParams,
  type QueryMemoryParams,
  type ScoredMemory,
} from "./types.js";

export class NpcMemoryManager {
  private store: MemoryStore;
  private retriever: MemoryRetriever;
  private decayEngine: DecayEngine;

  constructor(
    prisma: PrismaClient,
    embedClient: EmbeddingClient,
    language = "en"
  ) {
    this.store = new MemoryStore(prisma, embedClient, language);
    this.decayEngine = new DecayEngine();
    this.retriever = new MemoryRetriever(this.store, this.decayEngine);
  }

  // ===== Write =====

  async add(params: AddMemoryParams): Promise<NpcMemory> {
    return this.store.create(params);
  }

  async findLatestByType(
    sessionId: string,
    npcId: string,
    type: NpcMemoryType
  ): Promise<NpcMemory | null> {
    return this.store.findLatestByType(sessionId, npcId, type);
  }

  /**
   * Write this character's standing knowledge of the world — one memory per
   * macro location, one per scene inside it, and one for how the streets
   * connect (see contextMemory.ts). Idempotent per session: if any `context`
   * memory already exists for this character, nothing is written.
   *
   * Returns how many memories were created.
   */
  async ensureContextMemories(
    params: EnsureContextMemoriesParams
  ): Promise<number> {
    const existing = await this.store.findLatestByType(
      params.sessionId,
      params.npcId,
      "context"
    );
    if (existing) return 0;

    const knownIds = resolveKnownLocationIds(
      params.dgsm,
      params.seed,
      params.dgsm.getCharacterPosition(params.npcId)
    );
    const entries = buildContextMemoryEntries(
      params.dgsm,
      knownIds,
      params.language
    );

    await Promise.all(
      entries.map((entry) =>
        this.add({
          npcId: params.npcId,
          sessionId: params.sessionId,
          moduleId: params.moduleId,
          type: "context",
          content: entry.content,
          gameDateTime: params.gameDateTime,
          // `location` is a scene the memory happened at; only an interior
          // entry has one. Macro and topology ids live in metadata/tags.
          ...(entry.scope === "interior" && entry.locationId
            ? { location: entry.locationId }
            : {}),
          metadata: {
            scope: entry.scope,
            ...(entry.locationId ? { locationId: entry.locationId } : {}),
          },
        })
      )
    );

    return entries.length;
  }


  // ===== Retrieve =====

  async query(params: QueryMemoryParams): Promise<ScoredMemory[]> {
    return this.retriever.query(params);
  }

  /** Fetch all memories for a specific NPC on a specific game date (no scoring/semantic filtering). */
  async getAllForDate(
    npcId: string,
    sessionId: string,
    gameDate: string
  ): Promise<NpcMemory[]> {
    return this.store.findCandidates({
      sessionId,
      npcId,
      filters: { gameDate },
      limit: 500,
    });
  }

  /** Fetch all memories for a specific NPC and memory types without semantic filtering. */
  async getAllByTypes(
    npcId: string,
    sessionId: string,
    types: NpcMemoryType[],
    limit = 500
  ): Promise<NpcMemory[]> {
    return this.store.findCandidates({
      sessionId,
      npcId,
      filters: { types },
      limit,
    });
  }

  /** Fetch memories for a specific NPC, game date, and set of memory types (no scoring/semantic filtering). */
  async getForDateByTypes(
    npcId: string,
    sessionId: string,
    gameDate: string,
    types: NpcMemoryType[],
    limit = 500
  ): Promise<NpcMemory[]> {
    return this.store.findCandidates({
      sessionId,
      npcId,
      filters: { gameDate, types },
      limit,
    });
  }

  // ===== Context Building =====

  async getContext(params: GetContextParams): Promise<string> {
    const profile = CONTEXT_PROFILES[params.purpose];
    const query = params.query ?? "";

    let memories: ScoredMemory[];

    if (profile.typeLimits) {
      // Types with explicit typeLimits: query each separately
      const explicitTypes = profile.defaultTypes.filter(
        (t) => t in profile.typeLimits!
      );
      // Types without explicit typeLimits: query together with shared defaultLimit
      const sharedTypes = profile.defaultTypes.filter(
        (t) => !(t in profile.typeLimits!)
      );

      const perTypeResults = await Promise.all(
        explicitTypes.map((type) => {
          const limit = profile.typeLimits![type]!;
          return this.retriever.query({
            npcId: params.npcId,
            sessionId: params.sessionId,
            query,
            filters: { types: [type], currentGameDate: params.currentGameDate },
            limit: limit === 0 ? 500 : limit,
          });
        })
      );

      if (sharedTypes.length > 0) {
        const sharedResult = await this.retriever.query({
          npcId: params.npcId,
          sessionId: params.sessionId,
          query,
          filters: {
            types: sharedTypes,
            currentGameDate: params.currentGameDate,
          },
          limit: profile.defaultLimit,
        });
        perTypeResults.push(sharedResult);
      }

      memories = perTypeResults.flat();
    } else {
      memories = await this.retriever.query({
        npcId: params.npcId,
        sessionId: params.sessionId,
        query,
        filters: {
          types: profile.defaultTypes,
          currentGameDate: params.currentGameDate,
        },
        limit: profile.defaultLimit,
      });
    }

    const handlers = getAllHandlers();
    return memories.map((m) => handlers[m.type].format(m)).join("\n");
  }

  // ===== Decay & Reinforcement =====

  async decayAll(sessionId: string): Promise<void> {
    const now = new Date();
    const memories = await this.store.findAllForSession(sessionId);

    const updates = memories.map((m) => {
      const handler = getHandler(m.type);
      const decayRateMultiplier = handler.customDecayRate?.() ?? 1.0;
      const newImportance = this.decayEngine.computeEffectiveImportance(
        {
          baseImportance: m.baseImportance,
          accessCount: m.accessCount,
          lastAccessedAt: m.lastAccessedAt,
          decayRateMultiplier,
        },
        now
      );
      return { id: m.id, importance: newImportance };
    });

    if (updates.length > 0) {
      await this.store.batchUpdateImportance(sessionId, updates);
    }
  }

  // ===== History cleanup =====

  async deleteAfterTime(
    sessionId: string,
    cutoffCreatedAt: Date
  ): Promise<void> {
    await this.store.deleteAfterTime(sessionId, cutoffCreatedAt);
  }

  // ===== Belief Update =====

  async updateBeliefConfidence(
    memoryId: string,
    newConfidence: number,
    reason: string,
    currentMetadata: Record<string, any>
  ): Promise<void> {
    const updatedMetadata = {
      ...currentMetadata,
      confidence: newConfidence,
      reasoningChain: reason,
    };
    await this.store.updateMetadata(memoryId, updatedMetadata, {
      // confidence = 0 → disproven → accelerate forgetting
      ...(newConfidence === 0 && { baseImportance: 0.5 }),
    });
  }

  async updateKnowledgeContent(
    memoryId: string,
    newContent: string,
    currentMetadata: Record<string, any>
  ): Promise<void> {
    await this.store.updateContent(memoryId, newContent);
    await this.store.updateMetadata(memoryId, {
      ...currentMetadata,
      lastUpdated: new Date().toISOString(),
    });
  }
}
