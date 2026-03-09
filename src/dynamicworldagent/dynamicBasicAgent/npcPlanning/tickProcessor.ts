import { EmbeddingClient } from "../../../rag/embedding.js";
import { ModelProviderName } from "../../../models/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { NPCPlanningAgent } from "./NPCPlanningAgent.js";
import type {
  PlanNode,
  CharacterAction,
  DiscoveredClueEntry,
  SuccessLevel,
  TickResult,
  PlayerWitnessEvent,
} from "./types.js";
import { type SessionRagChunkInput, SessionRagService } from "../knowledge/sessionRagService.js";
import type { GameEngineRegistry } from "../../engine/registry.js";
import type { ExecutionContext, TickRuntimeContext } from "../../engine/types.js";

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

// ==================== Clue Discovery ====================

const CLUE_DIFFICULTY_RANK: Record<string, number> = {
  automatic: 0,
  regular: 1,
  hard: 2,
  extreme: 3,
};

/** success level -> max clue difficulty rank discoverable */
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
 * - Filters by success level -> clue difficulty
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
    // Qualifying actionType -> use success level
    maxRank = SUCCESS_TO_MAX_CLUE_RANK[successLevel] ?? 0;
  } else if (
    !node.actionType &&
    node.type === "character_interaction" &&
    node.targetCharacterId
  ) {
    // No actionType + character_interaction -> NPC relationship score determines max clue rank
    const rel = dgsm.getRelationship(node.characterId, node.targetCharacterId);
    const score = rel?.score ?? 0;
    if (score >= 80) maxRank = 3;      // extreme
    else if (score >= 70) maxRank = 2; // hard
    else if (score >= 60) maxRank = 1; // regular
    else maxRank = 0;                  // automatic only
  } else {
    // No qualifying actionType, not NPC interaction -> automatic only
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

// ==================== Clue RAG embedding ====================

function embedDiscoveredClues(
  clues: DiscoveredClueEntry[],
  dgsm: DynamicGameStateManager,
  language: "en" | "zh"
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
  language: string = "en",
  registry: GameEngineRegistry,
  ctx: ExecutionContext
): Promise<TickResult> {
  const state = dgsm.getState();
  const gameDay = state.gameDay;
  const currentTime = state.timeOfDay;

  // Build runtime context for WorldFeature hooks
  const tickRuntime: TickRuntimeContext = {
    sessionId, gameDay, language,
    npcPlanning: npcPlanningAgent,
  };

  // Fire onTickStart for all registered WorldFeatures
  for (const feature of registry.getAllFeatures()) {
    feature.onTickStart?.(dgsm, tickRuntime);
  }

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

      // Dispatch to registry handler
      const handler = registry.getHandler(node.type);
      if (!handler) {
        console.warn(`[TickProcessor] No handler for node type: ${node.type}, skipping`);
        continue;
      }
      const action = handler.execute(node, dgsm, ctx);
      bucketActions.push(action);
      allActions.push(action);

      // Check if a player node just failed
      if (action.status === "failed" && node.isPlayer) {
        playerFailedInBucket = true;
        // Continue executing remaining NPC nodes in this bucket
        // (the skip logic above handles player nodes)
      }

      // On character_interaction success -> update relationship (before logging so we can include delta)
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
          embedDiscoveredClues(clues, dgsm, language as "en" | "zh");
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

      // Fumble -> damage a random undiscovered scene clue
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

      // On failure -> immediate revisePlans (no gate) — NPC only
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

    // WorldFeature onBucketEnd hooks (includes impact gate, may inject new nodes)
    let allPlayerEvents: Array<{ event: CharacterAction; impact: number }> = [];
    for (const feature of registry.getAllFeatures()) {
      const result = await feature.onBucketEnd(bucketActions, dgsm, bucketTime, tickRuntime);
      if (result.newNodes?.length) {
        for (const newNode of result.newNodes) {
          const newBucket = minutesToBucket(timeToMinutes(newNode.gameTime));
          if (!buckets.has(newBucket)) {
            buckets.set(newBucket, []);
            const insertIdx = sortedBucketKeys.findIndex(k => k > newBucket);
            if (insertIdx === -1) sortedBucketKeys.push(newBucket);
            else sortedBucketKeys.splice(insertIdx, 0, newBucket);
          }
          buckets.get(newBucket)!.push(newNode);
        }
      }
      if (result.playerEvents?.length) {
        allPlayerEvents = allPlayerEvents.concat(result.playerEvents);
      }
    }

    // Player witness: interrupt tick execution so player can decide
    if (allPlayerEvents.length > 0) {
      const playerWitnessEvents: PlayerWitnessEvent[] = allPlayerEvents.map((e) => ({
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

  // Fire onTickEnd for all registered WorldFeatures
  for (const feature of registry.getAllFeatures()) {
    feature.onTickEnd?.(allActions, dgsm, tickRuntime);
  }

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
  language: string = "en",
  registry: GameEngineRegistry,
  ctx: ExecutionContext
): Promise<TickResult> {
  const state = dgsm.getState();
  const gameDay = state.gameDay;
  const allActions: CharacterAction[] = [...previousActions];
  const playerCharacterIds = new Set(playerNodes.map((n) => n.characterId));
  let playerFailed = false;

  // Build runtime context for WorldFeature hooks
  const tickRuntime: TickRuntimeContext = {
    sessionId, gameDay, language,
    npcPlanning: npcPlanningAgent,
  };

  // Rebuild buckets map
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

      // Dispatch to registry handler
      const handler = registry.getHandler(node.type);
      if (!handler) {
        console.warn(`[TickProcessor] No handler for node type: ${node.type}, skipping`);
        continue;
      }
      const action = handler.execute(node, dgsm, ctx);
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
          embedDiscoveredClues(clues, dgsm, language as "en" | "zh");
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

      // Fumble -> damage a random undiscovered scene clue
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

    // WorldFeature onBucketEnd hooks (includes impact gate, may inject new nodes)
    let allPlayerEvents: Array<{ event: CharacterAction; impact: number }> = [];
    for (const feature of registry.getAllFeatures()) {
      const result = await feature.onBucketEnd(bucketActions, dgsm, bucketTime, tickRuntime);
      if (result.newNodes?.length) {
        for (const newNode of result.newNodes) {
          const newBucket = minutesToBucket(timeToMinutes(newNode.gameTime));
          if (!buckets.has(newBucket)) {
            buckets.set(newBucket, []);
            const insertIdx = sortedBucketKeys.findIndex(k => k > newBucket);
            if (insertIdx === -1) sortedBucketKeys.push(newBucket);
            else sortedBucketKeys.splice(insertIdx, 0, newBucket);
          }
          buckets.get(newBucket)!.push(newNode);
        }
      }
      if (result.playerEvents?.length) {
        allPlayerEvents = allPlayerEvents.concat(result.playerEvents);
      }
    }

    // Player interrupt again if needed
    if (allPlayerEvents.length > 0) {
      const playerWitnessEvents: PlayerWitnessEvent[] = allPlayerEvents.map((e) => ({
        characterName: e.event.characterName, action: e.event.action, outcome: e.event.outcome,
        location: e.event.location, gameTime: e.event.gameTime, impact: e.impact,
      }));
      const existingWitness = (dgsm.getContextualData("playerWitnessEvents") as any[]) ?? [];
      dgsm.setContextualData("playerWitnessEvents", [...existingWitness, ...playerWitnessEvents]);

      const currentIdx = sortedBucketKeys.indexOf(bucketKey);
      const nextBuckets = sortedBucketKeys.slice(currentIdx + 1).map((k) => ({ bucketKey: k, nodes: buckets.get(k)! }));

      return { type: "player_interrupt", actions: allActions, witnessEvents: playerWitnessEvents, remainingBuckets: nextBuckets, gameDay };
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
