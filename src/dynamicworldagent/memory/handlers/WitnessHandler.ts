import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class WitnessHandler implements MemoryHandler {
  type = "witness" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string,
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags: string[] = ["witness"];
    if (location) tags.push(location);
    const sourceCharacterId = metadata?.sourceCharacterId as string | undefined;
    if (sourceCharacterId) tags.push(sourceCharacterId);
    return {
      tags,
      baseImportance: 2.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    return `[witness] Day${memory.gameDay} ${memory.gameTime} - ${memory.content}`;
  }
}
