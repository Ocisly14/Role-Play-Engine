import type { ActionType } from "../../../shared/state/index.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { PlanNode, SuccessLevel } from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { SkillRollResult } from "../types.js";
import { ACTION_TYPE_SKILL_MAP } from "../../dynamicBasicAgent/npcPlanning/actionTypeSkillMap.js";
import { BASELINE_HORROR_SOURCES } from "../../dynamicBasicAgent/npcPlanning/horrorSourceData.js";
import {
  rollD100,
  getSuccessLevel,
  getSuccessLevelWithDifficulty,
  SUCCESS_RANK,
  getDamageBonus,
  rollDamageBonus,
} from "./dice.js";
import { applySanityLoss } from "../features/sanityFeature.js";

// ==================== Difficulty derivation ====================

export function getNodeDifficulty(
  node: PlanNode,
  dgsm: DynamicGameStateManager
): "regular" | "hard" | "extreme" | "luck_only" {
  // Non-character interactions: always regular
  if (node.type !== "character_interaction") return "regular";
  if (!node.targetCharacterId) return "regular";

  // NPC character interactions: derive from relationship score
  const rel = dgsm.getRelationship(node.characterId, node.targetCharacterId);
  const score = rel?.score ?? 0;
  if (score >= 70) return "luck_only";
  if (score >= 30) return "regular";
  if (score >= -30) return "hard";
  return "extreme";
}

// ==================== Skill RAG (keyword overlap) ====================

export function selectBestSkill(
  actionDesc: string,
  actionType: ActionType,
  npcSkills: Record<string, number>
): { skill: string; value: number } | null {
  const candidates = ACTION_TYPE_SKILL_MAP[actionType] ?? [];
  const words = actionDesc.toLowerCase().split(/\s+/);

  let best: { skill: string; value: number; score: number } | null = null;

  for (const skillName of candidates) {
    const value = npcSkills[skillName];
    if (value === undefined) continue;

    const skillWords = skillName.toLowerCase().split(/[\s/()]+/);
    let overlap = 0;
    for (const sw of skillWords) {
      if (sw.length >= 3 && words.some((w) => w.includes(sw))) overlap++;
    }
    // Prefer higher skill value as tiebreaker
    const score = overlap * 1000 + value;
    if (!best || score > best.score) {
      best = { skill: skillName, value, score };
    }
  }

  // Fallback: if no keyword match, pick highest-value candidate
  if (!best) {
    for (const skillName of candidates) {
      const value = npcSkills[skillName];
      if (value !== undefined && (!best || value > best.value)) {
        best = { skill: skillName, value, score: value };
      }
    }
  }

  return best ? { skill: best.skill, value: best.value } : null;
}

// ==================== Horror RAG (keyword overlap) ====================

export function matchHorrorSource(actionDesc: string): { sanLossMin: number; sanLossMax: number } {
  const words = actionDesc.toLowerCase().split(/\s+/);
  let bestMatch: (typeof BASELINE_HORROR_SOURCES)[number] | null = null;
  let bestScore = 0;

  for (const source of BASELINE_HORROR_SOURCES) {
    const sourceWords = source.description.toLowerCase().split(/\s+/);
    let overlap = 0;
    for (const sw of sourceWords) {
      if (sw.length >= 3 && words.some((w) => w.includes(sw))) overlap++;
    }
    if (overlap > bestScore) {
      bestScore = overlap;
      bestMatch = source;
    }
  }

  return bestMatch ?? { sanLossMin: 0, sanLossMax: 1 };
}

// ==================== Skill Roll Resolution ====================

