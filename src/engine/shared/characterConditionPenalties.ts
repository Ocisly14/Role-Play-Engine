import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { CharacterCondition } from "../core/types.js";
import { catalogSkillName } from "../rules/skillCatalog.js";

/**
 * Aggregate skill penalties from a character's active conditions.
 *
 * Returns a Map<string, number> compatible with `applyPenalties`:
 * - Per-skill entries come from `mechanicalEffect.skillPenalty[<skill>]`
 * - `"*"` entry sums all `mechanicalEffect.globalSkillPenalty` values
 *
 * Apply the result with `effectiveSkillValue` below, NOT with
 * `applyPenalties` — see that function's comment for why.
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
        // Penalty keys must be the canonical domain names; this only recovers
        // exact casing. An unknown key stays verbatim and matches nothing.
        const key = skill === "*" ? "*" : (catalogSkillName(skill) ?? skill);
        penalties.set(key, (penalties.get(key) ?? 0) + delta);
      }
    }
  }
  return penalties;
}

/**
 * Floor on the TOTAL handicap conditions may stack onto one roll. Penalties
 * sum, so "exhausted" (-20) plus a shattering shock (-25) is -45, which drags
 * a 60 skill down to 15. `Math.max(1, …)` alone prevents the absurd but not
 * the futile; this keeps a stacked handicap severe rather than structurally
 * impossible.
 */
export const MAX_AGGREGATE_SKILL_PENALTY = -40;

/**
 * The actor's skill value for THIS roll, after their active conditions.
 *
 * Applied to an already-RESOLVED value rather than to the skills record,
 * because `resolveSkillValue` answers from two places the record does not
 * contain: `SKILL_BASE_VALUES` when the domain is untrained, and
 * `languages.learned` for a Languages check. Penalizing the record first (the
 * shape `applyPenalties` offers) would let every untrained and every language
 * roll escape the handicap entirely.
 */
export function effectiveSkillValue(
  canonicalSkillId: string,
  rawValue: number,
  penalties: Map<string, number>
): number {
  const total = Math.max(
    MAX_AGGREGATE_SKILL_PENALTY,
    (penalties.get("*") ?? 0) + (penalties.get(canonicalSkillId) ?? 0)
  );
  return Math.max(1, rawValue + total);
}
