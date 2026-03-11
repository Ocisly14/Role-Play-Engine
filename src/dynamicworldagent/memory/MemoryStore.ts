import type { PrismaClient, NpcMemory, NpcMemoryType } from "@prisma/client";
import type { EmbeddingClient } from "../../rag/embedding.js";
import { getHandler } from "./handlers/index.js";
import type { AddMemoryParams } from "./types.js";

export class MemoryStore {
  private prisma: PrismaClient;
  private embedClient: EmbeddingClient;

  constructor(prisma: PrismaClient, embedClient: EmbeddingClient) {
    this.prisma = prisma;
    this.embedClient = embedClient;
  }

  async create(params: AddMemoryParams): Promise<NpcMemory> {
    const handler = getHandler(params.type);
    const prepared = handler.prepare(params.content, params.metadata, params.location);
    const baseImportance = params.baseImportanceOverride ?? prepared.baseImportance;
    const tags = params.tagsOverride ?? prepared.tags;

    let embeddingBuffer: Uint8Array<ArrayBuffer> | undefined = undefined;
    try {
      const vector = await this.embedClient.embed(params.content);
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
        tags,
        gameDay: params.gameDay,
        gameTime: params.gameTime,
        location: params.location ?? null,
        baseImportance,
        importance: baseImportance,
        embedding: embeddingBuffer,
      },
    });
  }

  async findCandidates(params: {
    sessionId: string;
    npcId: string;
    filters?: {
      types?: NpcMemoryType[];
      gameDay?: number;
      location?: string;
      tags?: string[];
      minImportance?: number;
    };
    limit?: number;
  }): Promise<NpcMemory[]> {
    const { filters, limit } = params;
    return this.prisma.npcMemory.findMany({
      where: {
        sessionId: params.sessionId,
        npcId: params.npcId,
        ...(filters?.types && { type: { in: filters.types } }),
        ...(filters?.gameDay !== undefined && { gameDay: filters.gameDay }),
        ...(filters?.location && { location: filters.location }),
        ...(filters?.tags && { tags: { hasSome: filters.tags } }),
        ...(filters?.minImportance !== undefined && { importance: { gte: filters.minImportance } }),
      },
      orderBy: { importance: "desc" },
      take: limit ?? 200,
    });
  }

  async findAllForSession(sessionId: string): Promise<NpcMemory[]> {
    return this.prisma.npcMemory.findMany({ where: { sessionId } });
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
    extraFields?: { baseImportance?: number },
  ): Promise<void> {
    await this.prisma.npcMemory.update({
      where: { id: memoryId },
      data: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: metadata as any,
        ...(extraFields?.baseImportance !== undefined && { baseImportance: extraFields.baseImportance }),
      },
    });
  }

  async batchUpdateImportance(
    sessionId: string,
    updates: Array<{ id: string; importance: number }>,
  ): Promise<void> {
    await this.prisma.$transaction(
      updates.map((u) =>
        this.prisma.npcMemory.update({
          where: { id: u.id },
          data: { importance: u.importance },
        }),
      ),
    );
  }

  async deletePostCheckpoint(sessionId: string, checkpointCreatedAt: Date): Promise<void> {
    await this.prisma.npcMemory.deleteMany({
      where: { sessionId, createdAt: { gt: checkpointCreatedAt } },
    });
    await this.prisma.npcMemory.deleteMany({
      where: {
        sessionId,
        createdAt: { lte: checkpointCreatedAt },
        updatedAt: { gt: checkpointCreatedAt },
      },
    });
  }

  async embedQuery(query: string): Promise<number[]> {
    return this.embedClient.embed(query);
  }
}
