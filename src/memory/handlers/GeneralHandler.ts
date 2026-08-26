import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import { formatForPrompt } from "../../state/gameClock.js";
import type { MemoryHandler } from "../types.js";

/**
 * 普通记忆 — the default type the character writes for anything worth
 * keeping: what happened to them, what they saw others do, a conclusion they
 * reached, a fact learned. Replaces the former event / witness / belief /
 * information split — the engine no longer classifies memories, the character
 * simply records what mattered. `plan` and `secret` stay separate: they have
 * their own decay profiles and answer different questions.
 */
export class GeneralHandler implements MemoryHandler {
  type = "general" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags: string[] = ["general"];
    if (location) tags.push(location);
    return {
      tags,
      baseImportance: 1.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    const loc = memory.location ? ` [${memory.location}]` : "";
    return `${formatForPrompt(memory.gameDateTime)}${loc} — ${memory.content}`;
  }
}
