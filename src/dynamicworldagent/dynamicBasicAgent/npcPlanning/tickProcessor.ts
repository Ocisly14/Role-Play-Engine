import { EmbeddingClient } from "../../../rag/embedding.js";
import { ModelProviderName } from "../../../models/types.js";
import { generateText, ModelClass } from "../../../models/index.js";
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
import { findAffectedCharacters } from "../../engine/shared/impactPropagation.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";

// ==================== Time helpers ====================

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

function minutesToTimeLabel(minutes: number): string {
  const clamped = Math.min(minutes, 1439);
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

const TICK_DURATION_MINUTES = 5;

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

// ==================== Single tick execution ====================

interface SingleTickParams {
  tickStartMinutes: number;
  tickDurationMinutes: number;
  playerNodes: PlanNode[];
  dgsm: DynamicGameStateManager;
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  moduleId: string;
  language: string;
  registry: GameEngineRegistry;
  ctx: ExecutionContext;
  memoryManager?: NpcMemoryManager;
}

interface SingleTickResult {
  actions: CharacterAction[];
  playerFailed: boolean;
  playerEvents: PlayerWitnessEvent[];
  injectedNodes: PlanNode[];
}

/**
 * Execute a single 5-minute tick.
 *
 * 1. Fetch NPC nodes due in [tickStart, tickEnd)
 * 2. Filter player nodes in range
 * 3. Merge, sort (gameTime ASC, DEX DESC), scan encounters
 * 4. Execute all nodes via registry handlers
 * 5. Post-execution: relationship update, NPC memory, clue discovery, fumble damage, scene events, NPC failure revisePlans
 * 6. Built-in impact propagation (scan impact>0 actions, notify affected NPCs, LLM gate, plan revision)
 * 7. Feature temporal tick — each feature updates its time/state-driven logic
 * 8. Detect feature overlay fields on executed nodes → register propagation sources
 * 9. Drive feature propagation on schedule
 * 10. Return tick result
 */
async function executeSingleTick(params: SingleTickParams): Promise<SingleTickResult> {
  const {
    tickStartMinutes,
    tickDurationMinutes,
    playerNodes,
    dgsm,
    npcPlanningAgent,
    sessionId,
    moduleId,
    language,
    registry,
    ctx,
    memoryManager,
  } = params;

  const state = dgsm.getState();
  const gameDay = state.gameDay;
  const tickEndMinutes = tickStartMinutes + tickDurationMinutes - 1; // inclusive end
  const tickStartTime = minutesToTimeLabel(tickStartMinutes);
  const tickEndTime = minutesToTimeLabel(tickEndMinutes);
  const isFullTick = tickDurationMinutes >= TICK_DURATION_MINUTES;

  // Build runtime context for WorldFeature hooks
  const tickRuntime: TickRuntimeContext = {
    sessionId,
    gameDay,
    language,
    tickTime: tickStartTime,
    tickDurationMinutes,
    npcPlanning: npcPlanningAgent,
  };

  // 0. Ensure NPCs have detailed nodes available (two-tier planning refill)
  const allNpcIds = state.npcCharacters.map((n) => n.id);
  await Promise.all(
    allNpcIds.map((npcId) =>
      npcPlanningAgent.ensureNpcNodesAvailable(
        dgsm, sessionId, npcId, gameDay, tickStartTime, language, registry
      )
    )
  );

  // 1. Get NPC nodes due up to end of this tick
  const dueNpcNodes = await npcPlanningAgent.getDueNpcNodes(sessionId, gameDay, tickEndTime, dgsm);

  // Filter to nodes >= tickStartTime
  const npcNodesInRange = dueNpcNodes.filter((n) => n.gameTime >= tickStartTime);

  // 2. Filter player nodes in this tick's time range
  const playerNodesInRange = playerNodes.filter((n) => {
    const nodeMinutes = timeToMinutes(n.gameTime);
    return nodeMinutes >= tickStartMinutes && nodeMinutes <= tickEndMinutes;
  });

  // 3. Merge, sort by gameTime ASC then DEX DESC
  const allNodes: PlanNode[] = [...npcNodesInRange, ...playerNodesInRange];

  allNodes.sort((a, b) => {
    const timeDiff = a.gameTime.localeCompare(b.gameTime);
    if (timeDiff !== 0) return timeDiff;
    const npcA = state.npcCharacters.find((n) => n.id === a.characterId);
    const npcB = state.npcCharacters.find((n) => n.id === b.characterId);
    const dexA = npcA?.attributes?.DEX ?? 50;
    const dexB = npcB?.attributes?.DEX ?? 50;
    return dexB - dexA;
  });

  // Scan unplanned encounters (same-scene NPC pairs with |score| >= 60)
  scanUnplannedEncounters(allNodes, dgsm);

  // 4. Execute all nodes
  const tickActions: CharacterAction[] = [];
  let playerFailed = false;

  for (const node of allNodes) {
    // If player already failed, skip subsequent player nodes
    if (playerFailed && node.isPlayer) {
      continue;
    }

    // Dispatch to registry handler
    const handler = registry.getHandler(node.type);
    if (!handler) {
      console.warn(`[TickProcessor] No handler for node type: ${node.type}, skipping`);
      continue;
    }
    const action = handler.execute(node, dgsm, ctx);
    tickActions.push(action);

    // Check if a player node just failed
    if (action.status === "failed" && node.isPlayer) {
      playerFailed = true;
      // Continue executing remaining NPC nodes (skip logic above handles player nodes)
    }

    // 5. Post-execution processing

    // On character_interaction success -> update relationship
    let relationshipChange: string | undefined;
    if (action.status === "completed" && node.type === "character_interaction" && node.targetCharacterId) {
      const relResult = await npcPlanningAgent.updateRelationshipViaLLM(dgsm, node.characterId, node.targetCharacterId, action.outcome, language);
      if (relResult) {
        const sign = relResult.scoreDelta >= 0 ? "+" : "";
        relationshipChange = `[relationship ${sign}${relResult.scoreDelta} → ${relResult.newScore}, ${relResult.note}]`;

        // Write relationship memory via NpcMemoryManager
        if (memoryManager) {
          const targetChar = state.npcCharacters.find((n) => n.id === node.targetCharacterId);
          const targetName = targetChar?.name ?? (state.playerCharacter?.id === node.targetCharacterId ? state.playerCharacter.name : node.targetCharacterId ?? "");
          await memoryManager.add({
            npcId: node.characterId,
            sessionId,
            moduleId,
            type: "relationship",
            content: relResult.note,
            gameDay,
            gameTime: action.gameTime,
            location: action.location,
            metadata: {
              targetId: node.targetCharacterId ?? "",
              targetName,
              scoreDelta: relResult.scoreDelta,
              newScore: relResult.newScore,
            },
          });
        }
      }
    }

    // Log NPC actions (not player)
    if (!node.isPlayer) {
      let logEntry = `Day${gameDay} ${action.gameTime} [${action.location}] - ${action.outcome}`;
      if (relationshipChange) logEntry += ` ${relationshipChange}`;

      // Write event memory via NpcMemoryManager
      if (memoryManager) {
        await memoryManager.add({
          npcId: node.characterId,
          sessionId,
          moduleId,
          type: "event",
          content: logEntry,
          gameDay,
          gameTime: action.gameTime,
          location: action.location,
          metadata: { outcome: action.outcome },
        });
      }

      await npcPlanningAgent.markNodeCompleted(sessionId, node.characterId, gameDay, node.nodeId, action.outcome);
    }

    // Write conversation memory for character interactions involving the player
    if (memoryManager && action.status === "completed" && node.type === "character_interaction" && node.targetCharacterId) {
      const isPlayerInvolved = node.isPlayer || node.targetCharacterId === state.playerCharacter?.id;
      if (isPlayerInvolved) {
        const playerId = state.playerCharacter?.id ?? "";
        const playerName = state.playerCharacter?.name ?? "Player";
        // Determine who is NPC and who is player in this interaction
        const npcInConvo = node.isPlayer ? node.targetCharacterId : node.characterId;
        const playerInConvo = node.isPlayer ? node.characterId : playerId;
        const playerNameInConvo = node.isPlayer ? node.characterName : playerName;
        await memoryManager.add({
          npcId: npcInConvo,
          sessionId,
          moduleId,
          type: "conversation",
          content: `Conversation with ${playerNameInConvo}: ${action.outcome}`,
          gameDay,
          gameTime: action.gameTime,
          location: action.location,
          metadata: {
            withCharacterId: playerInConvo,
            withCharacterName: playerNameInConvo,
            topic: action.action,
          },
        });
      }
    }

    // Write clue transfer memories when a clue was successfully transferred
    if (memoryManager && action.status === "completed" && node.type === "character_interaction"
        && node.characterInteractionPayload?.transferType === "clue"
        && node.characterInteractionPayload.clueId
        && node.targetCharacterId) {
      const clueId = node.characterInteractionPayload.clueId;
      // Try to get clue text from DGSM state
      const npcClues = state.npcCharacters.find(n => n.id === node.targetCharacterId)?.clues ?? [];
      const clueObj = npcClues.find((c: any) => c.id === clueId || c.clueId === clueId);
      const clueText = clueObj?.clueText ?? clueId;
      const targetChar = state.npcCharacters.find(n => n.id === node.targetCharacterId);
      const targetName = targetChar?.name ?? node.targetCharacterId;

      // Receiver gets a clue memory
      const senderChar = state.npcCharacters.find(n => n.id === node.characterId);
      const senderName = senderChar?.name ?? node.characterId;
      await memoryManager.add({
        npcId: node.targetCharacterId,
        sessionId,
        moduleId,
        type: "clue",
        content: `Received information from ${senderName}: ${clueText}`,
        gameDay,
        gameTime: action.gameTime,
        location: action.location,
        metadata: { clueId, category: "knowledge" as const, sourceCharacterId: node.characterId, sourceCharacterName: senderName },
      });

      // Sender gets an event memory about sharing info
      await memoryManager.add({
        npcId: node.characterId,
        sessionId,
        moduleId,
        type: "event",
        content: `Shared information about "${clueText}" with ${targetName}`,
        gameDay,
        gameTime: action.gameTime,
        location: action.location,
      });
    }

    // Trigger reasoning on novel player information
    if (memoryManager && node.isPlayer && node.type === "character_interaction" && node.targetCharacterId) {
      const shouldReason = await memoryManager.shouldTriggerReasoningOnConversation(
        node.targetCharacterId,
        sessionId,
        action.outcome,
      );
      if (shouldReason) {
        const targetNpc = state.npcCharacters.find(n => n.id === node.targetCharacterId);
        const npcProfile = targetNpc?.background ?? targetNpc?.backstory ?? "";
        const generateTextFn = (prompt: string) =>
          generateText({ runtime: npcPlanningAgent.getRuntime(), context: prompt, modelClass: ModelClass.SMALL });
        await memoryManager.triggerReasoning(
          {
            npcId: node.targetCharacterId,
            sessionId,
            moduleId,
            trigger: "player_question",
            context: action.outcome,
            gameDay,
            gameTime: action.gameTime,
          },
          targetNpc?.name ?? node.targetCharacterId,
          npcProfile,
          generateTextFn,
          language,
        );
      }
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
      let failureContext: string | undefined;
      if (memoryManager) {
        failureContext = await memoryManager.getContext({
          npcId: node.characterId,
          sessionId,
          purpose: "reaction",
          query: `${action.action} failed: ${action.failureReason}`,
        });
      }
      const longTermIntent = failureContext ?? await npcPlanningAgent.getLongTermIntent(sessionId, node.characterId);
      const memoryLog = failureContext ? [failureContext] : [];
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
      // Also revise schedule if the failure was significant
      if (action.impact >= 2) {
        const triggerDesc = `Own action "${action.action}" at ${action.gameTime} failed: ${action.failureReason}`;
        await npcPlanningAgent.reviseSchedule(dgsm, sessionId, node.characterId, triggerDesc, language);
      }
    }
  }

  // 6. Built-in impact propagation
  //    Scans for actions with impact > 0, notifies affected NPCs,
  //    runs LLM impact gate, triggers plan revision if needed.
  let allPlayerEvents: PlayerWitnessEvent[] = [];
  const injectedNodes: PlanNode[] = [];

  const impactEvents = tickActions.filter((a) => a.impact > 0);
  if (impactEvents.length > 0 && isFullTick) {
    const playerId = state.playerCharacter?.id;

    // Aggregate affected characters across all impact events
    const characterEventsMap = new Map<string, Array<{ event: CharacterAction; impact: number }>>();

    for (const event of impactEvents) {
      const affected = findAffectedCharacters(event, event.impact, dgsm);
      for (const [charId, level] of affected) {
        if (!characterEventsMap.has(charId)) characterEventsMap.set(charId, []);
        const existing = characterEventsMap.get(charId)!;
        const idx = existing.findIndex((e) => e.event === event);
        if (idx >= 0) {
          if (level > existing[idx].impact) existing[idx].impact = level;
        } else {
          existing.push({ event, impact: level });
        }
      }
    }

    // Separate player events
    const playerEvents = playerId ? characterEventsMap.get(playerId) : undefined;
    if (playerId) characterEventsMap.delete(playerId);

    if (playerEvents) {
      allPlayerEvents = playerEvents.map((e) => ({
        characterName: e.event.characterName,
        action: e.event.action,
        outcome: e.event.outcome,
        location: e.event.location,
        gameTime: e.event.gameTime,
        impact: e.impact,
      }));
    }

    // NPC processing — parallel LLM calls
    if (characterEventsMap.size > 0) {
      await Promise.all(
        [...characterEventsMap.entries()].map(async ([npcId, npcEvents]) => {
          const npc = state.npcCharacters.find((n) => n.id === npcId);
          const pendingNodes = await npcPlanningAgent.getPendingNodes(sessionId, npcId, gameDay);
          const triggeringEvents = npcEvents
            .map((e) => `[impact ${e.impact}] ${e.event.characterName}: ${e.event.outcome}`)
            .join("\n");

          let reactionContext: string | undefined;
          if (memoryManager) {
            reactionContext = await memoryManager.getContext({
              npcId,
              sessionId,
              purpose: "reaction",
              query: triggeringEvents,
            });
          }
          // Use unified memory context or fall back to legacy getLongTermIntent
          const longTermIntent = reactionContext ?? await npcPlanningAgent.getLongTermIntent(sessionId, npcId);

          const result = await npcPlanningAgent.runImpactGateForNpc(
            {
              npcId,
              npcName: npc?.name ?? npcId,
              currentLocation: dgsm.getNpcLocation(npcId) ?? "unknown",
              longTermIntent,
              pendingNodesSummary: pendingNodes.map((n) => `${n.gameTime} ${n.action}`).join("; "),
              triggeringEvents,
              memoryContext: reactionContext,
            },
            tickRuntime.tickTime,
            language
          );

          const logEntry = `Day${gameDay} ${tickRuntime.tickTime} [witness] - ${result.witnessEntry}`;
          const npcLoc = dgsm.getNpcLocation(npcId) ?? "unknown";

          // Write witness memory via NpcMemoryManager
          if (memoryManager) {
            const sortedEventsForWitness = [...npcEvents].sort((a, b) => b.impact - a.impact);
            await memoryManager.add({
              npcId,
              sessionId,
              moduleId,
              type: "witness",
              content: logEntry,
              gameDay,
              gameTime: tickRuntime.tickTime,
              location: npcLoc,
              metadata: {
                sourceCharacterId: sortedEventsForWitness[0]?.event.characterId ?? "",
                sourceAction: sortedEventsForWitness[0]?.event.outcome ?? "",
                impact: sortedEventsForWitness[0]?.impact ?? 1,
              },
            });
          }

          // Write emotion memory if the impact gate returned an emotional shift
          if (result.emotionChange && memoryManager) {
            await memoryManager.add({
              npcId,
              sessionId,
              moduleId,
              type: "emotion",
              content: `Feeling ${result.emotionChange.emotionType} due to ${result.emotionChange.trigger}`,
              gameDay,
              gameTime: tickRuntime.tickTime,
              location: npcLoc ?? undefined,
              metadata: result.emotionChange,
            });
          }

          if (result.shouldRevise) {
            // Use unified memory context for revision, or empty array as fallback
            const memoryLog = reactionContext ? [reactionContext] : [];
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

            // Trigger reasoning for high-impact events
            if (memoryManager) {
              const npcForReasoning = state.npcCharacters.find((n) => n.id === npcId);
              const npcProfile = npcForReasoning?.background ?? npcForReasoning?.backstory ?? "";
              const generateTextFn = (prompt: string) =>
                generateText({ runtime: npcPlanningAgent.getRuntime(), context: prompt, modelClass: ModelClass.SMALL });
              await memoryManager.triggerReasoning(
                {
                  npcId,
                  sessionId,
                  moduleId,
                  trigger: "high_impact",
                  context: triggeringEvents,
                  gameDay,
                  gameTime: tickRuntime.tickTime,
                },
                npcForReasoning?.name ?? npcId,
                npcProfile,
                generateTextFn,
                language,
              );
            }
          }
          if (result.shouldReviseSchedule) {
            const sortedEvents = [...npcEvents].sort((a, b) => b.impact - a.impact);
            const triggerDesc = `Witnessed: ${sortedEvents[0].event.action} by ${sortedEvents[0].event.characterName} (${sortedEvents[0].event.outcome})`;
            await npcPlanningAgent.reviseSchedule(dgsm, sessionId, npcId, triggerDesc, language);
          }
        })
      );
    }
  }

  // 7. Feature temporal tick — let each feature update its time/state-driven logic
  for (const feature of registry.getAllFeatures()) {
    feature.tick?.(dgsm, tickRuntime);
  }

  // 8. Detect feature overlay fields on executed nodes → register propagation sources
  registry.detectFeatureOverlays(allNodes, dgsm);

  // 9. Drive feature propagation on schedule
  for (const feature of registry.getAllFeatures()) {
    if (!feature.propagation || !feature.propagate) continue;
    if (!registry.shouldPropagationFire(feature.id, isFullTick)) continue;

    const sources = registry.getPropagationSources(feature.id);
    if (sources.length === 0) continue;

    const nextSources: Array<{ sceneId: string; currentHop: number }> = [];

    for (const source of sources) {
      const propResult = await feature.propagate(
        source.sceneId, source.currentHop, dgsm, tickRuntime
      );

      // New scenes become sources at hop+1
      for (const newSceneId of propResult.spreadTo) {
        nextSources.push({ sceneId: newSceneId, currentHop: source.currentHop + 1 });
      }
      // Original source persists at hop+1
      nextSources.push({ sceneId: source.sceneId, currentHop: source.currentHop + 1 });

      // Collect propagation results
      if (propResult.newNodes?.length) {
        injectedNodes.push(...propResult.newNodes);
      }
      if (propResult.playerEvents?.length) {
        const witnessEvents: PlayerWitnessEvent[] = propResult.playerEvents.map((e) => ({
          characterName: e.event.characterName,
          action: e.event.action,
          outcome: e.event.outcome,
          location: e.event.location,
          gameTime: e.event.gameTime,
          impact: e.impact,
        }));
        allPlayerEvents = allPlayerEvents.concat(witnessEvents);
      }
    }

    registry.updatePropagationSources(feature.id, nextSources);
  }

  // Store witness events in contextualData for KeeperAgent
  if (allPlayerEvents.length > 0) {
    const existing = (dgsm.getContextualData("playerWitnessEvents") as any[]) ?? [];
    dgsm.setContextualData("playerWitnessEvents", [...existing, ...allPlayerEvents]);
  }

  return {
    actions: tickActions,
    playerFailed,
    playerEvents: allPlayerEvents,
    injectedNodes,
  };
}

// ==================== Main runPlayerAction ====================

/**
 * Drives N ticks in a loop for a player action. Replaces the old `runTick`.
 *
 * Calculates total minutes from the player action's timeAdvanceMinutes,
 * loops in TICK_DURATION_MINUTES increments, calls executeSingleTick for each.
 * Handles player interrupts and player failure, advances game time at the end.
 */
export async function runPlayerAction(
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
  const currentMinutes = timeToMinutes(state.timeOfDay);

  // Resolve moduleId and memoryManager once for the entire player action
  const resolvedModuleId = await npcPlanningAgent.resolveModuleId(sessionId);
  const moduleId = resolvedModuleId ?? "";
  const memoryManager = npcPlanningAgent.getMemoryManager();

  // Calculate total minutes from the player action
  const maxPlayerAdvance = playerNodes.reduce((max, n) => Math.max(max, n.timeAdvanceMinutes), 0);
  const totalMinutes = maxPlayerAdvance;

  const allActions: CharacterAction[] = [];
  let playerFailed = false;
  let minutesProcessed = 0;

  // Loop in TICK_DURATION_MINUTES increments
  while (minutesProcessed < totalMinutes) {
    const remaining = totalMinutes - minutesProcessed;
    const tickDuration = Math.min(TICK_DURATION_MINUTES, remaining);
    const tickStartMinutes = currentMinutes + minutesProcessed;

    const tickResult = await executeSingleTick({
      tickStartMinutes,
      tickDurationMinutes: tickDuration,
      playerNodes,
      dgsm,
      npcPlanningAgent,
      sessionId,
      moduleId,
      language,
      registry,
      ctx,
      memoryManager,
    });

    allActions.push(...tickResult.actions);

    // Handle player interrupt — pause so player can decide
    if (tickResult.playerEvents.length > 0) {
      const resumeFromMinutes = tickStartMinutes + tickDuration;
      const remainingMinutes = totalMinutes - (minutesProcessed + tickDuration);

      return {
        type: "player_interrupt",
        actions: allActions,
        witnessEvents: tickResult.playerEvents,
        remainingMinutes,
        resumeFromMinutes,
        gameDay,
      };
    }

    // Handle player failure — stop processing further ticks
    if (tickResult.playerFailed) {
      playerFailed = true;
      break;
    }

    minutesProcessed += tickDuration;
  }

  // Advance game time: sum timeAdvanceMinutes from all successfully executed player nodes
  const successfulPlayerAdvance = allActions
    .filter((a) => a.isPlayer && a.status === "completed")
    .reduce((sum, a) => {
      const matchingNode = playerNodes.find((n) => n.characterId === a.characterId && n.action === a.action);
      return sum + (matchingNode?.timeAdvanceMinutes ?? 0);
    }, 0);
  const timeAdvance = successfulPlayerAdvance > 0 ? successfulPlayerAdvance : maxPlayerAdvance;
  const { dayChanged } = dgsm.updateGameTime(timeAdvance);

  if (dayChanged) {
    const updatedState = dgsm.getState();
    const moduleId = await npcPlanningAgent.resolveModuleId(sessionId);
    if (moduleId) {
      await npcPlanningAgent.onNewDay(dgsm, sessionId, moduleId, updatedState.gameDay, language, registry);
    }
  }

  return { type: "completed", actions: allActions };
}

// ==================== Resume after player interrupt ====================

/**
 * Resume tick processing from where a player interrupt paused it. Replaces the old `resumeTick`.
 *
 * Similar to runPlayerAction but starts from a resumeFromMinutes offset
 * with a remainingMinutes budget.
 */
export async function resumePlayerAction(
  playerNodes: PlanNode[],
  previousActions: CharacterAction[],
  resumeFromMinutes: number,
  remainingMinutes: number,
  dgsm: DynamicGameStateManager,
  npcPlanningAgent: NPCPlanningAgent,
  sessionId: string,
  language: string = "en",
  registry: GameEngineRegistry,
  ctx: ExecutionContext
): Promise<TickResult> {
  const state = dgsm.getState();
  const gameDay = state.gameDay;

  // Resolve moduleId and memoryManager once for the entire resumed action
  const resolvedModuleId = await npcPlanningAgent.resolveModuleId(sessionId);
  const moduleId = resolvedModuleId ?? "";
  const memoryManager = npcPlanningAgent.getMemoryManager();

  const allActions: CharacterAction[] = [...previousActions];
  let playerFailed = false;
  let minutesProcessed = 0;

  // Loop in TICK_DURATION_MINUTES increments over the remaining budget
  while (minutesProcessed < remainingMinutes) {
    const remaining = remainingMinutes - minutesProcessed;
    const tickDuration = Math.min(TICK_DURATION_MINUTES, remaining);
    const tickStartMinutes = resumeFromMinutes + minutesProcessed;

    const tickResult = await executeSingleTick({
      tickStartMinutes,
      tickDurationMinutes: tickDuration,
      playerNodes,
      dgsm,
      npcPlanningAgent,
      sessionId,
      moduleId,
      language,
      registry,
      ctx,
      memoryManager,
    });

    allActions.push(...tickResult.actions);

    // Handle player interrupt — pause again
    if (tickResult.playerEvents.length > 0) {
      const newResumeFrom = tickStartMinutes + tickDuration;
      const newRemainingMinutes = remainingMinutes - (minutesProcessed + tickDuration);

      return {
        type: "player_interrupt",
        actions: allActions,
        witnessEvents: tickResult.playerEvents,
        remainingMinutes: newRemainingMinutes,
        resumeFromMinutes: newResumeFrom,
        gameDay,
      };
    }

    // Handle player failure — stop processing further ticks
    if (tickResult.playerFailed) {
      playerFailed = true;
      break;
    }

    minutesProcessed += tickDuration;
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
  const { dayChanged: dayChangedOnResume } = dgsm.updateGameTime(timeAdvance);

  if (dayChangedOnResume) {
    const updatedState = dgsm.getState();
    const moduleId = await npcPlanningAgent.resolveModuleId(sessionId);
    if (moduleId) {
      await npcPlanningAgent.onNewDay(dgsm, sessionId, moduleId, updatedState.gameDay, language, registry);
    }
  }

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
