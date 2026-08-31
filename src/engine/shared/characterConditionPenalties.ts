import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterCondition } from "../core/types.js";
import { canonicalSkillName } from "../rules/skillCatalog.js";

/**
 * Aggregate skill penalties from a character's active conditions.
 *
 * Returns a Map<string, number> compatible with `applyPenalties`:
 * - Per-skill entries come from `mechanicalEffect.skillPenalty[<skill>]`
 * - `"*"` entry sums all `mechanicalEffect.globalSkillPenalty` values
 *
 * Callers typically compose this with `getScenePenalties` before calling
 * `applyPenalties(npcSkills, map)`.
 */
export function getCharacterConditionPenalties(
  characterId: string,
  dgsm: DynamicGameStateManager
): Map<string, number> {
  const penalties = new Map<string, number>();
  const profile = dgsm.getNpcProfile(characterId);
  const conditions = profile?.status?.conditions;
  if (!conditions || !Array.isArray(conditions)) return penalties;

  for (const c of conditions) {
    // Guard against legacy string[] shape surviving anywhere
    if (typeof c !== "object" || c === null) continue;
    const cond = c as CharacterCondition;
    const mech = cond.mechanicalEffect;
    if (!mech) continue;

    if (typeof mech.globalSkillPenalty === "number") {
      penalties.set("*", (penalties.get("*") ?? 0) + mech.globalSkillPenalty);
    }
    if (mech.skillPenalty) {
      for (const [skill, delta] of Object.entries(mech.skillPenalty)) {
        // Conditions are authored with pre-consolidation skill names; map them
        // onto the broad domains the roll actually uses.
        const key = skill === "*" ? "*" : canonicalSkillName(skill);
        penalties.set(key, (penalties.get(key) ?? 0) + delta);
      }
    }
  }
  return penalties;
}
