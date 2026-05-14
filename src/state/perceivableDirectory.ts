// src/state/perceivableDirectory.ts
//
// Per-tick perception scope: which entity ids this actor may reference in
// citations. Used by the LLM interpreter to reject out-of-scope references
// and by the renderer to know which entities to surface in the perception
// prompt. The directory holds raw ids only — name/description lookup is
// always done via DGSM, so there is exactly one source of truth for entity
// metadata.

import type { DynamicGameStateManager } from "./DynamicGameState.js";
import type { DynamicNPCProfile } from "./types.js";

export interface PerceivableDirectory {
  /** Character ids in scope: KNOWN via relationships ∪ in-scene. */
  characters: Set<string>;
  /** Item ids in scope: scene items ∪ actor inventory. */
  items: Set<string>;
  /** Scene ids in scope: current scene + scenes reachable via 1-hop connections. */
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

  // ── Characters: in-scene (incl. UNKNOWN strangers) ──────────────
  const actorPos = dgsm.getCharacterPosition(actorId);
  const sceneId =
    actorPos && actorPos.type === "scene" ? actorPos.sceneId : null;
  if (sceneId) {
    for (const npc of dgsm.getState().npcCharacters) {
      if (npc.id === actorId) continue;
      if (!dgsm.isNpcAlive(npc.id)) continue;
      const pos = dgsm.getCharacterPosition(npc.id);
      const npcSceneId = pos && pos.type === "scene" ? pos.sceneId : null;
      if (npcSceneId === sceneId) characters.add(npc.id);
    }
  }

  // ── Items: scene items ∪ actor inventory ────────────────────────
  if (sceneId) {
    const scene = dgsm.getScene(sceneId);
    for (const item of scene?.items ?? []) items.add(item.id);
  }
  for (const item of actor.inventory ?? []) items.add(item.id);

  // ── Scenes: current + adjacent ──────────────────────────────────
  if (sceneId) {
    scenes.add(sceneId);
    const currentScene = dgsm.getScene(sceneId);
    for (const conn of currentScene?.connections ?? []) {
      if (dgsm.getScene(conn.targetId)) scenes.add(conn.targetId);
    }
  }

  return { characters, items, scenes };
}
