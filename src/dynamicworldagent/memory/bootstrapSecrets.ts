/**
 * Bootstrap NPC secrets into the unified NpcMemory system.
 *
 * Called once at session creation time (both single-player and multiplayer).
 * Each NPC's `secrets` array is written as a "secret" type memory.
 *
 * Idempotent: skips NPCs that already have secret memories for this session,
 * so re-running the init after a crash or reconnect is safe.
 */

import type { PrismaClient } from "@prisma/client";
import type { EmbeddingClient } from "../../rag/embedding.js";
import { NpcMemoryManager } from "./NpcMemoryManager.js";

export interface BootstrapSecretsParams {
  prisma: PrismaClient;
  embedClient: EmbeddingClient;
  sessionId: string;
  moduleId: string;
  npcs: ReadonlyArray<{
    id: string;
    secrets?: string[];
  }>;
  gameDay: number;
  gameTime: string;
}

export async function bootstrapNpcSecrets(
  params: BootstrapSecretsParams,
): Promise<number> {
  const { prisma, embedClient, sessionId, moduleId, npcs, gameDay, gameTime } =
    params;
  const memoryManager = new NpcMemoryManager(prisma, embedClient);

  let totalWritten = 0;

  for (const npc of npcs) {
    const secrets = npc.secrets;
    if (!secrets || secrets.length === 0) continue;

    // Guard against duplicates: check if this NPC already has secret memories
    const existing = await prisma.npcMemory.count({
      where: {
        npcId: npc.id,
        sessionId,
        type: "secret",
      },
    });

    if (existing > 0) {
      continue; // secrets already bootstrapped for this NPC
    }

    for (const secret of secrets) {
      if (!secret || typeof secret !== "string" || secret.trim() === "") {
        continue;
      }

      await memoryManager.add({
        npcId: npc.id,
        sessionId,
        moduleId,
        type: "secret",
        content: secret.trim(),
        gameDay,
        gameTime,
        metadata: { knownBy: [npc.id] },
      });
      totalWritten++;
    }
  }

  if (totalWritten > 0) {
    console.log(
      `[BootstrapSecrets] Wrote ${totalWritten} secret memories for session ${sessionId}`,
    );
  }

  return totalWritten;
}
