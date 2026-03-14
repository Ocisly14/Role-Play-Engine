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
    const difficulty = (metadata?.difficulty as string) ?? "hard";
    tags.push(`difficulty:${difficulty}`);
    const knowledgeId = metadata?.knowledgeId as string | undefined;
    if (knowledgeId) tags.push(knowledgeId);
    return {
      tags,
      baseImportance: 3.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    const meta = memory.metadata as Record<string, any> | null;
    const kid = (meta?.knowledgeId as string) ?? "";
    return kid
      ? `[secret:${kid}] ${memory.content}`
      : `[secret] ${memory.content}`;
  }

  customDecayRate(): number {
    return 0.3;
  }
}
