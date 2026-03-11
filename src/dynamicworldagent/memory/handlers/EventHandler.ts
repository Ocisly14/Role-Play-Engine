import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class EventHandler implements MemoryHandler {
  type = "event" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string,
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags: string[] = ["event"];
    if (location) tags.push(location);
    return {
      tags,
      baseImportance: 1.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    return `[event] Day${memory.gameDay} ${memory.gameTime} - ${memory.content}`;
  }
}
