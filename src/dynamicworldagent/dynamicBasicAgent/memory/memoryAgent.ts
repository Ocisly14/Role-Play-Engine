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
import {
  type DynamicGameState,
  DynamicGameStateManager,
} from "../../state/index.js";
import { RagQueryRewriter } from "../knowledge/ragQueryRewriter.js";
import {
  type RetrievedSessionRagChunk,
  SessionRagService,
} from "../knowledge/sessionRagService.js";

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
  ragQuery: string
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
    .slice(0, topKTurns)
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
 */
export const injectActionTypeRules = (
  gameState: DynamicGameState,
  actionType?: ActionType
): DynamicGameState => {
  if (!actionType) return gameState;

  const ruleText = actionRules[actionType];
  if (!ruleText) return gameState;

  const manager = new DynamicGameStateManager(gameState);
  manager.addTemporaryRules({
    rules: [
      {
        title: `${actionType} rules`,
        description: ruleText,
      },
    ],
    count: 1,
  });

  return manager.getState();
};

/**
 * Extract recent conversation history (last N completed turns) from database
 * Directly gets the last N turns by sessionId, no gameTime filtering needed
 */
export const extractRecentConversationHistory = async (
  db: CoCDatabase | CoCDatabaseAdapter | undefined,
  sessionId: string,
  limit = 1,
  sceneRoomId?: string
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
    });

    // Step 3: If any turn chunk is hit, expand to full turn content
    const fullTurnResults = await buildFullTurnRelevantHistoryFromChunks(
      sessionId,
      retrievedChunks,
      topKTurns,
      rewrite.ragQuery
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
        const supplementalActionLogs = (await fetchLegacyItems(1)).filter(
          (item) => item.type === "action_log"
        );
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
    const legacyItems = await fetchLegacyItems(topKTurns);

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
 * Enrich game state with action-type rules and conversation history for the memory workflow.
 */
export const enrichMemoryContext = async (
  gameState: DynamicGameState,
  actionAnalysis: ActionAnalysis | null,
  db?: CoCDatabase | CoCDatabaseAdapter,
  characterInput?: string,
  language?: "en" | "zh"
): Promise<DynamicGameState> => {
  // First inject the action-type rules
  const withRules = injectActionTypeRules(
    gameState,
    actionAnalysis?.actionType
  );

  // Extract recent conversation history (last 3 turns) and store in contextualData
  const conversationHistory = await extractRecentConversationHistory(
    db,
    gameState.sessionId,
    3
  );

  // Extract target characters for per-character retrieval
  const targetCharacters: string[] = [];

  // Add player character
  if (gameState.playerCharacter?.name) {
    targetCharacters.push(gameState.playerCharacter.name);
  }

  // Add target from action analysis (if available)
  if (actionAnalysis?.target?.name) {
    targetCharacters.push(actionAnalysis.target.name);
  }

  // Add characters from action results (NPCs who acted in current turn)
  if (gameState.temporaryInfo?.actionResults) {
    for (const result of gameState.temporaryInfo.actionResults) {
      if (result.character && !targetCharacters.includes(result.character)) {
        targetCharacters.push(result.character);
      }
    }
  }

  // Deduplicate
  const uniqueCharacters = [...new Set(targetCharacters)];

  // Get current location for boosting
  const currentLocation = gameState.currentScenario?.location || null;

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
        (gameState.npcCharacters || [])
          .map((npc) => (typeof npc?.name === "string" ? npc.name.trim() : ""))
          .filter((name) => name.length > 0)
      )
    ).slice(0, 30);

    const allScenes = (gameState.scenarioOutlines || [])
      .map((scene) => ({
        name: scene.name,
        description: scene.description,
      }))
      .filter((scene) => scene.name && scene.description)
      .slice(0, 50);

    const preloadedRelevantHistory =
      (withRules.temporaryInfo.contextualData?.relevantHistory as RelevantHistoryItem[]) || [];
    const preloadedRelevantHistoryQuery =
      typeof withRules.temporaryInfo.contextualData?.relevantHistoryQuery ===
      "string"
        ? withRules.temporaryInfo.contextualData.relevantHistoryQuery.trim()
        : "";
    const preloadedIncludesActionLogs =
      withRules.temporaryInfo.contextualData?.relevantHistoryIncludesActionLogs ===
      true;
    const currentInput = characterInput.trim();
    const canReusePreloaded =
      preloadedRelevantHistory.length > 0 &&
      preloadedRelevantHistoryQuery.length > 0 &&
      preloadedRelevantHistoryQuery === currentInput &&
      preloadedIncludesActionLogs;

    const rawRelevantHistory =
      canReusePreloaded
        ? preloadedRelevantHistory
        : await retrieveRelevantHistory(db, gameState.sessionId, characterInput, {
            topKActionLogs: 15, // Keeper path keeps action-log recall enabled
            topKTurns: 5, // Increase turn recall for better continuity
            alpha, // Dynamic: 10% BM25 (中文) or 30% BM25 (英文)
            // NEW: Per-character options
            targetCharacters:
              uniqueCharacters.length > 0 ? uniqueCharacters : undefined,
            topKPerCharacter: 5, // Top 5 per character
            currentLocation: currentLocation || undefined,
            locationBoostFactor: 1.2, // 20% boost for matching location
            language: effectiveLanguage,
            sceneName: gameState.currentScenario?.name || undefined,
            sceneLocation: currentLocation || undefined,
            npcNames,
            playerName: gameState.playerCharacter?.name || undefined,
            recentTurns: recentTurnsForRewrite,
            allScenes,
            minScore: 0.7,
            includeActionLogs: true,
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

  return {
    ...withRules,
    temporaryInfo: {
      ...withRules.temporaryInfo,
      contextualData: {
        ...withRules.temporaryInfo.contextualData,
        conversationHistory,
        relevantHistory, // Add RAG-retrieved relevant history
        relevantHistoryIncludesActionLogs: true,
      },
    },
  };
};
