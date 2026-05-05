import { COC_SKILL_BASE_VALUES } from "../../planning/cocSkillList.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { SkillRollResult } from "../types.js";

/**
 * Minimal structural shape consumed by `resolveSkillRoll` / `getNodeDifficulty`.
 * Replaces the legacy `PlanNode` import (deleted in Phase F). Callers may pass
 * any object that includes these fields — synthetic shims (e.g.
 * `skillCheckTool.executeSkillCheck`) and real engine actions both qualify.
 */
export interface SkillRollNode {
  characterId: string;
  skill?: string;
  difficulty?: "regular" | "hard" | "extreme";
  targetCharacterIds?: string[];
  type?: string;
}
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
  node: SkillRollNode,
  _dgsm: DynamicGameStateManager
): "regular" | "hard" | "extreme" {
  // character_interaction always uses "regular" — opposed rolls handle
  // per-target mechanics, and the LLM resolver has full relationship data.
  return node.difficulty ?? "regular";
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
const SOCIAL_DEFEND_SKILLS = [
  "Psychology",
  "Intimidate",
  "Persuade",
  "Fast Talk",
  "Charm",
];
/** Opposed combat defend */
const COMBAT_DEFEND_SKILLS = ["Dodge", "Fighting (Brawl)"];
/** Chase skills for target */
const CHASE_SKILLS = ["Dodge", "Drive Auto", "Climb", "Swim", "Jump", "Ride"];

export function resolveSkillRoll(
  node: SkillRollNode,
  adjustedSkills: Record<string, number>,
  dgsm: DynamicGameStateManager,
  /** Apply scene + character feature penalties to a target's skills */
  adjustTargetSkills?: (
    targetId: string,
    rawSkills: Record<string, number>
  ) => Record<string, number>
): SkillRollResult {
  const skill = node.skill;
  if (!skill) return { failed: false, successLevel: "regular" };

  const state = dgsm.getState();
  const difficulty = node.difficulty ?? "regular";
  const targetIds = node.targetCharacterIds ?? [];
  const npc = state.npcCharacters.find((n) => n.id === node.characterId);
  const npcAttrs = npc?.attributes ?? {
    STR: 50,
    DEX: 50,
    INT: 50,
    POW: 50,
    CON: 50,
    SIZ: 50,
    APP: 50,
    EDU: 50,
  };

  // NPC's trained value, or CoC base value for untrained skill (case-insensitive)
  const baseValue = caseInsensitiveMapGet(COC_SKILL_BASE_VALUES, skill) ?? 1;
  const skillValue = caseInsensitiveLookup(adjustedSkills, skill) ?? baseValue;

  // --- Combat (opposed, per-target) ---
  if (
    node.type === "character_interaction" &&
    targetIds.length > 0 &&
    isCombatSkill(skill)
  ) {
    const attackRoll = rollD100();
    const actorLevel = getSuccessLevel(attackRoll, skillValue);
    const db =
      npc?.status?.damageBonus ?? getDamageBonus(npcAttrs.STR, npcAttrs.SIZ);

    const perTargetResults: SkillRollResult["perTargetResults"] = {};
    let anyWon = false;

    for (const targetId of targetIds) {
      const defender = state.npcCharacters.find((n) => n.id === targetId);
      const rawDefenderSkills = defender?.skills ?? {};
      const defenderSkills = adjustTargetSkills
        ? adjustTargetSkills(targetId, rawDefenderSkills)
        : rawDefenderSkills;
      const defSkill = pickBestFromCandidates(
        COMBAT_DEFEND_SKILLS,
        defenderSkills
      );
      const defValue =
        defSkill?.value ?? Math.floor((defender?.attributes?.DEX ?? 50) / 2);

      const defendRoll = rollD100();
      const defendLevel = getSuccessLevel(defendRoll, defValue);
      const actorWon = SUCCESS_RANK[actorLevel] > SUCCESS_RANK[defendLevel];
      if (actorWon) anyWon = true;

      if (actorWon) {
        const weaponDamage = Math.floor(Math.random() * 6) + 1;
        const bonusDamage = rollDamageBonus(db);
        const totalDamage = weaponDamage + bonusDamage;
        perTargetResults![targetId] = {
          successLevel: defendLevel,
          actorWon: true,
          detail: `vs ${defSkill?.skill ?? "Dodge"} ${defValue}, rolled ${defendRoll} (${defendLevel}), hit for ${totalDamage} damage`,
          damage: totalDamage,
        };
      } else {
        perTargetResults![targetId] = {
          successLevel: defendLevel,
          actorWon: false,
          detail: `vs ${defSkill?.skill ?? "Dodge"} ${defValue}, rolled ${defendRoll} (${defendLevel})`,
        };
      }
    }

    if (!anyWon) {
      return {
        failed: true,
        successLevel: actorLevel,
        reason: `${skill} ${skillValue}, rolled ${attackRoll} (${actorLevel}) — all targets defended`,
        detail: "skill_roll_failed",
        perTargetResults,
      };
    }

    return {
      failed: false,
      successLevel: actorLevel,
      detail: `${skill} ${attackRoll}/${skillValue} (${actorLevel})`,
      perTargetResults,
    };
  }

  // --- Social opposed (per-target) ---
  if (
    node.type === "character_interaction" &&
    targetIds.length > 0 &&
    isSocialSkill(skill)
  ) {
    const actorRoll = rollD100();
    const actorLevel = getSuccessLevel(actorRoll, skillValue);

    const perTargetResults: SkillRollResult["perTargetResults"] = {};
    let anyWon = false;

    for (const targetId of targetIds) {
      const target = state.npcCharacters.find((n) => n.id === targetId);
      const rawTargetSkills = target?.skills ?? {};
      const targetSkills = adjustTargetSkills
        ? adjustTargetSkills(targetId, rawTargetSkills)
        : rawTargetSkills;
      const defSkill = pickBestFromCandidates(
        SOCIAL_DEFEND_SKILLS,
        targetSkills
      );
      const defValue =
        defSkill?.value ?? Math.floor((target?.attributes?.INT ?? 50) / 2);

      const targetRoll = rollD100();
      const targetLevel = getSuccessLevel(targetRoll, defValue);
      const actorWon = SUCCESS_RANK[actorLevel] > SUCCESS_RANK[targetLevel];
      if (actorWon) anyWon = true;

      perTargetResults![targetId] = {
        successLevel: targetLevel,
        actorWon,
        detail: `vs ${defSkill?.skill ?? "Psychology"} ${defValue}, rolled ${targetRoll} (${targetLevel})`,
      };
    }

    if (!anyWon) {
      return {
        failed: true,
        successLevel: actorLevel,
        reason: `${skill} ${skillValue}, rolled ${actorRoll} (${actorLevel}) — all targets resisted`,
        detail: "skill_roll_failed",
        perTargetResults,
      };
    }

    return {
      failed: false,
      successLevel: actorLevel,
      detail: `${skill} ${actorRoll}/${skillValue} (${actorLevel})`,
      perTargetResults,
    };
  }

  // --- Standard single roll ---
  const effectiveDifficulty = difficulty;
  const roll = rollD100();
  const level = getSuccessLevelWithDifficulty(
    roll,
    skillValue,
    effectiveDifficulty
  );

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
  "Charm",
  "Fast Talk",
  "Persuade",
  "Intimidate",
  "Psychology",
  "Credit Rating",
  "Disguise",
  "Art/Craft (Acting)",
  "Law",
]);

function isCombatSkill(skill: string): boolean {
  return COMBAT_SKILL_PREFIXES.some((p) => skill.startsWith(p));
}

function isSocialSkill(skill: string): boolean {
  return SOCIAL_SKILL_NAMES.has(skill);
}
