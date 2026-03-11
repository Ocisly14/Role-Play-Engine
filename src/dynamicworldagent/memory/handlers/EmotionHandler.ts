import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

export class EmotionHandler implements MemoryHandler {
  type = "emotion" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string,
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags: string[] = ["emotion"];
    if (location) tags.push(location);
    return {
      tags,
      baseImportance: 2.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    const meta = memory.metadata as Record<string, any> | null;
    const emotionType = meta?.emotionType ?? "unknown";
    const intensity = meta?.intensity ?? 1;
    return `[emotion] ${emotionType} (intensity: ${intensity}): ${memory.content}`;
  }

  customDecayRate(): number {
    return 2.0;
  }
}
