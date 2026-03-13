import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class InformationHandler implements MemoryHandler {
  type = "information" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags: string[] = ["information"];
    if (location) tags.push(location);
    const knowledgeId = metadata?.knowledgeId as string | undefined;
    if (knowledgeId) tags.push(knowledgeId);
    return {
      tags,
      baseImportance: 3.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    return `[information] ${memory.content}`;
  }

  customDecayRate(): number {
    return 0.5;
  }
}
