/**
 * Checkpoint functionality for DynamicGameState
 * Saves complete game state to database before major updates
 */

import type { CoCDatabase } from "../../../shared/agents/memory/database/index.js";
import type { DynamicGameState } from "../../state/index.js";
import type { DynamicScenarioSnapshot } from "../../world_builder/types.js";
import { randomUUID } from "crypto";
import { resolveEmailId } from "../../../shared/agents/memory/database/userContext.js";
import { TurnManager } from "./turnManager.js";

/**
 * Save DynamicGameState checkpoint to database
 * Includes all historical snapshots for each scenario
 * 
 * @param db - Database instance
 * @param dynamicState - Complete DynamicGameState to save
 * @param checkpointType - Type of checkpoint ('auto' | 'manual' | 'scene_transition')
 * @param description - Optional description for the checkpoint
 * @returns Checkpoint ID if successful, null if failed
 */
export function saveDynamicGameStateCheckpoint(
  db: CoCDatabase,
  dynamicState: DynamicGameState,
  checkpointType: 'auto' | 'manual' | 'scene_transition' = 'auto',
  description?: string
): string | null {
  try {
    // Generate checkpoint ID based on type
    let checkpointId: string;
    if (checkpointType === 'manual') {
      checkpointId = `manual-${Date.now()}`;
    } else {
      checkpointId = randomUUID();
    }
    
    const checkpointName = generateCheckpointName(dynamicState, checkpointType);
    
    // Serialize DynamicGameState to JSON
    // Convert Sets to Arrays for JSON serialization
    const serializableState = serializeDynamicGameState(dynamicState, db);
    
    // Attach conversation history and player memos so the checkpoint is self-contained
    const turnManager = new TurnManager(db);
    serializableState.conversationHistory = turnManager.getConversation(dynamicState.sessionId);
    try {
      const database = db.getDatabase();
      serializableState.playerMemos = database.prepare(
        `SELECT memo_id, email_id, text, game_day, game_time, location, created_at, updated_at
         FROM player_memos WHERE session_id = ? ORDER BY created_at ASC`
      ).all(dynamicState.sessionId);
    } catch (error) {
      serializableState.playerMemos = [];
    }

    // Save to database using existing checkpoint infrastructure
    db.saveCheckpoint(
      checkpointId,
      dynamicState.sessionId,
      checkpointName,
      serializableState,
      checkpointType,
      description || generateCheckpointDescription(dynamicState, checkpointType)
    );
    
    console.log(`💾 [Checkpoint] Saved ${checkpointType} checkpoint: ${checkpointName} (${checkpointId})`);
    return checkpointId;
  } catch (error) {
    console.error(`❌ [Checkpoint] Failed to save checkpoint:`, error);
    // Don't throw - checkpoint failure shouldn't block game updates
    return null;
  }
}

/**
 * Serialize DynamicGameState for database storage
 * Converts Sets to Arrays and ensures all data is JSON-serializable
 */
function serializeDynamicGameState(state: DynamicGameState, db: CoCDatabase): any {
  // Convert Sets to Arrays
  const revealedTruthEvents = Array.from(state.revealedTruthEvents);
  const activatedKnowledgeHolders = Array.from(state.activatedKnowledgeHolders);
  const deployedRedHerrings = Array.from(state.deployedRedHerrings);
  const mythosRevelations = Array.from(state.mythosRevelations);
  
  // Convert Map<string, DynamicScenarioSnapshot[]> to object
  // Only save the latest snapshot for each scenario in checkpoint
  // Historical snapshots are saved to database separately
  const updatedDynamicScenarioSnapshots: Record<string, any> = {};
  state.updatedDynamicScenarioSnapshots.forEach((snapshots, scenarioId) => {
    // Only save the latest snapshot (last in array) to checkpoint
    if (snapshots.length > 0) {
      const latestSnapshot = snapshots[snapshots.length - 1];
      updatedDynamicScenarioSnapshots[scenarioId] = {
        ...latestSnapshot,
        // Ensure Date objects are serialized as ISO strings
        timestamp: latestSnapshot.timestamp ? latestSnapshot.timestamp.toISOString() : undefined
      };
      
      // Save historical snapshots (all except the latest) to database
      if (snapshots.length > 1) {
        const historicalSnapshots = snapshots.slice(0, -1); // All except the last one
        saveHistoricalSnapshotsToDatabase(db, scenarioId, historicalSnapshots);
      }
    }
  });
  
  // Convert Date objects to ISO strings
  const serializedState = {
    ...state,
    revealedTruthEvents,
    activatedKnowledgeHolders,
    deployedRedHerrings,
    mythosRevelations,
    updatedDynamicScenarioSnapshots,
    loadedAt: state.loadedAt.toISOString(),
    lastUpdated: state.lastUpdated.toISOString(),
    lastPlayerInputTime: state.lastPlayerInputTime ? state.lastPlayerInputTime.toISOString() : null,
    // Ensure temporaryInfo doesn't have circular references
    temporaryInfo: {
      ...state.temporaryInfo,
      // Convert any Date objects in temporaryInfo
      contextualData: state.temporaryInfo.contextualData ? 
        JSON.parse(JSON.stringify(state.temporaryInfo.contextualData)) : null
    }
  };
  
  return serializedState;
}

