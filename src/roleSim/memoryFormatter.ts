// src/roleSim/memoryFormatter.ts
//
// Renders everything the character remembers into the user prompt's
// "## What you remember" section. Pure formatter — sorting + line mapping.
// Timestamps carry the date as well as the time: the section spans every day
// played, so a bare "09:15" would not say which morning.
// The shape only requires the three fields actually rendered, so callers can
// pass either a Prisma `NpcMemory` row or a slim `RoleSimContext.memories`
// item without coupling to the full Prisma type.

import { formatForPrompt } from "../state/gameClock.js";

export interface FormattableMemory {
  type: string;
  content: string;
  gameDateTime: string;
  /** Human-readable scene name; rendered inline as `at <Name>` when present. */
  location?: string;
}

export function formatMemories(
  rows: ReadonlyArray<FormattableMemory>
): string {
  return [...rows]
    .sort((a, b) => a.gameDateTime.localeCompare(b.gameDateTime))
    .map((m) => {
      const where = m.location ? ` at ${m.location}` : "";
      return `- [${formatForPrompt(m.gameDateTime)}] (${m.type})${where} ${m.content}`;
    })
    .join("\n");
}
