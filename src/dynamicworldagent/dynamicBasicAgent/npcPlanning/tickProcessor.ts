import type { ActionType } from "../../../shared/state/index.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { NPCPlanningAgent } from "./NPCPlanningAgent.js";
import { ACTION_TYPE_SKILL_MAP } from "./actionTypeSkillMap.js";
import { BASELINE_HORROR_SOURCES } from "./horrorSourceData.js";
import type {
  PlanNode,
  CharacterAction,
  FailureReason,
  SceneCondition,
} from "./types.js";

// ==================== Time helpers ====================

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToBucket(minutes: number, bucketSize = 5): number {
  return Math.floor(minutes / bucketSize) * bucketSize;
}

function getBucketLabel(bucketMinutes: number): string {
  const h = Math.floor(bucketMinutes / 60);
  const m = bucketMinutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// ==================== Dice ====================

function rollD100(): number {
  return Math.floor(Math.random() * 100) + 1;
}

type SuccessLevel = "critical" | "hard" | "regular" | "fail";

function getSuccessLevel(roll: number, skillValue: number): SuccessLevel {
  if (roll === 1) return "critical";
  if (roll <= Math.floor(skillValue / 5)) return "hard";
  if (roll <= Math.floor(skillValue / 2)) return "hard";
  if (roll <= skillValue) return "regular";
  return "fail";
}

function getSuccessLevelWithDifficulty(
  roll: number,
  skillValue: number,
  difficulty: "regular" | "hard" | "extreme"
): SuccessLevel {
  if (roll === 1) return "critical";
  const threshold =
    difficulty === "extreme" ? Math.floor(skillValue / 5)
    : difficulty === "hard" ? Math.floor(skillValue / 2)
    : skillValue;
  if (roll <= threshold) return "regular";
  return "fail";
}

const SUCCESS_RANK: Record<SuccessLevel, number> = {
  critical: 3,
  hard: 2,
  regular: 1,
  fail: 0,
};

// ==================== Difficulty derivation ====================

function getNodeDifficulty(
  node: PlanNode,
  dgsm: DynamicGameStateManager
): "regular" | "hard" | "extreme" | "luck_only" {
  // Player nodes: use explicit difficulty from LLM
  if (node.isPlayer) return node.difficulty ?? "regular";

  // NPC scene interactions: always regular
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

function selectBestSkill(
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

function matchHorrorSource(actionDesc: string): { sanLossMin: number; sanLossMax: number } {
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

// ==================== Luck failure ====================

function luckFailureRate(luck: number): number {
  return 0.025 + (100 - luck) * 0.0005;
}

// ==================== Damage bonus table (STR + SIZ) ====================

function getDamageBonus(str: number, siz: number): string {
  const total = str + siz;
  if (total <= 64) return "-2";
  if (total <= 84) return "-1";
  if (total <= 124) return "0";
  if (total <= 164) return "+1d4";
  if (total <= 204) return "+1d6";
  return "+2d6";
}

function rollDamageBonus(db: string): number {
  if (db === "0") return 0;
  const sign = db.startsWith("-") ? -1 : 1;
  const diceMatch = db.match(/(\d+)d(\d+)/);
  if (diceMatch) {
    const count = parseInt(diceMatch[1]);
    const sides = parseInt(diceMatch[2]);
    let total = 0;
    for (let i = 0; i < count; i++) {
      total += Math.floor(Math.random() * sides) + 1;
    }
    return sign * total;
  }
  const flat = parseInt(db);
  return isNaN(flat) ? 0 : flat;
}

// ==================== Scene penalties ====================

function getScenePenalties(
  location: string,
  dgsm: DynamicGameStateManager
): Map<string, number> {
  const penalties = new Map<string, number>();
  const conditions: SceneCondition[] = dgsm.getSceneConditions(location);
  for (const cond of conditions) {
    if (cond.mechanicalEffect?.skillPenalty) {
      for (const p of cond.mechanicalEffect.skillPenalty) {
        penalties.set(p.skill, (penalties.get(p.skill) ?? 0) + p.delta);
      }
    }
  }
  return penalties;
}

function applyPenalties(
  skills: Record<string, number>,
  penalties: Map<string, number>
): Record<string, number> {
  if (penalties.size === 0) return skills;
  const adjusted = { ...skills };
  for (const [skill, delta] of penalties) {
    if (adjusted[skill] !== undefined) {
      adjusted[skill] = Math.max(1, adjusted[skill] + delta);
    }
  }
  return adjusted;
}

// ==================== Skill Roll Resolution ====================

function resolveSkillRoll(
  node: PlanNode,
  adjustedSkills: Record<string, number>,
  dgsm: DynamicGameStateManager
): { failed: boolean; reason?: string; detail?: string } {
  const actionType = node.actionType;
  if (!actionType) return { failed: false };

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

    return { failed: false, detail: `Hit for ${totalDamage} damage (${attackSkill?.skill ?? "Attack"} ${attackRoll}/${attackValue})` };
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
        reason: `${socialSkill?.skill ?? "Social"} ${socialValue}, rolled ${actorRoll} (${actorLevel}) vs Psychology ${psychValue}, rolled ${targetRoll} (${targetLevel})`,
        detail: "skill_roll_failed",
      };
    }
    return { failed: false };
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
        reason: `${chaserSkill?.skill ?? "Chase"} ${chaserValue}, rolled ${chaserRoll} (${chaserLevel}) vs ${targetChaseSkill?.skill ?? "Flee"} ${targetValue}, rolled ${targetRoll} (${targetLevel})`,
        detail: "skill_roll_failed",
      };
    }
    return { failed: false };
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

    if (level === "fail") {
      // Failed SAN check
      const sanLoss = horror.sanLossMax;
      dgsm.updateNpcSan(node.characterId, -sanLoss);
      return {
        failed: true,
        reason: `SAN ${sanValue}, rolled ${roll} (difficulty: ${effectiveDifficulty}), lost ${sanLoss} sanity`,
        detail: "skill_roll_failed",
      };
    } else {
      const sanLoss = horror.sanLossMin;
      if (sanLoss > 0) dgsm.updateNpcSan(node.characterId, -sanLoss);
      return { failed: false, detail: `SAN check passed (${roll}/${sanValue}, difficulty: ${effectiveDifficulty}), lost ${sanLoss} sanity` };
    }
  }

  // Single roll for remaining actionTypes (exploration, stealth, environmental, narrative)
  // Use difficulty-aware check
  const effectiveDifficulty = difficulty === "luck_only" ? "extreme" : difficulty;
  const bestSkill = selectBestSkill(node.action, actionType, adjustedSkills);
  const skillValue = bestSkill?.value ?? npcAttrs.INT;
  const roll = rollD100();
  const level = getSuccessLevelWithDifficulty(roll, skillValue, effectiveDifficulty);

  if (level === "fail") {
    return {
      failed: true,
      reason: `${bestSkill?.skill ?? actionType} ${skillValue}, rolled ${roll} (difficulty: ${effectiveDifficulty})`,
      detail: "skill_roll_failed",
    };
  }
  return { failed: false, detail: `${bestSkill?.skill ?? actionType} ${roll}/${skillValue} (${level}, difficulty: ${effectiveDifficulty})` };
}

