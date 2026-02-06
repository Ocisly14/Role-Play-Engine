import { getScenarioUpdateTemplate, getPlayerSceneSwitchTemplate, getGlobalTriggerEventCheckTemplate, getStuckHintNarrativeTemplate } from "./directorTemplate.js";
import { composeTemplate } from "../../../template.js";
import type { ScenarioCharacter } from "../../../shared/agents/models/scenarioTypes.js";
import type { DynamicScenarioSnapshot } from "../../world_builder/types.js";
import { ScenarioLoader } from "../../../shared/agents/memory/scenarioloader/index.js";
import type { CoCDatabase } from "../../../shared/agents/memory/database/index.js";
import type { DynamicGameState } from "../../state/index.js";
import { DynamicGameStateManager } from "../../state/index.js";
import type { ActionLogEntry, CharacterStatus, InventoryItem, NPCRelationship } from "../../../shared/agents/models/gameTypes.js";
import type { DynamicCharacterProfile } from "../../world_builder/types.js";
import type { DynamicNPCProfile } from "../../world_builder/types.js";
import { InventoryUtils } from "../../../shared/agents/models/gameTypes.js";
import type { ScenarioConnectionType } from "../../world_builder/types.js";
import {
  ModelProviderName,
  ModelClass,
  generateText,
} from "../../../models/index.js";
import * as fs from "fs";
import * as path from "path";
import { saveDynamicGameStateCheckpoint } from "../memory/checkpoint.js";

interface DirectorRuntime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): DirectorRuntime => ({
  modelProvider: (process.env.MODEL_PROVIDER as ModelProviderName) || ModelProviderName.OPENAI,
  getSetting: (key: string) => process.env[key],
});

/**
 * Director Agent - Story progression and scene transition director
 * Responsible for monitoring game progress and advancing story development
 */
export class DirectorAgent {
  private scenarioLoader: ScenarioLoader;
  private db: CoCDatabase;

  constructor(scenarioLoader: ScenarioLoader, db: CoCDatabase) {
    this.scenarioLoader = scenarioLoader;
    this.db = db;
  }


  /**
   * Execute scene transition (shared logic)
   */
  private async executeSceneTransition(
    targetSnapshot: DynamicScenarioSnapshot,
    scenarioName: string,
    gameStateManager: DynamicGameStateManager
  ): Promise<void> {
    const dynamicState = gameStateManager.getState();
    
    console.log(`\n🔄 [Executing Scene Transition]:`);
    console.log(`   To: ${targetSnapshot.name}`);
    console.log(`   Location: ${targetSnapshot.location}`);
    
    try {
      // For DynamicWorld, use updateCurrentScenario directly
      // Checkpoint functionality can be added later if needed
      gameStateManager.updateCurrentScenario({
        snapshot: targetSnapshot,
        scenarioName: scenarioName
      });
      // Note: Scene change is now tracked via temporaryInfo.sceneChangeRequest
      
      const updatedState = gameStateManager.getState();
      
      console.log(`   ✓ Scene transition completed successfully`);
      console.log(`\n📍 [Post-Transition State]:`);
      console.log(`   Current Scene: ${updatedState.currentScenario?.name || 'None'}`);
      console.log(`   Scene ID: ${updatedState.currentScenario?.id || 'None'}`);
      console.log(`   Location: ${updatedState.currentScenario?.location || 'None'}`);
      
      console.log(`\n✅ [Director Agent] Scene transition completed`);
      console.log(`🎬 [Director Agent] ========================================\n`);
      
    } catch (error) {
      console.error(`   ❌ Scene transition failed:`, error);
      throw error;
    }
  }

  /**
   * Handle scene change request initiated by Action Agent
   * Use map data and LLM to validate and select target scene
   */
  async handleActionDrivenSceneChange(
    gameStateManager: DynamicGameStateManager,
    targetSceneName: string,
    reason: string,
    currentCharacterInput?: string
  ): Promise<void> {
    console.log(`\n🎬 [Director Agent] ========================================`);
    console.log(`🎬 [Director Agent] Starting to process Action-driven scene transition`);
    console.log(`🎬 [Director Agent] ========================================`);

    const dynamicState = gameStateManager.getState();
    const currentScenario = dynamicState.currentScenario;
    const sceneChangeRequest = dynamicState.temporaryInfo.sceneChangeRequest;

    // Save current scenario as previousScenario for Keeper to access
    if (currentScenario) {
      dynamicState.temporaryInfo.previousScenario = { ...currentScenario };
      console.log(`\n💾 [Director Agent] Saved previous scenario: ${currentScenario.name}`);
    }

    // Log current state
    console.log(`\n📍 [Current Scene State]:`);
    if (currentScenario) {
      console.log(`   Scene Name: ${currentScenario.name}`);
      console.log(`   Scene ID: ${currentScenario.id}`);
      console.log(`   Location: ${currentScenario.location}`);
      console.log(`   Description: ${currentScenario.description ? currentScenario.description.substring(0, 100) + '...' : 'None'}`);
    } else {
      console.log(`   ⚠️  No current scene`);
    }

    // Log target scene request
    console.log(`\n🎯 [Scene Transition Request]:`);
    console.log(`   Target Scene Name: ${targetSceneName}`);
    console.log(`   Transition Reason: ${reason}`);

    // Check if scene change request exists
    if (!sceneChangeRequest?.shouldChange) {
      console.log(`   ⚠️  No scene change request found, skipping transition`);
      return;
    }

    // Step 1: Unified update - validates target + generates all snapshots (complete target + simplified background)
    console.log(`\n🔄 [Director Agent] Updating scenarios for scene switch...`);
    const updateResult = await this.updateScenariosForSceneSwitch(gameStateManager);

    if (!updateResult) {
      // Validation failed, clear scene change request and return
      console.error(`   ❌ Scene change validation failed`);
      gameStateManager.clearSceneChangeRequest();
      return;
    }

    const { validatedTargetSceneName, targetSnapshot, backgroundSnapshots, modifiedConnections } = updateResult;

    console.log(`   ✓ Validated target scene: ${validatedTargetSceneName}`);
    console.log(`   ✓ Generated complete target snapshot + ${backgroundSnapshots.size} background snapshots`);
    if (modifiedConnections) {
      console.log(`   ✓ Updated ${modifiedConnections.length} connections for target scene`);
    }

    // Step 2: Find target scenario outline to get scenarioId
    const targetScenarioOutline = dynamicState.scenarioOutlines.find(
      outline => outline.name === validatedTargetSceneName
    );

    if (!targetScenarioOutline) {
      console.error(`   ❌ Target scenario outline not found for: ${validatedTargetSceneName}`);
      gameStateManager.clearSceneChangeRequest();
      return;
    }

    // Step 3: Save all snapshots to state (using scenarioId as key)
    // Ensure gameStateManager has db for snapshot management
    gameStateManager.setDb(this.db);
    gameStateManager.setUpdatedDynamicScenarioSnapshot(
      targetScenarioOutline.id,
      targetSnapshot
    );

    backgroundSnapshots.forEach((snapshot, scenarioId) => {
      gameStateManager.setUpdatedDynamicScenarioSnapshot(scenarioId, snapshot);
    });

    console.log(`   ✓ Saved all snapshots to state`);

    // Step 4: Execute scene transition using the UPDATED complete snapshot
    console.log(`\n🔄 [Executing Scene Transition]:`);
    console.log(`   To: ${targetSnapshot.name}`);
    console.log(`   Location: ${targetSnapshot.location}`);

    await this.executeSceneTransition(
      targetSnapshot,
      validatedTargetSceneName,
      gameStateManager
    );

    // Step 5: Clean up scene change request
    gameStateManager.clearSceneChangeRequest();

    console.log(`✅ [Director Agent] Scene change completed successfully`);
    console.log(`🎬 [Director Agent] ========================================\n`);
  }

