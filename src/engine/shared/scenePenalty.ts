import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { SceneCondition } from "../core/types.js";
import { catalogSkillName } from "../rules/skillCatalog.js";

export function getScenePenalties(
  location: string,
  dgsm: DynamicGameStateManager
): Map<string, number> {
  const penalties = new Map<string, number>();
  const conditions: SceneCondition[] = dgsm.getSceneConditions(location);
  for (const cond of conditions) {
    const sp = cond.mechanicalEffect?.skillPenalty;
    if (!sp) continue;
    for (const [skill, delta] of Object.entries(sp)) {
      // Penalty keys must be the canonical domain names; this only recovers
      // exact casing. An unknown key stays verbatim and matches nothing.
      const key = skill === "*" ? "*" : (catalogSkillName(skill) ?? skill);
      penalties.set(key, (penalties.get(key) ?? 0) + delta);
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

  // Handle wildcard "*" first — applies to all skills.
  // (Only used by character-condition aggregation: the
  //  characterConditionPenalties helper folds CharacterCondition.mechanicalEffect.globalSkillPenalty
  //  into this "*" key.)
  const wildcardDelta = penalties.get("*");
  if (wildcardDelta) {
    for (const skill of Object.keys(adjusted)) {
      adjusted[skill] = Math.max(1, adjusted[skill] + wildcardDelta);
    }
  }

  // Handle specific skill penalties
  for (const [skill, delta] of penalties) {
    if (skill === "*") continue; // already handled
    if (adjusted[skill] !== undefined) {
      adjusted[skill] = Math.max(1, adjusted[skill] + delta);
    }
  }
  return adjusted;
}
