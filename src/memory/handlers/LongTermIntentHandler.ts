import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class LongTermIntentHandler implements MemoryHandler {
  type = "long_term_intent" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags: string[] = ["long_term_intent"];
    if (location) tags.push(location);
    return {
      tags,
      // High baseline so the latest intent always surfaces in scoring;
      // matches Decision 22's "narrative authority" framing.
      baseImportance: 3.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    return `[long_term_intent] ${memory.content}`;
  }

  customDecayRate(): number {
    // Decay slowly — a long-term intent should outlive routine memories until
    // the agent explicitly overwrites it via writeMemory.
    return 0.3;
  }
}
