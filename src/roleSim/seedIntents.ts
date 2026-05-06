// src/roleSim/seedIntents.ts
//
// Module-load helper: write each NPC's module-defined `longTermIntent` as a
// `long_term_intent` memory entry. Called once per session bootstrap.
//
// Per Decision 22 (Phase F brainstorm 2026-04-24): module-author intents are
// narrative design and must be preserved verbatim into NpcMemory; agent can
// later self-revise via writeMemory.

import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { DynamicNPCProfile } from "../state/types.js";

export async function seedNpcLongTermIntents(params: {
  npcs: DynamicNPCProfile[];
  sessionId: string;
  moduleId: string;
  memoryManager: NpcMemoryManager;
  gameDateTime: string;
}): Promise<void> {
  let seeded = 0;
  for (const npc of params.npcs) {
    if (!npc.longTermIntent) continue;
    await params.memoryManager.add({
      npcId: npc.id,
      sessionId: params.sessionId,
      moduleId: params.moduleId,
      type: "long_term_intent",
      content: npc.longTermIntent,
      gameDateTime: params.gameDateTime,
    });
    seeded += 1;
  }
  console.log(
    `[seedNpcLongTermIntents] seeded ${seeded} long-term intent(s) ` +
      `(${params.npcs.length - seeded} npcs had no module-defined intent)`
  );
}
