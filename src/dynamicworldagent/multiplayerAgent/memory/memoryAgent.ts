import {
  GameHistoryRag,
  type RelevantHistoryItem as LegacyRelevantHistoryItem,
} from "../../../rag/gameHistoryRag.js";
import { getPrismaClient } from "../../../shared/agents/memory/database/prismaClient.js";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../../shared/agents/memory/database/index.js";
import { actionRules } from "../../../shared/rules/index.js";
import type {
  ActionAnalysis,
  ActionType,
} from "../../../shared/state/index.js";
/**
 * Memory Agent helpers
 * This module owns state-side helpers for memory workflows.
 */
import type { MultiplayerDynamicGameStateManager } from "../../multiplayerState/MultiplayerDynamicGameState.js";
import { getAncestorSceneRoomIds } from "../../multiplayerState/ancestorChain.js";
import { RagQueryRewriter } from "../knowledge/ragQueryRewriter.js";
import {
  type RetrievedSessionRagChunk,
  SessionRagService,
} from "../knowledge/sessionRagService.js";

// ── Trigger Evidence Types & Retrieval (used by Director) ──

type TriggerQueryType = "global_event" | "victory_condition";

export interface TriggerEvidenceItem {
  sourceKey: string;
  turnNumber: number | null;
  segmentType: "narrative";
  score: number;
  content: string;
  sceneName: string | null;
  matchedBy: Array<{ queryType: TriggerQueryType; query: string }>;
}

const TRIGGER_RAG_MIN_SCORE = 0.7;

/**
 * Search trigger chunks in both languages (zh + en) for a given segment type.
 * Returns deduped chunks above the minimum score threshold.
 */
