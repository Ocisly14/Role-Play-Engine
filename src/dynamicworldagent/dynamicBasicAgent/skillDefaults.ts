import type { CharacterAttributes } from "../state/types.js";

/**
 * Base skill defaults aligned with src/shared/agents/memory/database/seedData.ts
 */
const ALL_SKILL_BASE_DEFAULTS: Record<string, number> = {
  Charm: 15,
  Bluff: 5,
  Intimidate: 15,
  Persuade: 10,
  Psychology: 10,
  Accounting: 5,
  Anthropology: 1,
  Archaeology: 1,
  "Art and Craft": 5,
  History: 5,
  Law: 5,
  Research: 20,
  Occult: 5,
  Biology: 1,
  Chemistry: 1,
  Physics: 1,
  Appraise: 5,
  Listen: 20,
  Perception: 25,
  Track: 10,
  Climb: 20,
  Dodge: 0,
  Jump: 20,
  Swim: 20,
  Throw: 20,
  Ride: 5,
  Disguise: 5,
  "Sleight of Hand": 10,
  Stealth: 20,
  "Electrical Repair": 10,
  "Mechanical Repair": 10,
  "Operate Heavy Machinery": 1,
  "Pilot (Aircraft)": 1,
  "Pilot (Boat)": 1,
  "Drive Auto": 20,
  Navigate: 10,
  "First Aid": 30,
  Medicine: 1,
  "Natural World": 10,
  "Survival (Arctic)": 10,
  "Survival (Desert)": 10,
  "Survival (Forest)": 10,
  Psychoanalysis: 1,
  Brawling: 25,
  Sword: 20,
  Axe: 15,
  Whip: 5,
  Pistol: 20,
  Rifle: 25,
  "Submachine Gun": 15,
  Bow: 15,
  Locksmith: 1,
  Criminology: 1,
  Forgery: 1,
  "Language (Own)": 0,
  "Language (Other)": 1,
  "Social Status": 0,
  "Forbidden Lore": 0,
};

const COMBAT_SKILL_NAMES = [
  "Brawling",
  "Pistol",
  "Rifle",
  "Sword",
  "Axe",
  "Whip",
  "Submachine Gun",
  "Bow",
  "Dodge",
] as const;

function normalizeNumericSkills(
  skills?: Record<string, number> | null
): Record<string, number> {
  if (!skills) return {};

  const normalized: Record<string, number> = {};
  for (const [name, value] of Object.entries(skills)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      normalized[name] = value;
    }
  }
  return normalized;
}

function getDefaultDodge(attributes?: CharacterAttributes): number {
  const dex = attributes?.DEX;
  if (typeof dex === "number" && Number.isFinite(dex) && dex > 0) {
    return Math.floor(dex / 2);
  }
  return 25;
}

/**
 * Returns the static skill defaults (excluding Dodge which depends on DEX).
 * Used to inject a single shared reference into prompts instead of repeating
 * all 65 skills for every character.
 */
export function getStaticSkillDefaults(): Record<string, number> {
  return { ...ALL_SKILL_BASE_DEFAULTS };
}

/**
 * Ensures context has all baseline CoC skills.
 * Existing values override defaults.
 */
export function withAllSkillDefaults(
  skills?: Record<string, number> | null,
  attributes?: CharacterAttributes
): Record<string, number> {
  const normalized = normalizeNumericSkills(skills);
  const defaults = {
    ...ALL_SKILL_BASE_DEFAULTS,
    // CoC 7e common runtime default in this codebase.
    Dodge: getDefaultDodge(attributes),
  };

  return {
    ...defaults,
    ...normalized,
  };
}

/**
 * Combat-focused defaults for combat prompts; keeps any existing skills too.
 */
export function withCombatSkillDefaults(
  skills?: Record<string, number> | null,
  attributes?: CharacterAttributes
): Record<string, number> {
  const normalized = normalizeNumericSkills(skills);
  const allDefaults = withAllSkillDefaults(undefined, attributes);
  const combatDefaults: Record<string, number> = {};

  for (const skillName of COMBAT_SKILL_NAMES) {
    combatDefaults[skillName] = allDefaults[skillName] ?? 0;
  }

  return {
    ...combatDefaults,
    ...normalized,
  };
}
