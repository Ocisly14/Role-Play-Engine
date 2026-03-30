import type { NpcMemory, NpcMemoryType, PrismaClient } from "@prisma/client";
import type { EmbeddingClient } from "../../rag/embedding.js";
import { getHandler } from "./handlers/index.js";
import type { AddMemoryParams } from "./types.js";

export class MemoryStore {
  private prisma: PrismaClient;
  private embedClient: EmbeddingClient;
  private embeddingLanguage: "en" | "zh";

  constructor(
    prisma: PrismaClient,
    embedClient: EmbeddingClient,
    language = "en"
  ) {
    this.prisma = prisma;
    this.embedClient = embedClient;
    this.embeddingLanguage = language.startsWith("zh") ? "zh" : "en";
  }

  private prepareMemoryRecord(params: AddMemoryParams): {
    baseImportance: number;
    tags: string[];
    metadata: Record<string, any>;
  } {
    const handler = getHandler(params.type);
    const prepared = handler.prepare(
      params.content,
      params.metadata,
      params.location
    );
    const baseImportance =
      params.baseImportanceOverride ?? prepared.baseImportance;
    const tags = params.tagsOverride ?? prepared.tags;
    return {
      baseImportance,
      tags,
      metadata: prepared.metadata,
    };
  }

  async create(params: AddMemoryParams): Promise<NpcMemory> {
    const prepared = this.prepareMemoryRecord(params);

    let embeddingBuffer: Uint8Array<ArrayBuffer> | undefined = undefined;
    try {
      const vector = await this.embedClient.embed(params.content, {
        language: this.embeddingLanguage,
      });
      const float32 = new Float32Array(vector);
      // Copy into a plain ArrayBuffer to satisfy Prisma's Bytes type (Uint8Array<ArrayBuffer>)
      const ab = new ArrayBuffer(float32.byteLength);
      new Float32Array(ab).set(float32);
      embeddingBuffer = new Uint8Array(ab);
    } catch {
      // Embedding failure is non-fatal
    }

    return this.prisma.npcMemory.create({
      data: {
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        npcId: params.npcId,
        type: params.type,
        content: params.content,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: prepared.metadata as any,
        tags: prepared.tags,
        gameDay: params.gameDay,
        gameTime: params.gameTime,
        location: params.location ?? null,
        baseImportance: prepared.baseImportance,
        importance: prepared.baseImportance,
        embedding: embeddingBuffer,
      },
    });
  }

  /** Types that are ephemeral — only relevant for the current game day (past ones are covered by summary). */
  private static EPHEMERAL_TYPES: NpcMemoryType[] = [
    "event",
    "witness",
    "plan",
  ];

  async findCandidates(params: {
    sessionId: string;
    npcId: string;
    filters?: {
      types?: NpcMemoryType[];
      gameDay?: number;
      currentGameDay?: number;
      location?: string;
      tags?: string[];
      minImportance?: number;
    };
    limit?: number;
  }): Promise<NpcMemory[]> {
    const { filters, limit } = params;

    // When currentGameDay is set, ephemeral types (event/witness/plan) are restricted
    // to the current day only; past days are represented by summary memories.
    if (
      filters?.currentGameDay !== undefined &&
      filters.gameDay === undefined
    ) {
      const requestedTypes = filters.types;
      const ephemeralRequested = requestedTypes
        ? MemoryStore.EPHEMERAL_TYPES.filter((t) => requestedTypes.includes(t))
        : MemoryStore.EPHEMERAL_TYPES;
      const durableRequested = requestedTypes
        ? requestedTypes.filter((t) => !MemoryStore.EPHEMERAL_TYPES.includes(t))
        : (["summary", "secret", "belief", "information"] as NpcMemoryType[]);

      const baseWhere = {
        sessionId: params.sessionId,
        npcId: params.npcId,
        ...(filters.location && { location: filters.location }),
        ...(filters.tags && { tags: { hasSome: filters.tags } }),
        ...(filters.minImportance !== undefined && {
          importance: { gte: filters.minImportance },
        }),
      };

      const orClauses: any[] = [];
      if (durableRequested.length > 0) {
        orClauses.push({ ...baseWhere, type: { in: durableRequested } });
      }
      if (ephemeralRequested.length > 0) {
        orClauses.push({
          ...baseWhere,
          type: { in: ephemeralRequested },
          gameDay: filters.currentGameDay,
        });
      }

      if (orClauses.length === 0) return [];

      return this.prisma.npcMemory.findMany({
        where: { OR: orClauses },
        orderBy: { importance: "desc" },
        take: limit ?? 200,
      });
    }

    return this.prisma.npcMemory.findMany({
      where: {
        sessionId: params.sessionId,
        npcId: params.npcId,
        ...(filters?.types && { type: { in: filters.types } }),
        ...(filters?.gameDay !== undefined && { gameDay: filters.gameDay }),
        ...(filters?.location && { location: filters.location }),
        ...(filters?.tags && { tags: { hasSome: filters.tags } }),
        ...(filters?.minImportance !== undefined && {
          importance: { gte: filters.minImportance },
        }),
      },
      orderBy: { importance: "desc" },
      take: limit ?? 200,
    });
  }