  /**
   * Check if story progression should trigger and return recent player actionLog
   */
  async checkStoryProgression(
    gameStateManager: DynamicGameStateManager
  ): Promise<{ shouldTrigger: boolean; recentActionLog: ActionLogEntry[] }> {
    const dynamicState = gameStateManager.getState();

    // Get metrics
    const turnsInScene = gameStateManager.getTurnsInCurrentScene();
    const threshold = gameStateManager.getProgressionThreshold();
    const minutesSinceInput = gameStateManager.getMinutesSinceLastInput();

    console.log(`\n🎬 [Director Agent] Story Progression Check`);
    console.log(`   Turns in scene: ${turnsInScene} / ${threshold}`);
    console.log(`   Minutes since input: ${minutesSinceInput} / 3`);
    console.log(`   Tension: ${dynamicState.tension}/10`);
    console.log(`   Consecutive triggers: ${dynamicState.consecutiveProgressionTriggers} / 3`);

    // Check if either threshold is reached
    const shouldTrigger = gameStateManager.shouldTriggerProgression();

    if (!shouldTrigger) {
      if (dynamicState.consecutiveProgressionTriggers >= 3) {
        console.log(`   ⚠️ Max consecutive triggers reached (3), skipping to prevent infinite loop`);
      } else {
        console.log(`   ✓ No trigger conditions met`);
      }
      return { shouldTrigger: false, recentActionLog: [] };
    }

    // Increment consecutive trigger count
    gameStateManager.incrementConsecutiveTriggers();
    const currentTriggerCount = gameStateManager.getState().consecutiveProgressionTriggers;

    // Log which condition triggered
    if (turnsInScene >= threshold) {
      console.log(`   ⚠️ Turn threshold reached! Getting recent player actions... (trigger ${currentTriggerCount}/3)`);
    } else if (minutesSinceInput >= 3) {
      console.log(`   ⚠️ Time threshold reached (3 min idle)! Getting recent player actions... (trigger ${currentTriggerCount}/3)`);
    }

    // Get player's actionLog from the last 3 turns
    const playerActionLog = dynamicState.playerCharacter.actionLog || [];
    
    // Get recent conversation history to determine which actionLog entries belong to last 3 turns
    const conversationHistory = (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
      turnNumber: number;
      characterInput: string;
      keeperNarrative: string | null;
      actionAnalysis?: any;
    }>) || [];

    // Get last 3 turns
    const last3Turns = conversationHistory.slice(-3);
    const last3TurnNumbers = new Set(last3Turns.map(t => t.turnNumber));

    // Filter actionLog entries that belong to the last 3 turns
    // We'll use a simple approach: get the last N entries where N is roughly the number of actions in 3 turns
    // Or we can get all actionLog entries and let Character Agent analyze them
    // For simplicity, let's get the last 10-15 entries (assuming 3-5 actions per turn)
    const recentActionLog = playerActionLog.slice(-15);

    if (recentActionLog.length > 0) {
      console.log(`   ✓ Found ${recentActionLog.length} recent actionLog entries`);
      console.log(`   Latest actions: ${recentActionLog.slice(-3).map(a => a.summary).join("; ")}`);
    } else {
      console.log(`   ⚠️ No recent actionLog entries found`);
    }

