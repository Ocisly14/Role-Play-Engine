// src/state/perceivableDirectory.ts
//
// Phase H: shared directory used by GameInterpreter (citation resolution) and
// llmRenderer (perception identity gate). One source of truth for "what
// entities can this actor reference by name in this tick".
//
// Spec: docs/superpowers/specs/2026-05-07-agent-engine-citation-contract-design.md
//   - D8 character scope (relationships ∪ in-scene with KNOWN/UNKNOWN gate)
//   - OQ4 item scope (scene items ∪ actor inventory; scene wins conflicts)

import type { DynamicGameStateManager } from "./DynamicGameState.js";
import type { DynamicNPCProfile } from "./types.js";

export interface PerceivableDirectory {
  /** Display name → character ID. KNOWN: canonical name; UNKNOWN: descriptionIdentifier. */
  characters: Map<string, string>;
  /** Display name → item identifier. Scene items use Item.id; inventory items use name. */
  items: Map<string, string>;
  /** Display name → scene ID. Current scene + scenes reachable via 1-hop connections. */
  scenes: Map<string, string>;
}

/** Did `viewpoint` know `otherCharId` before this tick? Drives KNOWN/UNKNOWN gate. */
export function isKnownTo(
  viewpoint: DynamicNPCProfile | undefined,
  otherCharId: string
): boolean {
  if (!viewpoint?.relationships) return false;
  return viewpoint.relationships.some((r) => r.targetId === otherCharId);
}

/** Description-based identifier for an UNKNOWN character. Stable for a given
 *  profile snapshot — renderer + interpreter must agree. */
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
  const actor = dgsm.getNpcProfile(actorId);
  const characters = new Map<string, string>();
  const items = new Map<string, string>();
  const scenes = new Map<string, string>();

  if (!actor) {
    return { characters, items, scenes };
  }

  // ── Characters: KNOWN via relationships ─────────────────────────
  const knownIds = new Set<string>();
  for (const rel of actor.relationships ?? []) {
    if (rel.targetId === actorId) continue;
    if (!dgsm.isNpcAlive(rel.targetId)) continue;
    const target = dgsm.getNpcProfile(rel.targetId);
    if (!target) continue;
    characters.set(target.name, target.id);
    knownIds.add(target.id);
  }

  // ── Characters: UNKNOWN in-scene ─────────────────────────────────
  const actorPos = dgsm.getCharacterPosition(actorId);
  const sceneId =
    actorPos && actorPos.type === "scene" ? actorPos.sceneId : null;
  if (sceneId) {
    const state = dgsm.getState();
    for (const npc of state.npcCharacters) {
      if (npc.id === actorId) continue;
      if (knownIds.has(npc.id)) continue;
      if (!dgsm.isNpcAlive(npc.id)) continue;
      const npcPos = dgsm.getCharacterPosition(npc.id);
      const npcSceneId =
        npcPos && npcPos.type === "scene" ? npcPos.sceneId : null;
      if (npcSceneId !== sceneId) continue;
      characters.set(descriptionIdentifier(npc), npc.id);
    }
  }

  // ── Items: scene first (wins conflicts), then inventory ──────────
  if (sceneId) {
    const scene = dgsm.getScene(sceneId);
    for (const item of scene?.items ?? []) {
      items.set(item.name, item.id);
    }
  }
  for (const item of actor.inventory ?? []) {
    if (!items.has(item.name)) {
      items.set(item.name, item.name);
    }
  }

  // ── Scenes: current + adjacent via connections ───────────────────
  if (sceneId) {
    const currentScene = dgsm.getScene(sceneId);
    if (currentScene) {
      scenes.set(currentScene.name, currentScene.id);
      for (const conn of currentScene.connections ?? []) {
        const adj = dgsm.getScene(conn.targetId);
        if (adj) scenes.set(adj.name, adj.id);
      }
    }
  }

  return { characters, items, scenes };
}
