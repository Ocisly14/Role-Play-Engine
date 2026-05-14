import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class MapHandler implements MemoryHandler {
  type = "map" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags = ["map"];
    if (location) tags.push(location);
    return {
      tags,
      baseImportance: 4.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    return `[map] ${memory.content}`;
  }

  customDecayRate(): number {
    return 0.1;
  }
}