  async findAllForSession(sessionId: string): Promise<NpcMemory[]> {
    return this.prisma.npcMemory.findMany({ where: { sessionId } });
  }

  async findLatestByType(
    sessionId: string,
    npcId: string,
    type: NpcMemoryType
  ): Promise<NpcMemory | null> {
    return this.prisma.npcMemory.findFirst({
      where: { sessionId, npcId, type },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
  }

  async reinforce(memoryId: string, newImportance: number): Promise<void> {
    await this.prisma.npcMemory.update({
      where: { id: memoryId },
      data: {
        accessCount: { increment: 1 },
        lastAccessedAt: new Date(),
        importance: newImportance,
      },
    });
  }

  async updateMetadata(
    memoryId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    metadata: Record<string, any>,
    extraFields?: { baseImportance?: number }
  ): Promise<void> {
    await this.prisma.npcMemory.update({
      where: { id: memoryId },
      data: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: metadata as any,
        ...(extraFields?.baseImportance !== undefined && {
          baseImportance: extraFields.baseImportance,
        }),
      },
    });
  }

  async updateMemory(
    memoryId: string,
    params: Pick<
      AddMemoryParams,
      | "type"
      | "content"
      | "gameDay"
      | "gameTime"
      | "location"
      | "metadata"
      | "baseImportanceOverride"
      | "tagsOverride"
    >
  ): Promise<NpcMemory> {
    const prepared = this.prepareMemoryRecord({
      npcId: "",
      sessionId: "",
      moduleId: "",
      ...params,
    });

    return this.prisma.npcMemory.update({
      where: { id: memoryId },
      data: {
        content: params.content,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: prepared.metadata as any,
        tags: prepared.tags,
        gameDay: params.gameDay,
        gameTime: params.gameTime,
        location: params.location ?? null,
        baseImportance: prepared.baseImportance,
        importance: prepared.baseImportance,
      },
    });
  }

  async updateContent(memoryId: string, content: string): Promise<void> {
    await this.prisma.npcMemory.update({
      where: { id: memoryId },
      data: { content },
    });
  }

  async batchUpdateImportance(
    sessionId: string,
    updates: Array<{ id: string; importance: number }>
  ): Promise<void> {
    await this.prisma.$transaction(
      updates.map((u) =>
        this.prisma.npcMemory.update({
          where: { id: u.id },
          data: { importance: u.importance },
        })
      )
    );
  }

  async deleteAfterTime(
    sessionId: string,
    cutoffCreatedAt: Date
  ): Promise<void> {
    await this.prisma.npcMemory.deleteMany({
      where: { sessionId, createdAt: { gt: cutoffCreatedAt } },
    });
    await this.prisma.npcMemory.deleteMany({
      where: {
        sessionId,
        createdAt: { lte: cutoffCreatedAt },
        updatedAt: { gt: cutoffCreatedAt },
      },
    });
  }

  async embedQuery(query: string): Promise<number[]> {
    return this.embedClient.embed(query, { language: this.embeddingLanguage });
  }
}
