// src/state/characterSpot.ts
//
// Where a character is WITHIN their location — "at the workbench, back to the
// door". Free narrative text: nothing is computed from it, nothing is gated on
// it, and the only judgement code makes about it is whether the string is one
// a prompt line can carry.

/**
 * A phrase, not a paragraph. Long enough for a clause with a facing in it,
 * short enough that it can never crowd out the block it sits in.
 */
export const MAX_SPOT_LENGTH = 120;

/**
 * The one gate every spot passes through on the way in — module seed, Engine
 * delta, injected character, all of them.
 *
 * Square brackets are stripped, not escaped. The same string is printed into
 * the renderer's prompt, where a bracket means "a citable id". A module author
 * writing "在[柜台]旁" would hand the renderer a tag it may legally copy, the
 * actor a citation the trust boundary then rejects, and the tick one wasted
 * corrective round. Nothing about a spot is ever citable, so the bracket has
 * no meaning to lose.
 *
 * Returns "" for anything empty after normalization; callers read that as
 * "no spot".
 */
export function normalizeSpot(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SPOT_LENGTH);
}