// ==================== Execute single node ====================

function executeNode(
  node: PlanNode,
  dgsm: DynamicGameStateManager
): CharacterAction {
  const state = dgsm.getState();
  const npcLocation = dgsm.getNpcLocation(node.characterId);
  const npc = state.npcCharacters.find((n) => n.id === node.characterId);
  const npcSkills = npc?.skills ?? {};
  const luck = npc?.status?.luck ?? 50;
  const difficulty = getNodeDifficulty(node, dgsm);

  // Scene penalties
  const penalties = getScenePenalties(node.location, dgsm);
  const adjustedSkills = applyPenalties(npcSkills, penalties);

  const makeAction = (
    status: "completed" | "failed",
    outcome: string,
    failureReason?: FailureReason
  ): CharacterAction => ({
    characterId: node.characterId,
    characterName: node.characterName,
    gameTime: node.gameTime,
    action: node.action,
    location: node.location,
    type: node.type,
    actionType: node.actionType,
    impact: node.impact,
    isPlayer: node.isPlayer,
    difficulty,
    status,
    outcome,
    failureReason,
    targetCharacterId: node.targetCharacterId,
  });

  // === Type-specific execution ===

  if (node.type === "routine") {
    if (npcLocation && npcLocation !== node.location) {
      return makeAction("failed", `${node.action} failed: not at expected location`, "location_mismatch");
    }
    // actionType present? → skill roll
    if (node.actionType) {
      const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
      if (rollResult.failed) {
        return makeAction("failed", `${node.action} failed: ${rollResult.reason}`, "skill_roll_failed");
      }
    }
    return makeAction("completed", `${node.action} succeeded`);
  }

  if (node.type === "movement") {
    const fromLocation = npcLocation ?? node.location;
    if (dgsm.isConnectionBlocked(fromLocation, node.location)) {
      return makeAction("failed", `${node.action} failed: path blocked`, "location_blocked");
    }
    // Check scene conditions for blocked
    const targetConditions = dgsm.getSceneConditions(node.location);
    const isBlocked = targetConditions.some((c) => c.mechanicalEffect?.blocked);
    if (isBlocked) {
      return makeAction("failed", `${node.action} failed: destination blocked`, "location_blocked");
    }
    dgsm.setNpcLocation(node.characterId, node.location);
    return makeAction("completed", `${node.action} succeeded`);
  }

  if (node.type === "character_interaction") {
    if (npcLocation && npcLocation !== node.location) {
      return makeAction("failed", `${node.action} failed: not at expected location`, "location_mismatch");
    }
    if (node.targetCharacterId) {
      const targetLocation = dgsm.getNpcLocation(node.targetCharacterId);
      // Player character doesn't have npcLocation entry — skip check for player
      if (targetLocation && targetLocation !== node.location) {
        return makeAction("failed", `${node.action} failed: target not present`, "target_absent");
      }
    }

    // For NPC nodes with luck_only difficulty: skip actionType skill roll, only do luck-based roll
    if (!node.isPlayer && difficulty === "luck_only") {
      if (Math.random() < luckFailureRate(luck)) {
        return makeAction("failed", `${node.action} failed: bad luck (luck=${luck})`, "bad_luck");
      }
    } else if (node.isPlayer) {
      // Player nodes: skip luck-based failure check entirely
      // Only do skill roll if actionType present
      if (node.actionType) {
        const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
        if (rollResult.failed) {
          return makeAction("failed", `${node.action} failed: ${rollResult.reason}`, "skill_roll_failed");
        }
      }
    } else {
      // NPC nodes (non-luck_only): existing logic
      // Luck-based failure (only when no actionType)
      if (!node.actionType && Math.random() < luckFailureRate(luck)) {
        return makeAction("failed", `${node.action} failed: bad luck (luck=${luck})`, "bad_luck");
      }
      // Skill roll if actionType present
      if (node.actionType) {
        const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
        if (rollResult.failed) {
          return makeAction("failed", `${node.action} failed: ${rollResult.reason}`, "skill_roll_failed");
        }
      }
    }

    // Apply side effects
    if (node.characterInteractionPayload && node.targetCharacterId) {
      const payload = node.characterInteractionPayload;
      if (payload.transferType === "item" && payload.itemId) {
        dgsm.removeItemFromNpc(node.characterId, payload.itemId);
        dgsm.addItemToNpc(node.targetCharacterId, payload.itemId);
      } else if (payload.transferType === "clue" && payload.clueId) {
        dgsm.transferClue(node.characterId, node.targetCharacterId, payload.clueId);
      }
      // "information" transfer: no mechanical side effect here; impact gate handles plan revision
    }
    return makeAction("completed", `${node.action} succeeded`);
  }

  if (node.type === "object_interaction") {
    if (npcLocation && npcLocation !== node.location) {
      return makeAction("failed", `${node.action} failed: not at expected location`, "location_mismatch");
    }

    if (node.isPlayer) {
      // Player nodes: skip luck-based failure, only skill roll
      if (node.actionType) {
        const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
        if (rollResult.failed) {
          return makeAction("failed", `${node.action} failed: ${rollResult.reason}`, "skill_roll_failed");
        }
      }
    } else if (difficulty === "luck_only") {
      // NPC luck_only: skip actionType skill roll, only luck-based
      if (Math.random() < luckFailureRate(luck)) {
        return makeAction("failed", `${node.action} failed: bad luck (luck=${luck})`, "bad_luck");
      }
    } else {
      // NPC: existing logic
      if (!node.actionType && Math.random() < luckFailureRate(luck)) {
        return makeAction("failed", `${node.action} failed: bad luck (luck=${luck})`, "bad_luck");
      }
      if (node.actionType) {
        const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
        if (rollResult.failed) {
          return makeAction("failed", `${node.action} failed: ${rollResult.reason}`, "skill_roll_failed");
        }
      }
    }

    // Apply side effects
    if (node.objectInteractionPayload) {
      const payload = node.objectInteractionPayload;
      if (payload.action === "pickup" && payload.itemId) {
        dgsm.addItemToNpc(node.characterId, payload.itemId);
      } else if ((payload.action === "place" || payload.action === "destroy") && payload.itemId) {
        dgsm.removeItemFromNpc(node.characterId, payload.itemId);
      }
    }
    return makeAction("completed", `${node.action} succeeded`);
  }

  if (node.type === "scene_interaction") {
    if (npcLocation && npcLocation !== node.location) {
      return makeAction("failed", `${node.action} failed: not at expected location`, "location_mismatch");
    }

    if (node.isPlayer) {
      // Player nodes: skip luck-based failure, only skill roll
      if (node.actionType) {
        const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
        if (rollResult.failed) {
          return makeAction("failed", `${node.action} failed: ${rollResult.reason}`, "skill_roll_failed");
        }
      }
    } else if (difficulty === "luck_only") {
      // NPC luck_only: skip actionType skill roll, only luck-based
      if (Math.random() < luckFailureRate(luck)) {
        return makeAction("failed", `${node.action} failed: bad luck (luck=${luck})`, "bad_luck");
      }
    } else {
      // NPC: existing logic
      if (!node.actionType && Math.random() < luckFailureRate(luck)) {
        return makeAction("failed", `${node.action} failed: bad luck (luck=${luck})`, "bad_luck");
      }
      if (node.actionType) {
        const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
        if (rollResult.failed) {
          return makeAction("failed", `${node.action} failed: ${rollResult.reason}`, "skill_roll_failed");
        }
      }
    }

    // Append outcome as scene condition
    const outcome = `${node.action} succeeded`;
    dgsm.appendSceneCondition(node.location, { description: outcome });
    // Apply connection effect if present
    if (node.sceneConnectionEffect) {
      const effect = node.sceneConnectionEffect;
      const blocked = effect.action === "block";
      dgsm.setConnectionBlocked(node.location, effect.targetScenarioId, blocked, outcome);
    }
    return makeAction("completed", outcome);
  }

  // Fallback
  return makeAction("completed", `${node.action} succeeded`);
}

