import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class PlanHandler implements MemoryHandler {
  type = "plan" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string,
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags: string[] = ["plan"];
    if (location) tags.push(location);
    return {
      tags,
      baseImportance: 1.5,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    const meta = memory.metadata as Record<string, any> | null;
    const planType = (meta?.planType as string | undefined) ?? "daily";
    return `[plan:${planType}] ${memory.content}`;
  }

  customDecayRate(): number {
    return 1.5;
  }
}
