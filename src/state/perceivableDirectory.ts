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
// An alias is derived from (viewer, target) and is therefore STABLE: the same
// stranger is the same tag to the same actor, this minute and next week. It
// has to be. A citation can reach the boundary from the actor's own
// perception history, minutes after it was written, and a positional alias
// would by then name whoever else had walked in. Nothing downstream stores an
// alias — `act` and `writeMemory` both resolve to real ids at the boundary —
// but it must still mean tomorrow what it meant today.
//
// People the viewpoint DOES know, and all items and places, keep their real
// ids. `SCN_LIBRARY` tells the actor it is a library, which they can see;
// `ITEM_SCN2_7` tells them nothing. There is no identity to protect, so there
// is no indirection to pay for.

import { createHash } from "node:crypto";
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
/**
 * Does the viewpoint know WHO this is — not merely have a view of them.
 *
 * These are different things, and conflating them leaked every canonical name
 * in the world. It used to be "has a relationship entry", so the moment a
 * shopkeeper wrote down that a customer made her uneasy, the renderer began
 * calling him by his full legal name — which she had never been told. She then
 * recorded that she had "learned his name", believing she had heard it.
 *
 * A name arrives one way: somebody says it where the character can hear, and
 * the character writes it down. Until then they have opinions about a face.
 */
export function isKnownTo(
  dgsm: DynamicGameStateManager,
  viewpointId: string,
  otherCharId: string
): boolean {
  return dgsm.getRelationship(viewpointId, otherCharId)?.knownAs !== undefined;
}

/** What this viewpoint calls that person, when they know. */
export function knownAs(
  dgsm: DynamicGameStateManager,
  viewpointId: string,
  otherCharId: string
): string | undefined {
  return dgsm.getRelationship(viewpointId, otherCharId)?.knownAs;
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
  // Sorted by real id so the address book is byte-stable for the same cast.
  const characterHandles = new Map<string, string>();
  for (const id of [...characters].sort()) {
    // People they know are citable by their real id — no identity to protect.
    characterHandles.set(
      isKnownTo(dgsm, actorId, id) ? id : aliasFor(actorId, id),
      id
    );
  }

  return { characters, characterHandles, items, scenes };
}

/**
 * A stable, opaque name for someone this actor does not know.
 *
 * Derived from (viewer, target) rather than from position in the current
 * cast, and that difference is the whole point. Positional aliases —
 * `stranger_a` for whoever sorts first among the strangers present — mean
 * different people on different ticks, so a citation copied out of the
 * actor's own perception history resolves, silently, to somebody else. The
 * boundary could not catch it either: the alias was well-formed, it just
 * meant the wrong person.
 *
 * Keyed on the viewer as well as the target so two characters never learn
 * they are looking at the same stranger by comparing tags, and hashed so the
 * canonical name ("Hollins") never reaches an actor who only knows a tall
 * pale man. The renderer prints the description beside it, which is where the
 * legibility a letter used to give now comes from.
 */
export function aliasFor(actorId: string, targetId: string): string {
  return `stranger_${createHash("sha256")
    .update(`${actorId}\u0000${targetId}`)
    .digest("hex")
    .slice(0, 6)}`;
}
