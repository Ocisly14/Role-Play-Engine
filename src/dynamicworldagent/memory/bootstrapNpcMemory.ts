/**
 * Bootstrap NPC memory entries from profile JSON into the NpcMemory table.
 *
 * Called once at session creation time. Each NPC's `memory[]` array
 * is written into the unified NpcMemory system.
 *
 * Idempotent: skips NPCs that already have bootstrapped memories.
 */

import type { PrismaClient } from "@prisma/client";
import type { EmbeddingClient } from "../../rag/embedding.js";
import { NpcMemoryManager } from "./NpcMemoryManager.js";

export interface BootstrapNpcMemoryParams {
  prisma: PrismaClient;
  embedClient: EmbeddingClient;
  sessionId: string;
  moduleId: string;
  npcs: ReadonlyArray<{
    id: string;
    memory?: ReadonlyArray<{
      type: string;
      content: string;
      metadata?: Record<string, any>;
    }>;
  }>;
  gameDay: number;
  gameTime: string;
}

export async function bootstrapNpcMemory(
  params: BootstrapNpcMemoryParams
): Promise<number> {
  const { prisma, embedClient, sessionId, moduleId, npcs, gameDay, gameTime } =
    params;
  const memoryManager = new NpcMemoryManager(prisma, embedClient);

  let totalWritten = 0;

  for (const npc of npcs) {
    if (!npc.memory || npc.memory.length === 0) continue;

    // Guard: check if already bootstrapped
    const existing = await prisma.npcMemory.count({
      where: { npcId: npc.id, sessionId },
    });
    if (existing > 0) continue;

    for (const entry of npc.memory) {
      if (!entry.content || entry.content.trim() === "") continue;

      await memoryManager.add({
        npcId: npc.id,
        sessionId,
        moduleId,
        type: entry.type as any,
        content: entry.content.trim(),
        gameDay,
        gameTime,
        metadata: entry.metadata,
      });
      totalWritten++;
    }
  }

  if (totalWritten > 0) {
    console.log(
      `[BootstrapNpcMemory] Wrote ${totalWritten} memory entries for session ${sessionId}`
    );
  }

  return totalWritten;
}
