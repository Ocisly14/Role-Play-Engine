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
import type { CharacterLanguages } from "../../state/types.js";
import { SKILL_BASE_VALUES, catalogSkillName } from "../rules/skillCatalog.js";
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

/**
 * The catalog's exact spelling for a declared skill — the returned id is
 * persisted on the command and the roll record and is what
 * `renderSkillGuidance` looks up, so "stealth & security" must not survive as
 * a distinct id from "Stealth & Security". A name outside the 17 domains
 * comes back trimmed but unrecognized; `resolveSkillValue` then answers
 * undefined and the command is rejected at intake. There is no legacy-name
 * mapping: profiles and declarations must use the catalog names.
 */
export function canonicalDisplayName(skillId: string): string {
  return catalogSkillName(skillId) ?? skillId.trim();
}

/**
 * Resolve a declared skillId to its canonical domain name and the actor's
 * effective value: trained value from the profile when present, the domain's
 * base value otherwise. Returns undefined for anything outside the 17-domain
 * catalog — the command is then rejected at intake.
 */
export function resolveSkillValue(
  skillId: string,
  actorSkills: Record<string, number>,
  /** For "Languages" only: which tongue. The domain has no single value —
   *  a character reads Latin haltingly and speaks their own perfectly — so
   *  the fluency comes from the named language, and the flat `Languages`
   *  entry (if any sheet still carries one) is never used. */
  languages?: CharacterLanguages,
  language?: string
): { canonicalSkillId: string; value: number } | undefined {
  const canonicalSkillId = catalogSkillName(skillId);
  if (canonicalSkillId === undefined) return undefined;

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

  const base = SKILL_BASE_VALUES.get(canonicalSkillId);
  return base !== undefined ? { canonicalSkillId, value: base } : undefined;
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
