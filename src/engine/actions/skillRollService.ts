// src/engine/actions/skillRollService.ts
//
// Deterministic-side skill roll for the Trusted Action Intake. When an `act`
// command declares a skillId, code (never the model) resolves the actor's real
// skill value and rolls immediately — before any semantic judgement. The
// resulting SkillRollRecord is immutable: retries, tick retries and snapshot
// rehydration reuse the rollId and never re-roll (plan D2/§6 "先骰后审").
//
// Semantic applicability, required level and opposed checks are NOT decided
// here — that is the Engine's post-roll assessment (Phase 6 skillAdjudicator).

import { randomUUID } from "node:crypto";
import { COC_SKILL_BASE_VALUES } from "../../planning/cocSkillList.js";
import { getSkillReference } from "../rules/skillReference.js";
import { isFumble, rollD100 } from "../shared/dice.js";
import type { SkillRollRecord, SkillSuccessLevel } from "./types.js";

/** Case-insensitive lookup in a Record<string, number>. */
function lookupIgnoreCase(
  skills: Record<string, number>,
  key: string
): { name: string; value: number } | undefined {
  if (skills[key] !== undefined) return { name: key, value: skills[key] };
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(skills)) {
    if (k.toLowerCase() === lower) return { name: k, value: v };
  }
  return undefined;
}

/** Case-insensitive lookup in the CoC base-value table. */
function lookupBaseValue(
  key: string
): { name: string; value: number } | undefined {
  const direct = COC_SKILL_BASE_VALUES.get(key);
  if (direct !== undefined) return { name: key, value: direct };
  const lower = key.toLowerCase();
  for (const [k, v] of COC_SKILL_BASE_VALUES) {
    if (k.toLowerCase() === lower) return { name: k, value: v };
  }
  return undefined;
}

/**
 * Resolve a declared skillId to its canonical name and the actor's effective
 * value. Any known CoC skill is usable (decision 2026-08-26): trained value
 * from the profile when present, base value from COC_SKILL_BASE_VALUES
 * otherwise. Returns undefined for a skill name the system does not know —
 * the command is then rejected at intake.
 */
export function resolveSkillValue(
  skillId: string,
  actorSkills: Record<string, number>
): { canonicalSkillId: string; value: number } | undefined {
  const trained = lookupIgnoreCase(actorSkills, skillId);
  if (trained) return { canonicalSkillId: trained.name, value: trained.value };
  const base = lookupBaseValue(skillId);
  if (base) return { canonicalSkillId: base.name, value: base.value };
  // Skills documented in the reference catalog (rules/skills) but absent
  // from the base-value table are still declarable — the catalog is what
  // the agent sees, so the two sources must not disagree on existence.
  // Untrained value defaults to 1.
  const ref = getSkillReference(skillId);
  if (ref) return { canonicalSkillId: ref.title, value: 1 };
  return undefined;
}

/** Six-level CoC success ladder for a raw d100 roll against a skill value. */
export function successLevelFor(
  roll: number,
  skillValue: number
): SkillSuccessLevel {
  if (roll === 1) return "critical";
  if (isFumble(roll, skillValue)) return "fumble";
  if (roll <= Math.floor(skillValue / 5)) return "extreme";
  if (roll <= Math.floor(skillValue / 2)) return "hard";
  if (roll <= skillValue) return "regular";
  return "failure";
}

/** Roll once and freeze the record. `roll` is injectable for tests/replay. */
export function rollSkill(
  canonicalSkillId: string,
  skillValue: number,
  roll: number = rollD100()
): SkillRollRecord {
  return {
    rollId: randomUUID(),
    skillId: canonicalSkillId,
    skillValue,
    roll,
    successLevel: successLevelFor(roll, skillValue),
  };
}
