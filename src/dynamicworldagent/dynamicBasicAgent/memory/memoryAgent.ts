/**
 * Memory Agent helpers
 * This module owns state-side helpers for memory workflows.
 */
import {
  DynamicGameStateManager,
  type DynamicGameState,
} from "../../state/index.js";
import type {
  ActionType,
  ActionAnalysis,
} from "../../../shared/state/index.js";
import { actionRules } from "../../../shared/rules/index.js";
import type { CoCDatabase } from "../../../shared/agents/memory/database/index.js";
import type { DynamicScenarioSnapshot } from "../../world_builder/types.js";
import { GameHistoryRag, type RelevantHistoryItem } from "../../../rag/gameHistoryRag.js";


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
 * Note: Simulate queries (with actionAnalysis === null) are included in conversationHistory
 * but should not count towards turn statistics (turnsInCurrentScene).
 * Real queries have actionAnalysis set by the Orchestrator Agent.
 */
export const extractRecentConversationHistory = async (
  db: CoCDatabase | undefined,
  sessionId: string,
  limit = 1
): Promise<Array<{ turnNumber: number; characterInput: string; keeperNarrative: string | null; actionAnalysis?: any | null }>> => {
  if (!db) return [];

  try {
    // Get recent turns directly by sessionId (already sorted by turn_number DESC)
    // Get more turns to ensure we have enough completed ones
    const turns = db.getTurnHistory(
      sessionId,
      limit * 3, // Get more turns to account for filtering completed ones
      undefined // afterTurnNumber
    );
    
    // Filter only completed turns with keeper narrative
    // Include both real queries (with actionAnalysis) and simulate queries (actionAnalysis === null)
    const completedTurns = turns
      .filter(turn => turn.status === 'completed' && turn.keeperNarrative)
      .slice(0, limit) // Take first N (already sorted DESC, so these are the newest)
      .reverse(); // Reverse to get chronological order (oldest first)
    
    const result = completedTurns.map(turn => ({
      turnNumber: turn.turnNumber,
      characterInput: turn.characterInput,
      keeperNarrative: turn.keeperNarrative,
      actionAnalysis: turn.actionAnalysis || null, // null indicates simulate query
    }));

    if (result.length > 0) {
      const simulateCount = result.filter(t => !t.actionAnalysis).length;
      const realCount = result.length - simulateCount;
      console.log(`📜 [Memory Agent] 提取了 ${result.length} 轮历史对话 (Turn #${result[0]?.turnNumber} 到 Turn #${result[result.length - 1]?.turnNumber}), 其中真实轮数: ${realCount}, simulate轮数: ${simulateCount}`);
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
  db: CoCDatabase | undefined,
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
  } = {}
): Promise<RelevantHistoryItem[]> => {
  if (!db || !query.trim()) return [];

  const {
    topKActionLogs = 3,
    topKTurns = 3,
    alpha = 0.3,
  } = options;

  try {
    const ragManager = new GameHistoryRag(db);
    const searchResult = await ragManager.searchRelevantHistoryHybrid(
      sessionId,
      query,
      {
        topKActionLogs,
        topKTurns,
        alpha,
        // NEW: Pass through per-character options
        targetCharacters: options.targetCharacters,
        topKPerCharacter: options.topKPerCharacter,
        currentLocation: options.currentLocation,
        locationBoostFactor: options.locationBoostFactor,
      }
    );

    if (searchResult.items.length > 0) {
      const actionLogCount = searchResult.items.filter(i => i.type === "action_log").length;
      const turnCount = searchResult.items.filter(i => i.type === "turn").length;
      const modeInfo = options.targetCharacters?.length
        ? `per-character mode (${options.targetCharacters.length} chars)`
        : "global mode";
      console.log(
        `🔍 [Memory Agent] Retrieved ${searchResult.items.length} relevant history items via Hybrid RAG ` +
        `(${actionLogCount} action logs, ${turnCount} turns, α=${alpha}, ${modeInfo})`
      );
    }

    return searchResult.items;
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
  db?: CoCDatabase,
  characterInput?: string,
  language?: 'en' | 'zh'
): Promise<DynamicGameState> => {
  // First inject the action-type rules
  const withRules = injectActionTypeRules(gameState, actionAnalysis?.actionType);

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
  const effectiveLanguage = language || 'zh'; // Default to Chinese
  const alpha = effectiveLanguage === 'zh' ? 0.1 : 0.3; // Lower BM25 weight for Chinese

  // Retrieve relevant history using Hybrid RAG (BM25 + Vector) with per-character filtering
  let relevantHistory: RelevantHistoryItem[] = [];
  if (characterInput && characterInput.trim()) {
    const rawRelevantHistory = await retrieveRelevantHistory(
      db,
      gameState.sessionId,
      characterInput,
      {
        topKActionLogs: 15,  // Advisory max (3 chars × 5 per char)
        topKTurns: 3,       // Global turns (unchanged)
        alpha,              // Dynamic: 10% BM25 (中文) or 30% BM25 (英文)
        // NEW: Per-character options
        targetCharacters: uniqueCharacters.length > 0 ? uniqueCharacters : undefined,
        topKPerCharacter: 5,         // Top 5 per character
        currentLocation: currentLocation || undefined,
        locationBoostFactor: 1.2,    // 20% boost for matching location
      }
    );

    // Deduplicate turns: Remove RAG-retrieved turns that are already in conversationHistory
    const conversationTurnNumbers = new Set(
      conversationHistory.map(t => t.turnNumber)
    );

    relevantHistory = rawRelevantHistory.filter(item => {
      if (item.type === "turn" && item.metadata.turnId) {
        // Extract turn number from turnId (format: "turn_123" or "123")
        const turnNumber = parseInt(item.metadata.turnId.replace(/^turn_/, ""), 10);
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
      },
    },
  };
};

