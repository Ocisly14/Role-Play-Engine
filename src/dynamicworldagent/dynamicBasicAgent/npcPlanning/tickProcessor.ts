import type { ActionType } from "../../../shared/state/index.js";
import { EmbeddingClient } from "../../../rag/embedding.js";
import { ModelProviderName } from "../../../models/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { NPCPlanningAgent } from "./NPCPlanningAgent.js";
import { ACTION_TYPE_SKILL_MAP } from "./actionTypeSkillMap.js";
import { BASELINE_HORROR_SOURCES } from "./horrorSourceData.js";
import type {
  PlanNode,
  CharacterAction,
  FailureReason,
  SceneCondition,
  DiscoveredClueEntry,
  SuccessLevel,
  TickResult,
  PlayerWitnessEvent,
} from "./types.js";
import { type SessionRagChunkInput, SessionRagService } from "../knowledge/sessionRagService.js";

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

function isFumble(roll: number, skillValue: number): boolean {
  return skillValue < 50 ? roll >= 96 : roll === 100;
}

function getSuccessLevel(roll: number, skillValue: number): SuccessLevel {
  if (roll === 1) return "critical";
  if (isFumble(roll, skillValue)) return "fumble";
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
  if (isFumble(roll, skillValue)) return "fumble";
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
  fumble: -1,
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
): { failed: boolean; reason?: string; detail?: string; successLevel: SuccessLevel } {
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
      dgsm.updateNpcSan(node.characterId, -sanLoss);
      return {
        failed: true,
        successLevel: level,
        reason: `SAN ${sanValue}, rolled ${roll} (difficulty: ${effectiveDifficulty}), lost ${sanLoss} sanity`,
        detail: "skill_roll_failed",
      };
    } else {
      const sanLoss = horror.sanLossMin;
      if (sanLoss > 0) dgsm.updateNpcSan(node.characterId, -sanLoss);
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

// ==================== Clue Discovery ====================

const CLUE_DIFFICULTY_RANK: Record<string, number> = {
  automatic: 0,
  regular: 1,
  hard: 2,
  extreme: 3,
};

/** success level → max clue difficulty rank discoverable */
const SUCCESS_TO_MAX_CLUE_RANK: Record<SuccessLevel, number> = {
  critical: 3, // extreme
  hard: 2,     // hard
  regular: 1,  // regular
  fail: 0,     // automatic only
  fumble: -1,  // no clues, may damage one
};

/** Only these actionTypes can trigger non-automatic clue discovery */
const CLUE_DISCOVERY_ACTION_TYPES = new Set<string>([
  "exploration", "social", "stealth", "narrative",
]);

const CLUE_SIMILARITY_THRESHOLD = 0.7;

// Lazy embedding client singleton
let _embeddingClient: EmbeddingClient | null = null;
function getEmbeddingClient(): EmbeddingClient {
  if (!_embeddingClient) {
    const provider = (process.env.MODEL_PROVIDER as ModelProviderName) || ModelProviderName.OPENAI;
    _embeddingClient = new EmbeddingClient(provider);
  }
  return _embeddingClient;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface ClueCandidate {
  clueId: string;
  clueText: string;
  difficulty: string;
  source: "scene" | "npc";
  sourceId: string;
  sourceName: string;
}

/**
 * Discover clues after a successful action.
 *
 * - Scene clues: triggered by scene_interaction / object_interaction
 * - NPC clues + secrets: triggered by character_interaction
 * - Only exploration/social/stealth/narrative actionTypes unlock non-automatic clues
 * - Filters by success level → clue difficulty
 * - Semantic match with 0.7 threshold, prioritizes highest difficulty first
 */
async function discoverClues(
  node: PlanNode,
  successLevel: SuccessLevel,
  dgsm: DynamicGameStateManager,
  language: string
): Promise<DiscoveredClueEntry[]> {
  const state = dgsm.getState();
  const scene = dgsm.getCurrentScene();

  // Determine max discoverable difficulty rank
  let maxRank: number;
  if (node.actionType && CLUE_DISCOVERY_ACTION_TYPES.has(node.actionType)) {
    // Qualifying actionType → use success level
    maxRank = SUCCESS_TO_MAX_CLUE_RANK[successLevel] ?? 0;
  } else if (
    !node.actionType &&
    node.type === "character_interaction" &&
    node.targetCharacterId
  ) {
    // No actionType + character_interaction → NPC relationship score determines max clue rank
    const rel = dgsm.getRelationship(node.characterId, node.targetCharacterId);
    const score = rel?.score ?? 0;
    if (score >= 80) maxRank = 3;      // extreme
    else if (score >= 70) maxRank = 2; // hard
    else if (score >= 60) maxRank = 1; // regular
    else maxRank = 0;                  // automatic only
  } else {
    // No qualifying actionType, not NPC interaction → automatic only
    maxRank = 0;
  }

  // Collect candidates based on node type
  const candidates: ClueCandidate[] = [];

  if (
    (node.type === "scene_interaction" || node.type === "object_interaction") &&
    scene?.clues
  ) {
    for (const clue of scene.clues) {
      if (clue.discovered || clue.damaged) continue;
      const rank = CLUE_DIFFICULTY_RANK[clue.difficulty] ?? 1;
      if (rank > maxRank) continue;
      candidates.push({
        clueId: clue.id,
        clueText: clue.clueText,
        difficulty: clue.difficulty,
        source: "scene",
        sourceId: scene.id,
        sourceName: scene.name,
      });
    }
  }

  if (node.type === "character_interaction" && node.targetCharacterId) {
    const npc = state.npcCharacters.find((n) => n.id === node.targetCharacterId);
    if (npc) {
      // NPC clues
      if (npc.clues) {
        for (const clue of npc.clues) {
          if (clue.revealed) continue;
          const rank = CLUE_DIFFICULTY_RANK[clue.difficulty ?? "regular"] ?? 1;
          if (rank > maxRank) continue;
          candidates.push({
            clueId: clue.id,
            clueText: clue.clueText,
            difficulty: clue.difficulty ?? "regular",
            source: "npc",
            sourceId: npc.id,
            sourceName: npc.name,
          });
        }
      }
      // NPC secrets (treated as "hard" difficulty)
      if (npc.secrets) {
        const hardRank = CLUE_DIFFICULTY_RANK["hard"];
        if (hardRank <= maxRank) {
          for (let i = 0; i < npc.secrets.length; i++) {
            const alreadyKnown = state.discoveredClues.some(
              (dc) => dc.text === npc.secrets![i] || dc.text === `Secret: ${npc.secrets![i]}`
            );
            if (alreadyKnown) continue;
            candidates.push({
              clueId: `${npc.id}_secret_${i}`,
              clueText: npc.secrets[i],
              difficulty: "hard",
              source: "npc",
              sourceId: npc.id,
              sourceName: npc.name,
            });
          }
        }
      }
    }
  }

  if (candidates.length === 0) return [];

  // Split automatic (always discovered) vs non-automatic (need semantic match)
  const automaticResults: DiscoveredClueEntry[] = [];
  const matchCandidates: ClueCandidate[] = [];

  for (const c of candidates) {
    if (c.difficulty === "automatic") {
      automaticResults.push({
        clueId: c.clueId,
        clueText: c.clueText,
        source: c.source,
        sourceId: c.sourceId,
        sourceName: c.sourceName,
        difficulty: "automatic",
        similarity: 1.0,
      });
    } else {
      matchCandidates.push(c);
    }
  }

  if (matchCandidates.length === 0) return automaticResults;

  // Semantic match: embed action, compare against each candidate
  try {
    const embedClient = getEmbeddingClient();
    const lang = (language?.startsWith("zh") ? "zh" : "en") as "zh" | "en";
    const actionEmbedding = await embedClient.embed(node.action, { language: lang });
    if (!actionEmbedding.length) return automaticResults;

    // Sort candidates by difficulty descending (hardest first) before matching
    matchCandidates.sort(
      (a, b) => (CLUE_DIFFICULTY_RANK[b.difficulty] ?? 0) - (CLUE_DIFFICULTY_RANK[a.difficulty] ?? 0)
    );

    const matched: DiscoveredClueEntry[] = [];
    for (const c of matchCandidates) {
      const clueEmbedding = await embedClient.embed(c.clueText, { language: lang });
      if (!clueEmbedding.length) continue;

      const sim = cosineSimilarity(actionEmbedding, clueEmbedding);
      if (sim >= CLUE_SIMILARITY_THRESHOLD) {
        matched.push({
          clueId: c.clueId,
          clueText: c.clueText,
          source: c.source,
          sourceId: c.sourceId,
          sourceName: c.sourceName,
          difficulty: c.difficulty as DiscoveredClueEntry["difficulty"],
          similarity: sim,
        });
      }
    }

    // Already sorted by difficulty desc; break ties by similarity desc
    matched.sort((a, b) => {
      const diffDelta = (CLUE_DIFFICULTY_RANK[b.difficulty] ?? 0) - (CLUE_DIFFICULTY_RANK[a.difficulty] ?? 0);
      if (diffDelta !== 0) return diffDelta;
      return b.similarity - a.similarity;
    });

    return [...automaticResults, ...matched];
  } catch (error) {
    console.warn("[TickProcessor] Clue discovery embedding failed:", error);
    return automaticResults;
  }
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

  let resolvedSuccessLevel: SuccessLevel | undefined;
  let lastRollDetail: string | undefined; // skill roll detail from resolveSkillRoll

  // Build rich outcome string with skill + payload context
  const buildOutcome = (status: "completed" | "failed", reason?: string): string => {
    const parts: string[] = [node.action];
    // Skill roll info
    if (lastRollDetail) {
      parts.push(`[${lastRollDetail}]`);
    } else if (reason) {
      parts.push(`[${reason}]`);
    }
    // Payload context
    if (node.type === "character_interaction" && node.characterInteractionPayload) {
      const p = node.characterInteractionPayload;
      if (p.transferType === "item" && p.itemId) parts.push(`(item: ${p.itemId})`);
      else if (p.transferType === "clue" && p.clueId) parts.push(`(clue: ${p.clueId})`);
      else if (p.transferType === "information" && p.informationContent) parts.push(`(info: ${p.informationContent})`);
    } else if (node.type === "object_interaction" && node.objectInteractionPayload) {
      const p = node.objectInteractionPayload;
      parts.push(`(${p.action}${p.itemId ? `: ${p.itemId}` : ""})`);
    } else if (node.type === "scene_interaction" && node.sceneConnectionEffect) {
      const e = node.sceneConnectionEffect;
      parts.push(`(${e.action} connection to ${e.targetScenarioId})`);
    }
    parts.push(status === "completed" ? "succeeded" : "failed");
    return parts.join(" ");
  };

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
    successLevel: resolvedSuccessLevel,
    status,
    outcome,
    failureReason,
    targetCharacterId: node.targetCharacterId,
  });

  // === Type-specific execution ===

  if (node.type === "routine") {
    if (npcLocation && npcLocation !== node.location) {
      return makeAction("failed", buildOutcome("failed", "not at expected location"), "location_mismatch");
    }
    // actionType present? → skill roll
    if (node.actionType) {
      const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
      resolvedSuccessLevel = rollResult.successLevel;
      if (rollResult.failed) {
        lastRollDetail = rollResult.reason;
        return makeAction("failed", buildOutcome("failed", rollResult.reason), "skill_roll_failed");
      }
      lastRollDetail = rollResult.detail;
    }
    return makeAction("completed", buildOutcome("completed"));
  }

  if (node.type === "movement") {
    const fromLocation = npcLocation ?? node.location;
    if (dgsm.isConnectionBlocked(fromLocation, node.location)) {
      return makeAction("failed", buildOutcome("failed", "path blocked"), "location_blocked");
    }
    // Check scene conditions for blocked
    const targetConditions = dgsm.getSceneConditions(node.location);
    const isBlocked = targetConditions.some((c) => c.mechanicalEffect?.blocked);
    if (isBlocked) {
      return makeAction("failed", buildOutcome("failed", "destination blocked"), "location_blocked");
    }
    dgsm.setNpcLocation(node.characterId, node.location);
    return makeAction("completed", buildOutcome("completed"));
  }

  if (node.type === "character_interaction") {
    if (npcLocation && npcLocation !== node.location) {
      return makeAction("failed", buildOutcome("failed", "not at expected location"), "location_mismatch");
    }
    if (node.targetCharacterId) {
      const targetLocation = dgsm.getNpcLocation(node.targetCharacterId);
      // Player character doesn't have npcLocation entry — skip check for player
      if (targetLocation && targetLocation !== node.location) {
        return makeAction("failed", buildOutcome("failed", "target not present"), "target_absent");
      }
    }

    // For NPC nodes with luck_only difficulty: skip actionType skill roll, only do luck-based roll
    if (!node.isPlayer && difficulty === "luck_only") {
      if (Math.random() < luckFailureRate(luck)) {
        return makeAction("failed", buildOutcome("failed", `bad luck (luck=${luck})`), "bad_luck");
      }
    } else if (node.isPlayer) {
      // Player nodes: skip luck-based failure check entirely
      // Only do skill roll if actionType present
      if (node.actionType) {
        const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
        resolvedSuccessLevel = rollResult.successLevel;
        if (rollResult.failed) {
          lastRollDetail = rollResult.reason;
          return makeAction("failed", buildOutcome("failed", rollResult.reason), "skill_roll_failed");
        }
        lastRollDetail = rollResult.detail;
      }
    } else {
      // NPC nodes (non-luck_only): existing logic
      // Luck-based failure (only when no actionType)
      if (!node.actionType && Math.random() < luckFailureRate(luck)) {
        return makeAction("failed", buildOutcome("failed", `bad luck (luck=${luck})`), "bad_luck");
      }
      // Skill roll if actionType present
      if (node.actionType) {
        const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
        resolvedSuccessLevel = rollResult.successLevel;
        if (rollResult.failed) {
          lastRollDetail = rollResult.reason;
          return makeAction("failed", buildOutcome("failed", rollResult.reason), "skill_roll_failed");
        }
        lastRollDetail = rollResult.detail;
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
    return makeAction("completed", buildOutcome("completed"));
  }

  if (node.type === "object_interaction") {
    if (npcLocation && npcLocation !== node.location) {
      return makeAction("failed", buildOutcome("failed", "not at expected location"), "location_mismatch");
    }

    if (node.isPlayer) {
      if (node.actionType) {
        const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
        resolvedSuccessLevel = rollResult.successLevel;
        if (rollResult.failed) {
          lastRollDetail = rollResult.reason;
          return makeAction("failed", buildOutcome("failed", rollResult.reason), "skill_roll_failed");
        }
        lastRollDetail = rollResult.detail;
      }
    } else if (difficulty === "luck_only") {
      if (Math.random() < luckFailureRate(luck)) {
        return makeAction("failed", buildOutcome("failed", `bad luck (luck=${luck})`), "bad_luck");
      }
    } else {
      if (!node.actionType && Math.random() < luckFailureRate(luck)) {
        return makeAction("failed", buildOutcome("failed", `bad luck (luck=${luck})`), "bad_luck");
      }
      if (node.actionType) {
        const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
        resolvedSuccessLevel = rollResult.successLevel;
        if (rollResult.failed) {
          lastRollDetail = rollResult.reason;
          return makeAction("failed", buildOutcome("failed", rollResult.reason), "skill_roll_failed");
        }
        lastRollDetail = rollResult.detail;
      }
    }

    // Apply side effects
    if (node.objectInteractionPayload) {
      const payload = node.objectInteractionPayload;
      if (payload.action === "pickup" && payload.itemId) {
        dgsm.addItemToNpc(node.characterId, payload.itemId);
        const scene = dgsm.getCurrentScene();
        if (scene) {
          scene.items = scene.items.filter(i => i.id !== payload.itemId);
        }
      } else if (payload.action === "place" && payload.itemId) {
        dgsm.removeItemFromNpc(node.characterId, payload.itemId);
        const scene = dgsm.getCurrentScene();
        if (scene) {
          scene.items.push({ id: payload.itemId, name: payload.itemId });
        }
      } else if (payload.action === "destroy" && payload.itemId) {
        dgsm.removeItemFromNpc(node.characterId, payload.itemId);
        const scene = dgsm.getScene(node.location);
        if (scene) {
          scene.events.push(`${node.characterName} destroyed ${payload.itemId}`);
        }
      }
    }
    return makeAction("completed", buildOutcome("completed"));
  }

  if (node.type === "scene_interaction") {
    if (npcLocation && npcLocation !== node.location) {
      return makeAction("failed", buildOutcome("failed", "not at expected location"), "location_mismatch");
    }

    if (node.isPlayer) {
      if (node.actionType) {
        const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
        resolvedSuccessLevel = rollResult.successLevel;
        if (rollResult.failed) {
          lastRollDetail = rollResult.reason;
          return makeAction("failed", buildOutcome("failed", rollResult.reason), "skill_roll_failed");
        }
        lastRollDetail = rollResult.detail;
      }
    } else if (difficulty === "luck_only") {
      if (Math.random() < luckFailureRate(luck)) {
        return makeAction("failed", buildOutcome("failed", `bad luck (luck=${luck})`), "bad_luck");
      }
    } else {
      if (!node.actionType && Math.random() < luckFailureRate(luck)) {
        return makeAction("failed", buildOutcome("failed", `bad luck (luck=${luck})`), "bad_luck");
      }
      if (node.actionType) {
        const rollResult = resolveSkillRoll(node, adjustedSkills, dgsm);
        resolvedSuccessLevel = rollResult.successLevel;
        if (rollResult.failed) {
          lastRollDetail = rollResult.reason;
          return makeAction("failed", buildOutcome("failed", rollResult.reason), "skill_roll_failed");
        }
        lastRollDetail = rollResult.detail;
      }
    }

    // Append outcome as scene condition
    const outcome = buildOutcome("completed");
    dgsm.appendSceneCondition(node.location, { description: outcome });
    if (node.sceneConnectionEffect) {
      const effect = node.sceneConnectionEffect;
      const blocked = effect.action === "block";
      dgsm.setConnectionBlocked(node.location, effect.targetScenarioId, blocked, outcome);
    }
    return makeAction("completed", outcome);
  }

  // Fallback
  return makeAction("completed", buildOutcome("completed"));
}

// ==================== Clue RAG embedding ====================

function embedDiscoveredClues(
  clues: DiscoveredClueEntry[],
  dgsm: DynamicGameStateManager,
  language: string
): void {
  if (clues.length === 0) return;
  const ragService = new SessionRagService();
  const state = dgsm.getState();
  const ragChunks: SessionRagChunkInput[] = clues.map((entry) => ({
    sessionId: state.sessionId,
    chunkType: "clue" as const,
    role: "system" as const,
    content: [
      "Clue Discovered",
      `Type: ${entry.source}`,
      `Source: ${entry.sourceName}`,
      `Content: ${entry.clueText}`,
    ].join("\n"),
    metadata: {
      clueType: entry.source,
      sourceName: entry.sourceName,
      discoveredAt: `Day ${state.gameDay}, ${state.timeOfDay}`,
    },
    sourceKey: `clue:${entry.clueId}`,
    language,
  }));
  void ragService.upsertChunks(ragChunks).catch((err) =>
    console.error("[TickProcessor] Failed to embed clue:", err)
  );
}

// ==================== Main runTick ====================

export async function runTick(
  playerNodes: PlanNode[],
  dgsm: DynamicGameStateManager,
  npcPlanningAgent: NPCPlanningAgent,
  sessionId: string,
  language: string = "en"
): Promise<TickResult> {
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

      // On character_interaction success → update relationship (before logging so we can include delta)
      let relationshipChange: string | undefined;
      if (action.status === "completed" && node.type === "character_interaction" && node.targetCharacterId) {
        const relResult = await npcPlanningAgent.updateRelationshipViaLLM(dgsm, node.characterId, node.targetCharacterId, action.outcome, language);
        if (relResult) {
          const sign = relResult.scoreDelta >= 0 ? "+" : "";
          relationshipChange = `[relationship ${sign}${relResult.scoreDelta} → ${relResult.newScore}, ${relResult.note}]`;
        }
      }

      // Log NPC actions (not player)
      if (!node.isPlayer) {
        let logEntry = `Day${gameDay} ${action.gameTime} [${action.location}] - ${action.outcome}`;
        if (relationshipChange) logEntry += ` ${relationshipChange}`;
        await npcPlanningAgent.appendMemoryLog(sessionId, node.characterId, logEntry, gameDay, action.gameTime, action.location);
        await npcPlanningAgent.markNodeCompleted(sessionId, node.characterId, gameDay, node.nodeId, action.outcome);
      }

      // Clue discovery — only for player's successful nodes
      if (action.status === "completed" && node.isPlayer) {
        const effectiveSuccess: SuccessLevel = action.successLevel ?? "regular";
        const clues = await discoverClues(node, effectiveSuccess, dgsm, language);
        if (clues.length > 0) {
          action.discoveredClues = clues;
          embedDiscoveredClues(clues, dgsm, language);
          // Mark scene clues as discovered
          for (const entry of clues) {
            if (entry.source === "scene") {
              dgsm.markScenarioClueDiscovered(entry.clueId, node.characterName);
            } else if (entry.source === "npc") {
              dgsm.markNpcClueRevealed(entry.sourceId, entry.clueId);
            }
            // Add to global discoveredClues list
            dgsm.addDiscoveredClue({
              text: entry.clueText,
              type: entry.source === "scene" ? "scenario" : entry.clueId.includes("_secret_") ? "secret" : "npc",
              sourceName: entry.sourceName,
              discoveredBy: node.characterName,
              discoveredAt: new Date().toISOString(),
              difficulty: entry.difficulty,
              method: node.action,
            });
          }
          console.log(
            `[TickProcessor] Player discovered ${clues.length} clue(s): ${clues.map((c) => `[${c.difficulty}] ${c.clueText.slice(0, 40)}`).join("; ")}`
          );
        }
      }

      // Fumble → damage a random undiscovered scene clue
      if (node.isPlayer && action.successLevel === "fumble") {
        const scene = dgsm.getCurrentScene();
        const damageable = scene?.clues?.filter((c) => !c.discovered && !c.damaged) ?? [];
        if (damageable.length > 0) {
          const victim = damageable[Math.floor(Math.random() * damageable.length)];
          dgsm.damageScenarioClue(victim.id, node.characterName, `Fumbled: ${node.action}`);
          action.damagedClue = { clueId: victim.id, sourceName: scene!.name };
          console.log(`[TickProcessor] Fumble damaged clue: ${victim.clueText.slice(0, 40)}`);
        }
      }

      // Scene event logging for high-impact completed NPC actions
      if (action.status === "completed" && action.impact >= 2 && !node.isPlayer) {
        const scene = dgsm.getScene(node.location);
        if (scene) {
          scene.events.push(`${node.characterName}: ${action.outcome}`);
        }
      }

      // On failure → immediate revisePlans (no gate) — NPC only
      if (action.status === "failed" && !node.isPlayer) {
        const longTermIntent = await npcPlanningAgent.getLongTermIntent(sessionId, node.characterId);
        const memoryLog = await npcPlanningAgent.getMemoryLog(sessionId, node.characterId, gameDay);
        const pendingNodes = await npcPlanningAgent.getPendingNodes(sessionId, node.characterId, gameDay);
        await npcPlanningAgent.revisePlans(dgsm, sessionId, node.characterId, {
          longTermIntent,
          memoryLog,
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
      // Build per-character impact event map (characterId → events that affect them)
      const characterEventsMap = new Map<string, Array<{ event: CharacterAction; impact: number }>>();
      const playerScene = state.currentSceneId;
      const playerId = state.playerCharacter?.id;

      const addEventForCharacter = (charId: string, event: CharacterAction, impact: number) => {
        if (charId === event.characterId) return; // skip actor
        if (!characterEventsMap.has(charId)) characterEventsMap.set(charId, []);
        const existing = characterEventsMap.get(charId)!;
        // Keep highest impact if same event appears multiple times
        const idx = existing.findIndex((e) => e.event === event);
        if (idx >= 0) {
          if (impact > existing[idx].impact) existing[idx].impact = impact;
        } else {
          existing.push({ event, impact });
        }
      };

      for (const event of impactEvents) {
        if (event.impact >= 1 && event.targetCharacterId) {
          addEventForCharacter(event.targetCharacterId, event, 1);
        }
        if (event.impact >= 2) {
          const eventScene = event.location;
          for (const npc of state.npcCharacters) {
            const npcLoc = dgsm.getNpcLocation(npc.id);
            if (npcLoc === eventScene) {
              addEventForCharacter(npc.id, event, 2);
            } else {
              const isAdjacent = state.connectionStates.some(
                (c) =>
                  !c.blocked &&
                  ((c.fromScenarioId === eventScene && c.toScenarioId === npcLoc) ||
                    (c.toScenarioId === eventScene && c.fromScenarioId === npcLoc))
              );
              if (isAdjacent) addEventForCharacter(npc.id, event, 2);
            }
          }
          if (playerId && playerScene) {
            if (playerScene === eventScene) {
              addEventForCharacter(playerId, event, 2);
            } else {
              const playerAdjacent = state.connectionStates.some(
                (c) =>
                  !c.blocked &&
                  ((c.fromScenarioId === eventScene && c.toScenarioId === playerScene) ||
                    (c.toScenarioId === eventScene && c.fromScenarioId === playerScene))
              );
              if (playerAdjacent) addEventForCharacter(playerId, event, 2);
            }
          }
        }
        if (event.impact >= 3) {
          for (const npc of state.npcCharacters) {
            addEventForCharacter(npc.id, event, 3);
          }
          if (playerId) addEventForCharacter(playerId, event, 3);
        }
      }

      // Separate player from NPC candidates
      const playerEvents = playerId ? characterEventsMap.get(playerId) : undefined;
      if (playerId) characterEventsMap.delete(playerId);

      // NPC candidates → one LLM call per NPC, all in parallel
      if (characterEventsMap.size > 0) {
        await Promise.all(
          [...characterEventsMap.entries()].map(async ([npcId, npcEvents]) => {
            const npc = state.npcCharacters.find((n) => n.id === npcId);
            const longTermIntent = await npcPlanningAgent.getLongTermIntent(sessionId, npcId);
            const pendingNodes = await npcPlanningAgent.getPendingNodes(sessionId, npcId, gameDay);
            const triggeringEvents = npcEvents
              .map((e) => `[impact ${e.impact}] ${e.event.characterName}: ${e.event.outcome}`)
              .join("\n");

            const result = await npcPlanningAgent.runImpactGateForNpc(
              {
                npcId,
                npcName: npc?.name ?? npcId,
                currentLocation: dgsm.getNpcLocation(npcId) ?? "unknown",
                longTermIntent,
                pendingNodesSummary: pendingNodes.map((n) => `${n.gameTime} ${n.action}`).join("; "),
                triggeringEvents,
              },
              bucketTime,
              language
            );

            // Always log witness entry
            const logEntry = `Day${gameDay} ${bucketTime} [witness] - ${result.witnessEntry}`;
            const npcLoc = dgsm.getNpcLocation(npcId) ?? "unknown";
            await npcPlanningAgent.appendMemoryLog(sessionId, npcId, logEntry, gameDay, bucketTime, npcLoc);

            if (result.shouldRevise) {
              const memoryLog = await npcPlanningAgent.getMemoryLog(sessionId, npcId, gameDay);
              // Find the highest-impact triggering action for revision context
              const sortedEvents = [...npcEvents].sort((a, b) => b.impact - a.impact);
              await npcPlanningAgent.revisePlans(dgsm, sessionId, npcId, {
                longTermIntent,
                memoryLog,
                pendingNodes,
                trigger: {
                  type: "impact",
                  triggeringAction: sortedEvents[0].event,
                },
              }, language);
            }
          })
        );
      }

      // Player witness: interrupt tick execution so player can decide
      if (playerEvents && playerEvents.length > 0) {
        const playerWitnessEvents: PlayerWitnessEvent[] = playerEvents.map((e) => ({
          characterName: e.event.characterName,
          action: e.event.action,
          outcome: e.event.outcome,
          location: e.event.location,
          gameTime: e.event.gameTime,
          impact: e.impact,
        }));

        // Also store in contextualData for KeeperAgent
        const existing = (dgsm.getContextualData("playerWitnessEvents") as any[]) ?? [];
        dgsm.setContextualData("playerWitnessEvents", [...existing, ...playerWitnessEvents]);

        // Collect remaining buckets (after current one)
        const currentIdx = sortedBucketKeys.indexOf(bucketKey);
        const remainingBuckets = sortedBucketKeys
          .slice(currentIdx + 1)
          .map((k) => ({ bucketKey: k, nodes: buckets.get(k)! }));

        return {
          type: "player_interrupt",
          actions: allActions,
          witnessEvents: playerWitnessEvents,
          remainingBuckets,
          gameDay,
        };
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

  return { type: "completed", actions: allActions };
}

// ==================== Resume after player interrupt ====================

export async function resumeTick(
  remainingBuckets: Array<{ bucketKey: number; nodes: PlanNode[] }>,
  previousActions: CharacterAction[],
  dgsm: DynamicGameStateManager,
  npcPlanningAgent: NPCPlanningAgent,
  sessionId: string,
  playerNodes: PlanNode[],
  language: string = "en"
): Promise<TickResult> {
  const state = dgsm.getState();
  const gameDay = state.gameDay;
  const allActions: CharacterAction[] = [...previousActions];
  const playerCharacterIds = new Set(playerNodes.map((n) => n.characterId));
  let playerFailed = false;

  // Rebuild buckets map for impact gate reuse
  const buckets = new Map<number, PlanNode[]>();
  for (const { bucketKey, nodes } of remainingBuckets) {
    buckets.set(bucketKey, nodes);
  }
  const sortedBucketKeys = remainingBuckets.map((b) => b.bucketKey);

  for (const bucketKey of sortedBucketKeys) {
    const bucketNodes = buckets.get(bucketKey)!;
    const bucketTime = getBucketLabel(bucketKey);
    const bucketActions: CharacterAction[] = [];
    let playerFailedInBucket = false;

    for (const node of bucketNodes) {
      if ((playerFailed || playerFailedInBucket) && node.isPlayer) continue;

      const action = executeNode(node, dgsm);
      bucketActions.push(action);
      allActions.push(action);

      if (action.status === "failed" && node.isPlayer) {
        playerFailedInBucket = true;
      }

      let relationshipChange: string | undefined;
      if (action.status === "completed" && node.type === "character_interaction" && node.targetCharacterId) {
        const relResult = await npcPlanningAgent.updateRelationshipViaLLM(dgsm, node.characterId, node.targetCharacterId, action.outcome, language);
        if (relResult) {
          const sign = relResult.scoreDelta >= 0 ? "+" : "";
          relationshipChange = `[relationship ${sign}${relResult.scoreDelta} → ${relResult.newScore}, ${relResult.note}]`;
        }
      }

      if (!node.isPlayer) {
        let logEntry = `Day${gameDay} ${action.gameTime} [${action.location}] - ${action.outcome}`;
        if (relationshipChange) logEntry += ` ${relationshipChange}`;
        await npcPlanningAgent.appendMemoryLog(sessionId, node.characterId, logEntry, gameDay, action.gameTime, action.location);
        await npcPlanningAgent.markNodeCompleted(sessionId, node.characterId, gameDay, node.nodeId, action.outcome);
      }

      if (action.status === "completed" && node.isPlayer) {
        const effectiveSuccess: SuccessLevel = action.successLevel ?? "regular";
        const clues = await discoverClues(node, effectiveSuccess, dgsm, language);
        if (clues.length > 0) {
          action.discoveredClues = clues;
          embedDiscoveredClues(clues, dgsm, language);
          for (const entry of clues) {
            if (entry.source === "scene") {
              dgsm.markScenarioClueDiscovered(entry.clueId, node.characterName);
            } else if (entry.source === "npc") {
              dgsm.markNpcClueRevealed(entry.sourceId, entry.clueId);
            }
            dgsm.addDiscoveredClue({
              text: entry.clueText,
              type: entry.source === "scene" ? "scenario" : entry.clueId.includes("_secret_") ? "secret" : "npc",
              sourceName: entry.sourceName,
              discoveredBy: node.characterName,
              discoveredAt: new Date().toISOString(),
              difficulty: entry.difficulty,
              method: node.action,
            });
          }
        }
      }

      // Fumble → damage a random undiscovered scene clue
      if (node.isPlayer && action.successLevel === "fumble") {
        const scene = dgsm.getCurrentScene();
        const damageable = scene?.clues?.filter((c) => !c.discovered && !c.damaged) ?? [];
        if (damageable.length > 0) {
          const victim = damageable[Math.floor(Math.random() * damageable.length)];
          dgsm.damageScenarioClue(victim.id, node.characterName, `Fumbled: ${node.action}`);
          action.damagedClue = { clueId: victim.id, sourceName: scene!.name };
          console.log(`[TickProcessor] Fumble damaged clue: ${victim.clueText.slice(0, 40)}`);
        }
      }

      // Scene event logging for high-impact completed NPC actions
      if (action.status === "completed" && action.impact >= 2 && !node.isPlayer) {
        const scene = dgsm.getScene(node.location);
        if (scene) {
          scene.events.push(`${node.characterName}: ${action.outcome}`);
        }
      }

      if (action.status === "failed" && !node.isPlayer) {
        const longTermIntent = await npcPlanningAgent.getLongTermIntent(sessionId, node.characterId);
        const memoryLog = await npcPlanningAgent.getMemoryLog(sessionId, node.characterId, gameDay);
        const pendingNodes = await npcPlanningAgent.getPendingNodes(sessionId, node.characterId, gameDay);
        await npcPlanningAgent.revisePlans(dgsm, sessionId, node.characterId, {
          longTermIntent,
          memoryLog,
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

    // Impact gate (same logic as runTick)
    const impactEvents = bucketActions.filter((a) => a.impact > 0);
    if (impactEvents.length > 0) {
      const characterEventsMap = new Map<string, Array<{ event: CharacterAction; impact: number }>>();
      const playerScene = state.currentSceneId;
      const playerId = state.playerCharacter?.id;

      const addEventForCharacter = (charId: string, event: CharacterAction, impact: number) => {
        if (charId === event.characterId) return;
        if (!characterEventsMap.has(charId)) characterEventsMap.set(charId, []);
        const existing = characterEventsMap.get(charId)!;
        const idx = existing.findIndex((e) => e.event === event);
        if (idx >= 0) {
          if (impact > existing[idx].impact) existing[idx].impact = impact;
        } else {
          existing.push({ event, impact });
        }
      };

      for (const event of impactEvents) {
        if (event.impact >= 1 && event.targetCharacterId) addEventForCharacter(event.targetCharacterId, event, 1);
        if (event.impact >= 2) {
          const eventScene = event.location;
          for (const npc of state.npcCharacters) {
            const npcLoc = dgsm.getNpcLocation(npc.id);
            if (npcLoc === eventScene) addEventForCharacter(npc.id, event, 2);
            else {
              const isAdjacent = state.connectionStates.some((c) => !c.blocked && ((c.fromScenarioId === eventScene && c.toScenarioId === npcLoc) || (c.toScenarioId === eventScene && c.fromScenarioId === npcLoc)));
              if (isAdjacent) addEventForCharacter(npc.id, event, 2);
            }
          }
          if (playerId && playerScene) {
            if (playerScene === eventScene) addEventForCharacter(playerId, event, 2);
            else {
              const playerAdjacent = state.connectionStates.some((c) => !c.blocked && ((c.fromScenarioId === eventScene && c.toScenarioId === playerScene) || (c.toScenarioId === eventScene && c.fromScenarioId === playerScene)));
              if (playerAdjacent) addEventForCharacter(playerId, event, 2);
            }
          }
        }
        if (event.impact >= 3) {
          for (const npc of state.npcCharacters) addEventForCharacter(npc.id, event, 3);
          if (playerId) addEventForCharacter(playerId, event, 3);
        }
      }

      const playerEvents = playerId ? characterEventsMap.get(playerId) : undefined;
      if (playerId) characterEventsMap.delete(playerId);

      if (characterEventsMap.size > 0) {
        await Promise.all(
          [...characterEventsMap.entries()].map(async ([npcId, npcEvents]) => {
            const npc = state.npcCharacters.find((n) => n.id === npcId);
            const longTermIntent = await npcPlanningAgent.getLongTermIntent(sessionId, npcId);
            const pendingNodes = await npcPlanningAgent.getPendingNodes(sessionId, npcId, gameDay);
            const triggeringEvents = npcEvents.map((e) => `[impact ${e.impact}] ${e.event.characterName}: ${e.event.outcome}`).join("\n");

            const result = await npcPlanningAgent.runImpactGateForNpc(
              { npcId, npcName: npc?.name ?? npcId, currentLocation: dgsm.getNpcLocation(npcId) ?? "unknown", longTermIntent, pendingNodesSummary: pendingNodes.map((n) => `${n.gameTime} ${n.action}`).join("; "), triggeringEvents },
              bucketTime, language
            );

            const logEntry = `Day${gameDay} ${bucketTime} [witness] - ${result.witnessEntry}`;
            await npcPlanningAgent.appendMemoryLog(sessionId, npcId, logEntry, gameDay, bucketTime, dgsm.getNpcLocation(npcId) ?? "unknown");

            if (result.shouldRevise) {
              const memoryLog = await npcPlanningAgent.getMemoryLog(sessionId, npcId, gameDay);
              const sortedEvents = [...npcEvents].sort((a, b) => b.impact - a.impact);
              await npcPlanningAgent.revisePlans(dgsm, sessionId, npcId, {
                longTermIntent, memoryLog, pendingNodes,
                trigger: { type: "impact", triggeringAction: sortedEvents[0].event },
              }, language);
            }
          })
        );
      }

      // Player interrupt again if needed
      if (playerEvents && playerEvents.length > 0) {
        const playerWitnessEvents: PlayerWitnessEvent[] = playerEvents.map((e) => ({
          characterName: e.event.characterName, action: e.event.action, outcome: e.event.outcome,
          location: e.event.location, gameTime: e.event.gameTime, impact: e.impact,
        }));
        const existingWitness = (dgsm.getContextualData("playerWitnessEvents") as any[]) ?? [];
        dgsm.setContextualData("playerWitnessEvents", [...existingWitness, ...playerWitnessEvents]);

        const currentIdx = sortedBucketKeys.indexOf(bucketKey);
        const nextBuckets = sortedBucketKeys.slice(currentIdx + 1).map((k) => ({ bucketKey: k, nodes: buckets.get(k)! }));

        return { type: "player_interrupt", actions: allActions, witnessEvents: playerWitnessEvents, remainingBuckets: nextBuckets, gameDay };
      }
    }

    if (playerFailedInBucket) {
      playerFailed = true;
      break;
    }
  }

  // Advance game time
  const maxPlayerAdvance = playerNodes.reduce((max, n) => Math.max(max, n.timeAdvanceMinutes), 0);
  const successfulPlayerAdvance = allActions
    .filter((a) => a.isPlayer && a.status === "completed")
    .reduce((sum, a) => {
      const matchingNode = playerNodes.find((n) => n.characterId === a.characterId && n.action === a.action);
      return sum + (matchingNode?.timeAdvanceMinutes ?? 0);
    }, 0);
  const timeAdvance = successfulPlayerAdvance > 0 ? successfulPlayerAdvance : maxPlayerAdvance;
  dgsm.updateGameTime(timeAdvance);

  return { type: "completed", actions: allActions };
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
