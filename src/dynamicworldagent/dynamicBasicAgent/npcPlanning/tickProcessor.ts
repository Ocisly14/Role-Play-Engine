import { ModelClass, generateText } from "../../../models/index.js";
import { ModelProviderName } from "../../../models/types.js";
import { EmbeddingClient } from "../../../rag/embedding.js";
import { drainPendingEmotions } from "../../engine/features/sanityFeature.js";
import type { GameEngineRegistry } from "../../engine/registry.js";
import { findAffectedCharacters } from "../../engine/shared/impactPropagation.js";
import type {
  ExecutionContext,
  TickRuntimeContext,
} from "../../engine/types.js";
import type { NpcMemoryManager } from "../../memory/NpcMemoryManager.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  type SessionRagChunkInput,
  SessionRagService,
} from "../knowledge/sessionRagService.js";
import type { NPCPlanningAgent } from "./NPCPlanningAgent.js";
import type {
  CharacterAction,
  DiscoveryEntry,
  PlanNode,
  SimulationTickResult,
  SuccessLevel,
} from "./types.js";

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

// ==================== Discovery ====================

const DIFFICULTY_RANK: Record<string, number> = {
  automatic: 0,
  regular: 1,
  hard: 2,
  extreme: 3,
};

/** success level -> max difficulty rank discoverable */
const SUCCESS_TO_MAX_RANK: Record<SuccessLevel, number> = {
  critical: 3, // extreme
  hard: 2, // hard
  regular: 1, // regular
  fail: 0, // automatic only
  fumble: -1, // nothing, may damage evidence
};

/** Only these actionTypes can trigger non-automatic discovery */
const DISCOVERY_ACTION_TYPES = new Set<string>([
  "exploration",
  "social",
  "stealth",
  "narrative",
]);

const DISCOVERY_SIMILARITY_THRESHOLD = 0.7;