async function searchTriggerChunks(
  sessionId: string,
  query: string,
  segmentType: "narrative" | "actionlog",
  topK: number
): Promise<RetrievedSessionRagChunk[]> {
  const searches = await Promise.all([
    sessionRagService.searchHybrid({
      sessionId,
      ragQuery: query,
      topK,
      semanticWeight: 0.7,
      bm25Weight: 0.3,
      language: "zh",
      chunkType: "turn",
      segmentType,
      sceneRoomId: null, // Global scope — search all rooms
    }),
    sessionRagService.searchHybrid({
      sessionId,
      ragQuery: query,
      topK,
      semanticWeight: 0.7,
      bm25Weight: 0.3,
      language: "en",
      chunkType: "turn",
      segmentType,
      sceneRoomId: null,
    }),
  ]);

  const deduped = new Map<string, RetrievedSessionRagChunk>();
  for (const result of searches.flat()) {
    const key = result.sourceKey || result.id;
    const existing = deduped.get(key);
    if (!existing || result.score > existing.score) {
      deduped.set(key, result);
    }
  }

  return Array.from(deduped.values())
    .filter((item) => item.score >= TRIGGER_RAG_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

/**
 * Retrieve RAG evidence for global trigger events and victory conditions.
 * Searches ALL rooms (sceneRoomId=null) because global triggers are game-wide.
 */
export async function retrieveTriggerEvidence(params: {
  sessionId: string;
  globalEvents: string[];
  victoryConditions: string[];
}): Promise<TriggerEvidenceItem[]> {
  const { sessionId, globalEvents, victoryConditions } = params;
  const evidenceMap = new Map<string, TriggerEvidenceItem>();

  const queryDefs: Array<{ queryType: TriggerQueryType; query: string }> = [
    ...globalEvents.map((query) => ({ queryType: "global_event" as const, query })),
    ...victoryConditions.map((query) => ({
      queryType: "victory_condition" as const,
      query,
    })),
  ].filter((item) => typeof item.query === "string" && item.query.trim().length > 0);

  for (const def of queryDefs) {
    const query = def.query.trim();
    const narrativeChunks = await searchTriggerChunks(sessionId, query, "narrative", 3);

    for (const chunk of narrativeChunks) {
      const key = chunk.sourceKey || chunk.id;
      const existing = evidenceMap.get(key);
      const sceneName =
        typeof chunk.metadata?.sceneName === "string"
          ? chunk.metadata.sceneName
          : null;

      if (!existing) {
        evidenceMap.set(key, {
          sourceKey: chunk.sourceKey,
          turnNumber: chunk.turnNumber,
          segmentType: "narrative",
          score: chunk.score,
          content: chunk.content,
          sceneName,
          matchedBy: [{ queryType: def.queryType, query }],
        });
        continue;
      }

      if (chunk.score > existing.score) {
        existing.score = chunk.score;
        existing.content = chunk.content;
        existing.turnNumber = chunk.turnNumber;
        if (sceneName) existing.sceneName = sceneName;
      }

      if (
        !existing.matchedBy.some(
          (m) => m.queryType === def.queryType && m.query === query
        )
      ) {
        existing.matchedBy.push({ queryType: def.queryType, query });
      }
    }
  }

  return Array.from(evidenceMap.values()).sort((a, b) => b.score - a.score);
}

// ── Relevant History Types ──

type RelevantHistoryItem = {
  type: "action_log" | "turn";
  content: string;
  score: number;
  metadata: {
    timestamp?: string;
    location?: string;
    turnId?: string;
    turnNumber?: number;
    ragQuery?: string;
  };
};

const ragQueryRewriter = new RagQueryRewriter();
const sessionRagService = new SessionRagService();

function parseTurnIdFromSourceKey(sourceKey: string): string | null {
  const match = sourceKey.match(/^turn:([^:]+):/);
  return match?.[1] ?? null;
}

function formatTurnForRelevantHistory(
  turnNumber: number,
  playerInput: string,
  keeperNarrative: string
): string {
  return [
    `Turn #${turnNumber}`,
    `Player: ${playerInput || "(empty)"}`,
    `Keeper: ${keeperNarrative || "(empty)"}`,
  ].join("\n");
}

async function buildFullTurnRelevantHistoryFromChunks(
  sessionId: string,
  chunks: RetrievedSessionRagChunk[],
  topKTurns: number,
  ragQuery: string,
  sceneRoomId?: string | string[]
): Promise<RelevantHistoryItem[]> {
  const turnScoreMap = new Map<string, number>();

  for (const chunk of chunks) {
    const turnId = parseTurnIdFromSourceKey(chunk.sourceKey);
    if (!turnId) continue;

    const existing = turnScoreMap.get(turnId) ?? Number.NEGATIVE_INFINITY;
    if (chunk.score > existing) {
      turnScoreMap.set(turnId, chunk.score);
    }
  }

  const orderedTurnIds = Array.from(turnScoreMap.entries())
    .sort((a, b) => b[1] - a[1])
    // If we need to filter by sceneRoomId, over-select to avoid returning < topKTurns after filtering.
    .slice(0, sceneRoomId ? Math.max(topKTurns * 4, topKTurns) : topKTurns)
    .map(([turnId]) => turnId);

  if (orderedTurnIds.length === 0) {
    return [];
  }

  const prisma = getPrismaClient();
  const rows = await prisma.gameTurn.findMany({
    where: {
      sessionId,
      turnId: { in: orderedTurnIds },
      status: "completed",
      ...(sceneRoomId
        ? { sceneRoomId: Array.isArray(sceneRoomId) ? { in: sceneRoomId } : sceneRoomId }
        : {}),
    },
    select: {
      turnId: true,
      turnNumber: true,
      characterInput: true,
      keeperNarrative: true,
      gameDay: true,
      gameTime: true,
      location: true,
    },
  });

  const rowByTurnId = new Map(rows.map((row) => [row.turnId, row]));

  const fullTurns: RelevantHistoryItem[] = [];
  for (const turnId of orderedTurnIds) {
    if (fullTurns.length >= topKTurns) break;
    const row = rowByTurnId.get(turnId);
    if (!row || !row.keeperNarrative) continue;

    const timestampParts = [
      row.gameDay != null ? `Day ${row.gameDay}` : null,
      row.gameTime ?? null,
    ].filter(Boolean) as string[];

    fullTurns.push({
      type: "turn",
      content: formatTurnForRelevantHistory(
        row.turnNumber,
        row.characterInput ?? "",
        row.keeperNarrative
      ),
      score: turnScoreMap.get(turnId) ?? 0,
      metadata: {
        turnId,
        turnNumber: row.turnNumber,
        location: row.location ?? undefined,
        timestamp: timestampParts.length > 0 ? timestampParts.join(" ") : undefined,
        ragQuery,
      },
    });
  }

  return fullTurns;
}

/**
 * Inject action-type-specific rules into temporary rules so downstream agents can apply them.
 * Multiplayer native: writes directly to the sceneRoom via manager.
 */
export const injectActionTypeRules = (
  manager: MultiplayerDynamicGameStateManager,
  sceneRoomId: string,
  actionType?: ActionType
): void => {
  if (!actionType) return;

  const ruleText = actionRules[actionType];
  if (!ruleText) return;

  const sceneRoom = manager.getSceneRoom(sceneRoomId);
  if (!sceneRoom) return;

  const formatted = `${actionType} rules: ${ruleText}`;
  const currentRules = sceneRoom.temporaryInfo.rules ?? [];
  if (currentRules.includes(formatted)) return;

  manager.updateSceneRoom(sceneRoomId, {
    temporaryInfo: {
      ...sceneRoom.temporaryInfo,
      rules: [...currentRules, formatted],
    },
  });
};

/**
 * Extract recent conversation history (last N completed turns) from database
 * Directly gets the last N turns by sessionId, no gameTime filtering needed
 */
export const extractRecentConversationHistory = async (
  db: CoCDatabase | CoCDatabaseAdapter | undefined,
  sessionId: string,
  limit = 1,
  sceneRoomId?: string | string[]
): Promise<
  Array<{
    turnNumber: number;
    characterInput: string;
    keeperNarrative: string | null;
    actionAnalysis?: any | null;
  }>
> => {
  if (!db) return [];

  try {
    // Get recent turns directly by sessionId (already sorted by turn_number DESC)
    // Get more turns to ensure we have enough completed ones
    const turns = db.getTurnHistory(
      sessionId,
      limit * 3, // Get more turns to account for filtering completed ones
      undefined, // afterTurnNumber
      sceneRoomId
    );

    // Filter only completed turns with keeper narrative
    const completedTurns = turns
      .filter((turn) => turn.status === "completed" && turn.keeperNarrative)
      .slice(0, limit) // Take first N (already sorted DESC, so these are the newest)
      .reverse(); // Reverse to get chronological order (oldest first)

    const result = completedTurns.map((turn) => ({
      turnNumber: turn.turnNumber,
      characterInput: turn.characterInput,
      keeperNarrative: turn.keeperNarrative,
    }));

    if (result.length > 0) {
      console.log(
        `📜 [Memory Agent] 提取了 ${result.length} 轮历史对话 (Turn #${result[0]?.turnNumber} 到 Turn #${result[result.length - 1]?.turnNumber})`
      );
    }

    return result;
  } catch (error) {
    console.warn("Failed to extract conversation history:", error);
    return [];
  }
};

/**
 * Retrieve relevant history using HYBRID RAG (BM25 + Vector)
 * Combines keyword matching with semantic similarity for better retrieval
 */
export const retrieveRelevantHistory = async (
  db: CoCDatabase | CoCDatabaseAdapter | undefined,
  sessionId: string,
  query: string,
  options: {
    topKActionLogs?: number;
    topKTurns?: number;
    alpha?: number; // BM25 weight, default 0.3
    // NEW OPTIONS
    targetCharacters?: string[];
    topKPerCharacter?: number;
    currentLocation?: string;
    locationBoostFactor?: number;
    // Query rewrite context (Pensieve-style)
    language?: "en" | "zh";
    sceneName?: string;
    sceneLocation?: string;
    npcNames?: string[];
    playerName?: string;
    recentTurns?: Array<{
      turnNumber: number;
      playerInput: string;
      keeperNarrative: string;
    }>;
    allScenes?: Array<{
      name: string;
      description: string;
    }>;
    minScore?: number;
    includeActionLogs?: boolean;
    // Multiplayer: scope history retrieval to a sceneRoom (or ancestor chain). Prevents cross-room leakage.
    sceneRoomId?: string | string[];
  } = {}
): Promise<RelevantHistoryItem[]> => {
  if (!db || !query.trim()) return [];

  const {
    topKActionLogs = 3,
    topKTurns = 5,
    alpha = 0.3,
    language = "zh",
    minScore,
    includeActionLogs = true,
    sceneRoomId,
  } = options;

  try {
    // Step 1: Query rewrite (same pattern as Pensieve QA)
    const rewrite = await ragQueryRewriter.rewrite({
      question: query,
      language,
      sceneName: options.sceneName ?? options.currentLocation ?? null,
      sceneLocation: options.sceneLocation ?? options.currentLocation ?? null,
      npcNames: options.npcNames ?? [],
      playerName: options.playerName ?? null,
      recentTurns: options.recentTurns ?? [],
      allScenes: options.allScenes ?? [],
    });

    // Step 2: Search chunked session RAG (300/60 chunks are produced by TurnRagAgent)
    const candidateTopK = Math.max(topKTurns * 6, topKActionLogs * 2, 12);
    const retrievedChunks = await sessionRagService.searchHybrid({
      sessionId,
      ragQuery: rewrite.ragQuery,
      topK: candidateTopK,
      semanticWeight: 1 - alpha,
      bm25Weight: alpha,
      language,
      chunkType: "turn",
      sceneRoomId,
    });

    // Step 3: If any turn chunk is hit, expand to full turn content
    const fullTurnResults = await buildFullTurnRelevantHistoryFromChunks(
      sessionId,
      retrievedChunks,
      topKTurns,
      rewrite.ragQuery,
      sceneRoomId
    );

    const filteredFullTurnResults =
      typeof minScore === "number"
        ? fullTurnResults.filter((item) => item.score >= minScore)
        : fullTurnResults;

    const ragManager = new GameHistoryRag(db);
    const fetchLegacyItems = async (
      legacyTopKTurns: number
    ): Promise<RelevantHistoryItem[]> => {
      const searchResult = await ragManager.searchRelevantHistoryHybrid(
        sessionId,
        query,
        {
          topKActionLogs,
          topKTurns: legacyTopKTurns,
          alpha,
          targetCharacters: options.targetCharacters,
          topKPerCharacter: options.topKPerCharacter,
          currentLocation: options.currentLocation,
          locationBoostFactor: options.locationBoostFactor,
        }
      );

      return (
        searchResult.items as LegacyRelevantHistoryItem[] as RelevantHistoryItem[]
      ).filter(
        (item) =>
          (includeActionLogs || item.type === "turn") &&
          (typeof minScore === "number" ? item.score >= minScore : true)
      );
    };

    if (filteredFullTurnResults.length > 0) {
      let mergedItems = filteredFullTurnResults;

      if (includeActionLogs && topKActionLogs > 0) {
        let supplementalActionLogs = (await fetchLegacyItems(1)).filter(
          (item) => item.type === "action_log"
        );

        // Multiplayer: ensure action logs also don't leak across sceneRooms.
        if (sceneRoomId && supplementalActionLogs.length > 0) {
          const prisma = getPrismaClient();
          const actionLogTurnIds = Array.from(
            new Set(
              supplementalActionLogs
                .map((i) => (typeof i.metadata?.turnId === "string" ? i.metadata.turnId : null))
                .filter(Boolean) as string[]
            )
          );

          if (actionLogTurnIds.length > 0) {
            const sceneRoomFilter = Array.isArray(sceneRoomId)
              ? { sceneRoomId: { in: sceneRoomId } }
              : { sceneRoomId };
            const allowedTurns = await prisma.gameTurn.findMany({
              where: {
                sessionId,
                ...sceneRoomFilter,
                turnId: { in: actionLogTurnIds },
              },
              select: { turnId: true },
            });
            const allowed = new Set(allowedTurns.map((t) => t.turnId));
            supplementalActionLogs = supplementalActionLogs.filter((i) =>
              i.metadata?.turnId ? allowed.has(i.metadata.turnId) : false
            );
          } else {
            supplementalActionLogs = [];
          }
        }

        if (supplementalActionLogs.length > 0) {
          mergedItems = [...filteredFullTurnResults, ...supplementalActionLogs].sort(
            (a, b) => b.score - a.score
          );
        }
      }

      const actionLogCount = mergedItems.filter(
        (i) => i.type === "action_log"
      ).length;
      const turnCount = mergedItems.filter((i) => i.type === "turn").length;
      console.log(
        `🔍 [Memory Agent] Retrieved ${mergedItems.length} relevant history items via rewritten query + chunk RAG` +
          `${includeActionLogs ? " (+ legacy action logs)" : ""} ` +
          `(${actionLogCount} action logs, ${turnCount} turns, query="${query}" -> ragQuery="${rewrite.ragQuery}"` +
          `${typeof minScore === "number" ? `, minScore=${minScore}` : ""})`
      );
      return mergedItems;
    }

    // Fallback: legacy embedding store (for older sessions without chunk data)
    let legacyItems = await fetchLegacyItems(topKTurns);

    // Multiplayer: ensure fallback items don't leak across sceneRooms.
    if (sceneRoomId && legacyItems.length > 0) {
      const prisma = getPrismaClient();
      const legacyTurnIds = Array.from(
        new Set(
          legacyItems
            .map((i) => (typeof i.metadata?.turnId === "string" ? i.metadata.turnId : null))
            .filter(Boolean) as string[]
        )
      );

      if (legacyTurnIds.length > 0) {
        const sceneRoomFilter = Array.isArray(sceneRoomId)
          ? { sceneRoomId: { in: sceneRoomId } }
          : { sceneRoomId };
        const allowedTurns = await prisma.gameTurn.findMany({
          where: {
            sessionId,
            ...sceneRoomFilter,
            turnId: { in: legacyTurnIds },
          },
          select: { turnId: true },
        });
        const allowed = new Set(allowedTurns.map((t) => t.turnId));
        legacyItems = legacyItems.filter((i) =>
          i.metadata?.turnId ? allowed.has(i.metadata.turnId) : false
        );
      } else {
        legacyItems = [];
      }
    }

    if (legacyItems.length > 0) {
      const actionLogCount = legacyItems.filter(
        (i) => i.type === "action_log"
      ).length;
      const turnCount = legacyItems.filter(
        (i) => i.type === "turn"
      ).length;
      const modeInfo = options.targetCharacters?.length
        ? `per-character mode (${options.targetCharacters.length} chars)`
        : "global mode";
      console.log(
        `🔍 [Memory Agent] Retrieved ${legacyItems.length} relevant history items via Legacy Hybrid RAG ` +
          `(${actionLogCount} action logs, ${turnCount} turns, α=${alpha}, ${modeInfo}, ragQuery="${rewrite.ragQuery}"${typeof minScore === "number" ? `, minScore=${minScore}` : ""})`
      );
    }

    return legacyItems;
  } catch (error) {
    console.warn("[Memory Agent] Failed to retrieve relevant history:", error);
    return [];
  }
};

/**
 * Enrich sceneRoom state with action-type rules and conversation history for the memory workflow.
 * Multiplayer native: reads/writes through the multiplayer manager.
 */
export const enrichMemoryContext = async (
  manager: MultiplayerDynamicGameStateManager,
  sceneRoomId: string,
  actionAnalysis: ActionAnalysis | null,
  db?: CoCDatabase | CoCDatabaseAdapter,
  characterInput?: string,
  language?: "en" | "zh"
): Promise<void> => {
  const state = manager.getState();
  const sceneRoom = manager.getSceneRoom(sceneRoomId);
  if (!sceneRoom) return;

  // First inject the action-type rules
  injectActionTypeRules(manager, sceneRoomId, actionAnalysis?.actionType);

  // Re-read sceneRoom after rule injection
  const updatedSceneRoom = manager.getSceneRoom(sceneRoomId)!;
  const ancestorIds = getAncestorSceneRoomIds(manager, sceneRoomId);

  // Extract recent conversation history (last 3 turns, sceneRoom-scoped with ancestor chain)
  const conversationHistory = await extractRecentConversationHistory(
    db,
    state.sessionId,
    3,
    ancestorIds
  );

  // Extract target characters for per-character retrieval
  const targetCharacters: string[] = [];

  // Add all member player character names
  for (const pid of sceneRoom.memberPlayerIds) {
    const p = state.players[pid];
    if (p?.characterName) {
      targetCharacters.push(p.characterName);
    }
  }

  // Add target from action analysis (if available)
  if (actionAnalysis?.target?.name) {
    targetCharacters.push(actionAnalysis.target.name);
  }

  // Add characters from action results (NPCs who acted in current turn)
  if (updatedSceneRoom.temporaryInfo?.actionResults) {
    for (const result of updatedSceneRoom.temporaryInfo.actionResults) {
      if (result.character && !targetCharacters.includes(result.character)) {
        targetCharacters.push(result.character);
      }
    }
  }

  // Deduplicate
  const uniqueCharacters = [...new Set(targetCharacters)];

  // Get current location for boosting
  const currentLocation = sceneRoom.currentScenario?.location || null;

  // Adjust BM25 weight based on language
  // Chinese has poor BM25 performance due to FTS5 character-level tokenization
  const effectiveLanguage = language || "zh"; // Default to Chinese
  const alpha = effectiveLanguage === "zh" ? 0.1 : 0.3; // Lower BM25 weight for Chinese

  // Retrieve relevant history using Hybrid RAG (BM25 + Vector) with per-character filtering
  let relevantHistory: RelevantHistoryItem[] = [];
  if (characterInput && characterInput.trim()) {
    const recentTurnsForRewrite = conversationHistory
      .filter(
        (turn): turn is { turnNumber: number; characterInput: string; keeperNarrative: string } =>
          typeof turn.turnNumber === "number" &&
          typeof turn.characterInput === "string" &&
          typeof turn.keeperNarrative === "string"
      )
      .map((turn) => ({
        turnNumber: turn.turnNumber,
        playerInput: turn.characterInput,
        keeperNarrative: turn.keeperNarrative,
      }));

    const npcNames = Array.from(
      new Set(
        (state.npcCharacters || [])
          .map((npc: any) => (typeof npc?.name === "string" ? npc.name.trim() : ""))
          .filter((name: string) => name.length > 0)
      )
    ).slice(0, 30);

    const allScenes = (state.scenarioOutlines || [])
      .map((scene: any) => ({
        name: scene.name,
        description: scene.description,
      }))
      .filter((scene: any) => scene.name && scene.description)
      .slice(0, 50);

    const contextualData = updatedSceneRoom.temporaryInfo.contextualData ?? {};
    const preloadedRelevantHistory =
      (contextualData.relevantHistory as RelevantHistoryItem[]) || [];
    const preloadedRelevantHistoryQuery =
      typeof contextualData.relevantHistoryQuery === "string"
        ? (contextualData.relevantHistoryQuery as string).trim()
        : "";
    const preloadedIncludesActionLogs =
      contextualData.relevantHistoryIncludesActionLogs === true;
    const currentInput = characterInput.trim();
    const canReusePreloaded =
      preloadedRelevantHistory.length > 0 &&
      preloadedRelevantHistoryQuery.length > 0 &&
      preloadedRelevantHistoryQuery === currentInput &&
      preloadedIncludesActionLogs;

    const rawRelevantHistory =
      canReusePreloaded
        ? preloadedRelevantHistory
        : await retrieveRelevantHistory(db, state.sessionId, characterInput, {
            topKActionLogs: 15,
            topKTurns: 5,
            alpha,
            targetCharacters:
              uniqueCharacters.length > 0 ? uniqueCharacters : undefined,
            topKPerCharacter: 5,
            currentLocation: currentLocation || undefined,
            locationBoostFactor: 1.2,
            language: effectiveLanguage,
            sceneName: sceneRoom.currentScenario?.name || undefined,
            sceneLocation: currentLocation || undefined,
            npcNames,
            // No single playerName in MP; omit to avoid misleading the rewriter.
            recentTurns: recentTurnsForRewrite,
            allScenes,
            minScore: 0.7,
            includeActionLogs: true,
            sceneRoomId: ancestorIds,
          });

    if (canReusePreloaded) {
      console.log(
        `🧠 [Memory Agent] Reusing ${preloadedRelevantHistory.length} preloaded relevantHistory from orchestrator (same input query)`
      );
    } else if (preloadedRelevantHistory.length > 0) {
      console.log(
        "[Memory Agent] Ignored preloaded relevantHistory due to query mismatch or missing action-log coverage; refreshed retrieval"
      );
    }

    // Deduplicate turns: Remove RAG-retrieved turns that are already in conversationHistory
    const conversationTurnNumbers = new Set(
      conversationHistory.map((t) => t.turnNumber)
    );

    relevantHistory = rawRelevantHistory.filter((item) => {
      if (item.type === "turn") {
        const turnNumberFromMetadata =
          typeof item.metadata.turnNumber === "number"
            ? item.metadata.turnNumber
            : null;

        // Backward-compatible parsing for legacy turnId values: "turn_123" or "123"
        const turnNumberFromTurnId =
          !turnNumberFromMetadata && item.metadata.turnId
            ? Number.parseInt(item.metadata.turnId.replace(/^turn_/, ""), 10)
            : null;

        const turnNumber =
          turnNumberFromMetadata ||
          (Number.isFinite(turnNumberFromTurnId) ? turnNumberFromTurnId : null);

        if (turnNumber == null) {
          return true;
        }

        if (conversationTurnNumbers.has(turnNumber)) {
          console.debug(
            `[Memory Agent] Filtered duplicate turn #${turnNumber} from RAG results ` +
              `(already in conversationHistory)`
          );
          return false; // Skip this turn
        }
      }
      return true; // Keep action logs and non-duplicate turns
    });

    const filteredCount = rawRelevantHistory.length - relevantHistory.length;
    if (filteredCount > 0) {
      console.log(
        `🔄 [Memory Agent] Removed ${filteredCount} duplicate turn(s) from RAG results`
      );
    }

    if (uniqueCharacters.length > 0) {
      console.log(
        `📍 [Memory Agent] Retrieved history for characters: [${uniqueCharacters.join(", ")}] ` +
          `in location: "${currentLocation || "N/A"}"`
      );
    }
  }

  // Write enriched data via manager
  const finalSceneRoom = manager.getSceneRoom(sceneRoomId)!;
  manager.updateSceneRoom(sceneRoomId, {
    temporaryInfo: {
      ...finalSceneRoom.temporaryInfo,
      contextualData: {
        ...finalSceneRoom.temporaryInfo.contextualData,
        conversationHistory,
        relevantHistory,
        relevantHistoryIncludesActionLogs: true,
      },
    },
  });
};

/**
 * Multiplayer native memory enrichment (sceneRoom-scoped).
 * - Injects action-type rules for all input players in this sceneRoom (deduped).
 * - Ensures conversationHistory / relevantHistory are stored in sceneRoom contextualData.
 * - Does NOT read or write any other sceneRoom's temporaryInfo.
 */
export const enrichMemoryContextForSceneRoom = async (
  manager: MultiplayerDynamicGameStateManager,
  sceneRoomId: string,
  db?: CoCDatabase | CoCDatabaseAdapter,
  combinedCharacterInput?: string,
  language: "en" | "zh" = "zh"
): Promise<void> => {
  const state = manager.getState();
  const sceneRoom = manager.getSceneRoom(sceneRoomId);
  if (!sceneRoom) return;

  // Compute ancestor chain once: [currentId, ...parentIds, ...grandparentIds]
  const ancestorIds = getAncestorSceneRoomIds(manager, sceneRoomId);

  const contextualData = sceneRoom.temporaryInfo.contextualData ?? {};
  const playerActionAnalyses =
    (contextualData.playerActionAnalyses as Record<string, any>) ?? {};

  const uniqueActionTypes = new Set<ActionType>();
  const targetCharacters: string[] = [];

  for (const pa of Object.values(playerActionAnalyses)) {
    const actionType = pa?.actionAnalysis?.actionType;
    if (typeof actionType === "string") {
      const asType = actionType as ActionType;
      if (
        asType === "exploration" ||
        asType === "social" ||
        asType === "stealth" ||
        asType === "combat" ||
        asType === "chase" ||
        asType === "mental" ||
        asType === "environmental" ||
        asType === "narrative"
      ) {
        uniqueActionTypes.add(asType);
      }
    }
    const actorName = pa?.actionAnalysis?.character;
    if (typeof actorName === "string" && actorName.trim()) {
      targetCharacters.push(actorName.trim());
    }
    const targetName = pa?.actionAnalysis?.target?.name;
    if (typeof targetName === "string" && targetName.trim()) {
      targetCharacters.push(targetName.trim());
    }
  }

  // Inject action-type rules (deduped).
  const nextRules = [...(sceneRoom.temporaryInfo.rules ?? [])];
  for (const actionType of uniqueActionTypes) {
    const ruleText = actionRules[actionType];
    if (!ruleText) continue;
    if (!nextRules.includes(ruleText)) {
      nextRules.push(ruleText);
    }
  }

  // Conversation history: sceneRoom-scoped with ancestor chain (includes frozen parent rooms).
  const conversationHistory = db
    ? await extractRecentConversationHistory(db, state.sessionId, 3, ancestorIds)
    : [];

  // Relevant history: prefer orchestrator-preloaded relevantHistory.
  let relevantHistory =
    (contextualData.relevantHistory as RelevantHistoryItem[]) ?? [];
  const hasRelevantHistory =
    Array.isArray(relevantHistory) && relevantHistory.length > 0;
  const allowReuse = contextualData.relevantHistoryIncludesActionLogs === true;

  if ((!hasRelevantHistory || !allowReuse) && db) {
    const currentLocation = sceneRoom.currentScenario?.location || undefined;
    const inputQuery = combinedCharacterInput?.trim() ?? "";
    if (inputQuery) {
      const uniqueCharacters = [...new Set(targetCharacters)].slice(0, 12);
      const npcNames = Array.from(
        new Set(
          (state.npcCharacters || [])
            .map((npc) => (typeof npc?.name === "string" ? npc.name.trim() : ""))
            .filter((name) => name.length > 0)
        )
      ).slice(0, 30);

      // Chinese BM25 is weak due to tokenizer; lower alpha.
      const alpha = language === "zh" ? 0.1 : 0.3;
      try {
        relevantHistory = await retrieveRelevantHistory(db, state.sessionId, inputQuery, {
          topKActionLogs: 15,
          topKTurns: 5,
          alpha,
          targetCharacters: uniqueCharacters.length > 0 ? uniqueCharacters : undefined,
          topKPerCharacter: 5,
          currentLocation,
          locationBoostFactor: 1.2,
          language,
          sceneName: sceneRoom.currentScenario?.name || undefined,
          sceneLocation: currentLocation,
          npcNames,
          // No single playerName in MP; omit to avoid misleading the rewriter.
          minScore: 0.7,
          includeActionLogs: true,
          sceneRoomId: ancestorIds,
        });
      } catch {
        relevantHistory = [];
      }
    }
  }

  // --- Clue RAG: per-player query, max 2 each, deduplicated ---
  let retrievedClueContext: Array<{
    content: string;
    score: number;
    metadata: Record<string, unknown> | null;
    sourceKey: string;
  }> = [];

  // Chinese BM25 weight for clue retrieval (same heuristic as turn retrieval)
  const clueAlpha = language === "zh" ? 0.1 : 0.3;

  if (db) {
    const memberInputs = manager.getRoundInputsForSceneRoom(sceneRoomId)
      .filter((i) => i.inputType === "input" && Boolean(i.content?.trim()));
    const seenSourceKeys = new Set<string>();
    const CLUE_THRESHOLD = 0.4;
    const MAX_PER_PLAYER = 2;

    for (const input of memberInputs) {
      const query = input.content!.trim();
      try {
        const chunks = await sessionRagService.searchHybrid({
          sessionId: state.sessionId,
          ragQuery: query,
          topK: MAX_PER_PLAYER,
          semanticWeight: 1 - clueAlpha,
          bm25Weight: clueAlpha,
          language,
          chunkType: "clue",
          sceneRoomId: ancestorIds,
        });
        for (const chunk of chunks) {
          if (chunk.score < CLUE_THRESHOLD) continue;
          if (seenSourceKeys.has(chunk.sourceKey)) continue;
          seenSourceKeys.add(chunk.sourceKey);
          retrievedClueContext.push({
            content: chunk.content,
            score: chunk.score,
            metadata: chunk.metadata,
            sourceKey: chunk.sourceKey,
          });
        }
      } catch { /* swallow — clue RAG failure is non-fatal */ }
    }

    if (retrievedClueContext.length > 0) {
      console.log(
        `🔎 [Memory Agent] Retrieved ${retrievedClueContext.length} clue RAG chunk(s) for sceneRoom ${sceneRoomId}`
      );
    }
  }

  // ── Trigger evidence (global scope — for director's checkGlobalTriggerAndGameEnd) ──
  let triggerEvidence: TriggerEvidenceItem[] | undefined;
  const globalTrigger = state.globalTrigger;
  const victoryTrigger = state.moduleDigest?.victoryTrigger;

  if (globalTrigger || victoryTrigger) {
    const globalEvents = (globalTrigger?.events ?? []).filter(
      (e): e is string => typeof e === "string" && e.trim().length > 0
    );
    const victoryConditions = ((victoryTrigger as any)?.conditions ?? []).filter(
      (c: unknown): c is string => typeof c === "string" && (c as string).trim().length > 0
    );

    if (globalEvents.length > 0 || victoryConditions.length > 0) {
      try {
        triggerEvidence = await retrieveTriggerEvidence({
          sessionId: state.sessionId,
          globalEvents,
          victoryConditions,
        });
        console.log(
          `🔍 [Memory Agent] Retrieved ${triggerEvidence.length} trigger evidence chunk(s) for sceneRoom ${sceneRoomId}`
        );
      } catch (err) {
        console.warn("[Memory] Trigger evidence retrieval failed:", err);
      }
    }
  }

  manager.updateSceneRoom(sceneRoomId, {
    temporaryInfo: {
      ...sceneRoom.temporaryInfo,
      rules: nextRules,
      contextualData: {
        ...contextualData,
        conversationHistory,
        relevantHistory,
        relevantHistoryIncludesActionLogs: true,
        retrievedClueContext,
        ...(triggerEvidence !== undefined ? { triggerEvidence } : {}),
      },
    },
  });
};
