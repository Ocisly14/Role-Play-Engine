// src/state/itemId.ts
//
// The id an item gets when nobody supplies one. Shared by the code that mints
// it (`DynamicGameState.createItem`) and the code that decides whether the
// Engine had to supply one itself (`worldDeltaValidator`), so the two cannot
// disagree about which names are derivable.

/**
 * The readable part of an id derived from a name: lowercased, every run of
 * non-`[a-z0-9]` collapsed to `_`, trimmed and capped.
 *
 * It returns "" for a name with no Latin letters or digits at all — and this
 * world runs in Chinese, so that is the common case, not the edge one. The
 * caller that mints ids then produces `item_`, `item__2`, `item__3`: unique,
 * but telling nothing apart. Item ids are printed into prose as `[id]` and are
 * the only handle a character has on a thing, so the Engine supplies its own
 * id whenever this comes back empty.
 */
export function itemIdSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

/** True when a name yields no readable id and the author must supply one. */
export function needsExplicitItemId(name: string): boolean {
  return itemIdSlug(name).length === 0;
}
