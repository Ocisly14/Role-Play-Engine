/**
 * Memory Agent helpers
 * This module owns state-side helpers for memory workflows.
 */
import {
  GameStateManager,
  type GameState,
  type ActionType,
  type ActionAnalysis,
} from "../../state/index.js";
import { actionRules } from "../../rules/index.js";
import type { CoCDatabase } from "./database/index.js";
import type { ScenarioSnapshot } from "../models/scenarioTypes.js";
import type { Evidence, RagManager } from "./RagManager.js";


/**
 * Inject action-type-specific rules into temporary rules so downstream agents can apply them.
 */
export const injectActionTypeRules = (
  gameState: GameState,
  actionType?: ActionType
): GameState => {
  if (!actionType) return gameState;

  const ruleText = actionRules[actionType];
  if (!ruleText) return gameState;

  const manager = new GameStateManager(gameState);
  manager.addTemporaryRules({
    rules: [
      {
        title: `${actionType} rules`,
        description: ruleText,
      },
    ],
    count: 1,
  });

  return manager.getGameState() as GameState;
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
 * Enrich game state with action-type rules, RAG results, and conversation history for the memory workflow.
 */
export const enrichMemoryContext = async (
  gameState: GameState,
  actionAnalysis: ActionAnalysis | null,
  ragManager?: RagManager,
  db?: CoCDatabase,
  characterInput?: string
): Promise<GameState> => {
  // First inject the action-type rules
  const withRules = injectActionTypeRules(gameState, actionAnalysis?.actionType);

  // Fetch RAG evidence using the new RagManager
  // TODO: 暂时跳过RAG环节
  const SKIP_RAG = true; // 设置为 false 以启用 RAG
  let ragEvidence: Evidence[] = [];
  if (ragManager && !SKIP_RAG) {
    try {
      console.log(`[Memory Agent] 开始RAG检索 (场景: ${gameState.currentScenario?.name || '未知'}, 动作类型: ${actionAnalysis?.actionType || '未知'})`);
      const startTime = Date.now();
      const { evidence, debug } = await ragManager.runRagForTurn(withRules, {
        mode: "player",
      });
      const duration = Date.now() - startTime;
      ragEvidence = evidence;
      console.log(`[Memory Agent] RAG检索完成: 找到 ${evidence.length} 条证据 (耗时: ${duration}ms)`);
      if (debug) {
        const semanticCount = debug.semanticHits?.length ?? 0;
        const lexicalCount = debug.lexicalHits?.length ?? 0;
        const graphCount = debug.graphHits?.length ?? 0;
        console.log(`[Memory Agent] RAG详细统计: 语义检索 ${semanticCount} 条, 关键词检索 ${lexicalCount} 条, 图检索 ${graphCount} 条`);
      }
    } catch (error) {
      console.warn("[Memory Agent] RAG retrieval failed:", error);
    }
  } else if (SKIP_RAG) {
    console.log(`[Memory Agent] RAG环节已跳过 (SKIP_RAG = true)`);
  }

  // Extract recent conversation history (last 1 turn) and store in contextualData
  // Filter by current gameTime to get turns up to the current game time
  const conversationHistory = await extractRecentConversationHistory(
    db,
    gameState.sessionId,
    1,
    gameState.gameDay,
    gameState.timeOfDay
  );

  return {
    ...withRules,
    temporaryInfo: {
      ...withRules.temporaryInfo,
      ragResults: ragEvidence,
      contextualData: {
        ...withRules.temporaryInfo.contextualData,
        conversationHistory,
      },
    },
  };
};

/**
 * Create a checkpoint: Save current scenario state to database when scenario switches.
 * This includes: scenario snapshot, all NPCs, player character, and permanent changes.
 * 
 * New: Also saves a unified checkpoint to game_checkpoints table for easy save/load.
 */
export const createScenarioCheckpoint = async (
  gameState: GameState,
  db: CoCDatabase
): Promise<void> => {
  if (!gameState.currentScenario || !db) return;

  const database = db.getDatabase();
  const currentScenario = gameState.currentScenario;

  db.transaction(() => {
    // UNIFIED CHECKPOINT: Save complete game state to single checkpoint table
    const checkpointId = `checkpoint-${currentScenario.id}-${Date.now()}`;
    const checkpointName = `${currentScenario.name}`;
    const description = `Auto-saved at ${currentScenario.location}`;
    
    db.saveCheckpoint(
      checkpointId,
      gameState.sessionId,
      checkpointName,
      gameState,
      'scene_transition',
      description
    );

    // NOTE: We do NOT modify snapshot tables here
    // Snapshots (scenario_snapshots, scenario_characters, scenario_clues, scenario_conditions) 
    // are read-only original definitions that should never be modified after initial load.
    // All game state (discovered clues, permanent changes, etc.) is saved in the checkpoint 
    // (game_checkpoints table) and will be merged when restoring the scenario.
    
    // We still save permanent changes to scenarios table for query purposes,
    // but this is separate from the snapshot data
    if (currentScenario.permanentChanges && currentScenario.permanentChanges.length > 0) {
      // Determine scenarioId - infer from snapshot ID
      let scenarioId = (currentScenario as any).scenarioId;
      if (!scenarioId && currentScenario.id) {
        // Infer scenario ID from snapshot ID (e.g., "scenario-xyz-snapshot" -> "scenario-xyz")
        scenarioId = currentScenario.id.replace(/-snapshot.*$/, '');
      }
      const finalScenarioId = scenarioId || 'unknown';

      // Check if scenario exists in scenarios table
      const existingScenario = database
        .prepare("SELECT scenario_id, permanent_changes FROM scenarios WHERE scenario_id = ?")
        .get(finalScenarioId) as any;

      if (existingScenario) {
        // Merge with existing permanent changes to avoid duplicates
        const existingChanges = existingScenario.permanent_changes 
          ? JSON.parse(existingScenario.permanent_changes) 
          : [];
        const mergedChanges = Array.from(
          new Set([...existingChanges, ...currentScenario.permanentChanges])
        );

        // Update permanent changes in scenarios table (this is scenario-level metadata, not snapshot data)
        database
          .prepare("UPDATE scenarios SET permanent_changes = ? WHERE scenario_id = ?")
          .run(JSON.stringify(mergedChanges), finalScenarioId);
      }
    }

    // 6. Save player character
    const playerStmt = database.prepare(`
      INSERT OR REPLACE INTO characters (
        character_id, name, attributes, status, inventory, skills, notes,
        is_npc, user_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT user_id FROM characters WHERE character_id = ?), CURRENT_TIMESTAMP)
    `);

    playerStmt.run(
      gameState.playerCharacter.id,
      gameState.playerCharacter.name,
      JSON.stringify(gameState.playerCharacter.attributes),
      JSON.stringify(gameState.playerCharacter.status),
      JSON.stringify(gameState.playerCharacter.inventory),
      JSON.stringify(gameState.playerCharacter.skills),
      gameState.playerCharacter.notes || null,
      0, // is_npc = false
      gameState.playerCharacter.id
    );

    // 7. Save all NPC characters (with full NPCProfile attributes if available)
    if (gameState.npcCharacters.length > 0) {
      const npcStmt = database.prepare(`
        INSERT OR REPLACE INTO characters (
          character_id, name, attributes, status, inventory, skills, notes,
          is_npc, occupation, age, appearance, personality, background, goals, secrets, current_location,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `);

      for (const npc of gameState.npcCharacters) {
        // Type assertion to check if NPC has extended NPCProfile properties
        const npcWithExtras = npc as any;
        
        npcStmt.run(
          npc.id,
          npc.name,
          JSON.stringify(npc.attributes),
          JSON.stringify(npc.status),
          JSON.stringify(npc.inventory),
          JSON.stringify(npc.skills),
          npc.notes || null,
          1, // is_npc = true
          npcWithExtras.occupation || null,
          npcWithExtras.age || null,
          npcWithExtras.appearance || null,
          npcWithExtras.personality || null,
          npcWithExtras.background || null,
          npcWithExtras.goals ? JSON.stringify(npcWithExtras.goals) : null,
          npcWithExtras.secrets ? JSON.stringify(npcWithExtras.secrets) : null,
          npcWithExtras.currentLocation || null
        );
        
        // Save NPC clues if available
        if (npcWithExtras.clues && Array.isArray(npcWithExtras.clues)) {
          // Delete existing clues for this NPC
          database.prepare("DELETE FROM npc_clues WHERE npc_id = ?").run(npc.id);
          
          if (npcWithExtras.clues.length > 0) {
            const clueStmt = database.prepare(`
              INSERT INTO npc_clues (
                id, npc_id, clue_text, category, difficulty, revealed, related_to
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `);
            
            for (const clue of npcWithExtras.clues) {
              clueStmt.run(
                clue.id,
                npc.id,
                clue.clueText,
                clue.category || null,
                clue.difficulty || null,
                clue.revealed ? 1 : 0,
                clue.relatedTo ? JSON.stringify(clue.relatedTo) : null
              );
            }
          }
        }
        
        // Save NPC relationships if available
        if (npcWithExtras.relationships && Array.isArray(npcWithExtras.relationships)) {
          // Delete existing relationships for this NPC
          database.prepare("DELETE FROM npc_relationships WHERE source_id = ?").run(npc.id);
          
          if (npcWithExtras.relationships.length > 0) {
            const relStmt = database.prepare(`
              INSERT INTO npc_relationships (
                id, source_id, target_id, target_name, relationship_type,
                attitude, description, history
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            for (const rel of npcWithExtras.relationships) {
              const relId = `${npc.id}-to-${rel.targetId}`;
              relStmt.run(
                relId,
                npc.id,
                rel.targetId,
                rel.targetName,
                rel.relationshipType,
                rel.attitude || 0,
                rel.description || null,
                rel.history || null
              );
            }
          }
        }
      }
    }

    // 8. Save permanent scenario changes as game events (for timeline tracking)
    if (currentScenario.permanentChanges && currentScenario.permanentChanges.length > 0) {
      const eventStmt = database.prepare(`
        INSERT INTO game_events (
          event_type, session_id, timestamp, details, location, tags
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const change of currentScenario.permanentChanges) {
        eventStmt.run(
          "scenario_change",
          gameState.sessionId,
          new Date().toISOString(),
          JSON.stringify({
            snapshotId: currentScenario.id,
            change: change,
          }),
          currentScenario.location,
          JSON.stringify(["permanent_change", "scenario", "checkpoint"])
        );
      }
    }
  });

  console.log(
    `✓ Checkpoint created: ${currentScenario.name} (${currentScenario.id})`
  );
};

/**
 * Merge scenario state from checkpoint into current scenario snapshot
 * Preserves global state (player, discoveredClues, etc.) while restoring scenario-specific state
 */
const mergeScenarioStateFromCheckpoint = (
  originalSnapshot: ScenarioSnapshot,
  checkpointScenario: ScenarioSnapshot | null,
  currentGameState: GameState
): ScenarioSnapshot => {
  if (!checkpointScenario) {
    return originalSnapshot;
  }

  // Create a merged snapshot
  const mergedSnapshot: ScenarioSnapshot = {
    ...originalSnapshot,
    // Restore clue discovery states from checkpoint
    clues: originalSnapshot.clues.map(originalClue => {
      const checkpointClue = checkpointScenario.clues.find(c => c.id === originalClue.id);
      if (checkpointClue) {
        // Restore discovery state and details from checkpoint
        return {
          ...originalClue,
          discovered: checkpointClue.discovered,
          discoveryDetails: checkpointClue.discoveryDetails,
        };
      }
      return originalClue;
    }),
    // Restore permanent changes from checkpoint (merge with original to avoid duplicates)
    permanentChanges: [
      ...(originalSnapshot.permanentChanges || []),
      ...(checkpointScenario.permanentChanges || []).filter(
        change => !originalSnapshot.permanentChanges?.includes(change)
      )
    ],
    // Merge events (combine original and checkpoint events, avoiding duplicates)
    events: [
      ...(originalSnapshot.events || []),
      ...(checkpointScenario.events || []).filter(e => !originalSnapshot.events?.includes(e))
    ],
    // Merge conditions (prefer checkpoint conditions if they exist and are different)
    conditions: checkpointScenario.conditions.length > 0 
      ? checkpointScenario.conditions 
      : originalSnapshot.conditions,
    // Merge exits (prefer checkpoint exits if they exist)
    exits: checkpointScenario.exits && checkpointScenario.exits.length > 0
      ? checkpointScenario.exits
      : originalSnapshot.exits,
    // Keep checkpoint keeper notes if they exist
    keeperNotes: checkpointScenario.keeperNotes || originalSnapshot.keeperNotes,
  };

  return mergedSnapshot;
};

/**
 * Update current scenario with automatic checkpoint creation and restoration.
 * This should be called instead of directly calling GameStateManager.updateCurrentScenario
 * to ensure the current state is persisted before switching scenarios, and to restore
 * previous state when returning to a previously visited scenario.
 */
export const updateCurrentScenarioWithCheckpoint = async (
  manager: GameStateManager,
  scenarioData: { snapshot: ScenarioSnapshot; scenarioName: string } | null,
  db: CoCDatabase
): Promise<void> => {
  if (!scenarioData) return;

  const gameStateBefore = manager.getGameState() as GameState;

  // Create checkpoint for the current scenario before switching (if there is one)
  if (gameStateBefore.currentScenario) {
    await createScenarioCheckpoint(gameStateBefore, db);
  }

  // Check if we're returning to a previously visited scenario
  // If so, restore its state from the latest checkpoint
  const latestCheckpoint = db.findLatestCheckpointForScenario(
    gameStateBefore.sessionId,
    scenarioData.scenarioName,
    scenarioData.snapshot.id  // Also match by snapshot ID for more reliable matching
  );

  let targetSnapshot = scenarioData.snapshot;

  if (latestCheckpoint && latestCheckpoint.gameState?.currentScenario) {
    console.log(`📂 [Checkpoint] 发现场景 "${scenarioData.scenarioName}" 的历史 checkpoint，正在恢复场景状态...`);
    
    // Merge scenario state from checkpoint while preserving current global state
    targetSnapshot = mergeScenarioStateFromCheckpoint(
      scenarioData.snapshot,  // Original scenario from database
      latestCheckpoint.gameState.currentScenario,  // Scenario state from checkpoint
      gameStateBefore  // Current game state (to preserve global state)
    );

    console.log(`✓ [Checkpoint] 场景状态已恢复：`);
    console.log(`   - 已发现线索: ${targetSnapshot.clues.filter(c => c.discovered).length}/${targetSnapshot.clues.length}`);
    console.log(`   - 永久性变化: ${targetSnapshot.permanentChanges?.length || 0} 项`);
  } else {
    console.log(`📂 [Checkpoint] 场景 "${scenarioData.scenarioName}" 首次访问，使用原始状态`);
  }

  // Now update the scenario in memory with merged state
  manager.updateCurrentScenario({
    snapshot: targetSnapshot,
    scenarioName: scenarioData.scenarioName
  });
  
  // 设置场景转换标志，让 Keeper Agent 知道发生了场景变化
  manager.setTransitionFlag(true);
};

/**
 * Manually save a checkpoint with custom name
 */
export const saveManualCheckpoint = (
  gameState: GameState,
  db: CoCDatabase,
  checkpointName: string,
  description?: string
): string => {
  const checkpointId = `manual-${Date.now()}`;
  
  db.saveCheckpoint(
    checkpointId,
    gameState.sessionId,
    checkpointName,
    gameState,
    'manual',
    description
  );

  console.log(`✓ Manual checkpoint saved: "${checkpointName}" (ID: ${checkpointId})`);
  return checkpointId;
};

/**
 * Load a checkpoint and restore game state
 */
export const loadCheckpoint = (
  checkpointId: string,
  db: CoCDatabase
): GameState | null => {
  const checkpoint = db.loadCheckpoint(checkpointId);
  
  if (!checkpoint) {
    console.error(`Checkpoint not found: ${checkpointId}`);
    return null;
  }

  console.log(`✓ Loaded checkpoint: "${checkpoint.checkpointName}" from ${checkpoint.metadata.createdAt}`);
  return checkpoint.gameState as GameState;
};

/**
 * List all available checkpoints for current session
 */
export const listAvailableCheckpoints = (
  sessionId: string,
  db: CoCDatabase,
  limit = 20
): any[] => {
  return db.listCheckpoints(sessionId, limit);
};
