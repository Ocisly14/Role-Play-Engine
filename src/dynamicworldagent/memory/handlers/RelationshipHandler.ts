import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class RelationshipHandler implements MemoryHandler {
  type = "relationship" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string,
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags: string[] = ["relationship"];
    if (location) tags.push(location);
    const targetId = metadata?.targetId as string | undefined;
    if (targetId) tags.push(targetId);
    return {
      tags,
      baseImportance: 2.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    const meta = memory.metadata as Record<string, any> | null;
    const targetName = meta?.targetName ?? meta?.targetId ?? "unknown";
    const scoreDelta = meta?.scoreDelta as number | undefined;
    const deltaStr =
      scoreDelta !== undefined
        ? ` ${scoreDelta >= 0 ? "+" : ""}${scoreDelta}`
        : "";
    return `[relationship] ${targetName}${deltaStr}: ${memory.content}`;
  }

  customDecayRate(): number {
    return 0.5;
  }
}
