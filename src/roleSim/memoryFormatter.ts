// src/roleSim/memoryFormatter.ts
//
// Renders today's memories (event + witness) into the user prompt's
// "## Today's memories" section. Pure formatter — sorting + line mapping.
// The shape only requires the three fields actually rendered, so callers can
// pass either a Prisma `NpcMemory` row or a slim `RoleSimContext.recentMemory`
// item without coupling to the full Prisma type.

export interface FormattableMemory {
  type: string;
  content: string;
  gameTime: string;
}

export function formatTodayMemories(
  rows: ReadonlyArray<FormattableMemory>
): string {
  return [...rows]
    .sort((a, b) => (a.gameTime < b.gameTime ? -1 : 1))
    .map((m) => `- [${m.gameTime}] (${m.type}) ${m.content}`)
    .join("\n");
}
