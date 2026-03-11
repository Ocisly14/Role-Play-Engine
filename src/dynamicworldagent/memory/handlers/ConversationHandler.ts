import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class ConversationHandler implements MemoryHandler {
  type = "conversation" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string,
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags: string[] = ["conversation"];
    if (location) tags.push(location);
    const withCharacterId = metadata?.withCharacterId as string | undefined;
    if (withCharacterId) tags.push(withCharacterId);
    return {
      tags,
      baseImportance: 1.5,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    const meta = memory.metadata as Record<string, any> | null;
    const withName = meta?.withCharacterName ?? meta?.withCharacterId ?? "unknown";
    return `[conversation] with ${withName}: ${memory.content}`;
  }
}