// Lazy embedding client singleton
let _embeddingClient: EmbeddingClient | null = null;
function getEmbeddingClient(): EmbeddingClient {
  if (!_embeddingClient) {
    const provider =
      (process.env.MODEL_PROVIDER as ModelProviderName) ||
      ModelProviderName.OPENAI;
    _embeddingClient = new EmbeddingClient(provider);
  }
  return _embeddingClient;
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

interface DiscoveryCandidate {
  id: string;
  text: string;
  difficulty: string;
  source: "evidence" | "npc";
  sourceId: string;
  sourceName: string;
}

/**
 * Discover evidence items (from scenes) after a successful action.
 * Triggered by scene_interaction / object_interaction.
 * Candidates: scene.items where category === "evidence" and !damaged.
 */
async function discoverEvidence(
  node: PlanNode,
  successLevel: SuccessLevel,
  dgsm: DynamicGameStateManager,
  language: string,
  sceneId: string
): Promise<DiscoveryEntry[]> {
  const scene = dgsm.getScene(sceneId);
  if (!scene?.items) return [];
  if (node.type !== "scene_interaction" && node.type !== "object_interaction")
    return [];

  let maxRank: number;
  if (node.actionType && DISCOVERY_ACTION_TYPES.has(node.actionType)) {
    maxRank = SUCCESS_TO_MAX_RANK[successLevel] ?? 0;
  } else {
    maxRank = 0; // automatic only
  }

  const candidates: DiscoveryCandidate[] = [];
  for (const item of scene.items) {
    if (item.category !== "evidence" || item.damaged) continue;
    const difficulty = item.discoveryMethod ? "regular" : "automatic";
    const rank = DIFFICULTY_RANK[difficulty] ?? 1;
    if (rank > maxRank) continue;
    candidates.push({
      id: item.id,
      text: item.description || item.name,
      difficulty,
      source: "evidence",
      sourceId: scene.id,
      sourceName: scene.name,
    });
  }

  return matchCandidates(candidates, node, language);
}

/**
 * Discover NPC knowledge after a successful character_interaction.
 * Queries target NPC's information and secret memories (unrevealed).
 */
async function discoverNpcKnowledge(
  node: PlanNode,
  successLevel: SuccessLevel,
  dgsm: DynamicGameStateManager,
  language: string,
  memoryManager: NpcMemoryManager
): Promise<DiscoveryEntry[]> {
  if (node.type !== "character_interaction" || !node.targetCharacterId)
    return [];

  let maxRank: number;
  if (node.actionType && DISCOVERY_ACTION_TYPES.has(node.actionType)) {
    maxRank = SUCCESS_TO_MAX_RANK[successLevel] ?? 0;
  } else {
    const rel = dgsm.getRelationship(node.characterId, node.targetCharacterId);
    const score = rel?.score ?? 0;
    if (score >= 80) maxRank = 3;
    else if (score >= 70) maxRank = 2;
    else if (score >= 60) maxRank = 1;
    else maxRank = 0;
  }

  const targetId = node.targetCharacterId;
  const state = dgsm.getState();
  const targetNpc = state.npcCharacters.find((n) => n.id === targetId);
  if (!targetNpc) return [];

  // Query target NPC's unrevealed information and secret memories
  const targetMemories = await memoryManager.query({
    npcId: targetId,
    sessionId: state.sessionId,
    query: node.action,
    filters: { types: ["information", "secret"] },
    limit: 50,
  });

  const candidates: DiscoveryCandidate[] = [];

  for (const mem of targetMemories) {
    const meta = mem.metadata as Record<string, any> | null;
    if (meta?.revealed) continue;

    const difficulty =
      (meta?.difficulty as string) ??
      (mem.type === "secret" ? "hard" : "regular");
    const rank = DIFFICULTY_RANK[difficulty] ?? 1;
    if (rank > maxRank) continue;

    candidates.push({
      id: (meta?.knowledgeId as string) ?? mem.id,
      text: mem.content,
      difficulty,
      source: "npc",
      sourceId: targetNpc.id,
      sourceName: targetNpc.name,
    });
  }

  return matchCandidates(candidates, node, language);
}

/** Mark a target NPC's knowledge/secret memory as revealed after discovery */
async function markMemoryRevealed(
  memoryManager: NpcMemoryManager,
  targetNpcId: string,
  sessionId: string,
  knowledgeIdOrMemoryId: string
): Promise<void> {
  const candidates = await memoryManager.query({
    npcId: targetNpcId,
    sessionId,
    query: "",
    filters: { types: ["information", "secret"] },
    limit: 100,
  });
  for (const mem of candidates) {
    const meta = mem.metadata as Record<string, any> | null;
    const kid = (meta?.knowledgeId as string) ?? mem.id;
    if (kid === knowledgeIdOrMemoryId) {
      await memoryManager.updateBeliefConfidence(
        mem.id,
        meta?.confidence ?? 1,
        "revealed via discovery",
        { ...meta, revealed: true }
      );
      break;
    }
  }
}

/** Common logic: split automatic vs semantic-match candidates */
async function matchCandidates(
  candidates: DiscoveryCandidate[],
  node: PlanNode,
  language: string
): Promise<DiscoveryEntry[]> {
  if (candidates.length === 0) return [];

  const automaticResults: DiscoveryEntry[] = [];
  const semanticCandidates: DiscoveryCandidate[] = [];

  for (const c of candidates) {
    if (c.difficulty === "automatic") {
      automaticResults.push({
        id: c.id,
        text: c.text,
        source: c.source,
        sourceId: c.sourceId,
        sourceName: c.sourceName,
        difficulty: "automatic",
        similarity: 1.0,
      });
    } else {
      semanticCandidates.push(c);
    }
  }

  if (semanticCandidates.length === 0) return automaticResults;

  try {
    const embedClient = getEmbeddingClient();
    const lang = (language?.startsWith("zh") ? "zh" : "en") as "zh" | "en";
    const actionEmbedding = await embedClient.embed(node.action, {
      language: lang,
    });
    if (!actionEmbedding.length) return automaticResults;

    semanticCandidates.sort(
      (a, b) =>
        (DIFFICULTY_RANK[b.difficulty] ?? 0) -
        (DIFFICULTY_RANK[a.difficulty] ?? 0)
    );

    const matched: DiscoveryEntry[] = [];
    for (const c of semanticCandidates) {
      const cEmbedding = await embedClient.embed(c.text, { language: lang });
      if (!cEmbedding.length) continue;

      const sim = cosineSimilarity(actionEmbedding, cEmbedding);
      if (sim >= DISCOVERY_SIMILARITY_THRESHOLD) {
        matched.push({
          id: c.id,
          text: c.text,
          source: c.source,
          sourceId: c.sourceId,
          sourceName: c.sourceName,
          difficulty: c.difficulty as DiscoveryEntry["difficulty"],
          similarity: sim,
        });
      }
    }

    matched.sort((a, b) => {
      const diffDelta =
        (DIFFICULTY_RANK[b.difficulty] ?? 0) -
        (DIFFICULTY_RANK[a.difficulty] ?? 0);
      if (diffDelta !== 0) return diffDelta;
      return b.similarity - a.similarity;
    });

    return [...automaticResults, ...matched];
  } catch (error) {
    console.warn("[TickProcessor] Discovery embedding failed:", error);
    return automaticResults;
  }
}

// ==================== Discovery RAG embedding ====================

function embedDiscoveries(
  discoveries: DiscoveryEntry[],
  dgsm: DynamicGameStateManager,
  language: "en" | "zh"
): void {
  if (discoveries.length === 0) return;
  const ragService = new SessionRagService();
  const state = dgsm.getState();
  const ragChunks: SessionRagChunkInput[] = discoveries.map((entry) => ({
    sessionId: state.sessionId,
    chunkType: "discovery" as const,
    role: "system" as const,
    content: [
      "Discovery",
      `Type: ${entry.source}`,
      `Source: ${entry.sourceName}`,
      `Content: ${entry.text}`,
    ].join("\n"),
    metadata: {
      discoveryType: entry.source,
      sourceName: entry.sourceName,
      discoveredAt: `Day ${state.gameDay}, ${state.timeOfDay}`,
    },
    sourceKey: `discovery:${entry.id}`,
    language,
  }));
  void ragService
    .upsertChunks(ragChunks)
    .catch((err) =>
      console.error("[TickProcessor] Failed to embed discovery:", err)
    );
}

// ==================== Single tick execution ====================

interface SingleTickParams {
  tickStartMinutes: number;
  tickDurationMinutes: number;
  /** Nodes injected by previous ticks' feature propagation, to be executed in this tick */
  carryOverNodes?: PlanNode[];
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
  injectedNodes: PlanNode[];
}

/**
 * Execute a single 5-minute simulation tick.
 *
 * 1. Fetch NPC nodes due in [tickStart, tickEnd)
 * 2. Merge with carry-over nodes, sort (gameTime ASC, DEX DESC), scan encounters
 * 3. Execute all nodes via registry handlers
 * 4. Post-execution: relationship update, NPC memory, discovery, NPC failure revisePlans
 * 5. Built-in impact propagation (scan impact>0 actions, notify affected NPCs, LLM gate, plan revision)
 * 6. Feature temporal tick — each feature updates its time/state-driven logic
 * 7. Detect feature overlay fields on executed nodes → register propagation sources
 * 8. Drive feature propagation on schedule
 * 9. Return tick result
 */
async function executeSingleTick(
  params: SingleTickParams
): Promise<SingleTickResult> {
  const {
    tickStartMinutes,
    tickDurationMinutes,
    carryOverNodes,
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
        dgsm,
        sessionId,
        npcId,
        gameDay,
        tickStartTime,
        language,
        registry
      )
    )
  );

  // 1. Get NPC nodes due up to end of this tick
  const dueNpcNodes = await npcPlanningAgent.getDueNpcNodes(
    sessionId,
    gameDay,
    tickEndTime,
    dgsm
  );

  // Filter to nodes >= tickStartTime
  const npcNodesInRange = dueNpcNodes.filter(
    (n) => n.gameTime >= tickStartTime
  );

  // 2. Merge (including carry-over nodes from previous tick's feature propagation)
  const allNodes: PlanNode[] = [...npcNodesInRange, ...(carryOverNodes ?? [])];

  // Sort by gameTime ASC then DEX DESC
  allNodes.sort((a, b) => {
    const timeDiff = a.gameTime.localeCompare(b.gameTime);
    if (timeDiff !== 0) return timeDiff;
    const npcA = state.npcCharacters.find((n) => n.id === a.characterId);
    const npcB = state.npcCharacters.find((n) => n.id === b.characterId);
    const dexA = npcA?.attributes?.DEX ?? 50;
    const dexB = npcB?.attributes?.DEX ?? 50;
    return dexB - dexA;
  });

  // 3. Execute all nodes
  const tickActions: CharacterAction[] = [];

  for (const node of allNodes) {
    // Dispatch to registry handler
    const handler = registry.getHandler(node.type);
    if (!handler) {
      console.warn(
        `[TickProcessor] No handler for node type: ${node.type}, skipping`
      );
      continue;
    }
    const action = handler.execute(node, dgsm, ctx);
    tickActions.push(action);

    // 4. Post-execution processing

    // On character_interaction success -> update relationship
    let relationshipChange: string | undefined;
    let relResult:
      | { scoreDelta: number; newScore: number; note: string }
      | null
      | undefined;
    if (
      action.status === "completed" &&
      node.type === "character_interaction" &&
      node.targetCharacterId
    ) {
      relResult = await npcPlanningAgent.updateRelationshipViaLLM(
        dgsm,
        node.characterId,
        node.targetCharacterId,
        action.outcome,
        language
      );
      if (relResult) {
        const sign = relResult.scoreDelta >= 0 ? "+" : "";
        relationshipChange = `[relationship ${sign}${relResult.scoreDelta} → ${relResult.newScore}, ${relResult.note}]`;
      }
    }

    // Mirror write: passive NPC gets event memory of this interaction
    if (
      memoryManager &&
      action.status === "completed" &&
      node.type === "character_interaction" &&
      node.targetCharacterId
    ) {
      const targetId = node.targetCharacterId;
      const initiatorName = node.characterName;

      await memoryManager.add({
        npcId: targetId,
        sessionId,
        moduleId,
        type: "event",
        content: `${initiatorName} ${action.action} — result: ${action.outcome}`,
        gameDay,
        gameTime: action.gameTime,
        location: action.location,
        metadata: { outcome: action.outcome },
      });
    }

    // Log NPC actions and mark completed
    {
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

      await npcPlanningAgent.markNodeCompleted(
        sessionId,
        node.characterId,
        gameDay,
        node.nodeId,
        action.outcome
      );
    }

    // Knowledge transfer: write information memory to target NPC
    if (
      memoryManager &&
      action.status === "completed" &&
      node.type === "character_interaction" &&
      node.characterInteractionPayload?.transferType === "information" &&
      node.characterInteractionPayload.informationContent
    ) {
      const payload = node.characterInteractionPayload;
      const informationContent = payload.informationContent!;
      const targets =
        payload.targetCharacterIds ??
        (node.targetCharacterId ? [node.targetCharacterId] : []);
      const filteredTargets = targets.filter((id) => id !== node.characterId);

      const senderChar = state.npcCharacters.find(
        (n) => n.id === node.characterId
      );
      const senderName = senderChar?.name ?? node.characterName;

      // Filter to targets actually present at the same location
      const presentTargets = filteredTargets.filter((id) => {
        const loc = dgsm.getNpcLocation(id);
        return loc === node.location;
      });

      // Use source knowledgeId if available, otherwise generate one
      const sourceKnowledgeId =
        payload.relatedKnowledgeIds?.[0] ?? `transfer_${node.nodeId}`;

      for (const targetId of presentTargets) {
        await memoryManager.add({
          npcId: targetId,
          sessionId,
          moduleId,
          type: "information",
          content: `${senderName} told me: ${informationContent}`,
          gameDay,
          gameTime: action.gameTime,
          location: action.location,
          metadata: {
            knowledgeId: sourceKnowledgeId,
            difficulty: "automatic",
          },
        });
      }

      // Sender event memory (recording the act of sharing)
      const targetNames = presentTargets
        .map((id) => {
          const npc = state.npcCharacters.find((n) => n.id === id);
          return npc?.name ?? id;
        })
        .join(", ");
      if (targetNames) {
        await memoryManager.add({
          npcId: node.characterId,
          sessionId,
          moduleId,
          type: "event",
          content: `Shared information with ${targetNames}: ${informationContent}`,
          gameDay,
          gameTime: action.gameTime,
          location: action.location,
          metadata: { outcome: action.outcome },
        });
      }
    }

    // Discovery — NPC discovers evidence/knowledge on successful actions
    if (action.status === "completed") {
      const effectiveSuccess: SuccessLevel = action.successLevel ?? "regular";
      const evidenceSceneId = node.location;
      // Discover evidence items from scene
      const evidence = await discoverEvidence(
        node,
        effectiveSuccess,
        dgsm,
        language,
        evidenceSceneId
      );
      // Discover NPC knowledge
      const npcKnowledge = memoryManager
        ? await discoverNpcKnowledge(
            node,
            effectiveSuccess,
            dgsm,
            language,
            memoryManager
          )
        : [];
      const allDiscoveries = [...evidence, ...npcKnowledge];

      if (allDiscoveries.length > 0) {
        action.discoveries = allDiscoveries;
        embedDiscoveries(allDiscoveries, dgsm, language as "en" | "zh");
        for (const entry of allDiscoveries) {
          if (entry.source === "npc" && memoryManager) {
            await markMemoryRevealed(
              memoryManager,
              entry.sourceId,
              sessionId,
              entry.id
            );
          }
        }
        console.log(
          `[TickProcessor] NPC discovered ${allDiscoveries.length} item(s): ${allDiscoveries.map((d) => `[${d.difficulty}] ${d.text.slice(0, 40)}`).join("; ")}`
        );
      }
    }

    // Fumble -> damage a random evidence item in the NPC's current scene
    if (action.successLevel === "fumble") {
      const scene = dgsm.getScene(node.location);
      const damageable =
        scene?.items?.filter((i) => i.category === "evidence" && !i.damaged) ??
        [];
      if (damageable.length > 0) {
        const victim =
          damageable[Math.floor(Math.random() * damageable.length)];
        dgsm.damageEvidenceItem(
          victim.id,
          node.characterName,
          `Fumbled: ${node.action}`,
          node.location
        );
        action.damagedEvidence = { itemId: victim.id, sourceName: scene!.name };
        console.log(
          `[TickProcessor] Fumble damaged evidence: ${(victim.description || victim.name).slice(0, 40)}`
        );
      }
    }

    // On failure -> immediate revisePlans (no gate)
    if (action.status === "failed") {
      let failureContext: string | undefined;
      if (memoryManager) {
        failureContext = await memoryManager.getContext({
          npcId: node.characterId,
          sessionId,
          purpose: "reaction",
          query: `${action.action} failed: ${action.failureReason}`,
          currentGameDay: gameDay,
        });
      }
      const longTermIntent =
        failureContext ??
        (await npcPlanningAgent.getLongTermIntent(sessionId, node.characterId));
      const memoryLog = failureContext ? [failureContext] : [];
      const pendingNodes = await npcPlanningAgent.getPendingNodes(
        sessionId,
        node.characterId,
        gameDay
      );
      await npcPlanningAgent.revisePlans(
        dgsm,
        sessionId,
        node.characterId,
        {
          longTermIntent,
          memoryLog,
          pendingNodes,
          trigger: {
            type: "failure",
            failureReason: action.failureReason!,
            action: action.action,
            gameTime: action.gameTime,
          },
        },
        language,
        registry
      );
    }
  }

  // 4.5 Scan NPC co-presence → write witness memories + build synthetic encounter events
  const encounterEvents = scanUnplannedEncounters(
    dgsm,
    tickStartTime,
    tickActions,
    memoryManager,
    sessionId,
    moduleId,
    gameDay
  );

  // 5. Built-in impact propagation
  //    Scans for actions with impact > 0, notifies affected NPCs,
  //    runs LLM impact gate, triggers plan revision if needed.
  const injectedNodes: PlanNode[] = [];

  const impactEvents = [
    ...tickActions.filter((a) => a.impact > 0),
    ...encounterEvents,
  ];
  if (impactEvents.length > 0) {
    // Aggregate affected characters across all impact events
    const characterEventsMap = new Map<
      string,
      Array<{ event: CharacterAction; impact: number }>
    >();

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

    // NPC processing — parallel LLM calls
    if (characterEventsMap.size > 0) {
      await Promise.all(
        [...characterEventsMap.entries()].map(async ([npcId, npcEvents]) => {
          const npc = state.npcCharacters.find((n) => n.id === npcId);
          const pendingNodes = await npcPlanningAgent.getPendingNodes(
            sessionId,
            npcId,
            gameDay
          );
          const plan = await npcPlanningAgent.getDailyPlan(
            sessionId,
            npcId,
            gameDay
          );
          const schedule =
            (plan?.schedule as unknown as import(
              "./types.js"
            ).ScheduleEntry[]) ?? [];
          const triggeringEvents = npcEvents
            .map(
              (e) =>
                `[impact ${e.impact}] ${e.event.characterName}: ${e.event.outcome}`
            )
            .join("\n");

          let reactionContext: string | undefined;
          if (memoryManager) {
            reactionContext = await memoryManager.getContext({
              npcId,
              sessionId,
              purpose: "reaction",
              query: triggeringEvents,
              currentGameDay: gameDay,
            });
          }
          // Use unified memory context or fall back to legacy getLongTermIntent
          const longTermIntent =
            reactionContext ??
            (await npcPlanningAgent.getLongTermIntent(sessionId, npcId));

          const result = await npcPlanningAgent.runImpactGateForNpc(
            {
              npcId,
              npcName: npc?.name ?? npcId,
              currentLocation: dgsm.getNpcLocation(npcId) ?? "unknown",
              longTermIntent,
              todayScheduleSummary: schedule
                .map((s) => `${s.location}: ${s.activity}`)
                .join("; "),
              currentDetailedPlan: pendingNodes
                .map((n) => `${n.gameTime} ${n.action}`)
                .join("; "),
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
            const sortedEventsForWitness = [...npcEvents].sort(
              (a, b) => b.impact - a.impact
            );
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
                sourceCharacterId:
                  sortedEventsForWitness[0]?.event.characterId ?? "",
                sourceAction: sortedEventsForWitness[0]?.event.outcome ?? "",
                impact: sortedEventsForWitness[0]?.impact ?? 1,
              },
            });
          }

          if (result.shouldRevise) {
            // Use unified memory context for revision, or empty array as fallback
            const memoryLog = reactionContext ? [reactionContext] : [];
            const sortedEvents = [...npcEvents].sort(
              (a, b) => b.impact - a.impact
            );
            await npcPlanningAgent.revisePlans(
              dgsm,
              sessionId,
              npcId,
              {
                longTermIntent,
                memoryLog,
                pendingNodes,
                trigger: {
                  type: "impact",
                  triggeringAction: sortedEvents[0].event,
                },
              },
              language,
              registry
            );

            // Trigger reasoning for high-impact events
            if (memoryManager) {
              const npcForReasoning = state.npcCharacters.find(
                (n) => n.id === npcId
              );
              const npcProfile =
                npcForReasoning?.background ?? npcForReasoning?.backstory ?? "";
              const generateTextFn = (prompt: string) =>
                generateText({
                  runtime: npcPlanningAgent.getRuntime(),
                  context: prompt,
                  modelClass: ModelClass.SMALL,
                });
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
                language
              );
            }
          }
          if (result.shouldReviseSchedule) {
            const sortedEvents = [...npcEvents].sort(
              (a, b) => b.impact - a.impact
            );
            const triggerDesc = `Witnessed: ${sortedEvents[0].event.action} by ${sortedEvents[0].event.characterName} (${sortedEvents[0].event.outcome})`;
            await npcPlanningAgent.reviseSchedule(
              dgsm,
              sessionId,
              npcId,
              triggerDesc,
              language,
              registry
            );
          }
        })
      );
    }
  }

  // 6. Feature temporal tick — let each feature update its time/state-driven logic
  for (const feature of registry.getAllFeatures()) {
    feature.tick?.(dgsm, tickRuntime);
  }

  // 7. Detect feature overlay fields on executed nodes → register propagation sources
  registry.detectFeatureOverlays(allNodes, dgsm);

  // 8. Drive feature propagation on schedule
  for (const feature of registry.getAllFeatures()) {
    if (!feature.propagation || !feature.propagate) continue;
    if (!registry.shouldPropagationFire(feature.id, isFullTick)) continue;

    const sources = registry.getPropagationSources(feature.id);
    if (sources.length === 0) continue;

    const nextSources: Array<{ sceneId: string; currentHop: number }> = [];

    for (const source of sources) {
      const propResult = await feature.propagate(
        source.sceneId,
        source.currentHop,
        dgsm,
        tickRuntime
      );

      // New scenes become sources at hop+1
      for (const newSceneId of propResult.spreadTo) {
        nextSources.push({
          sceneId: newSceneId,
          currentHop: source.currentHop + 1,
        });
      }
      // Original source persists at hop+1
      nextSources.push({
        sceneId: source.sceneId,
        currentHop: source.currentHop + 1,
      });

      // Collect propagation-injected nodes
      if (propResult.newNodes?.length) {
        injectedNodes.push(...propResult.newNodes);
      }
    }

    registry.updatePropagationSources(feature.id, nextSources);
  }

  // Drain sanity-triggered emotions (clear from pending queue; no longer persisted as memory)
  drainPendingEmotions(dgsm);

  return {
    actions: tickActions,
    injectedNodes,
  };
}