    return { shouldTrigger: true, recentActionLog };
  }

  /**
   * Parse game time from snapshot gameTime string or actionLog time
   * Format: "Day N, HH:MM" or "initial" or other formats
   */
  private parseGameTimeFromSnapshot(gameTime?: string): { gameDay: number; timeOfDay: string } | null {
    if (!gameTime) return null;
    
    // Handle "initial" or other non-standard formats
    if (gameTime.toLowerCase() === "initial" || !gameTime.includes("Day")) {
      return null; // Cannot parse, treat as before any valid time
    }
    
    const match = gameTime.match(/Day\s*(\d+),\s*(\d{2}:\d{2})/i);
    if (match) {
      return {
        gameDay: parseInt(match[1], 10),
        timeOfDay: match[2]
      };
    }
    
    return null;
  }

  /**
   * Get all scenarios with their latest snapshots (excluding player's current scene)
   * Gets snapshots from dynamicState.updatedDynamicScenarioSnapshots or scenarioLoader (initial snapshots)
   */
  private async getAllScenariosLatestSnapshots(
    currentScenarioId: string | null,
    currentGameDay: number,
    currentTimeOfDay: string,
    dynamicState: DynamicGameState
  ): Promise<Array<{
    scenarioId: string;
    scenarioName: string;
    snapshot: DynamicScenarioSnapshot;
  }>> {
    const allScenarios = this.scenarioLoader.getAllScenarios();
    
    const scenariosWithLatestSnapshots: Array<{
      scenarioId: string;
      scenarioName: string;
      snapshot: DynamicScenarioSnapshot;
    }> = [];

    for (const scenario of allScenarios) {
      // Skip player's current scenario
      if (currentScenarioId && scenario.id === currentScenarioId) {
        continue;
      }

      // Try to get latest updated snapshot from dynamicState first
      const snapshots = dynamicState.updatedDynamicScenarioSnapshots.get(scenario.id);
      let snapshot: DynamicScenarioSnapshot | null = null;
      
      if (snapshots && snapshots.length > 0) {
        // Get the latest snapshot (last in array)
        snapshot = snapshots[snapshots.length - 1];
      }
      
      // If no updated snapshot, get initial snapshot from scenarioLoader
      if (!snapshot) {
        const scenarioProfile = this.scenarioLoader.getScenarioById(scenario.id);
        if (scenarioProfile && scenarioProfile.snapshot) {
          snapshot = scenarioProfile.snapshot;
        }
      }

      if (snapshot) {
        scenariosWithLatestSnapshots.push({
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          snapshot: snapshot
        });
      }
    }

    return scenariosWithLatestSnapshots;
  }

  /**
   * Get current location from actionLog (latest entry with location)
   */
  private getCurrentLocationFromActionLog(actionLog?: ActionLogEntry[]): string | null {
    if (!actionLog || actionLog.length === 0) {
      return null;
    }
    
    // Find the latest entry with a location (iterate backwards)
    for (let i = actionLog.length - 1; i >= 0; i--) {
      if (actionLog[i].location) {
        return actionLog[i].location;
      }
    }
    
    return null;
  }

  /**
   * Get NPCs that should be in a specific scenario at the current time point
   * Based on NPC's actionLog location and scenario conditions
   */
  private getNPCsForScenario(
    scenarioLocation: string,
    scenarioId: string,
    npcCharacters: DynamicNPCProfile[],
    previousSnapshotTime: string | undefined,
    currentGameTime: string
  ): Array<{
    id: string;
    name: string;
    occupation?: string;
    age?: number;
    gender?: string;
    appearance?: string;
    personality?: string;
    background?: string;
    goals?: string[];
    secrets?: string[];
    notes?: string;
    status: CharacterStatus;
    inventory: InventoryItem[];
    relationships: NPCRelationship[];
    actionLog: ActionLogEntry[]; // Timeline from previous snapshot to current time
    instantiatedFrom?: string | null; // Knowledge holder ID (ROLE/ORGANIZATION)
    inheritsKnowledge?: string[]; // Truth event IDs this NPC knows
  }> {
    const npcsInScenario: Array<{
      id: string;
      name: string;
      occupation?: string;
      age?: number;
      gender?: string;
      appearance?: string;
      personality?: string;
      background?: string;
      goals?: string[];
      secrets?: string[];
      notes?: string;
      status: CharacterStatus;
      inventory: InventoryItem[];
      relationships: NPCRelationship[];
      actionLog: ActionLogEntry[];
      instantiatedFrom?: string | null;
      inheritsKnowledge?: string[];
    }> = [];

    for (const npc of npcCharacters) {
      const npcProfile = npc;
      
      // Check if NPC is currently in this scenario location
      // Get current location from actionLog (latest entry with location)
      const currentLocation = this.getCurrentLocationFromActionLog(npcProfile.actionLog);
      let isInScenario = false;
      
      if (currentLocation && 
          currentLocation.toLowerCase() === scenarioLocation.toLowerCase()) {
        isInScenario = true;
      }
      
      if (isInScenario) {
        // Extract timeline actionLog from previous snapshot time to current time
        // This creates a timeline of events that happened in this scenario during the time period
        let timelineActionLog: ActionLogEntry[] = [];
        
        if (npcProfile.actionLog && npcProfile.actionLog.length > 0) {
          // Filter actionLog entries that fall between previous snapshot time and current time
          // This represents what happened in the scenario during this time period
          timelineActionLog = npcProfile.actionLog.filter(log => {
            // Skip entries with invalid time formats (like "initial")
            const logTime = this.parseGameTimeFromSnapshot(log.time);
            if (!logTime) {
              // If time is "initial" or invalid, only include if no previous snapshot time
              // (meaning this is the first update)
              return !previousSnapshotTime;
            }
            
            // If no previous snapshot time, include all entries up to current time
            if (!previousSnapshotTime) {
              return this.isTimeBeforeOrEqual(log.time, currentGameTime);
            }
            
            // Include entries between previous snapshot time and current time
            // (exclusive of previous time, inclusive of current time)
            return this.isTimeAfter(log.time, previousSnapshotTime) && 
                   this.isTimeBeforeOrEqual(log.time, currentGameTime);
          });
          
          // Sort by time to ensure chronological order
          timelineActionLog.sort((a, b) => {
            const timeA = this.parseGameTimeFromSnapshot(a.time);
            const timeB = this.parseGameTimeFromSnapshot(b.time);
            if (!timeA || !timeB) return 0;
            if (timeA.gameDay !== timeB.gameDay) return timeA.gameDay - timeB.gameDay;
            const [hA, mA] = timeA.timeOfDay.split(':').map(Number);
            const [hB, mB] = timeB.timeOfDay.split(':').map(Number);
            return hA * 60 + mA - (hB * 60 + mB);
          });
        }
        
        npcsInScenario.push({
          id: npcProfile.id,
          name: npcProfile.name,
          occupation: npcProfile.occupation,
          age: npcProfile.age,
          gender: npcProfile.gender,
          appearance: npcProfile.appearance,
          personality: npcProfile.personality,
          background: npcProfile.background,
          goals: npcProfile.goals,
          secrets: npcProfile.secrets,
          notes: npcProfile.notes,
          status: npcProfile.status, // Full CharacterStatus object
          inventory: npcProfile.inventory || [], // InventoryItem[]
          relationships: npcProfile.relationships || [], // NPCRelationship[]
          actionLog: timelineActionLog,
          // DynamicWorld specific fields for matching with knowledge matrix
          instantiatedFrom: npcProfile.instantiatedFrom || null, // Knowledge holder ID (ROLE/ORGANIZATION)
          inheritsKnowledge: npcProfile.inheritsKnowledge || [] // Truth event IDs this NPC knows
        });
      }
    }
    
    return npcsInScenario;
  }

  /**
   * Compare game times (format: "Day N, HH:MM")
   * Returns true if time1 is before or equal to time2
   */
  private isTimeBeforeOrEqual(time1: string, time2: string): boolean {
    const t1 = this.parseGameTimeFromSnapshot(time1);
    const t2 = this.parseGameTimeFromSnapshot(time2);
    
    if (!t1 || !t2) return false;
    
    if (t1.gameDay < t2.gameDay) return true;
    if (t1.gameDay > t2.gameDay) return false;
    
    // Same day, compare time
    const [h1, m1] = t1.timeOfDay.split(':').map(Number);
    const [h2, m2] = t2.timeOfDay.split(':').map(Number);
    
    return h1 < h2 || (h1 === h2 && m1 <= m2);
  }

  /**
   * Compare game times (format: "Day N, HH:MM")
   * Returns true if time1 is after time2
   */
  private isTimeAfter(time1: string, time2: string): boolean {
    const t1 = this.parseGameTimeFromSnapshot(time1);
    const t2 = this.parseGameTimeFromSnapshot(time2);
    
    if (!t1 || !t2) return false;
    
    if (t1.gameDay > t2.gameDay) return true;
    if (t1.gameDay < t2.gameDay) return false;
    
    // Same day, compare time
    const [h1, m1] = t1.timeOfDay.split(':').map(Number);
    const [h2, m2] = t2.timeOfDay.split(':').map(Number);
    
    return h1 > h2 || (h1 === h2 && m1 > m2);
  }

  /**
   * Find NPC by ID with fuzzy matching fallback
   * 1st priority: Exact match (case-sensitive)
   * 2nd priority: Fuzzy match (case-insensitive, normalized)
   */
  private findNPCById(
    npcCharacters: DynamicNPCProfile[],
    targetId: string,
    targetName?: string
  ): DynamicNPCProfile | null {
    // Stage 1: Exact match (case-sensitive)
    const exactMatch = npcCharacters.find(npc => npc.id === targetId);
    if (exactMatch) {
      return exactMatch;
    }

    // Stage 2: Fuzzy match by ID (case-insensitive, normalized)
    const normalizeId = (id: string) => id.toLowerCase().trim().replace(/[\s_-]/g, '');
    const normalizedTargetId = normalizeId(targetId);

    let bestMatch: DynamicNPCProfile | null = null;
    let bestScore = 0;

    for (const npc of npcCharacters) {
      const normalizedNpcId = normalizeId(npc.id);

      // Calculate similarity score
      let score = 0;

      // Check if normalized IDs match
      if (normalizedNpcId === normalizedTargetId) {
        score = 0.9; // High score for normalized match
      } else if (normalizedNpcId.includes(normalizedTargetId) || normalizedTargetId.includes(normalizedNpcId)) {
        score = 0.7; // Medium score for substring match
      }

      // Bonus: Check name similarity if provided
      if (targetName && npc.name) {
        const normalizedTargetName = normalizeId(targetName);
        const normalizedNpcName = normalizeId(npc.name);

        if (normalizedNpcName === normalizedTargetName) {
          score += 0.3;
        } else if (normalizedNpcName.includes(normalizedTargetName) || normalizedTargetName.includes(normalizedNpcName)) {
          score += 0.2;
        }
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = npc;
      }
    }

    // Only return fuzzy match if score is above threshold
    if (bestScore >= 0.5) {
      console.log(`   ℹ️  Fuzzy matched "${targetId}"${targetName ? ` (${targetName})` : ''} → "${bestMatch?.id}" (${bestMatch?.name}) [score: ${bestScore.toFixed(2)}]`);
      return bestMatch;
    }

    return null;
  }

  /**
   * Merge character delta updates from snapshot to actual NPC data
   * Applies status changes, inventory add/remove, and relationship updates
   */
  private mergeCharacterDeltaToNPC(
    npc: DynamicNPCProfile,
    delta: {
      status?: Partial<CharacterStatus>;
      inventory?: { add?: InventoryItem[]; remove?: InventoryItem[] } | InventoryItem[];
      relationships?: NPCRelationship[];
      actionLog?: ActionLogEntry[];
    }
  ): void {
    // Apply status delta (only changed attributes)
    if (delta.status) {
      for (const [key, value] of Object.entries(delta.status)) {
        if (typeof value === 'number' && key in npc.status) {
          // Apply differential update (e.g., hp: -2 means subtract 2)
          (npc.status as any)[key] += value;
          
          // Ensure values don't go below 0 (except for conditions array)
          if (key !== 'conditions' && (npc.status as any)[key] < 0) {
            (npc.status as any)[key] = 0;
          }
          
          // Ensure hp/sanity don't exceed max
          if (key === 'hp' && npc.status.hp > npc.status.maxHp) {
            npc.status.hp = npc.status.maxHp;
          }
          if (key === 'sanity' && npc.status.sanity > npc.status.maxSanity) {
            npc.status.sanity = npc.status.maxSanity;
          }
        }
      }
    }

    // Apply inventory delta (add/remove format)
    if (delta.inventory) {
      npc.inventory = InventoryUtils.normalizeInventory(npc.inventory);
      
      if (Array.isArray(delta.inventory)) {
        // Replace entire inventory (legacy support)
        npc.inventory = InventoryUtils.normalizeInventory(delta.inventory);
      } else if (typeof delta.inventory === 'object' && !Array.isArray(delta.inventory)) {
        // Support { add: [...], remove: [...] } format
        if (delta.inventory.add) {
          const itemsToAdd = Array.isArray(delta.inventory.add) 
            ? delta.inventory.add 
            : [delta.inventory.add];
          npc.inventory = InventoryUtils.addItems(
            npc.inventory, 
            InventoryUtils.normalizeInventory(itemsToAdd)
          );
        }
        
        if (delta.inventory.remove) {
          const itemsToRemove = Array.isArray(delta.inventory.remove)
            ? delta.inventory.remove
            : [delta.inventory.remove];
          npc.inventory = InventoryUtils.removeItems(
            npc.inventory, 
            InventoryUtils.normalizeInventory(itemsToRemove)
          );
        }
      }
    }

    // Apply relationship updates (merge new/changed relationships)
    if (delta.relationships && delta.relationships.length > 0) {
      for (const newRel of delta.relationships) {
        const existingIndex = npc.relationships.findIndex(r => r.targetId === newRel.targetId);
        if (existingIndex >= 0) {
          // Update existing relationship
          npc.relationships[existingIndex] = newRel;
        } else {
          // Add new relationship
          npc.relationships.push(newRel);
        }
      }
    }

    // Merge actionLog (append new entries)
    if (delta.actionLog && delta.actionLog.length > 0) {
      if (!npc.actionLog) {
        npc.actionLog = [];
      }
      // Append new actionLog entries (avoid duplicates by checking time+location+summary)
      for (const newEntry of delta.actionLog) {
        const isDuplicate = npc.actionLog.some(
          existing => 
            existing.time === newEntry.time &&
            existing.location === newEntry.location &&
            existing.summary === newEntry.summary
        );
        if (!isDuplicate) {
          npc.actionLog.push(newEntry);
        }
      }
      // Sort by time
      npc.actionLog.sort((a, b) => {
        const timeA = this.parseGameTimeFromSnapshot(a.time);
        const timeB = this.parseGameTimeFromSnapshot(b.time);
        if (!timeA || !timeB) return 0;
        if (timeA.gameDay !== timeB.gameDay) return timeA.gameDay - timeB.gameDay;
        const [hA, mA] = timeA.timeOfDay.split(':').map(Number);
        const [hB, mB] = timeB.timeOfDay.split(':').map(Number);
        return hA * 60 + mA - (hB * 60 + mB);
      });
    }
  }

  /**
   * Update scenarios for scene switch - unified method that generates both complete target snapshot and simplified background snapshots
   */
  async updateScenariosForSceneSwitch(
    gameStateManager: DynamicGameStateManager
  ): Promise<{
    validatedTargetSceneName: string;
    targetSnapshot: DynamicScenarioSnapshot;
    backgroundSnapshots: Map<string, DynamicScenarioSnapshot>;
    modifiedConnections: Array<{
      scenarioName: string;
      relationshipType: string;
      description?: string;
      blocked?: boolean;
      blockReason?: string | null;
    }> | null;
  } | null> {
    console.log(`\n🔄 [Director Agent] Updating scenarios for scene switch...`);

    const dynamicState = gameStateManager.getState();
    const sceneChangeRequest = dynamicState.temporaryInfo.sceneChangeRequest;
    const currentScenario = dynamicState.currentScenario;
    const currentScenarioName = currentScenario?.name || null;

    if (!sceneChangeRequest) {
      console.error(`   ❌ No scene change request found`);
      return null;
    }

    console.log(`   📋 Scene change request: ${sceneChangeRequest.targetSceneName}`);
    console.log(`   📍 Current scenario: ${currentScenarioName}`);

    try {
      // Build current game time
      const currentGameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;

      // Get all scenarios (including current one for context, but will exclude it in output)
      const allScenarios = this.scenarioLoader.getAllScenarios();

      // Build scenario outline map for quick lookup
      const scenarioOutlineMap = new Map(
        dynamicState.scenarioOutlines.map(outline => [outline.id, outline])
      );

      // Build comprehensive scenario data with NPCs, clues, conditions for ALL scenarios
      const allScenariosData = [];

      for (const scenario of allScenarios) {
        // Get the scenario's initial snapshot (with full details: clues, conditions)
        const scenarioProfile = this.scenarioLoader.getScenarioById(scenario.id);
        if (!scenarioProfile || !scenarioProfile.snapshot) continue;
        const initialSnapshot = scenarioProfile.snapshot;

        // Get NPCs for this scenario
        const npcsInScenario = this.getNPCsForScenario(
          initialSnapshot.location,
          scenario.id,
          dynamicState.npcCharacters,
          initialSnapshot.gameTime, // Previous snapshot time
          currentGameTime // Current game time
        );

        // Get scenario outline for knowledge holder references and connections
        const scenarioOutline = scenarioOutlineMap.get(scenario.id);

        allScenariosData.push({
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          sourcePlaceId: scenarioOutline?.sourcePlaceId || null,
          sourcePlaceName: scenarioOutline?.sourcePlaceName || null,
          connections: scenarioOutline?.connections || [], // Scenario-level connections (NOT snapshot data)
          snapshot: {
            id: initialSnapshot.id,
            name: initialSnapshot.name,
            location: initialSnapshot.location,
            description: initialSnapshot.description,
            clues: initialSnapshot.clues || [], // FULL clues for target scene
            conditions: initialSnapshot.conditions || [], // FULL conditions
            previousGameTime: initialSnapshot.gameTime || null
          },
          characters: npcsInScenario,
          currentGameTime: currentGameTime
        });
      }

      // Serialize scenarios to JSON for template injection
      const allScenariosJson = JSON.stringify(allScenariosData, null, 2);

      // Get player's current scenario outline for sourcePlaceId, sourcePlaceName, and connections
      const playerScenarioOutline = currentScenario?.id 
        ? scenarioOutlineMap.get(currentScenario.id)
        : null;

      // Find target scenario info for template
      const targetScenarioData = allScenariosData.find(
        s => s.scenarioName === sceneChangeRequest.targetSceneName
      );

      // Build template context
      const templateContext = {
        sceneChangeRequest: {
          targetSceneName: sceneChangeRequest.targetSceneName,
          reason: sceneChangeRequest.reason,
          timestamp: sceneChangeRequest.timestamp?.toISOString() || new Date().toISOString()
        },
        currentScenarioName,
        playerCurrentScene: currentScenario ? {
          name: currentScenario.name,
          location: currentScenario.location,
          description: currentScenario.description || null,
          sourcePlaceId: playerScenarioOutline?.sourcePlaceId || null,
          sourcePlaceName: playerScenarioOutline?.sourcePlaceName || null,
          connections: playerScenarioOutline?.connections || []
        } : null,
        targetScene: targetScenarioData ? {
          id: targetScenarioData.scenarioId,
          name: targetScenarioData.scenarioName
        } : null,
        allScenariosJson,
        currentGameDay: dynamicState.gameDay,
        currentTimeOfDay: dynamicState.timeOfDay,
        truthTimelineJson: JSON.stringify(dynamicState.truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(dynamicState.knowledgeMatrix, null, 2),
        previousGlobalTrigger: dynamicState.globalTrigger,
        previousGlobalTriggerJson: dynamicState.globalTrigger ? JSON.stringify(dynamicState.globalTrigger, null, 2) : null,
        endStateJson: dynamicState.endState ? JSON.stringify(dynamicState.endState, null, 2) : "null"
      };

      // Generate unified snapshots using LLM
      const runtime = createRuntime();
      const template = getPlayerSceneSwitchTemplate();

      const prompt = composeTemplate(
        template,
        { dynamicGameState: dynamicState },
        templateContext,
        "handlebars"
      );

      console.log(`   🤖 Calling LLM to generate unified snapshots (1 complete target + ${allScenariosData.length - 1} simplified background)...`);

      const response = await generateText({
        runtime,
        context: prompt,
        modelClass: ModelClass.LARGE,
      });

      // Parse LLM response
      let parsedResponse: {
        updatedSnapshots?: Array<{
          scenarioId: string;
          isTargetScene?: boolean;
          snapshot: DynamicScenarioSnapshot;
          connections?: Array<{
            scenarioName: string;
            relationshipType: string;
            description?: string;
            blocked?: boolean;
            blockReason?: string | null;
          }>;
        }>;
        globalTrigger?: {
          timeRestriction?: string;
          timeReason?: string;
          events?: string[];
          eventReasons?: string[];
          keeperNotes?: string;
        };
      };

      try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedResponse = JSON.parse(jsonMatch[0]);
        } else {
          parsedResponse = JSON.parse(response);
        }
      } catch (error) {
        console.error("❌ Failed to parse LLM response as JSON:", error);
        console.error("Raw response:", response);
        return null;
      }

      // Validate response structure
      if (!parsedResponse.updatedSnapshots || parsedResponse.updatedSnapshots.length === 0) {
        console.error(`❌ LLM response missing updatedSnapshots array`);
        console.error(`   Full parsed response:`, JSON.stringify(parsedResponse, null, 2));
        return null;
      }

      // Extract target scene from updatedSnapshots (marked with isTargetScene: true)
      const targetSceneItem = parsedResponse.updatedSnapshots.find(item => item.isTargetScene === true);

      if (!targetSceneItem) {
        console.error(`❌ No target scene found in updatedSnapshots (isTargetScene: true)`);
        console.error(`   Available scenes:`, parsedResponse.updatedSnapshots.map(s => ({
          scenarioId: s.scenarioId,
          isTargetScene: s.isTargetScene,
          name: s.snapshot.name
        })));
        return null;
      }

      // Extract background snapshots (all non-target scenes)
      const backgroundSnapshotsArray = parsedResponse.updatedSnapshots.filter(item => !item.isTargetScene);

      // Get validated target scene name from the snapshot
      const validatedTargetSceneName = targetSceneItem.snapshot.name;
      const modifiedConnections = targetSceneItem.connections || null;

      // Ensure target snapshot has unified time and type
      const targetSnapshot: DynamicScenarioSnapshot = {
        ...targetSceneItem.snapshot,
        gameTime: currentGameTime,
        snapshotType: "complete"  // Target snapshot is always complete
      };

      console.log(`   ✓ Validated target scene: ${validatedTargetSceneName}`);

      // Merge character deltas from target snapshot to actual NPCs
      if (targetSnapshot.characters) {
        for (const char of targetSnapshot.characters) {
          const charWithActionLog = char as ScenarioCharacter & {
            actionLog?: ActionLogEntry[];
            status?: Partial<CharacterStatus>;
            inventory?: { add?: InventoryItem[]; remove?: InventoryItem[] } | InventoryItem[];
            relationships?: NPCRelationship[];
          };

          // Merge delta to actual NPC in gameState (with fuzzy matching)
          const npc = this.findNPCById(dynamicState.npcCharacters, char.id, char.name);
          if (npc) {
            this.mergeCharacterDeltaToNPC(npc, {
              status: charWithActionLog.status,
              inventory: charWithActionLog.inventory,
              relationships: charWithActionLog.relationships,
              actionLog: charWithActionLog.actionLog
            });
            console.log(`   ✓ Merged delta updates to NPC: ${npc.name} (${npc.id})`);
          } else {
            console.warn(`   ⚠️ NPC "${char.id}"${char.name ? ` (${char.name})` : ''} not found in gameState, skipping delta merge`);
          }
        }
      }

      // Use target snapshot directly (no database save)
      const savedTargetSnapshot = targetSnapshot;

      // Process background snapshots
      const backgroundSnapshotsMap = new Map<string, DynamicScenarioSnapshot>();

      if (backgroundSnapshotsArray.length > 0) {
        console.log(`   📋 Processing ${backgroundSnapshotsArray.length} background snapshots...`);

        for (const item of backgroundSnapshotsArray) {
          // Validate actionLog format (background snapshots don't update actual NPCs)
          if (item.snapshot.characters) {
            for (const char of item.snapshot.characters) {
              const charWithActionLog = char as ScenarioCharacter & { 
                actionLog?: ActionLogEntry[];
              };
              
              // Validate actionLog entries
              if (charWithActionLog.actionLog) {
                for (const logEntry of charWithActionLog.actionLog) {
                  if (!logEntry.time || !logEntry.location || !logEntry.summary) {
                    console.warn(`   ⚠️ Invalid actionLog entry for character ${char.id}, filtering...`);
                    charWithActionLog.actionLog = charWithActionLog.actionLog.filter(
                      (e: ActionLogEntry) => e.time && e.location && e.summary
                    );
                  }
                }
              }
            }
          }

          // Ensure snapshot uses unified time and type
          const bgSnapshot: DynamicScenarioSnapshot = {
            ...item.snapshot,
            gameTime: currentGameTime,
            snapshotType: "simplified"  // Background snapshots are simplified
          };

          // Add to map (no database save)
          backgroundSnapshotsMap.set(item.scenarioId, bgSnapshot);

          console.log(`   ✓ Processed background snapshot for scenario ${item.scenarioId}`);
        }
      }

      // Handle modified connections if present
      if (modifiedConnections && modifiedConnections.length > 0) {
        console.log(`   🔗 Updating scenario connections...`);

        // Find target scenario in scenarioOutlines
        const targetScenarioOutline = dynamicState.scenarioOutlines.find(
          outline => outline.name === validatedTargetSceneName
        );

        if (targetScenarioOutline) {
          // Update connections in database
          const database = this.db.getDatabase();
          const updateStmt = database.prepare(`
            UPDATE scenarios
            SET connections = ?
            WHERE scenario_id = ?
          `);

          updateStmt.run(
            JSON.stringify(modifiedConnections),
            targetScenarioOutline.id
          );

          // Update in-memory scenarioOutline
          // Convert relationshipType to ScenarioConnectionType and add scenarioId
          const convertedConnections = modifiedConnections.map(conn => {
            // Find target scenario to get ID
            const targetScenario = dynamicState.scenarioOutlines.find(
              outline => outline.name === conn.scenarioName || outline.id === conn.scenarioName
            );
            return {
              scenarioName: targetScenario?.name || conn.scenarioName,
              scenarioId: targetScenario?.id || conn.scenarioName,
              relationshipType: conn.relationshipType as ScenarioConnectionType,
              description: conn.description,
              blocked: conn.blocked,
              blockReason: conn.blockReason ?? undefined
            };
          });
          targetScenarioOutline.connections = convertedConnections;

          console.log(`   ✓ Updated connections for ${validatedTargetSceneName}`);

          // Log blocked connections if any
          const blockedConnections = modifiedConnections.filter(c => c.blocked);
          if (blockedConnections.length > 0) {
            console.log(`   ⚠️ Blocked connections:`);
            blockedConnections.forEach(c => {
              console.log(`      - ${c.scenarioName}: ${c.blockReason || 'blocked'}`);
            });
          }
        }
      }

      // Save global trigger condition
      if (parsedResponse.globalTrigger) {
        gameStateManager.setGlobalTrigger(parsedResponse.globalTrigger);
        console.log(`   ✓ Saved global trigger condition`);
        if (parsedResponse.globalTrigger.timeRestriction) {
          console.log(`     - Time: ${parsedResponse.globalTrigger.timeRestriction}`);
          if (parsedResponse.globalTrigger.timeReason) {
            console.log(`       Reason: ${parsedResponse.globalTrigger.timeReason}`);
          }
        }
        if (parsedResponse.globalTrigger.events && parsedResponse.globalTrigger.events.length > 0) {
          console.log(`     - Events: ${parsedResponse.globalTrigger.events.join(", ")}`);
          if (parsedResponse.globalTrigger.eventReasons && parsedResponse.globalTrigger.eventReasons.length > 0) {
            parsedResponse.globalTrigger.eventReasons.forEach((reason, index) => {
              console.log(`       Event ${index + 1} reason: ${reason}`);
            });
          }
        }
      }

      console.log(`✅ [Director Agent] Scene switch update completed`);
      console.log(`   - Target: ${validatedTargetSceneName} (complete)`);
      console.log(`   - Background: ${backgroundSnapshotsMap.size} scenarios (simplified)`);
      if (modifiedConnections) {
        console.log(`   - Connections: ${modifiedConnections.length} updated`);
      }

      return {
        validatedTargetSceneName,
        targetSnapshot: savedTargetSnapshot,
        backgroundSnapshots: backgroundSnapshotsMap,
        modifiedConnections
      };
    } catch (error) {
      console.error(`❌ [Director Agent] Failed to update scenarios for scene switch:`, error);
      return null;
    }
  }

  /**
   * Update non-player scenarios with simplified snapshots
   */
  async updateNonPlayerScenarios(
    gameStateManager: DynamicGameStateManager
  ): Promise<void> {
    console.log(`\n🎬 [Director Agent] Starting scenario update for non-player scenes...`);

    // Ensure gameStateManager has db for snapshot management
    gameStateManager.setDb(this.db);

    const dynamicState = gameStateManager.getState();
    const currentScenario = dynamicState.currentScenario;
    const currentScenarioId = currentScenario?.id || null;

    // Save checkpoint before scenario update
    saveDynamicGameStateCheckpoint(
      this.db,
      dynamicState,
      'auto',
      'Before non-player scenario update'
    );

    try {
      // Get all scenarios with their latest snapshots (excluding player's current scene)
      const scenariosWithSnapshots = await this.getAllScenariosLatestSnapshots(
        currentScenarioId,
        dynamicState.gameDay,
        dynamicState.timeOfDay,
        dynamicState
      );

      if (scenariosWithSnapshots.length === 0) {
        console.log(`   ✓ No scenarios to update`);
        return;
      }

      console.log(`   📋 Found ${scenariosWithSnapshots.length} scenarios to update`);

      // Build template context with NPCs for each scenario at current time point
      const currentGameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
      
      // Build a map of scenarioId -> scenarioOutline for quick lookup
      const scenarioOutlineMap = new Map(
        dynamicState.scenarioOutlines.map(outline => [outline.id, outline])
      );

      const scenariosToUpdate = scenariosWithSnapshots.map(item => {
        // Get NPCs that should be in this scenario at current time point
        // NPCs can move between scenarios based on their actionLog
        const npcsInScenario = this.getNPCsForScenario(
          item.snapshot.location,
          item.scenarioId,
          dynamicState.npcCharacters,
          item.snapshot.gameTime, // Previous snapshot time (for timeline extraction)
          currentGameTime // Current game time (unified for all snapshots)
        );

        // Get scenario outline to access sourcePlaceId and connections
        const scenarioOutline = scenarioOutlineMap.get(item.scenarioId);

        return {
          scenarioId: item.scenarioId,
          scenarioName: item.scenarioName,
          sourcePlaceId: scenarioOutline?.sourcePlaceId || null, // Knowledge holder PLACE ID
          sourcePlaceName: scenarioOutline?.sourcePlaceName || null,
          connections: scenarioOutline?.connections || [], // Scenario-level connections (NOT snapshot data)
          snapshot: {
            id: item.snapshot.id,
            name: item.snapshot.name,
            location: item.snapshot.location,
            description: item.snapshot.description,
            previousGameTime: item.snapshot.gameTime || null // Previous snapshot time for timeline reference
          },
          characters: npcsInScenario,
          currentGameTime: currentGameTime // Unified current game time for all snapshots
        };
      });

      // Serialize scenarios to JSON string for template injection
      const scenariosToUpdateJson = JSON.stringify(scenariosToUpdate, null, 2);

      // Get player's current scenario outline for sourcePlaceId, sourcePlaceName, and connections
      const playerScenarioOutline = currentScenarioId 
        ? scenarioOutlineMap.get(currentScenarioId)
        : null;

      const endState = dynamicState.endState;
      
      const templateContext = {
        currentGameDay: dynamicState.gameDay,
        currentTimeOfDay: dynamicState.timeOfDay,
        playerCurrentScene: currentScenario ? {
          name: currentScenario.name,
          location: currentScenario.location,
          description: currentScenario.description || null,
          sourcePlaceId: playerScenarioOutline?.sourcePlaceId || null,
          sourcePlaceName: playerScenarioOutline?.sourcePlaceName || null,
          connections: playerScenarioOutline?.connections || []
        } : null,
        scenariosToUpdateJson,
        truthTimelineJson: JSON.stringify(dynamicState.truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(dynamicState.knowledgeMatrix, null, 2),
        previousGlobalTrigger: dynamicState.globalTrigger,
        previousGlobalTriggerJson: dynamicState.globalTrigger ? JSON.stringify(dynamicState.globalTrigger, null, 2) : null,
        endStateJson: endState ? JSON.stringify(endState, null, 2) : "null"
      };

      // Generate updated snapshots using LLM
      const runtime = createRuntime();
      const template = getScenarioUpdateTemplate();

      const prompt = composeTemplate(
        template,
        { dynamicGameState: dynamicState },
        templateContext,
        "handlebars"
      );

      console.log(`   🤖 Calling LLM to generate updated snapshots...`);

      const response = await generateText({
        runtime,
        context: prompt,
        modelClass: ModelClass.LARGE,
      });

      // Parse LLM response
      let parsedResponse: {
        globalTrigger?: {
          timeRestriction?: string;
          timeReason?: string;
          events?: string[];
          eventReasons?: string[];
          keeperNotes?: string;
        };
        updatedSnapshots?: Array<{
          scenarioId: string;
          snapshot: DynamicScenarioSnapshot;
        }>;
      };

      try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedResponse = JSON.parse(jsonMatch[0]);
        } else {
          parsedResponse = JSON.parse(response);
        }
      } catch (error) {
        console.error("Failed to parse LLM response as JSON:", error);
        console.error("Raw response:", response);
        return;
      }

      // Validate and process snapshots
      if (parsedResponse.updatedSnapshots && parsedResponse.updatedSnapshots.length > 0) {
        console.log(`   📋 Processing ${parsedResponse.updatedSnapshots.length} updated snapshots...`);

        for (const item of parsedResponse.updatedSnapshots) {
          // Validate actionLog format (simplified snapshots don't update actual NPCs)
          if (item.snapshot.characters) {
            for (const char of item.snapshot.characters) {
              const charWithActionLog = char as ScenarioCharacter & { 
                actionLog?: ActionLogEntry[];
              };
              
              // Validate actionLog entries
              if (charWithActionLog.actionLog) {
                for (const logEntry of charWithActionLog.actionLog) {
                  if (!logEntry.time || !logEntry.location || !logEntry.summary) {
                    console.warn(`   ⚠️ Invalid actionLog entry for character ${char.id}, skipping...`);
                    charWithActionLog.actionLog = charWithActionLog.actionLog.filter((e: ActionLogEntry) => e.time && e.location && e.summary);
                  }
                }
              }
            }
          }

          // Ensure snapshot uses unified current game time and type
          const snapshotWithUnifiedTime: DynamicScenarioSnapshot = {
            ...item.snapshot,
            gameTime: currentGameTime, // Use unified current game time
            snapshotType: "simplified"  // Non-player scenario snapshots are simplified
          };
          
          // Save to state (no database save)
          // db is already set at the beginning of this method
          gameStateManager.setUpdatedDynamicScenarioSnapshot(item.scenarioId, snapshotWithUnifiedTime);

          console.log(`   ✓ Updated snapshot for scenario ${item.scenarioId}`);
        }
      }

      // Save global trigger condition
      if (parsedResponse.globalTrigger) {
        gameStateManager.setGlobalTrigger(parsedResponse.globalTrigger);
        console.log(`   ✓ Saved global trigger condition`);
        if (parsedResponse.globalTrigger.timeRestriction) {
          console.log(`     - Time: ${parsedResponse.globalTrigger.timeRestriction}`);
          if (parsedResponse.globalTrigger.timeReason) {
            console.log(`       Reason: ${parsedResponse.globalTrigger.timeReason}`);
          }
        }
        if (parsedResponse.globalTrigger.events && parsedResponse.globalTrigger.events.length > 0) {
          console.log(`     - Events: ${parsedResponse.globalTrigger.events.join(", ")}`);
          if (parsedResponse.globalTrigger.eventReasons && parsedResponse.globalTrigger.eventReasons.length > 0) {
            parsedResponse.globalTrigger.eventReasons.forEach((reason, index) => {
              console.log(`       Event ${index + 1} reason: ${reason}`);
            });
          }
        }
      }

      console.log(`✅ [Director Agent] Scenario update completed`);
    } catch (error) {
      console.error(`❌ [Director Agent] Failed to update scenarios:`, error);
      throw error;
    }
  }

  /**
   * Check if global trigger time restriction has been reached
   * @returns true if current game time >= trigger time, false otherwise
   */
  checkGlobalTriggerTime(
    gameStateManager: DynamicGameStateManager
  ): boolean {
    const dynamicState = gameStateManager.getState();
    const globalTrigger = dynamicState.globalTrigger;

    if (!globalTrigger || !globalTrigger.timeRestriction) {
      return false;
    }

    const currentGameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    const triggerTime = globalTrigger.timeRestriction;

    // Parse both times
    const currentTime = this.parseGameTimeFromSnapshot(currentGameTime);
    const targetTime = this.parseGameTimeFromSnapshot(triggerTime);

    if (!currentTime || !targetTime) {
      console.warn(`   ⚠️ Failed to parse time: current="${currentGameTime}", trigger="${triggerTime}"`);
      return false;
    }

    // Check if current time >= trigger time
    const timeReached =
      currentTime.gameDay > targetTime.gameDay ||
      (currentTime.gameDay === targetTime.gameDay &&
       this.compareTimeOfDay(currentTime.timeOfDay, targetTime.timeOfDay) >= 0);

    if (timeReached) {
      console.log(`   ⏰ Global trigger time reached: ${triggerTime}`);
      if (globalTrigger.timeReason) {
        console.log(`      Reason: ${globalTrigger.timeReason}`);
      }
    }

    return timeReached;
  }

  /**
   * Check global trigger and determine if it causes game end
   * Combines time check and event check, and determines if trigger causes game end
   * @returns { triggered: boolean, causesGameEnd: boolean, reason?: string }
   */
  async checkGlobalTriggerAndGameEnd(
    gameStateManager: DynamicGameStateManager
  ): Promise<{ triggered: boolean; causesGameEnd: boolean; reason?: string }> {
    const dynamicState = gameStateManager.getState();
    const globalTrigger = dynamicState.globalTrigger;
    const endState = dynamicState.endState;

    // If no global trigger, return early
    if (!globalTrigger) {
      return { triggered: false, causesGameEnd: false };
    }

    console.log(`\n🔍 [Director Agent] Checking global trigger and game end conditions...`);

    let triggered = false;
    let triggerReason = "";

    // Check 1: Time restriction
    const timeReached = this.checkGlobalTriggerTime(gameStateManager);
    if (timeReached) {
      triggered = true;
      triggerReason = "时间限制到达";
    }

    // Check 2: Events (only if time not reached)
    if (!triggered && globalTrigger.events && globalTrigger.events.length > 0) {
      // Get recent actionLog entries for event check
      const conversationHistory = (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
        turnNumber: number;
        characterInput: string;
        keeperNarrative: string | null;
        actionResults?: any[];
      }>) || [];

      const recentTurns = conversationHistory.slice(-3);
      if (recentTurns.length > 0) {
        const currentGameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
        let earliestTime: string | null = null;

        // Find earliest time from actionResults in recent turns
        for (const turn of recentTurns) {
          if (turn.actionResults && turn.actionResults.length > 0) {
            for (const result of turn.actionResults) {
              const resultTime = result.gameTime || `Day ${dynamicState.gameDay}, ${result.timeOfDay || dynamicState.timeOfDay}`;
              if (!earliestTime || this.isTimeBeforeOrEqual(resultTime, earliestTime)) {
                earliestTime = resultTime;
              }
            }
          }
        }

        if (!earliestTime) {
          earliestTime = currentGameTime;
        }

        // Extract actionLog entries from all characters
        const recentActionLogs: Array<{
          turnNumber: number;
          characterId: string;
          characterName: string;
          actionLog: ActionLogEntry[];
        }> = [];

        const allCharacters: Array<{
          id: string;
          name: string;
          actionLog: ActionLogEntry[];
        }> = [
          {
            id: dynamicState.playerCharacter.id,
            name: dynamicState.playerCharacter.name,
            actionLog: dynamicState.playerCharacter.actionLog || []
          },
          ...dynamicState.npcCharacters.map(npc => ({
            id: npc.id,
            name: npc.name,
            actionLog: npc.actionLog || []
          }))
        ];

        // Filter actionLog entries within the time range
        for (const character of allCharacters) {
          const filteredActionLog = character.actionLog.filter(entry => {
            return this.isTimeBeforeOrEqual(earliestTime, entry.time) && 
                   this.isTimeBeforeOrEqual(entry.time, currentGameTime);
          });

          if (filteredActionLog.length > 0) {
            recentActionLogs.push({
              turnNumber: recentTurns[0]?.turnNumber || 0,
              characterId: character.id,
              characterName: character.name,
              actionLog: filteredActionLog
            });
          }
        }

        if (recentActionLogs.length > 0) {
          // Use unified template to check events and game end
          const runtime = createRuntime();
          const template = getGlobalTriggerEventCheckTemplate();

          const templateContext = {
            globalTriggerJson: JSON.stringify(globalTrigger, null, 2),
            endStateJson: endState ? JSON.stringify(endState, null, 2) : "null",
            recentActionLogsJson: JSON.stringify(recentActionLogs, null, 2)
          };

          const prompt = composeTemplate(
            template,
            { dynamicGameState: dynamicState },
            templateContext,
            "handlebars"
          );

          try {
            const response = await generateText({
              runtime,
              context: prompt,
              modelClass: ModelClass.SMALL,
            });

            // Parse response
            let parsed: { triggered: boolean; causesGameEnd: boolean; reason?: string };
            try {
              const jsonMatch = response.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[0]);
              } else {
                parsed = JSON.parse(response);
              }
            } catch (error) {
              console.error("   ❌ Failed to parse trigger check response:", error);
              return { triggered: false, causesGameEnd: false };
            }

            if (parsed.triggered) {
              triggered = true;
              triggerReason = parsed.reason || "事件已完成";
              
              if (parsed.causesGameEnd) {
                console.log(`   ✅ Global trigger triggered AND causes game end`);
                console.log(`      Reason: ${triggerReason}`);
                return { triggered: true, causesGameEnd: true, reason: triggerReason };
              } else {
                console.log(`   ✅ Global trigger triggered but does NOT cause game end`);
                console.log(`      Reason: ${triggerReason}`);
                return { triggered: true, causesGameEnd: false, reason: triggerReason };
              }
            }
          } catch (error) {
            console.error("   ❌ Error checking global trigger events:", error);
            return { triggered: false, causesGameEnd: false };
          }
        }
      }
    }

    // If time reached, check if it causes game end
    if (triggered && timeReached) {
      // Check if time trigger aligns with point of no return
      if (endState && endState.pointOfNoReturn.type === "time") {
        const pointOfNoReturnReached = gameStateManager.checkPointOfNoReturn(
          dynamicState.gameDay,
          dynamicState.timeOfDay
        );
        if (pointOfNoReturnReached) {
          console.log(`   ✅ Global trigger time reached AND causes game end (point of no return)`);
          return { triggered: true, causesGameEnd: true, reason: triggerReason };
        }
      }
      console.log(`   ✅ Global trigger time reached but does NOT cause game end`);
      return { triggered: true, causesGameEnd: false, reason: triggerReason };
    }

    return { triggered: false, causesGameEnd: false };
  }

  /**
   * Check if global trigger events have been fulfilled using LLM analysis
   * Analyzes recent actionLog entries from the last 3 turns
   * @returns true if events are triggered, false otherwise
   */
  async checkGlobalTriggerEvents(
    gameStateManager: DynamicGameStateManager
  ): Promise<boolean> {
    const dynamicState = gameStateManager.getState();
    const globalTrigger = dynamicState.globalTrigger;

    if (!globalTrigger || !globalTrigger.events || globalTrigger.events.length === 0) {
      return false;
    }

    console.log(`\n🔍 [Director Agent] Checking global trigger events...`);

    // Get conversation history from last 3 turns (including current turn)
    const conversationHistory = (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
      turnNumber: number;
      characterInput: string;
      keeperNarrative: string | null;
      actionResults?: any[];
    }>) || [];

    // Get recent 3 turns (including current turn)
    const recentTurns = conversationHistory.slice(-3);
    if (recentTurns.length === 0) {
      console.log(`   ℹ️  No recent turns found`);
      return false;
    }

    // Calculate time range for recent 3 turns
    // Get the earliest time from recent turns' actionResults
    const currentGameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    let earliestTime: string | null = null;

    // Find earliest time from actionResults in recent turns
    for (const turn of recentTurns) {
      if (turn.actionResults && turn.actionResults.length > 0) {
        for (const result of turn.actionResults) {
          const resultTime = result.gameTime || `Day ${dynamicState.gameDay}, ${result.timeOfDay || dynamicState.timeOfDay}`;
          if (!earliestTime || this.isTimeBeforeOrEqual(resultTime, earliestTime)) {
            earliestTime = resultTime;
          }
        }
      }
    }

    // If no time found in actionResults, use current time as fallback
    if (!earliestTime) {
      earliestTime = currentGameTime;
    }

    console.log(`   📅 Time range: ${earliestTime} to ${currentGameTime}`);

    // Extract actionLog entries directly from all characters' actionLog
    // Filter entries that fall within the time range of recent 3 turns
    const recentActionLogs: Array<{
      turnNumber: number;
      characterId: string;
      characterName: string;
      actionLog: ActionLogEntry[];
    }> = [];

    // Collect all characters (player + NPCs)
    const allCharacters: Array<{
      id: string;
      name: string;
      actionLog: ActionLogEntry[];
    }> = [
      {
        id: dynamicState.playerCharacter.id,
        name: dynamicState.playerCharacter.name,
        actionLog: dynamicState.playerCharacter.actionLog || []
      },
      ...dynamicState.npcCharacters.map(npc => ({
        id: npc.id,
        name: npc.name,
        actionLog: npc.actionLog || []
      }))
    ];

    // Filter actionLog entries within the time range
    for (const character of allCharacters) {
      const filteredActionLog = character.actionLog.filter(entry => {
        // Include entries that are within the time range (earliestTime to currentGameTime)
        return this.isTimeBeforeOrEqual(earliestTime, entry.time) && 
               this.isTimeBeforeOrEqual(entry.time, currentGameTime);
      });

      if (filteredActionLog.length > 0) {
        recentActionLogs.push({
          turnNumber: recentTurns[0]?.turnNumber || 0,
          characterId: character.id,
          characterName: character.name,
          actionLog: filteredActionLog
        });
      }
    }

    if (recentActionLogs.length === 0) {
      console.log(`   ℹ️  No recent actionLog entries found in the last 3 turns`);
      return false;
    }

    console.log(`   📋 Found ${recentActionLogs.length} characters with actionLog entries in recent 3 turns`);

    // Prepare template context
    const runtime = createRuntime();
    const template = getGlobalTriggerEventCheckTemplate();

    const templateContext = {
      globalTriggerJson: JSON.stringify(globalTrigger, null, 2),
      recentActionLogsJson: JSON.stringify(recentActionLogs, null, 2)
    };

    const prompt = composeTemplate(
      template,
      { dynamicGameState: dynamicState },
      templateContext,
      "handlebars"
    );

    try {
      const response = await generateText({
        runtime,
        context: prompt,
        modelClass: ModelClass.SMALL,
      });

      // Parse response
      let parsed: { triggered: boolean };
      try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          parsed = JSON.parse(response);
        }
      } catch (error) {
        console.error("   ❌ Failed to parse event check response:", error);
        return false;
      }

      if (parsed.triggered) {
        console.log(`   ✅ Global trigger events have been fulfilled`);
        if (globalTrigger.events) {
          console.log(`      Events: ${globalTrigger.events.join(", ")}`);
        }
      } else {
        console.log(`   ⏳ Global trigger events not yet fulfilled`);
      }

      return parsed.triggered;

    } catch (error) {
      console.error("   ❌ Error checking global trigger events:", error);
      return false;
    }
  }

  /**
   * Generate a stuck-hint narrative when the player appears stuck.
   * Builds context (game time, tension, current scene snapshot, connections, last 3 inputs/narratives),
   * calls the stuck-hint template and LLM, parses { "narrative": string } and returns the narrative.
   * @returns The hint narrative string, or null if no current scenario, parse failure, or LLM error.
   */
  async generateStuckHintNarrative(gameStateManager: DynamicGameStateManager): Promise<string | null> {
    const dynamicState = gameStateManager.getState();
    const currentScenario = dynamicState.currentScenario;

    if (!currentScenario) {
      return null;
    }

    const gameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    const tension = dynamicState.tension;

    const currentSceneSnapshotJson = JSON.stringify(currentScenario, null, 2);

    const currentScenarioOutline = dynamicState.scenarioOutlines.find(
      (outline) => outline.id === currentScenario.id || outline.name === currentScenario.name
    );
    const rawConnections = currentScenarioOutline?.connections || [];
    const connections = rawConnections.map((conn) => {
      const targetScenario = dynamicState.scenarioOutlines.find(
        (outline) => outline.name === conn.scenarioName || outline.id === conn.scenarioName
      );
      return {
        scenarioName: targetScenario?.name ?? conn.scenarioName,
        relationshipType: conn.relationshipType,
        description: conn.description,
        blocked: conn.blocked,
        blockReason: conn.blockReason,
      };
    });
    const scenarioConnectionsJson = JSON.stringify(connections, null, 2);

    const conversationHistory = (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
      turnNumber: number;
      characterInput: string;
      keeperNarrative: string | null;
    }>) ?? [];
    const recentTurns = conversationHistory.slice(-3).map((t) => ({
      turnNumber: t.turnNumber,
      characterInput: t.characterInput,
      keeperNarrative: t.keeperNarrative,
    }));

    const runtime = createRuntime();
    const template = getStuckHintNarrativeTemplate();
    const templateContext = {
      gameTime,
      tension,
      currentSceneSnapshotJson,
      scenarioConnectionsJson,
      recentTurns,
    };

    const prompt = composeTemplate(
      template,
      { dynamicGameState: dynamicState },
      templateContext,
      "handlebars"
    );

    try {
      const response = await generateText({
        runtime,
        context: prompt,
        modelClass: ModelClass.SMALL,
      });

      const jsonMatch = response.match(/\{[\s\S]*\}/);
      const raw = jsonMatch ? jsonMatch[0] : response;
      const parsed = JSON.parse(raw) as { narrative?: string };
      if (typeof parsed.narrative === "string") {
        return parsed.narrative;
      }
      return null;
    } catch (error) {
      console.error("[Director Agent] generateStuckHintNarrative failed:", error);
      return null;
    }
  }

  /**
   * Compare two time-of-day strings (HH:MM format)
   * @returns negative if time1 < time2, 0 if equal, positive if time1 > time2
   */
  private compareTimeOfDay(time1: string, time2: string): number {
    const [h1, m1] = time1.split(':').map(Number);
    const [h2, m2] = time2.split(':').map(Number);

    const minutes1 = h1 * 60 + m1;
    const minutes2 = h2 * 60 + m2;

    return minutes1 - minutes2;
  }
}
