import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class ClueHandler implements MemoryHandler {
  type = "clue" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string,
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags: string[] = ["clue"];
    if (location) tags.push(location);
    const clueId = metadata?.clueId as string | undefined;
    if (clueId) tags.push(clueId);
    return {
      tags,
      baseImportance: 3.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    return `[clue] ${memory.content}`;
  }

  customDecayRate(): number {
    return 0.5;
  }
}
