import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class SecretHandler implements MemoryHandler {
  type = "secret" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags: string[] = ["secret"];
    if (location) tags.push(location);
    return {
      tags,
      baseImportance: 3.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    return `[secret] ${memory.content}`;
  }

  customDecayRate(): number {
    return 0.3;
  }
}