// ==================== Main runTick ====================

export async function runTick(
  playerNodes: PlanNode[],
  dgsm: DynamicGameStateManager,
  npcPlanningAgent: NPCPlanningAgent,
  sessionId: string,
  language: string = "en"
): Promise<CharacterAction[]> {
  const state = dgsm.getState();
  const gameDay = state.gameDay;
  const currentTime = state.timeOfDay;

  // Calculate new game time based on max player timeAdvanceMinutes
  const maxPlayerAdvance = playerNodes.reduce((max, n) => Math.max(max, n.timeAdvanceMinutes), 0);
  const currentMinutes = timeToMinutes(currentTime);
  const newMinutes = currentMinutes + maxPlayerAdvance;
  const newTime = getBucketLabel(Math.min(newMinutes, 1439)); // cap at 23:59

  // 1. Get all due NPC nodes
  const dueNpcNodes = await npcPlanningAgent.getDueNpcNodes(sessionId, gameDay, newTime, dgsm);

  // Merge all nodes: NPC nodes + player nodes
  const allNodes: PlanNode[] = [...dueNpcNodes, ...playerNodes];

  // Sort by gameTime ASC, then DEX DESC
  allNodes.sort((a, b) => {
    const timeDiff = a.gameTime.localeCompare(b.gameTime);
    if (timeDiff !== 0) return timeDiff;
    const npcA = state.npcCharacters.find((n) => n.id === a.characterId);
    const npcB = state.npcCharacters.find((n) => n.id === b.characterId);
    const dexA = npcA?.attributes?.DEX ?? 50;
    const dexB = npcB?.attributes?.DEX ?? 50;
    return dexB - dexA;
  });

  // 3. Scan unplanned encounters (same-scene NPC pairs with |score| >= 60)
  scanUnplannedEncounters(allNodes, dgsm);

  // Collect player character IDs for identification
  const playerCharacterIds = new Set(playerNodes.map((n) => n.characterId));

  // 4. Group into 5-minute buckets
  const buckets = new Map<number, PlanNode[]>();
  for (const node of allNodes) {
    const bucket = minutesToBucket(timeToMinutes(node.gameTime));
    if (!buckets.has(bucket)) buckets.set(bucket, []);
    buckets.get(bucket)!.push(node);
  }

  const allActions: CharacterAction[] = [];
  const sortedBucketKeys = [...buckets.keys()].sort((a, b) => a - b);

  // Track player failure state for cascade
  let playerFailed = false;

  // 5. Execute each bucket sequentially
  for (const bucketKey of sortedBucketKeys) {
    const bucketNodes = buckets.get(bucketKey)!;
    const bucketTime = getBucketLabel(bucketKey);
    const bucketActions: CharacterAction[] = [];
    let playerFailedInBucket = false;

    // Execute all nodes in this bucket serially
    for (const node of bucketNodes) {
      // If player already failed, skip subsequent player nodes
      if ((playerFailed || playerFailedInBucket) && node.isPlayer) {
        continue;
      }

      const action = executeNode(node, dgsm);
      bucketActions.push(action);
      allActions.push(action);

      // Check if a player node just failed
      if (action.status === "failed" && node.isPlayer) {
        playerFailedInBucket = true;
        // Continue executing remaining NPC nodes in this bucket
        // (the skip logic above handles player nodes)
      }

      // Log NPC actions (not player)
      if (!node.isPlayer) {
        const logEntry = `Day${gameDay} ${action.gameTime} [${action.location}] - ${action.outcome}`;
        await npcPlanningAgent.appendActionLog(sessionId, node.characterId, logEntry, gameDay, action.gameTime, action.location);
        await npcPlanningAgent.markNodeCompleted(sessionId, node.characterId, gameDay, node.nodeId, action.outcome);
      }

      // On character_interaction success → update relationship
      if (action.status === "completed" && node.type === "character_interaction" && node.targetCharacterId) {
        await npcPlanningAgent.updateRelationshipViaLLM(dgsm, node.characterId, node.targetCharacterId, action.outcome, language);
      }

      // On failure → immediate revisePlans (no gate) — NPC only
      if (action.status === "failed" && !node.isPlayer) {
        const longTermIntent = await npcPlanningAgent.getLongTermIntent(sessionId, node.characterId);
        const actionLog = await npcPlanningAgent.getActionLog(sessionId, node.characterId);
        const pendingNodes = await npcPlanningAgent.getPendingNodes(sessionId, node.characterId, gameDay);
        await npcPlanningAgent.revisePlans(dgsm, sessionId, node.characterId, {
          longTermIntent,
          actionLog,
          pendingNodes,
          trigger: {
            type: "failure",
            failureReason: action.failureReason!,
            action: action.action,
            gameTime: action.gameTime,
          },
        }, language);
      }
    }

    // Impact gate: collect impact > 0 events from this bucket
    const impactEvents = bucketActions.filter((a) => a.impact > 0);
    if (impactEvents.length > 0) {
      // Determine candidate NPCs per impact level
      const candidateNpcIds = new Set<string>();
      for (const event of impactEvents) {
        if (event.impact === 1 && event.targetCharacterId) {
          candidateNpcIds.add(event.targetCharacterId);
        } else if (event.impact === 2) {
          // All NPCs in same scene or adjacent
          const eventScene = event.location;
          for (const npc of state.npcCharacters) {
            const npcLoc = dgsm.getNpcLocation(npc.id);
            if (npcLoc === eventScene) {
              candidateNpcIds.add(npc.id);
            }
            // Check adjacent scenes
            const isAdjacent = state.connectionStates.some(
              (c) =>
                !c.blocked &&
                ((c.fromScenarioId === eventScene && c.toScenarioId === npcLoc) ||
                  (c.toScenarioId === eventScene && c.fromScenarioId === npcLoc))
            );
            if (isAdjacent) candidateNpcIds.add(npc.id);
          }
        } else if (event.impact === 3) {
          for (const npc of state.npcCharacters) {
            candidateNpcIds.add(npc.id);
          }
        }
      }

      // Remove NPCs who were the actors of these events
      for (const event of impactEvents) {
        candidateNpcIds.delete(event.characterId);
      }
      // Remove player characters
      for (const playerId of playerCharacterIds) {
        candidateNpcIds.delete(playerId);
      }

      if (candidateNpcIds.size > 0) {
        const candidates = await Promise.all(
          [...candidateNpcIds].map(async (npcId) => {
            const npc = state.npcCharacters.find((n) => n.id === npcId);
            const longTermIntent = await npcPlanningAgent.getLongTermIntent(sessionId, npcId);
            const pendingNodes = await npcPlanningAgent.getPendingNodes(sessionId, npcId, gameDay);
            const relevantEvents = impactEvents
              .map((e) => `${e.characterName}: ${e.outcome}`)
              .join("; ");

            return {
              npcId,
              npcName: npc?.name ?? npcId,
              longTermIntent,
              pendingNodesSummary: pendingNodes.map((n) => `${n.gameTime} ${n.action}`).join("; "),
              triggeringEvents: relevantEvents,
            };
          })
        );

        const gateResults = await npcPlanningAgent.runImpactGate(sessionId, bucketTime, candidates, language);

        // Process gate results in parallel
        await Promise.all(
          gateResults.map(async (result) => {
            // Always log witness entry
            const logEntry = `Day${gameDay} ${bucketTime} [witness] - ${result.witnessEntry}`;
            const npcLoc = dgsm.getNpcLocation(result.npcId) ?? "unknown";
            await npcPlanningAgent.appendActionLog(sessionId, result.npcId, logEntry, gameDay, bucketTime, npcLoc);

            if (result.shouldRevise) {
              const longTermIntent = await npcPlanningAgent.getLongTermIntent(sessionId, result.npcId);
              const actionLog = await npcPlanningAgent.getActionLog(sessionId, result.npcId);
              const pendingNodes = await npcPlanningAgent.getPendingNodes(sessionId, result.npcId, gameDay);
              const triggeringAction = impactEvents[0]; // Use first event as trigger
              await npcPlanningAgent.revisePlans(dgsm, sessionId, result.npcId, {
                longTermIntent,
                actionLog,
                pendingNodes,
                trigger: {
                  type: "impact",
                  triggeringAction,
                },
              }, language);
            }
          })
        );
      }
    }

    // If a player failed in this bucket, set global flag and break out of outer bucket loop
    if (playerFailedInBucket) {
      playerFailed = true;
      break;
    }
  }

  // 6. Advance game time: sum timeAdvanceMinutes from all successfully executed player nodes
  const successfulPlayerAdvance = allActions
    .filter((a) => a.isPlayer && a.status === "completed")
    .reduce((sum, a) => {
      const matchingNode = playerNodes.find((n) => n.characterId === a.characterId && n.action === a.action);
      return sum + (matchingNode?.timeAdvanceMinutes ?? 0);
    }, 0);
  const timeAdvance = successfulPlayerAdvance > 0 ? successfulPlayerAdvance : maxPlayerAdvance;
  dgsm.updateGameTime(timeAdvance);

  return allActions;
}

