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
import type { CharacterLanguages } from "../../state/types.js";
import { canonicalSkillName } from "../rules/skillCatalog.js";
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
/**
 * The catalog's canonical spelling for a declared skill. Goes through the
 * legacy consolidation map first, then recovers the catalog's exact casing —
 * the returned id is persisted on the command and the roll record and is what
 * `renderSkillGuidance` looks up, so "stealth & security" must not survive as
 * a distinct id from "Stealth & Security".
 */
export function canonicalDisplayName(skillId: string): string {
  const mapped = canonicalSkillName(skillId.trim());
  const base = lookupBaseValue(mapped);
  if (base) return base.name;
  const ref = getSkillReference(mapped);
  if (ref) return ref.title;
  return mapped;
}

export function resolveSkillValue(
  skillId: string,
  actorSkills: Record<string, number>,
  /** For "Languages" only: which tongue. The domain has no single value —
   *  a character reads Latin haltingly and speaks their own perfectly — so
   *  the fluency comes from the named language, and the flat `Languages`
   *  entry (if any legacy sheet still carries one) is never used. */
  languages?: CharacterLanguages,
  language?: string
): { canonicalSkillId: string; value: number } | undefined {
  const canonicalSkillId = canonicalDisplayName(skillId);

  if (canonicalSkillId === "Languages") {
    if (!language) return undefined;
    const learned = Object.entries(languages?.learned ?? {}).find(
      ([tongue]) => tongue.toLowerCase() === language.toLowerCase()
    );
    // A native tongue never reaches here — the boundary drops the declaration
    // — and a tongue the character never learned is rejected there too. So an
    // unresolvable language at this point is a bug, not a hard attempt.
    return learned ? { canonicalSkillId, value: learned[1] } : undefined;
  }

  const trained = lookupIgnoreCase(actorSkills, canonicalSkillId);
  if (trained) return { canonicalSkillId, value: trained.value };

  // Existing NPC and saved-character data may still use a pre-consolidation
  // name. Use the strongest matching legacy specialty until it is resaved.
  const legacyTrained = Object.entries(actorSkills)
    .filter(([name]) => canonicalSkillName(name) === canonicalSkillId)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)[0];
  if (legacyTrained) return { canonicalSkillId, value: legacyTrained.value };

  const base = lookupBaseValue(canonicalSkillId);
  if (base) return { canonicalSkillId, value: base.value };
  // Skills documented in the reference catalog (rules/skills) but absent
  // from the base-value table are still declarable — the catalog is what
  // the agent sees, so the two sources must not disagree on existence.
  // Untrained value defaults to 1.
  const ref = getSkillReference(canonicalSkillId);
  if (ref) return { canonicalSkillId, value: 1 };
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
