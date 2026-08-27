// src/roleSim/memoryFormatter.ts
//
// Renders everything the character remembers into the user prompt's
// "## What you remember" section, and mints the tag each line is cited by.
// Pure formatter — sorting, tagging and line mapping; no store access.
//
// Timestamps carry the date as well as the time: the section spans every day
// played, so a bare "09:15" would not say which morning.
//
// The shape only requires the fields actually rendered, so callers can pass
// either a Prisma `NpcMemory` row or a slim `RoleSimContext.memories` item
// without coupling to the full Prisma type.

import { formatForPrompt } from "../state/gameClock.js";

export interface FormattableMemory {
  /** Store row id. Never rendered raw — `memoryTag` derives the cited tag. */
  id: string;
  type: string;
  content: string;
  gameDateTime: string;
  /** Human-readable scene name; rendered inline as `at <Name>` when present. */
  location?: string;
}

/**
 * The tag a character cites to revise or retract one of their own memories.
 *
 * Derived from the row id, not from the memory's position in the list, so it
 * is stable for the life of the row: writing or retracting a memory never
 * renumbers the ones around it. A positional scheme would silently repoint a
 * tag the character read last minute at a different memory, and would rewrite
 * the whole (cached) memory block on every retraction.
 */
export function memoryTag(id: string, length = 8): string {
  return `M${id.replace(/-/g, "").slice(0, length)}`;
}

/**
 * Tags for a whole set, guaranteed distinct within it.
 *
 * A truncated id can collide — at eight hex characters, roughly one run in two
 * thousand. Rather than assume it away, colliding ids get the untruncated tag.
 * The resolver reads this same map, so both sides always agree on what a tag
 * means.
 */
export function buildMemoryTags(
  rows: ReadonlyArray<Pick<FormattableMemory, "id">>
): Map<string, string> {
  const idsByTag = new Map<string, string[]>();
  for (const row of rows) {
    const tag = memoryTag(row.id);
    idsByTag.set(tag, [...(idsByTag.get(tag) ?? []), row.id]);
  }

  const tagById = new Map<string, string>();
  for (const [tag, ids] of idsByTag) {
    if (ids.length === 1) {
      tagById.set(ids[0], tag);
      continue;
    }
    for (const id of ids) tagById.set(id, memoryTag(id, 32));
  }
  return tagById;
}

export function formatMemories(rows: ReadonlyArray<FormattableMemory>): string {
  const tagById = buildMemoryTags(rows);

  // Render first, then sort on (time, rendered line). Sorting on time alone
  // is not a TOTAL order — every `context` memory is stamped at session start,
  // so a character's whole geography ties — and `Array.sort` is stable, which
  // means ties silently inherit whatever order the caller happened to pass.
  // This block is ~90% of the user prompt and sits inside its cached prefix,
  // so an order that wobbles between ticks throws that prefix away.
  //
  // The line itself is the right tiebreaker: two memories that tie on it
  // render identically, so their relative order cannot change the output.
  return [...rows]
    .map((m) => {
      const where = m.location ? ` at ${m.location}` : "";
      const tag = tagById.get(m.id) ?? memoryTag(m.id);
      return {
        at: m.gameDateTime,
        line: `- [${tag}] [${formatForPrompt(m.gameDateTime)}] (${m.type})${where} ${m.content}`,
      };
    })
    .sort((a, b) => a.at.localeCompare(b.at) || a.line.localeCompare(b.line))
    .map((m) => m.line)
    .join("\n");
}