// ==================== Unplanned encounters (signal-only) ====================

/**
 * Detect NPC co-presence per scene after node execution.
 * Writes a lightweight witness memory per NPC and returns synthetic
 * impact-2 CharacterActions (one per scene) for the gate pipeline.
 */
function scanUnplannedEncounters(
  dgsm: DynamicGameStateManager,
  tickTime: string,
  tickActions: CharacterAction[],
  memoryManager: NpcMemoryManager | undefined,
  sessionId: string,
  moduleId: string,
  gameDay: number
): CharacterAction[] {
  const state = dgsm.getState();

  // Group NPCs by location
  const locationGroups = new Map<string, string[]>();
  for (const npc of state.npcCharacters) {
    const loc = dgsm.getNpcLocation(npc.id);
    if (!loc) continue;
    if (!locationGroups.has(loc)) locationGroups.set(loc, []);
    locationGroups.get(loc)!.push(npc.id);
  }

  // Build dedup set from already-executed character_interaction actions
  const interactedPairs = new Set<string>();
  for (const action of tickActions) {
    if (action.type === "character_interaction" && action.targetCharacterId) {
      const pairKey = [action.characterId, action.targetCharacterId]
        .sort()
        .join("_");
      interactedPairs.add(pairKey);
    }
  }

  const encounterEvents: CharacterAction[] = [];

  for (const [sceneId, npcIds] of locationGroups) {
    if (npcIds.length < 2) continue;

    // Filter out NPC pairs that already interacted this tick
    // For each NPC, collect others they haven't interacted with
    const npcEncounterMap = new Map<string, string[]>(); // npcId -> other NPC ids to notice
    for (let i = 0; i < npcIds.length; i++) {
      for (let j = i + 1; j < npcIds.length; j++) {
        const pairKey = [npcIds[i], npcIds[j]].sort().join("_");
        if (interactedPairs.has(pairKey)) continue;
        // Both NPCs notice each other
        if (!npcEncounterMap.has(npcIds[i])) npcEncounterMap.set(npcIds[i], []);
        if (!npcEncounterMap.has(npcIds[j])) npcEncounterMap.set(npcIds[j], []);
        npcEncounterMap.get(npcIds[i])!.push(npcIds[j]);
        npcEncounterMap.get(npcIds[j])!.push(npcIds[i]);
      }
    }

    if (npcEncounterMap.size === 0) continue;

    const sceneName = dgsm.getScene(sceneId)?.name ?? sceneId;

    // Write witness memory per NPC
    if (memoryManager) {
      for (const [npcId, otherIds] of npcEncounterMap) {
        const otherNames = otherIds.map((id) => {
          const npc = state.npcCharacters.find((n) => n.id === id);
          return npc?.name ?? id;
        });
        // Fire-and-forget; consistent with existing memory write pattern
        void memoryManager.add({
          npcId,
          sessionId,
          moduleId,
          type: "witness",
          content: `Day${gameDay} ${tickTime} [${sceneName}] - Saw ${otherNames.join(", ")} here`,
          gameDay,
          gameTime: tickTime,
          location: sceneId,
          metadata: {
            sourceCharacterId: "__encounter__",
            sourceAction: "co-presence",
            impact: 2,
          },
        });
      }
    }

    // Build one synthetic event per scene
    const allNpcNames = [...npcEncounterMap.keys()].map((id) => {
      const npc = state.npcCharacters.find((n) => n.id === id);
      return npc?.name ?? id;
    });

    encounterEvents.push({
      characterId: "__encounter__",
      characterName: "Co-presence",
      gameTime: tickTime,
      action: `NPCs present together at ${sceneName}`,
      location: sceneId,
      type: "character_interaction",
      impact: 2 as const,
      status: "completed",
      outcome: `${allNpcNames.join(", ")} are at ${sceneName}`,
    });
  }

  return encounterEvents;
}

// ==================== Simulation tick ====================

/**
 * Execute a single simulation tick (no player involved).
 *
 * Wraps executeSingleTick and advances game time
 * by TICK_DURATION_MINUTES afterwards.
 */
export async function runSimulationTick(params: {
  dgsm: DynamicGameStateManager;
  npcPlanningAgent: NPCPlanningAgent;
  sessionId: string;
  moduleId: string;
  language: string;
  registry: GameEngineRegistry;
  ctx: ExecutionContext;
  memoryManager?: NpcMemoryManager;
}): Promise<SimulationTickResult> {
  const state = params.dgsm.getState();
  const tickStartMinutes =
    Number.parseInt(state.timeOfDay.split(":")[0]) * 60 +
    Number.parseInt(state.timeOfDay.split(":")[1]);

  const result = await executeSingleTick({
    tickStartMinutes,
    tickDurationMinutes: TICK_DURATION_MINUTES,
    ...params,
  });

  const { dayChanged } = params.dgsm.updateGameTime(TICK_DURATION_MINUTES);

  return {
    actions: result.actions,
    events: [], // Events will be constructed by SimulationEventEmitter from actions
    dayChanged,
  };
}
