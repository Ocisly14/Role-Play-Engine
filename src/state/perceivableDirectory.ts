// src/state/perceivableDirectory.ts
//
// Per-tick perception scope: which entities this actor may reference, and
// under what handle. Used by the trust boundary to reject out-of-scope
// references and by the prompt builder to tell the actor what it can point
// at. The directory holds raw ids only — name/description lookup is always
// done via DGSM, so there is exactly one source of truth for entity metadata.
//
// A character the viewpoint does not know is addressed by an ALIAS —
// `stranger_a` — never by their real id, which would hand over the canonical
// name ("Hollins") of someone they may only know as "the tall pale man". That
// leak used to be held back by nothing but a prompt rule. The alias closes it
// structurally: the actor cites `stranger_a`, the trust boundary swaps in the
// real id before the Engine sees the command, and the name never enters the
// actor's context at all.
//
// Aliases are per-tick and carry no meaning of their own — the address book
// prints the description beside each one. Nothing downstream stores an alias:
// both `act` and `writeMemory` resolve to real ids at the boundary, so an
// alias never has to mean the same thing tomorrow that it means today. That
// is why they can be short and legible instead of a stable hash.
//
// People the viewpoint DOES know, and all items and places, keep their real
// ids. `SCN_LIBRARY` tells the actor it is a library, which they can see;
// `ITEM_SCN2_7` tells them nothing. There is no identity to protect, so there
// is no indirection to pay for.

import type { DynamicGameStateManager } from "./DynamicGameState.js";
import {
  charactersAtSameLocation,
  resolvePerceivedLocation,
} from "./perceivedLocation.js";
import type { DynamicNPCProfile } from "./types.js";

export interface PerceivableDirectory {
  /** Real character ids in scope: known via the relationship graph ∪
   *  co-located. A stranger's real id is never shown to the actor — see
   *  `characterHandles`. */
  characters: Set<string>;
  /** What the actor may cite → the real character id, one entry per id in
   *  `characters`. Someone they know maps to themselves (their real id is no
   *  secret); a stranger maps from an alias. This map is the only way back. */
  characterHandles: Map<string, string>;
  /** Item ids in scope: items at the current location ∪ actor inventory. */
  items: Set<string>;
  /** PLACE ids in scope — scenes, junctions and roads alike (the citation
   *  grammar has one `scene` kind for "a place"): the actor's current
   *  location plus everything one hop from it. */
  scenes: Set<string>;
}

/**
 * Does `viewpointId` know `otherCharId` by name? Drives the KNOWN/UNKNOWN gate
 * everywhere it matters: the renderer describes an unknown person instead of
 * naming them, and the address book lists them the same way.
 *
 * The answer comes from `npcRelationshipGraph` — the LIVE graph, which the
 * Engine grows through `relationship` deltas as characters actually deal with
 * one another. `profile.relationships` is only its module-load seed and never
 * moves again; reading that instead used to mean the profile block introduced
 * "Hollins" by name while the address book still called him "the tall pale
 * man", which both leaked the name and contradicted itself inside one prompt.
 */
export function isKnownTo(
  dgsm: DynamicGameStateManager,
  viewpointId: string,
  otherCharId: string
): boolean {
  return dgsm.getRelationship(viewpointId, otherCharId) !== undefined;
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

  if (!dgsm.getNpcProfile(actorId)) {
    return { characters, characterHandles: new Map(), items, scenes };
  }

  // ── Characters: KNOWN via the live relationship graph ───────────
  for (const targetId of Object.keys(
    dgsm.getState().npcRelationshipGraph[actorId] ?? {}
  )) {
    if (targetId === actorId) continue;
    if (!dgsm.isNpcAlive(targetId)) continue;
    if (!dgsm.getNpcProfile(targetId)) continue;
    characters.add(targetId);
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

  // ── What the actor may cite, per character in scope ─────────────
  // Sorted by real id so aliases fall the same way for the same cast, which
  // keeps the address book byte-stable across the ticks of an unchanged scene.
  const sorted = [...characters].sort();
  const characterHandles = new Map<string, string>();
  // People they know go in first: their real id is citable as-is, and
  // registering it up front stops an alias from ever shadowing one.
  const strangers: string[] = [];
  for (const id of sorted) {
    if (isKnownTo(dgsm, actorId, id)) characterHandles.set(id, id);
    else strangers.push(id);
  }
  let n = 0;
  for (const id of strangers) {
    let alias = strangerAlias(n++);
    while (characterHandles.has(alias)) alias = strangerAlias(n++);
    characterHandles.set(alias, id);
  }

  return { characters, characterHandles, items, scenes };
}

/** `stranger_a`, `stranger_b`, … `stranger_z`, `stranger_aa`. Short enough to
 *  copy without slipping, and meaningless on its own — the address book
 *  carries the description that tells the actor which stranger this is. */
function strangerAlias(index: number): string {
  let n = index;
  let label = "";
  do {
    label = String.fromCharCode(97 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `stranger_${label}`;
}
