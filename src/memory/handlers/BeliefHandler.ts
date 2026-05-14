import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class BeliefHandler implements MemoryHandler {
  type = "belief" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags: string[] = ["belief"];
    if (location) tags.push(location);
    return {
      tags,
      baseImportance: 2.5,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    const meta = memory.metadata as Record<string, any> | null;
    const confidence = meta?.confidence ?? 1.0;
    const reasoningChain = meta?.reasoningChain as string | undefined;
    let result = `[belief] ${memory.content} (confidence: ${confidence})`;
    if (reasoningChain) {
      result += `\n  Reasoning: ${reasoningChain}`;
    }
    return result;
  }

  customDecayRate(): number {
    return 0.5;
  }
}
