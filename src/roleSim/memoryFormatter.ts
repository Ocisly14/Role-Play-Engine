// src/roleSim/memoryFormatter.ts
//
// Renders everything the character remembers into the user prompt's
// "## What you remember" section. Pure formatter — sorting and line mapping,
// no store access and no id arithmetic: the handle each line is cited by was
// decided when the memory was written.
//
// Timestamps carry the date as well as the time: the section spans every day
// played, so a bare "09:15" would not say which morning.
//
// The handle is written `#M3f9a2c`, NOT in brackets. Square brackets mean one
// thing everywhere else in this prompt — a citable entity in the world — and
// a handle that wore them was a handle an actor would cite as an objectRef.
// Observed live: asked to name the church nave he was standing in, a
// character cited `M999df02a`, the handle of his own map memory OF that
// nave, which renders on a line reading "at 教堂主殿". Two id spaces, one
// surface form, and only the section heading to tell them apart.
//
// The shape only requires the fields actually rendered, so callers can pass
// either a Prisma `NpcMemory` row or a slim `RoleSimContext.memories` item
// without coupling to the full Prisma type.

import { formatForPrompt } from "../state/gameClock.js";

export interface FormattableMemory {
  /** The short name this memory answers to, minted once when it was written
   *  and stored on the row. Nothing here derives it: a handle computed from
   *  the set it happens to be rendered with is a handle that changes when the
   *  company does, and twice already it did. */
  handle: string;
  /** Store row id. Never shown — the handle is what the character cites. */
  id: string;
  type: string;
  content: string;
  gameDateTime: string;
  /** Human-readable scene name; rendered inline as `at <Name>` when present. */
  location?: string;
}

export function formatMemories(rows: ReadonlyArray<FormattableMemory>): string {
  // Render first, then sort on (time, rendered line). Sorting on time alone
  // is not a TOTAL order — generated map memories share a session-start stamp,
  // so a character's whole geography ties — and `Array.sort` is stable, which
  // means ties silently inherit whatever order the caller happened to pass.
  // This block is ~90% of the user prompt and sits inside its cached prefix,
  // so an order that wobbles between ticks throws that prefix away.
  //
  // The line itself is the right tiebreaker: two memories that tie on it
  // render identically, so their relative order cannot change the output.
  return [...rows]
    .map((m) => {
      // The place sits inside the parentheses with the type, so the whole
      // bracketed run reads as metadata. Rendered as a bare ` at <place>`
      // between the type and the content, it was copied INTO a memory's
      // content as if it were the first words of it — and then rendered
      // twice, once by the world and once by the character.
      const where = m.location ? `, at ${m.location}` : "";

      return {
        at: m.gameDateTime,
        line: `- #${m.handle} [${formatForPrompt(m.gameDateTime)}] (${m.type}${where}) ${m.content}`,
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.line.localeCompare(b.line))
    .map((m) => m.line)
    .join("\n");
}
