import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class SummaryHandler implements MemoryHandler {
  type = "summary" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    _location?: string,
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const meta = metadata ?? {};
    const gameDay = meta.gameDay;
    const tags: string[] = ["summary"];
    if (gameDay !== undefined) tags.push(`day_${gameDay}`);
    return {
      tags,
      baseImportance: meta.importance ?? 3.0,
      metadata: meta,
    };
  }

  format(memory: PrismaNpcMemory): string {
    return `[summary] Day${memory.gameDay} - ${memory.content}`;
  }

  /** Summaries decay much slower than regular memories. */
  customDecayRate(): number {
    return 3.0;
  }
}