// ==================== Unplanned encounters ====================

function scanUnplannedEncounters(
  queue: PlanNode[],
  dgsm: DynamicGameStateManager
): void {
  const state = dgsm.getState();
  // Group NPCs by location at this point in time
  const locationGroups = new Map<string, string[]>();
  for (const npc of state.npcCharacters) {
    const loc = dgsm.getNpcLocation(npc.id);
    if (!loc) continue;
    if (!locationGroups.has(loc)) locationGroups.set(loc, []);
    locationGroups.get(loc)!.push(npc.id);
  }

  const existingPairs = new Set<string>();
  // Track existing character_interaction pairs to avoid duplicates
  for (const node of queue) {
    if (node.type === "character_interaction" && node.targetCharacterId) {
      const pairKey = [node.characterId, node.targetCharacterId].sort().join("_");
      existingPairs.add(pairKey);
    }
  }

  for (const [location, npcIds] of locationGroups) {
    for (let i = 0; i < npcIds.length; i++) {
      for (let j = i + 1; j < npcIds.length; j++) {
        const idA = npcIds[i];
        const idB = npcIds[j];
        const pairKey = [idA, idB].sort().join("_");
        if (existingPairs.has(pairKey)) continue;

        const rel = dgsm.getRelationship(idA, idB);
        if (!rel) continue;

        if (rel.score >= 60 || rel.score <= -60) {
          const npcA = state.npcCharacters.find((n) => n.id === idA);
          const npcB = state.npcCharacters.find((n) => n.id === idB);
          const isFriendly = rel.score >= 60;

          // Insert temp encounter node (A initiates toward B)
          queue.push({
            nodeId: `encounter-${idA}-${idB}-${Date.now()}`,
            characterId: idA,
            characterName: npcA?.name ?? idA,
            gameTime: state.timeOfDay,
            action: isFriendly
              ? `Friendly encounter with ${npcB?.name ?? idB}`
              : `Hostile confrontation with ${npcB?.name ?? idB}`,
            location,
            type: "character_interaction",
            actionType: isFriendly ? "social" : "combat",
            impact: 2,
            timeAdvanceMinutes: 0,
            targetCharacterId: idB,
            status: "pending",
          });
          existingPairs.add(pairKey);
        }
      }
    }
  }
}
