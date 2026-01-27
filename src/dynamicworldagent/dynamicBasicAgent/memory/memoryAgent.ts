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
} from "../../../coc_multiagents_system/state/index.js";
import { actionRules } from "../../../coc_multiagents_system/rules/index.js";
import type { CoCDatabase } from "../../../coc_multiagents_system/agents/memory/database/index.js";
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
    // Get more turns to ensure we have enough completed ones
    const turns = db.getTurnHistory(sessionId, limit * 2);
    
    // Filter only completed turns with keeper narrative, then take the last N
    // Include both real queries (with actionAnalysis) and simulate queries (actionAnalysis === null)
    const completedTurns = turns
      .filter(turn => turn.status === 'completed' && turn.keeperNarrative)
      .slice(0, limit)
      .map(turn => ({
        turnNumber: turn.turnNumber,
        characterInput: turn.characterInput,
        keeperNarrative: turn.keeperNarrative,
        actionAnalysis: turn.actionAnalysis || null, // null indicates simulate query
      }))
      .reverse(); // Reverse to get chronological order (oldest first)

    if (completedTurns.length > 0) {
      const simulateCount = completedTurns.filter(t => !t.actionAnalysis).length;
      const realCount = completedTurns.length - simulateCount;
      console.log(`📜 [Memory Agent] 提取了 ${completedTurns.length} 轮历史对话 (Turn #${completedTurns[0]?.turnNumber} 到 Turn #${completedTurns[completedTurns.length - 1]?.turnNumber}), 其中真实轮数: ${realCount}, simulate轮数: ${simulateCount}`);
    }

    return completedTurns;
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

