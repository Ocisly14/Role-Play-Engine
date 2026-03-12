import type { PrismaClient, NpcMemory } from "@prisma/client";
import type { EmbeddingClient } from "../../rag/embedding.js";
import { MemoryStore } from "./MemoryStore.js";
import { MemoryRetriever } from "./MemoryRetriever.js";
import { DecayEngine } from "./DecayEngine.js";
import { getHandler, getAllHandlers } from "./handlers/index.js";
import {
  CONTEXT_PROFILES,
  MIN_MEMORIES_FOR_REASONING,
  type AddMemoryParams,
  type QueryMemoryParams,
  type GetContextParams,
  type ScoredMemory,
  type TriggerReasoningParams,
} from "./types.js";
import {
  buildReasoningPrompt,
  parseReasoningOutput,
} from "./prompts/reasoningPrompt.js";

export class NpcMemoryManager {
  private store: MemoryStore;
  private retriever: MemoryRetriever;
  private decayEngine: DecayEngine;

  constructor(prisma: PrismaClient, embedClient: EmbeddingClient) {
    this.store = new MemoryStore(prisma, embedClient);
    this.decayEngine = new DecayEngine();
    this.retriever = new MemoryRetriever(this.store, this.decayEngine);
  }

  // ===== Write =====

  async add(params: AddMemoryParams): Promise<NpcMemory> {
    return this.store.create(params);
  }

  // ===== Retrieve =====

  async query(params: QueryMemoryParams): Promise<ScoredMemory[]> {
    return this.retriever.query(params);
  }

  /** Fetch all memories for a specific NPC on a specific game day (no scoring/semantic filtering). */
  async getAllForDay(npcId: string, sessionId: string, gameDay: number): Promise<NpcMemory[]> {
    return this.store.findCandidates({ sessionId, npcId, filters: { gameDay }, limit: 500 });
  }

  // ===== Context Building =====

  async getContext(params: GetContextParams): Promise<string> {
    const profile = CONTEXT_PROFILES[params.purpose];
    const memories = await this.retriever.query({
      npcId: params.npcId,
      sessionId: params.sessionId,
      query: params.query ?? "",
      filters: { types: profile.defaultTypes },
      limit: profile.defaultLimit,
    });

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
        now,
      );
      return { id: m.id, importance: newImportance };
    });

    if (updates.length > 0) {
      await this.store.batchUpdateImportance(sessionId, updates);
    }
  }

  // ===== Checkpoint =====

  async deletePostCheckpoint(
    sessionId: string,
    checkpointCreatedAt: Date,
  ): Promise<void> {
    await this.store.deletePostCheckpoint(sessionId, checkpointCreatedAt);
  }

  // ===== Belief Update =====

  async updateBeliefConfidence(
    memoryId: string,
    newConfidence: number,
    reason: string,
    currentMetadata: Record<string, any>,
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

  async triggerReasoning(
    params: TriggerReasoningParams,
    npcName: string,
    npcProfile: string,
    generateTextFn: (prompt: string) => Promise<string>,
    language?: string,
  ): Promise<NpcMemory[]> {
    // Fetch relevant memories for reasoning
    const memories = await this.retriever.query({
      npcId: params.npcId,
      sessionId: params.sessionId,
      query: params.context ?? "",
      filters: {
        types: ["information", "witness", "event", "belief"],
      },
      limit: 25,
    });

    // Early return if insufficient information
    if (memories.length < MIN_MEMORIES_FOR_REASONING) {
      return [];
    }

    // Fetch existing active beliefs
    const existingBeliefs = await this.retriever.query({
      npcId: params.npcId,
      sessionId: params.sessionId,
      query: "",
      filters: { types: ["belief"] },
      limit: 20,
    });
    // Filter out disproven beliefs (confidence = 0)
    const activeBeliefs = existingBeliefs.filter((b) => {
      const meta = b.metadata as Record<string, any> | null;
      return (meta?.confidence ?? 0) > 0;
    });

    // Build and execute reasoning prompt
    const prompt = buildReasoningPrompt({
      npcName,
      npcProfile,
      memories,
      existingBeliefs: activeBeliefs,
      trigger: params.trigger,
      triggerContext: params.context,
      language,
    });

    const rawResult = await generateTextFn(prompt);
    const result = parseReasoningOutput(rawResult);

    const newMemories: NpcMemory[] = [];

    // Create new belief memories
    for (const belief of result.newBeliefs) {
      const memory = await this.add({
        npcId: params.npcId,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        type: "belief",
        content: belief.belief,
        gameDay: params.gameDay,
        gameTime: params.gameTime,
        metadata: {
          confidence: belief.confidence,
          reasoningChain: belief.reasoningChain,
        },
      });
      newMemories.push(memory);
    }

    // Update existing beliefs
    for (const update of result.updatedBeliefs) {
      const existing = activeBeliefs.find(
        (b) => b.content === update.originalBelief,
      );
      if (!existing) continue;

      await this.updateBeliefConfidence(
        existing.id,
        update.newConfidence,
        update.reason,
        (existing.metadata as Record<string, any>) ?? {},
      );
    }

    return newMemories;
  }

  async shouldTriggerReasoningOnConversation(
    npcId: string,
    sessionId: string,
    playerUtterance: string,
  ): Promise<boolean> {
    const results = await this.retriever.query({
      npcId,
      sessionId,
      query: playerUtterance,
      limit: 5,
    });

    const maxSimilarity =
      results.length > 0 ? results[0].similarityScore : 0;
    return maxSimilarity < 0.3;
  }
}