export function resolveSkillRoll(
  node: PlanNode,
  adjustedSkills: Record<string, number>,
  dgsm: DynamicGameStateManager
): SkillRollResult {
  const actionType = node.actionType;
  if (!actionType) return { failed: false, successLevel: "regular" };

  const state = dgsm.getState();
  const difficulty = getNodeDifficulty(node, dgsm);

  // Get NPC profile for attributes
  const npc = state.npcCharacters.find((n) => n.id === node.characterId);
  const npcAttrs = npc?.attributes ?? { STR: 50, DEX: 50, INT: 50, POW: 50, CON: 50, SIZ: 50, APP: 50, EDU: 50 };

  if (actionType === "combat" && node.targetCharacterId) {
    // Opposed roll: attacker vs defender Dodge — difficulty doesn't directly apply
    const attackSkill = selectBestSkill(node.action, actionType, adjustedSkills);
    const attackValue = attackSkill?.value ?? npcAttrs.STR;

    const defender = state.npcCharacters.find((n) => n.id === node.targetCharacterId);
    const defenderDodge = defender?.skills?.["Dodge"] ?? Math.floor((defender?.attributes?.DEX ?? 50) / 2);

    const attackRoll = rollD100();
    const defendRoll = rollD100();
    const attackLevel = getSuccessLevel(attackRoll, attackValue);
    const defendLevel = getSuccessLevel(defendRoll, defenderDodge);

    if (SUCCESS_RANK[attackLevel] <= SUCCESS_RANK[defendLevel]) {
      return {
        failed: true,
        successLevel: attackLevel,
        reason: `${attackSkill?.skill ?? "Attack"} ${attackValue}, rolled ${attackRoll} (${attackLevel}) vs Dodge ${defenderDodge}, rolled ${defendRoll} (${defendLevel})`,
        detail: "skill_roll_failed",
      };
    }

    // Hit: apply damage
    const db = npc?.status?.damageBonus ?? getDamageBonus(npcAttrs.STR, npcAttrs.SIZ);
    const weaponDamage = Math.floor(Math.random() * 6) + 1; // default 1d6
    const bonusDamage = rollDamageBonus(db);
    const totalDamage = weaponDamage + bonusDamage;
    dgsm.updateNpcHp(node.targetCharacterId, -totalDamage);

    return { failed: false, successLevel: attackLevel, detail: `Hit for ${totalDamage} damage (${attackSkill?.skill ?? "Attack"} ${attackRoll}/${attackValue})` };
  }

  if (actionType === "social" && node.targetCharacterId) {
    // Opposed roll: actor social skill vs target Psychology — difficulty doesn't directly apply
    const socialSkill = selectBestSkill(node.action, actionType, adjustedSkills);
    const socialValue = socialSkill?.value ?? npcAttrs.APP;

    const target = state.npcCharacters.find((n) => n.id === node.targetCharacterId);
    const psychValue = target?.skills?.["Psychology"] ?? Math.floor((target?.attributes?.INT ?? 50) / 2);

    const actorRoll = rollD100();
    const targetRoll = rollD100();
    const actorLevel = getSuccessLevel(actorRoll, socialValue);
    const targetLevel = getSuccessLevel(targetRoll, psychValue);

    if (SUCCESS_RANK[actorLevel] <= SUCCESS_RANK[targetLevel]) {
      return {
        failed: true,
        successLevel: actorLevel,
        reason: `${socialSkill?.skill ?? "Social"} ${socialValue}, rolled ${actorRoll} (${actorLevel}) vs Psychology ${psychValue}, rolled ${targetRoll} (${targetLevel})`,
        detail: "skill_roll_failed",
      };
    }
    return { failed: false, successLevel: actorLevel };
  }

  if (actionType === "chase" && node.targetCharacterId) {
    // Opposed roll: both use best chase skill — difficulty doesn't directly apply
    const chaserSkill = selectBestSkill(node.action, actionType, adjustedSkills);
    const chaserValue = chaserSkill?.value ?? npcAttrs.DEX;

    const target = state.npcCharacters.find((n) => n.id === node.targetCharacterId);
    const targetSkills = target?.skills ?? {};
    const targetChaseSkill = selectBestSkill("flee escape run", "chase", targetSkills);
    const targetValue = targetChaseSkill?.value ?? (target?.attributes?.DEX ?? 50);

    const chaserRoll = rollD100();
    const targetRoll = rollD100();
    const chaserLevel = getSuccessLevel(chaserRoll, chaserValue);
    const targetLevel = getSuccessLevel(targetRoll, targetValue);

    if (SUCCESS_RANK[chaserLevel] <= SUCCESS_RANK[targetLevel]) {
      return {
        failed: true,
        successLevel: chaserLevel,
        reason: `${chaserSkill?.skill ?? "Chase"} ${chaserValue}, rolled ${chaserRoll} (${chaserLevel}) vs ${targetChaseSkill?.skill ?? "Flee"} ${targetValue}, rolled ${targetRoll} (${targetLevel})`,
        detail: "skill_roll_failed",
      };
    }
    return { failed: false, successLevel: chaserLevel };
  }

  if (actionType === "mental") {
    // SAN roll + horror source match — use difficulty for SAN check
    const npcStats = dgsm.getNpcStats(node.characterId);
    const sanValue = npcStats?.san ?? npc?.status?.sanity ?? 50;
    const roll = rollD100();
    const horror = matchHorrorSource(node.action);

    // Apply difficulty to the SAN threshold
    const effectiveDifficulty = difficulty === "luck_only" ? "extreme" : difficulty;
    const level = getSuccessLevelWithDifficulty(roll, sanValue, effectiveDifficulty);

    if (level === "fail" || level === "fumble") {
      const sanLoss = horror.sanLossMax;
      applySanityLoss(dgsm, node.characterId, -sanLoss, undefined, undefined, node.action);
      return {
        failed: true,
        successLevel: level,
        reason: `SAN ${sanValue}, rolled ${roll} (difficulty: ${effectiveDifficulty}), lost ${sanLoss} sanity`,
        detail: "skill_roll_failed",
      };
    } else {
      const sanLoss = horror.sanLossMin;
      if (sanLoss > 0) applySanityLoss(dgsm, node.characterId, -sanLoss, false, undefined, undefined, node.action);
      return { failed: false, successLevel: level, detail: `SAN check passed (${roll}/${sanValue}, difficulty: ${effectiveDifficulty}), lost ${sanLoss} sanity` };
    }
  }

  // Single roll for remaining actionTypes (exploration, stealth, environmental, narrative)
  // Use difficulty-aware check
  const effectiveDifficulty = difficulty === "luck_only" ? "extreme" : difficulty;
  const bestSkill = selectBestSkill(node.action, actionType, adjustedSkills);
  const skillValue = bestSkill?.value ?? npcAttrs.INT;
  const roll = rollD100();
  const level = getSuccessLevelWithDifficulty(roll, skillValue, effectiveDifficulty);

  if (level === "fail" || level === "fumble") {
    return {
      failed: true,
      successLevel: level,
      reason: `${bestSkill?.skill ?? actionType} ${skillValue}, rolled ${roll} (difficulty: ${effectiveDifficulty})`,
      detail: "skill_roll_failed",
    };
  }
  return { failed: false, successLevel: level, detail: `${bestSkill?.skill ?? actionType} ${roll}/${skillValue} (${level}, difficulty: ${effectiveDifficulty})` };
}