/**
 * Generate checkpoint name based on game state and type
 */
function generateCheckpointName(
  state: DynamicGameState,
  checkpointType: 'auto' | 'manual' | 'scene_transition'
): string {
  const sceneName = state.currentScenario?.name || 'Unknown Scene';
  const gameTime = `Day ${state.gameDay}, ${state.timeOfDay}`;
  
  switch (checkpointType) {
    case 'manual':
      return `Manual Save - ${sceneName} (${gameTime})`;
    case 'scene_transition':
      return `Scene Transition - ${sceneName} (${gameTime})`;
    case 'auto':
    default:
      return `Auto Save - ${sceneName} (${gameTime})`;
  }
}

/**
 * Generate checkpoint description
 */
function generateCheckpointDescription(
  state: DynamicGameState,
  checkpointType: 'auto' | 'manual' | 'scene_transition'
): string {
  const sceneName = state.currentScenario?.name || 'Unknown Scene';
  const location = state.currentScenario?.location || 'Unknown Location';
  const gameTime = `Day ${state.gameDay}, ${state.timeOfDay}`;
  const scenarioCount = state.updatedDynamicScenarioSnapshots.size;
  
  let description = `${checkpointType === 'manual' ? 'Manual' : checkpointType === 'scene_transition' ? 'Scene transition' : 'Automatic'} checkpoint. `;
  description += `Scene: ${sceneName} (${location}). `;
  description += `Game Time: ${gameTime}. `;
  description += `Scenarios with snapshots: ${scenarioCount}.`;
  
  return description;
}

/**
 * Save historical snapshots to database
 * These are snapshots that are not the latest (all except the last one)
 */
