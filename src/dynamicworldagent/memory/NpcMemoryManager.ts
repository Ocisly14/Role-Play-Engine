import type { NpcMemory, NpcMemoryType, PrismaClient } from "@prisma/client";
import type { EmbeddingClient } from "../../rag/embedding.js";
import { DecayEngine } from "./DecayEngine.js";
import {
  areKnownMapSnapshotsEquivalent,
  areKnownMapConnectionKeysEqual,
  areKnownMapIdsEqual,
  buildKnownMapSnapshot,
  createFullKnownMapIds,
  createKnownMapIdsFromSeed,
  extractNameOnlySceneIds,
  getKnownMapLocationIdsFromPosition,
  makeKnownMapConnectionKey,
  mergeKnownMapIds,
  normalizeKnownMapConnectionKeys,
  revealKnownMapLocations,
  revealKnownMapLocationsDirect,
  snapshotSummary,
} from "./mapMemory.js";
import { MemoryRetriever } from "./MemoryRetriever.js";
import { MemoryStore } from "./MemoryStore.js";
import { getAllHandlers, getHandler } from "./handlers/index.js";
import {
  buildReasoningPrompt,
  parseReasoningOutput,
} from "./prompts/reasoningPrompt.js";
import {
  type AddMemoryParams,
  CONTEXT_PROFILES,
  type EnsureMapSnapshotParams,
  type GetContextParams,
  type KnownMapIds,
  type KnownMapSnapshot,
  MIN_MEMORIES_FOR_REASONING,
  type QueryMemoryParams,
  type RefreshMapSnapshotParams,
  type ScoredMemory,
  type TriggerReasoningParams,
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

  private async upsertMapSnapshot(params: {
    npcId: string;
    sessionId: string;
    moduleId: string;
    gameDay: number;
    gameTime: string;
    location?: string;
    snapshot: KnownMapSnapshot;
  }): Promise<NpcMemory> {
    const existing = await this.store.findLatestByType(
      params.sessionId,
      params.npcId,
      "map"
    );
    const content = snapshotSummary(params.snapshot);
    const metadata = { snapshot: params.snapshot };

    if (!existing) {
      return this.add({
        npcId: params.npcId,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        type: "map",
        content,
        gameDay: params.gameDay,
        gameTime: params.gameTime,
        location: params.location,
        metadata,
      });
    }

    return this.store.updateMemory(existing.id, {
      type: "map",
      content,
      gameDay: params.gameDay,
      gameTime: params.gameTime,
      location: params.location,
      metadata,
    });
  }

  async getMapSnapshot(
    npcId: string,
    sessionId: string
  ): Promise<KnownMapSnapshot | null> {
    const memory = await this.store.findLatestByType(sessionId, npcId, "map");
    const metadata = memory?.metadata as Record<string, any> | null;
    const snapshot = metadata?.snapshot as KnownMapSnapshot | undefined;
    if (!snapshot?.knownIds) return null;
    return {
      ...snapshot,
      revealedHiddenConnections: Array.isArray(
        snapshot.revealedHiddenConnections
      )
        ? snapshot.revealedHiddenConnections.filter(
            (value): value is string => typeof value === "string"
          )
        : [],
    };
  }

  async ensureMapSnapshot(
    params: EnsureMapSnapshotParams
  ): Promise<KnownMapSnapshot> {
    const existing = await this.getMapSnapshot(params.npcId, params.sessionId);
    if (existing) return existing;

    const knownIds = createKnownMapIdsFromSeed(params.dgsm, params.seed);
    const snapshot = buildKnownMapSnapshot(params.dgsm, knownIds, {
      revealedHiddenConnections: [],
    });
    await this.upsertMapSnapshot({
      npcId: params.npcId,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      gameDay: params.gameDay,
      gameTime: params.gameTime,
      location: params.location,
      snapshot,
    });
    return snapshot;
  }

  async refreshMapSnapshot(
    params: RefreshMapSnapshotParams
  ): Promise<KnownMapSnapshot> {
    const existing = await this.getMapSnapshot(params.npcId, params.sessionId);
    const knownIds = existing?.knownIds ?? createFullKnownMapIds(params.dgsm);
    const snapshot = buildKnownMapSnapshot(params.dgsm, knownIds, {
      revealedHiddenConnections: existing?.revealedHiddenConnections ?? [],
      nameOnlySceneIds: extractNameOnlySceneIds(existing),
      currentLocationId: params.location,
    });
    if (existing && areKnownMapSnapshotsEquivalent(existing, snapshot)) {
      return existing;
    }
    await this.upsertMapSnapshot({
      npcId: params.npcId,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      gameDay: params.gameDay,
      gameTime: params.gameTime,
      location: params.location,
      snapshot,
    });
    return snapshot;
  }


  async ensureCurrentLocationInMap(
    params: RefreshMapSnapshotParams
  ): Promise<KnownMapSnapshot> {
    const existing = await this.ensureMapSnapshot({
      ...params,
      seed: undefined,
    });
    const position = params.dgsm.getCharacterPosition(params.npcId);
    const locationIds = getKnownMapLocationIdsFromPosition(position);
    if (locationIds.length === 0) {
      return existing;
    }

    const expandedKnownIds = revealKnownMapLocations(
      params.dgsm,
      existing.knownIds,
      locationIds
    );
    const existingNameOnlySceneIds = extractNameOnlySceneIds(existing);
    const nextNameOnlySceneIds = new Set(existingNameOnlySceneIds);

    if (position?.type === "scene") {
      nextNameOnlySceneIds.delete(position.sceneId);
    }

    for (const sceneId of expandedKnownIds.sceneIds) {
      if (existing.knownIds.sceneIds.includes(sceneId)) continue;
      if (position?.type === "scene" && sceneId === position.sceneId) continue;
      nextNameOnlySceneIds.add(sceneId);
    }

    const normalizedNameOnlySceneIds = [...nextNameOnlySceneIds].sort();
    const needsSceneUpgrade =
      position?.type === "scene" &&
      existing.scenes[position.sceneId]?.detailLevel === "name_only";

    if (
      areKnownMapIdsEqual(existing.knownIds, expandedKnownIds) &&
      areKnownMapConnectionKeysEqual(
        existingNameOnlySceneIds,
        normalizedNameOnlySceneIds
      ) &&
      !needsSceneUpgrade
    ) {
      return existing;
    }

    const snapshot = buildKnownMapSnapshot(params.dgsm, expandedKnownIds, {
      revealedHiddenConnections: existing.revealedHiddenConnections,
      nameOnlySceneIds: normalizedNameOnlySceneIds,
      currentLocationId: params.location,
    });
    await this.upsertMapSnapshot({
      npcId: params.npcId,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      gameDay: params.gameDay,
      gameTime: params.gameTime,
      location: params.location,
      snapshot,
    });
    return snapshot;
  }

  async mergeKnownIdsIntoMap(
    params: RefreshMapSnapshotParams & { knownIds: KnownMapIds }
  ): Promise<KnownMapSnapshot> {
    const existing = await this.ensureMapSnapshot({
      ...params,
      seed: undefined,
    });
    const mergedIds = mergeKnownMapIds(existing.knownIds, params.knownIds);
    if (areKnownMapIdsEqual(existing.knownIds, mergedIds)) {
      return existing;
    }
    const snapshot = buildKnownMapSnapshot(params.dgsm, mergedIds, {
      revealedHiddenConnections: existing.revealedHiddenConnections,
      nameOnlySceneIds: extractNameOnlySceneIds(existing),
      currentLocationId: params.location,
    });
    await this.upsertMapSnapshot({
      npcId: params.npcId,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      gameDay: params.gameDay,
      gameTime: params.gameTime,
      location: params.location,
      snapshot,
    });
    return snapshot;
  }

  async revealHiddenConnectionsInMap(
    params: RefreshMapSnapshotParams & {
      connections: Array<{ sceneId: string; targetId: string }>;
    }
  ): Promise<KnownMapSnapshot> {
    const existing = await this.ensureMapSnapshot({
      ...params,
      seed: undefined,
    });
    const currentLocationId =
      params.location ??
      (() => {
        const position = params.dgsm.getCharacterPosition(params.npcId);
        return position ? params.dgsm.resolveLocationId(position) : undefined;
      })();
    const locationIds = params.connections.flatMap((connection) => [
      connection.sceneId,
      connection.targetId,
    ]);
    const nextKnownIds = revealKnownMapLocationsDirect(
      params.dgsm,
      existing.knownIds,
      locationIds
    );
    const revealedHiddenConnections = normalizeKnownMapConnectionKeys(
      params.dgsm,
      [
        ...(existing.revealedHiddenConnections ?? []),
        ...params.connections.map((connection) =>
          makeKnownMapConnectionKey(connection.sceneId, connection.targetId)
        ),
      ]
    );
    const nameOnlySceneIds = [
      ...new Set([
        ...extractNameOnlySceneIds(existing).filter(
          (sceneId) => sceneId !== currentLocationId
        ),
        ...params.connections
          .map((connection) => connection.targetId)
          .filter((sceneId) => {
            if (sceneId === currentLocationId) return false;
            if (!params.dgsm.getState().scenes.has(sceneId)) return false;
            return existing.scenes[sceneId]?.detailLevel !== "full";
          }),
      ]),
    ].sort();
    if (
      areKnownMapIdsEqual(existing.knownIds, nextKnownIds) &&
      areKnownMapConnectionKeysEqual(
        existing.revealedHiddenConnections,
        revealedHiddenConnections
      ) &&
      areKnownMapConnectionKeysEqual(
        extractNameOnlySceneIds(existing),
        nameOnlySceneIds
      )
    ) {
      return existing;
    }
    const snapshot = buildKnownMapSnapshot(params.dgsm, nextKnownIds, {
      revealedHiddenConnections,
      nameOnlySceneIds,
      currentLocationId,
    });
    await this.upsertMapSnapshot({
      npcId: params.npcId,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      gameDay: params.gameDay,
      gameTime: params.gameTime,
      location: params.location,
      snapshot,
    });
    return snapshot;
  }

  // ===== Retrieve =====

  async query(params: QueryMemoryParams): Promise<ScoredMemory[]> {
    return this.retriever.query(params);
  }

  /** Fetch all memories for a specific NPC on a specific game day (no scoring/semantic filtering). */
  async getAllForDay(
    npcId: string,
    sessionId: string,
    gameDay: number
  ): Promise<NpcMemory[]> {
    return this.store.findCandidates({
      sessionId,
      npcId,
      filters: { gameDay },
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
            filters: { types: [type], currentGameDay: params.currentGameDay },
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
            currentGameDay: params.currentGameDay,
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
          currentGameDay: params.currentGameDay,
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

  async triggerReasoning(
    params: TriggerReasoningParams,
    npcName: string,
    npcProfile: string,
    generateTextFn: (prompt: string) => Promise<string>,
    language?: string
  ): Promise<NpcMemory[]> {
    // Fetch relevant memories for reasoning
    const memories = await this.retriever.query({
      npcId: params.npcId,
      sessionId: params.sessionId,
      query: params.context ?? "",
      filters: {
        types: ["information", "witness", "event", "belief"],
        currentGameDay: params.gameDay,
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
        (b) => b.content === update.originalBelief
      );
      if (!existing) continue;

      await this.updateBeliefConfidence(
        existing.id,
        update.newConfidence,
        update.reason,
        (existing.metadata as Record<string, any>) ?? {}
      );
    }

    return newMemories;
  }

  async shouldTriggerReasoningOnConversation(
    npcId: string,
    sessionId: string,
    playerUtterance: string
  ): Promise<boolean> {
    const results = await this.retriever.query({
      npcId,
      sessionId,
      query: playerUtterance,
      limit: 5,
    });

    const maxSimilarity = results.length > 0 ? results[0].similarityScore : 0;
    return maxSimilarity < 0.3;
  }
}
