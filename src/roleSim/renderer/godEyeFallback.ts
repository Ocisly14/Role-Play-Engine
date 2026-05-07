// src/roleSim/renderer/godEyeFallback.ts
//
// Deterministic, no-LLM narrative used when the renderer LLM call fails twice
// (G11). Same information density as the LLM path — scene baseline + own
// action + each propagated event's `description` — but without citation
// formatting. Agents tolerate the uglier prose; pipeline never blocks.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { PerceivedBundle } from "./types.js";

export function buildGodEyeFallback(
  npcId: string,
  bundle: PerceivedBundle,
  dgsm: DynamicGameStateManager
): string {
  const lines: string[] = [];

  const sceneLine = renderSceneLine(bundle);
  if (sceneLine) lines.push(sceneLine);

  const presentLine = renderPresentNpcs(npcId, bundle.scene.id, dgsm);
  if (presentLine) lines.push(presentLine);

  const conditionLine = renderSceneConditions(bundle);
  if (conditionLine) lines.push(conditionLine);

  const ownActionLine = renderOwnAction(bundle);
  if (ownActionLine) lines.push(ownActionLine);

  const ownConditionLine = renderOwnConditions(bundle);
  if (ownConditionLine) lines.push(ownConditionLine);

  for (const event of bundle.events) {
    if (event.description) lines.push(event.description);
  }

  return lines.join(" ");
}

function renderSceneLine(bundle: PerceivedBundle): string {
  const { scene } = bundle;
  if (!scene.name) return "";
  const desc = scene.description ? ` ${scene.description}` : "";
  return `You are in ${scene.name}.${desc}`;
}

function renderPresentNpcs(
  selfId: string,
  sceneId: string,
  dgsm: DynamicGameStateManager
): string {
  if (!sceneId) return "";
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
  if (names.length === 0) return "";
  return `${names.map((n) => `${n} is here`).join("; ")}.`;
}

function renderSceneConditions(bundle: PerceivedBundle): string {
  const conditions = bundle.scene.activeConditions ?? [];
  if (conditions.length === 0) return "";
  return conditions
    .map((c) => c.description)
    .filter(Boolean)
    .join("; ");
}

function renderOwnAction(bundle: PerceivedBundle): string {
  switch (bundle.ownAction.kind) {
    case "ongoing":
      return `You are doing: "${bundle.ownAction.actionText}".`;
    case "ended":
      return `You just ${bundle.ownAction.status} your action: "${bundle.ownAction.actionText}".`;
    case "idle":
      return "";
  }
}

function renderOwnConditions(bundle: PerceivedBundle): string {
  if (bundle.ownConditions.length === 0) return "";
  const descs = bundle.ownConditions.map((c) => c.description).filter(Boolean);
  if (descs.length === 0) return "";
  return `You feel: ${descs.join("; ")}.`;
}