function saveHistoricalSnapshotsToDatabase(
  db: CoCDatabase,
  scenarioId: string,
  historicalSnapshots: DynamicScenarioSnapshot[]
): void {
  try {
    const database = db.getDatabase();
    const emailId = resolveEmailId();
    const hasInitialSnapshot = db.hasColumn("scenario_snapshots", "initial_snapshot");
    const hasGameTime = db.hasColumn("scenario_snapshots", "game_time");
    const hasDynamicHistorical = db.hasColumn("scenario_snapshots", "is_dynamic_historical");
    const hasSnapshotEmailId = db.hasColumn("scenario_snapshots", "email_id");
    const hasCharacterEmailId = db.hasColumn("scenario_characters", "email_id");
    const hasClueEmailId = db.hasColumn("scenario_clues", "email_id");
    const hasConditionEmailId = db.hasColumn("scenario_conditions", "email_id");

    for (const snapshot of historicalSnapshots) {
      // Generate a unique snapshot ID for historical snapshot
      const historicalSnapshotId = `hist-${scenarioId}-${Date.now()}-${randomUUID().slice(0, 8)}`;
      
      // Check if snapshot already exists
      const existing = database
        .prepare(`SELECT snapshot_id FROM scenario_snapshots WHERE snapshot_id = ?${hasSnapshotEmailId && emailId ? " AND email_id = ?" : ""}`)
        .get(...(hasSnapshotEmailId && emailId ? [historicalSnapshotId, emailId] : [historicalSnapshotId]));

      if (existing) {
        continue; // Skip if already exists
      }

      // Insert snapshot
      if (hasInitialSnapshot && hasGameTime && hasDynamicHistorical) {
        const snapshotStmt = database.prepare(`
          INSERT INTO scenario_snapshots (
            snapshot_id, scenario_id, snapshot_name, location, description,
            events, exits, keeper_notes, time_restriction, show_map,
            initial_snapshot, game_time, is_dynamic_historical
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        snapshotStmt.run(
          historicalSnapshotId,
          scenarioId,
          snapshot.name || `Historical snapshot for ${scenarioId}`,
          snapshot.location,
          snapshot.description,
          JSON.stringify([]), // events removed
          JSON.stringify([]), // exits removed
          snapshot.keeperNotes || null,
          snapshot.timeRestriction || null,
          snapshot.showMap === false ? 0 : 1,
          0, // initial_snapshot = false
          snapshot.gameTime || null,
          1 // is_dynamic_historical = true
        );
      } else if (hasInitialSnapshot && hasGameTime) {
        const snapshotStmt = database.prepare(`
          INSERT INTO scenario_snapshots (
            snapshot_id, scenario_id, snapshot_name, location, description,
            events, exits, keeper_notes, time_restriction, show_map,
            initial_snapshot, game_time
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        snapshotStmt.run(
          historicalSnapshotId,
          scenarioId,
          snapshot.name || `Historical snapshot for ${scenarioId}`,
          snapshot.location,
          snapshot.description,
          JSON.stringify([]),
          JSON.stringify([]),
          snapshot.keeperNotes || null,
          snapshot.timeRestriction || null,
          snapshot.showMap === false ? 0 : 1,
          0,
          snapshot.gameTime || null
        );
      } else {
        const snapshotStmt = database.prepare(`
          INSERT INTO scenario_snapshots (
            snapshot_id, scenario_id, snapshot_name, location, description,
            events, exits, keeper_notes, time_restriction, show_map
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        snapshotStmt.run(
          historicalSnapshotId,
          scenarioId,
          snapshot.name || `Historical snapshot for ${scenarioId}`,
          snapshot.location,
          snapshot.description,
          JSON.stringify([]),
          JSON.stringify([]),
          snapshot.keeperNotes || null,
          snapshot.timeRestriction || null,
          snapshot.showMap === false ? 0 : 1
        );
      }
      if (hasSnapshotEmailId && emailId) {
        database
          .prepare("UPDATE scenario_snapshots SET email_id = ? WHERE snapshot_id = ?")
          .run(emailId, historicalSnapshotId);
      }

      // Insert characters if present
      if (snapshot.characters && snapshot.characters.length > 0) {
        const charStmt = database.prepare(`
          INSERT OR IGNORE INTO scenario_characters (
            id, snapshot_id, character_name, character_role, character_status,
            character_location, character_notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const char of snapshot.characters) {
          const charId = char.id || `${historicalSnapshotId}-char-${randomUUID().slice(0, 8)}`;
          charStmt.run(
            charId,
            historicalSnapshotId,
            char.name,
            char.role,
            char.status,
            char.location || null,
            char.notes || null
          );
          if (hasCharacterEmailId && emailId) {
            database
              .prepare("UPDATE scenario_characters SET email_id = ? WHERE id = ?")
              .run(emailId, charId);
          }
        }
      }

      // Insert clues if present
      if (snapshot.clues && snapshot.clues.length > 0) {
        const clueStmt = database.prepare(`
          INSERT OR IGNORE INTO scenario_clues (
            clue_id, snapshot_id, clue_text, category, difficulty,
            clue_location, discovery_method, reveals, discovered, discovery_details
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const clue of snapshot.clues) {
          const clueId = clue.id || `${historicalSnapshotId}-clue-${randomUUID().slice(0, 8)}`;
          clueStmt.run(
            clueId,
            historicalSnapshotId,
            clue.clueText,
            clue.category,
            clue.difficulty,
            clue.location,
            clue.discoveryMethod || null,
            JSON.stringify(clue.reveals || []),
            clue.discovered ? 1 : 0,
            clue.discoveryDetails ? JSON.stringify(clue.discoveryDetails) : null
          );
          if (hasClueEmailId && emailId) {
            database
              .prepare("UPDATE scenario_clues SET email_id = ? WHERE clue_id = ?")
              .run(emailId, clueId);
          }
        }
      }

      // Insert conditions if present
      if (snapshot.conditions && snapshot.conditions.length > 0) {
        const conditionStmt = database.prepare(`
          INSERT OR IGNORE INTO scenario_conditions (
            condition_id, snapshot_id, condition_type, description, mechanical_effect
          ) VALUES (?, ?, ?, ?, ?)
        `);

        for (const condition of snapshot.conditions) {
          const conditionId = `${historicalSnapshotId}-cond-${randomUUID().slice(0, 8)}`;
          conditionStmt.run(
            conditionId,
            historicalSnapshotId,
            condition.type,
            condition.description,
            condition.mechanicalEffect || null
          );
          if (hasConditionEmailId && emailId) {
            database
              .prepare("UPDATE scenario_conditions SET email_id = ? WHERE condition_id = ?")
              .run(emailId, conditionId);
          }
        }
      }
    }

    console.log(`💾 [Checkpoint] Saved ${historicalSnapshots.length} historical snapshots to database for scenario ${scenarioId}`);
  } catch (error) {
    console.error(`❌ [Checkpoint] Failed to save historical snapshots to database:`, error);
    // Don't throw - snapshot save failure shouldn't block checkpoint save
  }
}
