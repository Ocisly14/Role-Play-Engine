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
 * Enrich game state with action-type rules and conversation history for the memory workflow.
 */
export const enrichMemoryContext = async (
  gameState: DynamicGameState,
  actionAnalysis: ActionAnalysis | null,
  db?: CoCDatabase,
  characterInput?: string
): Promise<DynamicGameState> => {
  // First inject the action-type rules
  const withRules = injectActionTypeRules(gameState, actionAnalysis?.actionType);

  // Extract recent conversation history (last 3 turns) and store in contextualData
  const conversationHistory = await extractRecentConversationHistory(
    db,
    gameState.sessionId,
    3
  );

  return {
    ...withRules,
    temporaryInfo: {
      ...withRules.temporaryInfo,
      contextualData: {
        ...withRules.temporaryInfo.contextualData,
        conversationHistory,
      },
    },
  };
};

