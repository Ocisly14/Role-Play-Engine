import { COC_SKILL_BASE_VALUES } from "../../dynamicBasicAgent/npcPlanning/cocSkillList.js";
import type { PlanNode } from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { applySanityLoss } from "../features/sanityFeature.js";
import type { SkillRollResult } from "../types.js";
import {
  SUCCESS_RANK,
  getDamageBonus,
  getSuccessLevel,
  getSuccessLevelWithDifficulty,
  rollD100,
  rollDamageBonus,
} from "./dice.js";

// ==================== Difficulty derivation ====================

export function getNodeDifficulty(
  node: PlanNode,
  dgsm: DynamicGameStateManager
): "regular" | "hard" | "extreme" | "luck_only" {
  if (node.type !== "character_interaction") return "regular";
  if (!node.targetCharacterId) return "regular";

  const rel = dgsm.getRelationship(node.characterId, node.targetCharacterId);
  const score = rel?.score ?? 0;
  if (score >= 70) return "luck_only";
  if (score >= 30) return "regular";
  if (score >= -30) return "hard";
  return "extreme";
}

// ==================== Best skill selection (for opposed rolls) ====================

/** Case-insensitive lookup in a Record<string, number>. */
function caseInsensitiveLookup(
  skills: Record<string, number>,
  key: string
): number | undefined {
  if (skills[key] !== undefined) return skills[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(skills)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Case-insensitive lookup in a Map<string, number>. */
function caseInsensitiveMapGet(
  map: Map<string, number>,
  key: string
): number | undefined {
  const direct = map.get(key);
  if (direct !== undefined) return direct;
  const lower = key.toLowerCase();
  for (const [k, v] of map) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Pick the NPC's highest skill value from a list of candidate skill names */
function pickBestFromCandidates(
  candidates: string[],
  npcSkills: Record<string, number>
): { skill: string; value: number } | null {
  let best: { skill: string; value: number } | null = null;
  for (const name of candidates) {
    const value = caseInsensitiveLookup(npcSkills, name);
    if (value !== undefined && (!best || value > best.value)) {
      best = { skill: name, value };
    }
  }
  return best;
}

// ==================== Skill Roll Resolution ====================

/** Opposed social skills for defender */
const SOCIAL_DEFEND_SKILLS = ["Psychology", "Intimidate", "Persuade", "Fast Talk", "Charm"];
/** Opposed combat defend */
const COMBAT_DEFEND_SKILLS = ["Dodge", "Fighting (Brawl)"];
/** Chase skills for target */
const CHASE_SKILLS = ["Dodge", "Drive Auto", "Climb", "Swim", "Jump", "Ride"];

export function resolveSkillRoll(
  node: PlanNode,
  adjustedSkills: Record<string, number>,
  dgsm: DynamicGameStateManager
): SkillRollResult {
  const skill = node.skill;
  if (!skill) return { failed: false, successLevel: "regular" };

  const state = dgsm.getState();
  const difficulty = getNodeDifficulty(node, dgsm);
  const npc = state.npcCharacters.find((n) => n.id === node.characterId);
  const npcAttrs = npc?.attributes ?? {
    STR: 50, DEX: 50, INT: 50, POW: 50, CON: 50, SIZ: 50, APP: 50, EDU: 50,
  };

  // NPC's trained value, or CoC base value for untrained skill (case-insensitive)
  const baseValue = caseInsensitiveMapGet(COC_SKILL_BASE_VALUES, skill) ?? 1;
  const skillValue = caseInsensitiveLookup(adjustedSkills, skill) ?? baseValue;

  // --- Combat (opposed) ---
  if (node.type === "character_interaction" && node.targetCharacterId && isCombatSkill(skill)) {
    const defender = state.npcCharacters.find((n) => n.id === node.targetCharacterId);
    const defenderSkills = defender?.skills ?? {};
    const defSkill = pickBestFromCandidates(COMBAT_DEFEND_SKILLS, defenderSkills);
    const defValue = defSkill?.value ?? Math.floor((defender?.attributes?.DEX ?? 50) / 2);

    const attackRoll = rollD100();
    const defendRoll = rollD100();
    const attackLevel = getSuccessLevel(attackRoll, skillValue);
    const defendLevel = getSuccessLevel(defendRoll, defValue);

    if (SUCCESS_RANK[attackLevel] <= SUCCESS_RANK[defendLevel]) {
      return {
        failed: true,
        successLevel: attackLevel,
        reason: `${skill} ${skillValue}, rolled ${attackRoll} (${attackLevel}) vs ${defSkill?.skill ?? "Dodge"} ${defValue}, rolled ${defendRoll} (${defendLevel})`,
        detail: "skill_roll_failed",
      };
    }

    // Hit: apply damage
    const db = npc?.status?.damageBonus ?? getDamageBonus(npcAttrs.STR, npcAttrs.SIZ);
    const weaponDamage = Math.floor(Math.random() * 6) + 1;
    const bonusDamage = rollDamageBonus(db);
    const totalDamage = weaponDamage + bonusDamage;
    dgsm.updateNpcHp(node.targetCharacterId, -totalDamage);

    return {
      failed: false,
      successLevel: attackLevel,
      detail: `Hit for ${totalDamage} damage (${skill} ${attackRoll}/${skillValue})`,
    };
  }

  // --- Social opposed ---
  if (node.type === "character_interaction" && node.targetCharacterId && isSocialSkill(skill)) {
    const target = state.npcCharacters.find((n) => n.id === node.targetCharacterId);
    const targetSkills = target?.skills ?? {};
    const defSkill = pickBestFromCandidates(SOCIAL_DEFEND_SKILLS, targetSkills);
    const defValue = defSkill?.value ?? Math.floor((target?.attributes?.INT ?? 50) / 2);

    const actorRoll = rollD100();
    const targetRoll = rollD100();
    const actorLevel = getSuccessLevel(actorRoll, skillValue);
    const targetLevel = getSuccessLevel(targetRoll, defValue);

    if (SUCCESS_RANK[actorLevel] <= SUCCESS_RANK[targetLevel]) {
      return {
        failed: true,
        successLevel: actorLevel,
        reason: `${skill} ${skillValue}, rolled ${actorRoll} (${actorLevel}) vs ${defSkill?.skill ?? "Psychology"} ${defValue}, rolled ${targetRoll} (${targetLevel})`,
        detail: "skill_roll_failed",
      };
    }
    return { failed: false, successLevel: actorLevel };
  }

  // --- Standard single roll ---
  const effectiveDifficulty = difficulty === "luck_only" ? "extreme" : difficulty;
  const roll = rollD100();
  const level = getSuccessLevelWithDifficulty(roll, skillValue, effectiveDifficulty);

  if (level === "fail" || level === "fumble") {
    return {
      failed: true,
      successLevel: level,
      reason: `${skill} ${skillValue}, rolled ${roll} (difficulty: ${effectiveDifficulty})`,
      detail: "skill_roll_failed",
    };
  }
  return {
    failed: false,
    successLevel: level,
    detail: `${skill} ${roll}/${skillValue} (${level}, difficulty: ${effectiveDifficulty})`,
  };
}

// ==================== Skill classification helpers ====================

const COMBAT_SKILL_PREFIXES = ["Fighting", "Firearms", "Throw", "Dodge"];
const SOCIAL_SKILL_NAMES = new Set([
  "Charm", "Fast Talk", "Persuade", "Intimidate", "Psychology",
  "Credit Rating", "Disguise", "Art/Craft (Acting)", "Law",
]);

function isCombatSkill(skill: string): boolean {
  return COMBAT_SKILL_PREFIXES.some((p) => skill.startsWith(p));
}

function isSocialSkill(skill: string): boolean {
  return SOCIAL_SKILL_NAMES.has(skill);
}
