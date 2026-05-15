// src/roleSim/memoryFormatter.ts
//
// Renders today's memories (event + witness) into the user prompt's
// "## Today's memories" section. Pure formatter — sorting + line mapping.
// The shape only requires the three fields actually rendered, so callers can
// pass either a Prisma `NpcMemory` row or a slim `RoleSimContext.recentMemory`
// item without coupling to the full Prisma type.

import { timePart } from "../state/gameClock.js";

export interface FormattableMemory {
  type: string;
  content: string;
  gameDateTime: string;
  /** Human-readable scene name; rendered inline as `at <Name>` when present. */
  location?: string;
}

export function formatTodayMemories(
  rows: ReadonlyArray<FormattableMemory>
): string {
  return [...rows]
    .sort((a, b) => a.gameDateTime.localeCompare(b.gameDateTime))
    .map((m) => {
      const where = m.location ? ` at ${m.location}` : "";
      return `- [${timePart(m.gameDateTime)}] (${m.type})${where} ${m.content}`;
    })
    .join("\n");
}
