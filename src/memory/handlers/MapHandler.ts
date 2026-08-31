import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

/**
 * 地图记忆 — both the geography a character starts with and places or routes
 * they learn in play. One type keeps map knowledge editable and avoids a
 * second, system-only memory category.
 */
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
    return 0;
  }
}
