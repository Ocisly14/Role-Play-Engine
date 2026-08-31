import { randomUUID } from "node:crypto";
import { mintMemoryHandle } from "./memoryHandle.js";
import type { NpcMemory, NpcMemoryType, PrismaClient } from "@prisma/client";
import type { EmbeddingClient } from "../rag/embedding.js";
import { getHandler } from "./handlers/index.js";
import type { AddMemoryParams } from "./types.js";

/**
 * Row order for every candidate query: chronological, with `id` breaking ties.
 *
 * It used to be `{ importance: "desc" }`, a single NON-UNIQUE key — and
 * `importance` defaults to 1.0 with nothing overriding it for generated map
 * memories, so a character's entire geography (76 rows for one NPC) sorted as
 * one flat tie. Postgres is free to return a tie in any order it likes, and
 * that order reaches the prompt verbatim through `formatMemories`, whose sort
 * is stable and therefore inherits it. Two consequences, both bad: the diary
 * read a day's events in importance order instead of chronological order, and
 * the prompt's cached prefix was silently destroyed whenever the row order
 * shifted — including every time `reinforce()` nudged an importance value.
 */
const CHRONOLOGICAL = [{ gameDateTime: "desc" }, { id: "desc" }] as const;

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

  /**
   * The handle this memory will answer to, decided here and never again.
   *
   * The id is generated in application code rather than by the database
   * because the handle is derived from it: it has to exist before the row
   * does. Minted against the handles this character already holds, so a
   * collision lengthens the newcomer and leaves every handle the character
   * may already have read exactly as it was.
   */
  private async mintHandle(
    id: string,
    sessionId: string,
    npcId: string
  ): Promise<string> {
    const held = await this.prisma.npcMemory.findMany({
      where: { sessionId, npcId },
      select: { handle: true },
    });
    return mintMemoryHandle(id, new Set(held.map((row) => row.handle)));
  }

  async create(params: AddMemoryParams): Promise<NpcMemory> {
    const prepared = this.prepareMemoryRecord(params);
    const id = randomUUID();
    const handle = await this.mintHandle(id, params.sessionId, params.npcId);

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
        id,
        handle,
        sessionId: params.sessionId,
        moduleId: params.moduleId,
        npcId: params.npcId,
        type: params.type,
        content: params.content,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: prepared.metadata as any,
        tags: prepared.tags,
        gameDateTime: params.gameDateTime,
        location: params.location ?? null,
        baseImportance: prepared.baseImportance,
        importance: prepared.baseImportance,
        embedding: embeddingBuffer,
      },
    });
  }

  /**
   * Types restricted to the current game day when `currentGameDate` is set
   * (older ones are represented by summaries instead).
   *
   * Empty since memory became agent-authored: the character now writes only
   * what it judged worth keeping, so there is no per-tick auto-written bulk
   * to age out. Importance + decay govern relevance instead.
   */
  private static EPHEMERAL_TYPES: NpcMemoryType[] = [];

  async findCandidates(params: {
    sessionId: string;
    npcId: string;
    filters?: {
      types?: NpcMemoryType[];
      gameDate?: string | string[];
      currentGameDate?: string;
      location?: string;
      tags?: string[];
      minImportance?: number;
    };
    limit?: number;
  }): Promise<NpcMemory[]> {
    const { filters, limit } = params;
    const dateFilter = (() => {
      if (filters?.gameDate === undefined) return undefined;
      if (Array.isArray(filters.gameDate)) {
        if (filters.gameDate.length === 0) return undefined;
        if (filters.gameDate.length === 1) {
          return { gameDateTime: { startsWith: filters.gameDate[0] } };
        }
        return {
          OR: filters.gameDate.map((d) => ({
            gameDateTime: { startsWith: d },
          })),
        };
      }
      return { gameDateTime: { startsWith: filters.gameDate } };
    })();

    // When currentGameDate is set, ephemeral types are restricted to the
    // current date only; past dates are represented by summary memories.
    // EPHEMERAL_TYPES is currently empty (see above), so this degenerates to
    // the durable branch — kept because the day-scoping rule is still the
    // intended behaviour if a short-lived type is ever reintroduced.
    if (
      filters?.currentGameDate !== undefined &&
      filters.gameDate === undefined
    ) {
      const requestedTypes = filters.types;
      const ephemeralRequested = requestedTypes
        ? MemoryStore.EPHEMERAL_TYPES.filter((t) => requestedTypes.includes(t))
        : MemoryStore.EPHEMERAL_TYPES;
      const durableRequested = requestedTypes
        ? requestedTypes.filter((t) => !MemoryStore.EPHEMERAL_TYPES.includes(t))
        : ([
            "general",
            "plan",
            "secret",
            "relationship",
            "map",
          ] as NpcMemoryType[]);

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
          gameDateTime: { startsWith: filters.currentGameDate },
        });
      }

      if (orClauses.length === 0) return [];

      // Queried newest-first so `take` drops the OLDEST when the cap bites,
      // then reversed to hand back chronological order.
      const page = await this.prisma.npcMemory.findMany({
        where: { OR: orClauses },
        orderBy: [...CHRONOLOGICAL],
        take: limit ?? 200,
      });
      return page.reverse();
    }

    const page = await this.prisma.npcMemory.findMany({
      where: {
        sessionId: params.sessionId,
        npcId: params.npcId,
        ...(filters?.types && { type: { in: filters.types } }),
        ...(dateFilter ?? {}),
        ...(filters?.location && { location: filters.location }),
        ...(filters?.tags && { tags: { hasSome: filters.tags } }),
        ...(filters?.minImportance !== undefined && {
          importance: { gte: filters.minImportance },
        }),
      },
      orderBy: [...CHRONOLOGICAL],
      take: limit ?? 200,
    });
    return page.reverse();
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
      | "gameDateTime"
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
        gameDateTime: params.gameDateTime,
        location: params.location ?? null,
        baseImportance: prepared.baseImportance,
        importance: prepared.baseImportance,
      },
    });
  }

  /**
   * Revise or retract one memory that the given character owns.
   *
   * The ownership check lives in the WHERE clause, not in a read-then-verify:
   * a row that is not this character's, in this session, simply does not
   * match, so a guessed or stale id can never touch someone else's memory.
   * The returned count is what the caller reports back to the agent — 0 means
   * "no such memory of yours", which is exactly the feedback it needs.
   */
  async updateOwnContent(params: {
    memoryId: string;
    sessionId: string;
    npcId: string;
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<number> {
    const result = await this.prisma.npcMemory.updateMany({
      where: {
        id: params.memoryId,
        sessionId: params.sessionId,
        npcId: params.npcId,
      },
      data: {
        content: params.content,
        ...(params.metadata !== undefined
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { metadata: params.metadata as any }
          : {}),
      },
    });
    return result.count;
  }

  async deleteOwn(params: {
    memoryId: string;
    sessionId: string;
    npcId: string;
  }): Promise<number> {
    const result = await this.prisma.npcMemory.deleteMany({
      where: {
        id: params.memoryId,
        sessionId: params.sessionId,
        npcId: params.npcId,
      },
    });
    return result.count;
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
