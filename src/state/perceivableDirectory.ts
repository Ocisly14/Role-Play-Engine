// src/state/perceivableDirectory.ts
//
// Per-tick perception scope: which entity ids this actor may reference in
// citations. Used by the LLM interpreter to reject out-of-scope references
// and by the renderer to know which entities to surface in the perception
// prompt. The directory holds raw ids only — name/description lookup is
// always done via DGSM, so there is exactly one source of truth for entity
// metadata.

import type { DynamicGameStateManager } from "./DynamicGameState.js";
import {
  charactersAtSameLocation,
  resolvePerceivedLocation,
} from "./perceivedLocation.js";
import type { DynamicNPCProfile } from "./types.js";

export interface PerceivableDirectory {
  /** Character ids in scope: KNOWN via relationships ∪ co-located. */
  characters: Set<string>;
  /** Item ids in scope: items at the current location ∪ actor inventory. */
  items: Set<string>;
  /** PLACE ids in scope — scenes, junctions and roads alike (the citation
   *  grammar has one `scene` kind for "a place"): the actor's current
   *  location plus everything one hop from it. */
  scenes: Set<string>;
}

/** Did `viewpoint` know `otherCharId` before this tick? Drives the renderer's
 *  KNOWN/UNKNOWN gate (UNKNOWN people get rendered by description, not by
 *  canonical name, even though their id is exposed for citation). */
export function isKnownTo(
  viewpoint: DynamicNPCProfile | undefined,
  otherCharId: string
): boolean {
  if (!viewpoint?.relationships) return false;
  return viewpoint.relationships.some((r) => r.targetId === otherCharId);
}

/** Description-based identifier for an UNKNOWN character. Used by the
 *  renderer when rendering an unknown person in narrative prose. */
export function descriptionIdentifier(profile: DynamicNPCProfile): string {
  const bits: string[] = [];
  if (profile.appearance) {
    bits.push(profile.appearance);
  } else if (profile.age || profile.gender) {
    if (profile.age) bits.push(`age ${profile.age}`);
    if (profile.gender) bits.push(profile.gender);
  } else if (profile.occupation) {
    bits.push(profile.occupation);
  }
  return bits.length > 0 ? `the ${bits.join(", ")}` : "an unfamiliar person";
}

export function buildPerceivableDirectory(
  actorId: string,
  dgsm: DynamicGameStateManager
): PerceivableDirectory {
  const characters = new Set<string>();
  const items = new Set<string>();
  const scenes = new Set<string>();

  const actor = dgsm.getNpcProfile(actorId);
  if (!actor) return { characters, items, scenes };

  // ── Characters: KNOWN via relationships ─────────────────────────
  for (const rel of actor.relationships ?? []) {
    if (rel.targetId === actorId) continue;
    if (!dgsm.isNpcAlive(rel.targetId)) continue;
    if (!dgsm.getNpcProfile(rel.targetId)) continue;
    characters.add(rel.targetId);
  }

  // ── Characters: co-located (incl. UNKNOWN strangers) ────────────
  // Works on roads and at junctions too — a traveller must be able to see
  // whoever is walking beside them.
  for (const id of charactersAtSameLocation(actorId, dgsm)) characters.add(id);

  // ── Items: items at the current location ∪ actor inventory ──────
  const location = resolvePerceivedLocation(
    dgsm.getCharacterPosition(actorId),
    dgsm
  );
  for (const item of location?.items ?? []) items.add(item.id);
  // Read inventory from runtime npcInventories (mutated by item.move /
  // item.create / item.destroy). The static profile.inventory is loaded once
  // from JSON and never updated by Applier paths — perception MUST reflect
  // runtime state.
  for (const item of dgsm.getNpcInventory(actorId)) items.add(item.id);

  // ── Places: current + one hop ───────────────────────────────────
  if (location) {
    scenes.add(location.id);
    for (const id of location.adjacentIds) scenes.add(id);
  }

  return { characters, items, scenes };
}
