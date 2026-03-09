import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { SceneCondition } from "../../dynamicBasicAgent/npcPlanning/types.js";

export function getScenePenalties(
  location: string,
  dgsm: DynamicGameStateManager
): Map<string, number> {
  const penalties = new Map<string, number>();
  const conditions: SceneCondition[] = dgsm.getSceneConditions(location);
  for (const cond of conditions) {
    if (cond.mechanicalEffect?.skillPenalty) {
      for (const p of cond.mechanicalEffect.skillPenalty) {
        penalties.set(p.skill, (penalties.get(p.skill) ?? 0) + p.delta);
      }
    }
  }
  return penalties;
}

export function applyPenalties(
  skills: Record<string, number>,
  penalties: Map<string, number>
): Record<string, number> {
  if (penalties.size === 0) return skills;
  const adjusted = { ...skills };
  for (const [skill, delta] of penalties) {
    if (adjusted[skill] !== undefined) {
      adjusted[skill] = Math.max(1, adjusted[skill] + delta);
    }
  }
  return adjusted;
}
