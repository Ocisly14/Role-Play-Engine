// src/memory/memoryHandle.ts
//
// The short name a character cites to revise or retract one of their own
// memories: `M3f9a2c`.
//
// Minted ONCE, when the memory is written, and stored on the row. That is the
// whole design. Two earlier versions computed it at render time from whatever
// set of memories happened to be in hand, and both were wrong in ways nothing
// caught:
//
//  - A memory's handle could CHANGE. Collisions were resolved by lengthening
//    both sides, so writing a new memory could silently rename an old one, and
//    a handle the character had read a minute earlier stopped resolving.
//  - Uniqueness was scoped to the argument, not the character. Splitting the
//    memory block in two for the prompt cache meant tagging each half
//    separately; a collision spanning the halves was invisible to both calls,
//    so the same handle was printed on two different memories — while the
//    resolver, which saw the whole set, recognised neither.
//
// Stored, both disappear: the handle is an attribute of the memory rather than
// a function of the company it is rendered in.

import { createHash } from "node:crypto";

/** `M` + the first `length` hex characters of the row id. */
export function memoryHandle(id: string, length = 8): string {
  const hex = id.replace(/-/g, "");
  // A non-uuid id (tests, fixtures) still needs a stable hex source.
  const source = /^[0-9a-f]+$/i.test(hex)
    ? hex
    : createHash("sha256").update(id).digest("hex");
  return `M${source.slice(0, length)}`;
}

/**
 * A handle for `id` that no memory of this character already holds.
 *
 * Lengthens only the NEWCOMER, never the handles already out there: a memory
 * the character has read about keeps the name it was given, whatever arrives
 * afterwards.
 */
export function mintMemoryHandle(
  id: string,
  taken: ReadonlySet<string>
): string {
  for (let length = 8; length <= 32; length += 2) {
    const candidate = memoryHandle(id, length);
    if (!taken.has(candidate)) return candidate;
  }
  // Two ids identical over all 32 hex characters are the same id.
  return memoryHandle(id, 32);
}
