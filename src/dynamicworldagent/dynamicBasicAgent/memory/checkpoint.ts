/**
 * Checkpoint functionality for DynamicGameState
 * Saves complete game state to database before major updates
 */

import type { CoCDatabase } from "../../../coc_multiagents_system/agents/memory/database/index.js";
import type { DynamicGameState } from "../../state/index.js";
import { randomUUID } from "crypto";

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
    const serializableState = serializeDynamicGameState(dynamicState);
    
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
function serializeDynamicGameState(state: DynamicGameState): any {
  // Convert Sets to Arrays
  const revealedTruthEvents = Array.from(state.revealedTruthEvents);
  const activatedKnowledgeHolders = Array.from(state.activatedKnowledgeHolders);
  const deployedRedHerrings = Array.from(state.deployedRedHerrings);
  const mythosRevelations = Array.from(state.mythosRevelations);
  
  // Convert Map<string, DynamicScenarioSnapshot[]> to object
  // Only save the latest snapshot for each scenario (historical snapshots are not used currently)
  const updatedDynamicScenarioSnapshots: Record<string, any> = {};
  state.updatedDynamicScenarioSnapshots.forEach((snapshots, scenarioId) => {
    // Only save the latest snapshot (last in array)
    if (snapshots.length > 0) {
      const latestSnapshot = snapshots[snapshots.length - 1];
      updatedDynamicScenarioSnapshots[scenarioId] = {
        ...latestSnapshot,
        // Ensure Date objects are serialized as ISO strings
        timestamp: latestSnapshot.timestamp ? latestSnapshot.timestamp.toISOString() : undefined
      };
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
