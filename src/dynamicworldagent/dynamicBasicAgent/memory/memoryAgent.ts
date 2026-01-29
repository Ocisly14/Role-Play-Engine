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
 * Filtered by gameTime to get turns up to the current game time
 * Note: Simulate queries (with actionAnalysis === null) are included in conversationHistory
 * but should not count towards turn statistics (turnsInCurrentScene).
 * Real queries have actionAnalysis set by the Orchestrator Agent.
 */
export const extractRecentConversationHistory = async (
  db: CoCDatabase | undefined,
  sessionId: string,
  limit = 1,
  gameDay?: number | null,
  gameTime?: string | null
): Promise<Array<{ turnNumber: number; characterInput: string; keeperNarrative: string | null; actionAnalysis?: any | null }>> => {
  if (!db) return [];

  try {
    // Get turns filtered by gameTime if provided, otherwise get recent turns
    // Get more turns to ensure we have enough completed ones
    const turns = db.getTurnHistory(
      sessionId,
      limit * 10, // Get more turns to account for filtering by gameTime
      undefined, // afterTurnNumber
      gameDay !== undefined && gameDay !== null ? gameDay : undefined,
      gameTime !== undefined && gameTime !== null ? gameTime : undefined
    );
    
    // Helper function to compare gameTime (handles null values)
    const compareGameTime = (a: { gameDay?: number | null; gameTime?: string | null }, b: { gameDay?: number | null; gameTime?: string | null }): number => {
      // Null gameTime/gameDay are treated as earliest (before any timestamped turns)
      if (!a.gameDay || !a.gameTime) return -1;
      if (!b.gameDay || !b.gameTime) return 1;
      
      // Compare by gameDay first
      if (a.gameDay !== b.gameDay) {
        return b.gameDay - a.gameDay; // Descending (newer first)
      }
      
      // Same day, compare by gameTime (HH:MM format)
      const [aHour, aMin] = a.gameTime.split(':').map(Number);
      const [bHour, bMin] = b.gameTime.split(':').map(Number);
      const aTotal = aHour * 60 + aMin;
      const bTotal = bHour * 60 + bMin;
      
      return bTotal - aTotal; // Descending (newer first)
    };
    
    // Filter only completed turns with keeper narrative
    // Include both real queries (with actionAnalysis) and simulate queries (actionAnalysis === null)
    let completedTurns = turns
      .filter(turn => turn.status === 'completed' && turn.keeperNarrative);
    
    // Sort by gameTime (newest first), then take the last N and reverse to chronological order
    completedTurns.sort(compareGameTime);
    completedTurns = completedTurns.slice(0, limit);
    completedTurns.reverse(); // Reverse to get chronological order (oldest first)
    
    const result = completedTurns.map(turn => ({
      turnNumber: turn.turnNumber,
      characterInput: turn.characterInput,
      keeperNarrative: turn.keeperNarrative,
      actionAnalysis: turn.actionAnalysis || null, // null indicates simulate query
    }));

    if (result.length > 0) {
      const simulateCount = result.filter(t => !t.actionAnalysis).length;
      const realCount = result.length - simulateCount;
      const timeInfo = gameDay && gameTime ? ` (截至 Day ${gameDay}, ${gameTime})` : '';
      console.log(`📜 [Memory Agent] 提取了 ${result.length} 轮历史对话${timeInfo} (Turn #${result[0]?.turnNumber} 到 Turn #${result[result.length - 1]?.turnNumber}), 其中真实轮数: ${realCount}, simulate轮数: ${simulateCount}`);
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
  // Filter by current gameTime to get turns up to the current game time
  const conversationHistory = await extractRecentConversationHistory(
    db,
    gameState.sessionId,
    3,
    gameState.gameDay,
    gameState.timeOfDay
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

