import type { NpcMemory as PrismaNpcMemory } from "@prisma/client";
import type { MemoryHandler } from "../types.js";

/**
 * Compatibility handler for sessions persisted before map knowledge was
 * unified under `map`. New sessions never create `context` rows.
 *
 * Three scopes, in the order they are generated: `macro` (one per building
 * or macro location), `interior` (one per scene inside it), and a single
 * `topology` entry tying them together — which building sits on which
 * street, and how the streets connect.
 *
 * Does not decay. A person does not forget which street the hospital is on;
 * the sceneries they walk past every day are the last thing to go.
 */
export class ContextHandler implements MemoryHandler {
  type = "context" as const;

  prepare(
    _content: string,
    metadata?: Record<string, any>,
    location?: string
  ): { tags: string[]; baseImportance: number; metadata: Record<string, any> } {
    const tags: string[] = ["context"];
    const scope = metadata?.scope as string | undefined;
    if (scope) tags.push(scope);
    const locationId = metadata?.locationId as string | undefined;
    if (locationId) tags.push(locationId);
    if (location && location !== locationId) tags.push(location);
    return {
      tags,
      baseImportance: 5.0,
      metadata: metadata ?? {},
    };
  }

  format(memory: PrismaNpcMemory): string {
    return `[map] ${memory.content}`;
  }

  customDecayRate(): number {
    return 0;
  }
}
