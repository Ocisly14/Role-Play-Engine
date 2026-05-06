// src/roleSim/perceptionRenderer.ts
//
// Controller-side perception narrative stub. Produces the "## What you
// perceive" content for the user prompt. This is a deterministic placeholder
// until a real renderer ships (future Phase H — template vs LLM choice TBD).
// Output is fixed English; the LLM's response language is governed by the
// "Write content in <lang>" instruction in the user prompt's `## Decide`
// section.

import type { DynamicGameStateManager } from "../state/DynamicGameState.js";

const HP_HURT_THRESHOLD = 0.25;
const SAN_FRAYING_THRESHOLD = 0.2;
const FATIGUE_EXHAUSTED_THRESHOLD = 0.75;

export function buildPerceptionNarrative(
  npcId: string,
  dgsm: DynamicGameStateManager
): string {
  const lines: string[] = [];

  const position = dgsm.getCharacterPosition(npcId);
  const sceneId =
    position && position.type === "scene" ? position.sceneId : null;
  const scene = sceneId ? dgsm.getScene(sceneId) : null;

  if (scene) {
    lines.push(`You are in ${scene.name}. ${scene.description}`);
  } else {
    lines.push("You are somewhere indistinct.");
  }

  // Present NPCs (same scene, excluding self, alive only)
  if (sceneId) {
    const presentNames = collectPresentNpcNames(dgsm, npcId, sceneId);
    if (presentNames.length > 0) {
      lines.push(presentNames.map((n) => `${n} is here`).join("; ") + ".");
    }
  }

  // Scene conditions
  if (scene && scene.conditions && scene.conditions.length > 0) {
    lines.push(scene.conditions.map((c) => c.description).join("; "));
  }

  // Status feel (HP / SAN / Fatigue thresholds)
  const statusFeel = renderStatusFeel(dgsm, npcId);
  if (statusFeel) lines.push(statusFeel);

  return lines.join(" ");
}

function collectPresentNpcNames(
  dgsm: DynamicGameStateManager,
  selfId: string,
  sceneId: string
): string[] {
  const state = dgsm.getState();
  const names: string[] = [];
  for (const npc of state.npcCharacters) {
    if (npc.id === selfId) continue;
    if (!dgsm.isNpcAlive(npc.id)) continue;
    const pos = state.characterPositions?.[npc.id];
    if (pos && pos.type === "scene" && pos.sceneId === sceneId) {
      names.push(npc.name);
    }
  }
  return names;
}

function renderStatusFeel(
  dgsm: DynamicGameStateManager,
  npcId: string
): string | null {
  const npc = dgsm.getState().npcCharacters.find((n) => n.id === npcId);
  if (!npc) return null;
  const s = npc.status;
  const feels: string[] = [];
  if (s.maxHp > 0 && s.hp / s.maxHp < HP_HURT_THRESHOLD) {
    feels.push("You're badly hurt.");
  }
  if (s.maxSan > 0 && s.san / s.maxSan < SAN_FRAYING_THRESHOLD) {
    feels.push("Your mind is fraying.");
  }
  if (
    s.maxFatigue > 0 &&
    s.fatigue / s.maxFatigue > FATIGUE_EXHAUSTED_THRESHOLD
  ) {
    feels.push("You're exhausted.");
  }
  return feels.length > 0 ? feels.join(" ") : null;
}
