import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { SUCCESS_RANK, getSuccessLevel, rollD100 } from "./dice.js";

/**
 * Perception dice helpers (Cluster B from the legacy `runtime/movementTick.ts`).
 *
 * Functions are copied verbatim from movementTick.ts:25-76; they previously
 * powered movement-time stealth/spot rolls inside the per-tick movement
 * processor. The renderer layer (post-Phase-E) will call these to decide
 * whether a quietly-moving NPC is detected by witnesses; until then they live
 * here so movement.ts can be removed without losing the implementation.
 */

function getNpcSkillValue(
  dgsm: DynamicGameStateManager,
  npcId: string,
  skillName: string,
  defaultValue: number
): number {
  const npc = dgsm.getState().npcCharacters.find((n) => n.id === npcId);
  if (!npc?.skills) return defaultValue;
  const lower = skillName.toLowerCase();
  for (const [k, v] of Object.entries(npc.skills)) {
    if (k.toLowerCase() === lower) return v;
  }
  return defaultValue;
}

function getDetectionSkillValue(
  dgsm: DynamicGameStateManager,
  npcId: string
): number {
  const npc = dgsm.getState().npcCharacters.find((n) => n.id === npcId);
  const skills = npc?.skills ?? {};
  const lower = Object.fromEntries(
    Object.entries(skills).map(([k, v]) => [k.toLowerCase(), v])
  );
  return lower["spot hidden"] ?? lower.perception ?? 25;
}

export function rollStealthForMovement(
  dgsm: DynamicGameStateManager,
  npcId: string
): boolean {
  const stealthValue = getNpcSkillValue(dgsm, npcId, "Stealth", 20);
  const roll = rollD100();
  const level = getSuccessLevel(roll, stealthValue);
  return level !== "fail" && level !== "fumble";
}

export function tryDetectHidden(
  dgsm: DynamicGameStateManager,
  observerId: string,
  hiddenNpcId: string
): boolean {
  const detectionValue = getDetectionSkillValue(dgsm, observerId);
  const stealthValue = getNpcSkillValue(dgsm, hiddenNpcId, "Stealth", 20);

  const observerRoll = rollD100();
  const stealthRoll = rollD100();
  const observerLevel = getSuccessLevel(observerRoll, detectionValue);
  const stealthLevel = getSuccessLevel(stealthRoll, stealthValue);

  return SUCCESS_RANK[observerLevel] > SUCCESS_RANK[stealthLevel];
}
