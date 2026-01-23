import { getPlayerIntentAnalysisTemplate, getScenarioUpdateTemplate, getPlayerSceneSwitchTemplate } from "./directorTemplate.js";
import { composeTemplate } from "../../../template.js";
import type { GameEndingInfo } from "../../../coc_multiagents_system/state/index.js";
import type { ScenarioCharacter } from "../../../coc_multiagents_system/agents/models/scenarioTypes.js";
import type { DynamicScenarioSnapshot } from "../../world_builder/types.js";
import { ScenarioLoader } from "../../../coc_multiagents_system/agents/memory/scenarioloader/index.js";
import type { CoCDatabase } from "../../../coc_multiagents_system/agents/memory/database/index.js";
import type { DynamicGameState, DynamicGameStateManager } from "../../state/index.js";
import type { ActionLogEntry, CharacterStatus, InventoryItem, NPCRelationship } from "../../../coc_multiagents_system/agents/models/gameTypes.js";
import type { DynamicCharacterProfile } from "../../world_builder/types.js";
import type { DynamicNPCProfile } from "../../world_builder/types.js";
import { InventoryUtils } from "../../../coc_multiagents_system/agents/models/gameTypes.js";
import type { ScenarioConnectionType } from "../../world_builder/types.js";
import {
  ModelProviderName,
  ModelClass,
  generateText,
} from "../../../models/index.js";
import * as fs from "fs";
import * as path from "path";

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
   * Build complete snapshot object from database row
   */
  private async buildSnapshotFromRow(snapshotId: string): Promise<DynamicScenarioSnapshot | null> {
    const database = this.db.getDatabase();
    
    const snap = database
      .prepare(`SELECT * FROM scenario_snapshots WHERE snapshot_id = ?`)
      .get(snapshotId) as any;
    
    if (!snap) {
      return null;
    }
    
    // Get characters, clues, conditions for this snapshot
    const characters = database
      .prepare(`SELECT * FROM scenario_characters WHERE snapshot_id = ?`)
      .all(snapshotId) as any[];
    
    const clues = database
      .prepare(`SELECT * FROM scenario_clues WHERE snapshot_id = ?`)
      .all(snapshotId) as any[];
    
    const conditions = database
      .prepare(`SELECT * FROM scenario_conditions WHERE snapshot_id = ?`)
      .all(snapshotId) as any[];
    
    // Get scenario for map image path
    const scenario = database
      .prepare(`SELECT map_image_path FROM scenarios WHERE scenario_id = ?`)
      .get(snap.scenario_id) as any;
    
    const snapshot: DynamicScenarioSnapshot = {
      id: snap.snapshot_id,
      name: snap.snapshot_name,
      location: snap.location,
      description: snap.description,
      characters: characters.map((c) => ({
        id: c.id,
        name: c.character_name,
        role: c.character_role,
        status: c.character_status,
        location: c.character_location,
        notes: c.character_notes,
      })),
      clues: clues.map((c) => ({
        id: c.clue_id,
        clueText: c.clue_text,
        category: c.category,
        difficulty: c.difficulty,
        location: c.clue_location,
        discoveryMethod: c.discovery_method,
        reveals: c.reveals ? JSON.parse(c.reveals) : [],
        discovered: c.discovered === 1,
        discoveryDetails: c.discovery_details ? JSON.parse(c.discovery_details) : undefined,
      })),
      conditions: conditions.map((c) => ({
        type: c.condition_type,
        description: c.description,
        mechanicalEffect: c.mechanical_effect,
      })),
      keeperNotes: snap.keeper_notes,
      timeRestriction: snap.time_restriction || undefined,
      mapImagePath: scenario?.map_image_path || undefined,
    };
    
    return snapshot;
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
    
    // Check if we're returning to a previously visited scenario
    const wasVisited = dynamicState.visitedScenarios.some(
      v => v.id === targetSnapshot.id || v.name === scenarioName
    );
    
    if (wasVisited) {
      console.log(`   📂 This is a previously visited scene, will restore historical state`);
    } else {
      console.log(`   🆕 This is a first-time visit scene`);
    }
    
    try {
      // For DynamicWorld, use updateCurrentScenario directly
      // Checkpoint functionality can be added later if needed
      gameStateManager.updateCurrentScenario({
        snapshot: targetSnapshot,
        scenarioName: scenarioName
      });
      gameStateManager.setTransitionFlag(true);
      
      const updatedState = gameStateManager.getState();
      
      console.log(`   ✓ Scene transition completed successfully`);
      console.log(`\n📍 [Post-Transition State]:`);
      console.log(`   Current Scene: ${updatedState.currentScenario?.name || 'None'}`);
      console.log(`   Scene ID: ${updatedState.currentScenario?.id || 'None'}`);
      console.log(`   Location: ${updatedState.currentScenario?.location || 'None'}`);
      console.log(`   Visited Scenarios Count: ${updatedState.visitedScenarios.length}`);
      
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

    // Step 2: Save all snapshots to state
    gameStateManager.setUpdatedDynamicScenarioSnapshot(
      targetSnapshot.id,
      targetSnapshot
    );

    backgroundSnapshots.forEach((snapshot, scenarioId) => {
      gameStateManager.setUpdatedDynamicScenarioSnapshot(scenarioId, snapshot);
    });

    console.log(`   ✓ Saved all snapshots to state`);

    // Step 3: Execute scene transition using the UPDATED complete snapshot
    // Find the target scenario outline
    const targetScenarioOutline = dynamicState.scenarioOutlines.find(
      outline => outline.name === validatedTargetSceneName
    );

    if (!targetScenarioOutline) {
      console.error(`   ❌ Target scenario outline not found for: ${validatedTargetSceneName}`);
      gameStateManager.clearSceneChangeRequest();
      return;
    }

    // Execute scene transition with the updated complete snapshot
    console.log(`\n🔄 [Executing Scene Transition]:`);
    console.log(`   To: ${targetSnapshot.name}`);
    console.log(`   Location: ${targetSnapshot.location}`);

    await this.executeSceneTransition(
      targetSnapshot,
      validatedTargetSceneName,
      gameStateManager
    );

    // Step 4: Clean up scene change request
    gameStateManager.clearSceneChangeRequest();

    console.log(`✅ [Director Agent] Scene change completed successfully`);
    console.log(`🎬 [Director Agent] ========================================\n`);
  }

  /**
   * Check if story progression should trigger and generate simulated player intent query
   */
  async checkStoryProgression(
    gameStateManager: DynamicGameStateManager
  ): Promise<{ shouldTrigger: boolean; simulatedQuery: string | null }> {
    const dynamicState = gameStateManager.getState();

    // Get metrics
    const turnsInScene = gameStateManager.getTurnsInCurrentScene();
    const threshold = gameStateManager.getProgressionThreshold();
    const minutesSinceInput = gameStateManager.getMinutesSinceLastInput();

    console.log(`\n🎬 [Director Agent] Story Progression Check`);
    console.log(`   Turns in scene: ${turnsInScene} / ${threshold}`);
    console.log(`   Minutes since input: ${minutesSinceInput} / 3`);
    console.log(`   Tension: ${dynamicState.tension}/10`);

    // Check if either threshold is reached
    const shouldTrigger = gameStateManager.shouldTriggerProgression();

    if (!shouldTrigger) {
      console.log(`   ✓ No trigger conditions met`);
      return { shouldTrigger: false, simulatedQuery: null };
    }

    // Log which condition triggered
    if (turnsInScene >= threshold) {
      console.log(`   ⚠️ Turn threshold reached! Analyzing player intent...`);
    } else if (minutesSinceInput >= 3) {
      console.log(`   ⚠️ Time threshold reached (3 min idle)! Analyzing player intent...`);
    }

    // Get recent conversation history
    const conversationHistory = (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
      turnNumber: number;
      characterInput: string;
      keeperNarrative: string | null;
      actionAnalysis?: any;
    }>) || [];

    // Get last 3 turns
    const recentActions = conversationHistory.slice(-3).map(turn => ({
      turnNumber: turn.turnNumber,
      characterInput: turn.characterInput,
      actionAnalysis: turn.actionAnalysis ? JSON.stringify(turn.actionAnalysis, null, 2) : null
    }));

    // Get current scenario info
    const currentScenario = dynamicState.currentScenario;
    const scenarioInfo = currentScenario ? {
      name: currentScenario.name,
      location: currentScenario.location,
      description: currentScenario.description
    } : null;

    // Prepare template context
    const runtime = createRuntime();
    const template = getPlayerIntentAnalysisTemplate();

    const templateContext = {
      playerName: dynamicState.playerCharacter.name,
      scenarioInfoJson: scenarioInfo ? JSON.stringify(scenarioInfo, null, 2) : "No current scene",
      recentActions,
      tension: dynamicState.tension
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
      let parsed;
      try {
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          parsed = JSON.parse(response);
        }
      } catch (error) {
        console.error("Failed to parse player intent analysis:", error);
        return { shouldTrigger: false, simulatedQuery: null };
      }

      if (parsed.query) {
        console.log(`   ✓ Generated simulated query: "${parsed.query}"`);
        return { shouldTrigger: true, simulatedQuery: parsed.query };
      } else {
        console.warn(`   ⚠️ No query in response`);
        return { shouldTrigger: false, simulatedQuery: null };
      }

    } catch (error) {
      console.error("Error generating player intent analysis:", error);
      return { shouldTrigger: false, simulatedQuery: null };
    }
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
   * Latest snapshot is determined by game_time closest to but not exceeding current game time
   */
  private async getAllScenariosLatestSnapshots(
    currentScenarioId: string | null,
    currentGameDay: number,
    currentTimeOfDay: string
  ): Promise<Array<{
    scenarioId: string;
    scenarioName: string;
    snapshot: DynamicScenarioSnapshot;
  }>> {
    const database = this.db.getDatabase();
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

      // Get all snapshots for this scenario
      const snapshots = database
        .prepare(`SELECT snapshot_id, snapshot_name, location, description, game_time, time_restriction
                  FROM scenario_snapshots 
                  WHERE scenario_id = ? 
                  ORDER BY snapshot_id`)
        .all(scenario.id) as Array<{
          snapshot_id: string;
          snapshot_name: string;
          location: string;
          description: string;
          game_time: string | null;
          time_restriction: string | null;
        }>;

      if (snapshots.length === 0) continue;

      // Find the latest snapshot based on game_time
      let latestSnapshot: DynamicScenarioSnapshot | null = null;
      let latestTime: { gameDay: number; timeOfDay: string } | null = null;

      for (const snap of snapshots) {
        const snapTime = this.parseGameTimeFromSnapshot(snap.game_time || undefined);
        if (!snapTime) continue;

        // Check if this snapshot's time is before or equal to current time
        const isBeforeCurrent = snapTime.gameDay < currentGameDay ||
          (snapTime.gameDay === currentGameDay && snapTime.timeOfDay <= currentTimeOfDay);

        if (isBeforeCurrent) {
          // Check if this is later than the current latest
          if (!latestTime ||
            snapTime.gameDay > latestTime.gameDay ||
            (snapTime.gameDay === latestTime.gameDay && snapTime.timeOfDay > latestTime.timeOfDay)) {
            latestTime = snapTime;
            latestSnapshot = await this.buildSnapshotFromRow(snap.snapshot_id);
          }
        }
      }

      // If no snapshot found with valid time, use the first one
      if (!latestSnapshot && snapshots.length > 0) {
        latestSnapshot = await this.buildSnapshotFromRow(snapshots[0].snapshot_id);
      }

      if (latestSnapshot) {
        scenariosWithLatestSnapshots.push({
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          snapshot: latestSnapshot
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
   * Save complete scenario snapshot to database (with clues, conditions)
   * Note: exits are removed - connections are scenario-level data
   */
  private async saveCompleteSnapshotToDatabase(
    scenarioId: string,
    snapshot: DynamicScenarioSnapshot
  ): Promise<DynamicScenarioSnapshot> {
    const database = this.db.getDatabase();
    const snapshotId = snapshot.id; // Use the provided ID (already includes timestamp)

    // Save snapshot to scenario_snapshots table
    const snapshotStmt = database.prepare(`
      INSERT INTO scenario_snapshots (
        snapshot_id, scenario_id, snapshot_name, location, description,
        events, exits, keeper_notes, time_restriction, show_map, game_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    snapshotStmt.run(
      snapshotId,
      scenarioId,
      snapshot.name,
      snapshot.location,
      snapshot.description,
      JSON.stringify([]), // events removed - tracked via actionResults
      JSON.stringify([]), // exits removed - connections are scenario-level data
      snapshot.keeperNotes || null,
      snapshot.timeRestriction || null,
      snapshot.showMap ? 1 : 0,
      snapshot.gameTime || null
    );

    // Save characters to scenario_characters table
    if (snapshot.characters && snapshot.characters.length > 0) {
      const charStmt = database.prepare(`
        INSERT INTO scenario_characters (
          id, snapshot_id, character_name, character_role, character_status,
          character_location, character_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      for (const char of snapshot.characters) {
        // Store actionLog in character_notes as JSON if present
        let notes = char.notes || "";
        const charWithActionLog = char as ScenarioCharacter & { actionLog?: ActionLogEntry[] };
        if (charWithActionLog.actionLog && charWithActionLog.actionLog.length > 0) {
          const actionLogJson = JSON.stringify(charWithActionLog.actionLog);
          notes = notes ? `${notes}\n\nActionLog: ${actionLogJson}` : `ActionLog: ${actionLogJson}`;
        }

        charStmt.run(
          char.id,
          snapshotId,
          char.name,
          char.role,
          char.status,
          char.location || null,
          notes || null
        );
      }
    }

    // Save clues to scenario_clues table
    if (snapshot.clues && snapshot.clues.length > 0) {
      const clueStmt = database.prepare(`
        INSERT INTO scenario_clues (
          clue_id, snapshot_id, clue_text, category, difficulty,
          clue_location, discovery_method, reveals, discovered, discovery_details
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const clue of snapshot.clues) {
        clueStmt.run(
          clue.id,
          snapshotId,
          clue.clueText || "",
          clue.category || "physical",
          clue.difficulty || "regular",
          clue.location || null,
          clue.discoveryMethod || null,
          JSON.stringify(clue.reveals || []),
          clue.discovered ? 1 : 0,
          clue.discoveryDetails ? JSON.stringify(clue.discoveryDetails) : null
        );
      }
    }

    // Save conditions to scenario_conditions table
    if (snapshot.conditions && snapshot.conditions.length > 0) {
      const condStmt = database.prepare(`
        INSERT INTO scenario_conditions (
          condition_id, snapshot_id, condition_type, description, mechanical_effect
        ) VALUES (?, ?, ?, ?, ?)
      `);

      for (const cond of snapshot.conditions) {
        // Generate a unique condition ID
        const conditionId = `COND_${snapshotId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        condStmt.run(
          conditionId,
          snapshotId,
          cond.type || "other",
          cond.description,
          cond.mechanicalEffect || null
        );
      }
    }

    // Return the saved snapshot
    return snapshot;
  }

  /**
   * Save simplified snapshot to database
   */
  private async saveSimplifiedSnapshotToDatabase(
    scenarioId: string,
    snapshot: DynamicScenarioSnapshot
  ): Promise<DynamicScenarioSnapshot> {
    const database = this.db.getDatabase();
    const timestamp = Date.now();
    const newSnapshotId = `${snapshot.id}_updated_${timestamp}`;

    // Save snapshot to scenario_snapshots table
    const snapshotStmt = database.prepare(`
      INSERT INTO scenario_snapshots (
        snapshot_id, scenario_id, snapshot_name, location, description,
        events, exits, keeper_notes, time_restriction, show_map, game_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    snapshotStmt.run(
      newSnapshotId,
      scenarioId,
      snapshot.name,
      snapshot.location,
      snapshot.description,
      JSON.stringify([]), // events removed - tracked via actionResults
      JSON.stringify([]), // exits removed - connections are scenario-level data
      snapshot.keeperNotes || null,
      null, // timeRestriction (not used in simplified snapshots)
      snapshot.showMap ? 1 : 0,
      snapshot.gameTime || null
    );

      // Save characters to scenario_characters table
      if (snapshot.characters && snapshot.characters.length > 0) {
        const charStmt = database.prepare(`
          INSERT INTO scenario_characters (
            id, snapshot_id, character_name, character_role, character_status,
            character_location, character_notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const char of snapshot.characters) {
          // Store actionLog in character_notes as JSON if present
          // Note: actionLog is not part of ScenarioCharacter interface, but may be present in simplified snapshots
          let notes = char.notes || "";
          const charWithActionLog = char as ScenarioCharacter & { actionLog?: ActionLogEntry[] };
          if (charWithActionLog.actionLog && charWithActionLog.actionLog.length > 0) {
            const actionLogJson = JSON.stringify(charWithActionLog.actionLog);
            notes = notes ? `${notes}\n\nActionLog: ${actionLogJson}` : `ActionLog: ${actionLogJson}`;
          }

          charStmt.run(
            char.id,
            newSnapshotId,
            char.name,
            char.role,
            char.status,
            char.location || null,
            notes || null
          );
        }
      }

    // Return the saved snapshot with new ID
    return {
      ...snapshot,
      id: newSnapshotId
    };
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

      // Build template context
      const templateContext = {
        sceneChangeRequest: {
          targetSceneName: sceneChangeRequest.targetSceneName,
          reason: sceneChangeRequest.reason,
          timestamp: sceneChangeRequest.timestamp?.toISOString() || new Date().toISOString()
        },
        currentScenarioName,
        allScenariosJson,
        currentGameDay: dynamicState.gameDay,
        currentTimeOfDay: dynamicState.timeOfDay,
        truthTimelineJson: JSON.stringify(dynamicState.truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(dynamicState.knowledgeMatrix, null, 2),
        previousGlobalTrigger: dynamicState.globalTrigger,
        previousGlobalTriggerJson: dynamicState.globalTrigger ? JSON.stringify(dynamicState.globalTrigger, null, 2) : null
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
        modelClass: ModelClass.SMALL,
      });

      // Parse LLM response
      let parsedResponse: {
        validatedTargetSceneName?: string;
        modifiedConnections?: Array<{
          scenarioName: string;
          relationshipType: string;
          description?: string;
          blocked?: boolean;
          blockReason?: string | null;
        }> | null;
        targetSnapshot?: DynamicScenarioSnapshot;
        backgroundSnapshots?: Array<{
          scenarioId: string;
          snapshot: DynamicScenarioSnapshot;
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
      if (!parsedResponse.validatedTargetSceneName || !parsedResponse.targetSnapshot) {
        console.error(`❌ LLM response missing required fields`);
        return null;
      }

      console.log(`   ✓ Validated target scene: ${parsedResponse.validatedTargetSceneName}`);

      // Ensure target snapshot has unified time
      const targetSnapshot: DynamicScenarioSnapshot = {
        ...parsedResponse.targetSnapshot,
        gameTime: currentGameTime
      };

      // Merge character deltas from target snapshot to actual NPCs
      if (targetSnapshot.characters) {
        for (const char of targetSnapshot.characters) {
          const charWithActionLog = char as ScenarioCharacter & { 
            actionLog?: ActionLogEntry[];
            status?: Partial<CharacterStatus>;
            inventory?: { add?: InventoryItem[]; remove?: InventoryItem[] } | InventoryItem[];
            relationships?: NPCRelationship[];
          };
          
          // Merge delta to actual NPC in gameState
          const npc = dynamicState.npcCharacters.find(n => n.id === char.id);
          if (npc) {
            this.mergeCharacterDeltaToNPC(npc, {
              status: charWithActionLog.status,
              inventory: charWithActionLog.inventory,
              relationships: charWithActionLog.relationships,
              actionLog: charWithActionLog.actionLog
            });
            console.log(`   ✓ Merged delta updates to NPC: ${npc.name}`);
          } else {
            console.warn(`   ⚠️ NPC ${char.id} not found in gameState, skipping delta merge`);
          }
        }
      }

      // Save target snapshot to database
      const targetSnapshotId = `${targetSnapshot.id}_entered_${Date.now()}`;
      const targetSnapshotWithId = {
        ...targetSnapshot,
        id: targetSnapshotId
      };

      const savedTargetSnapshot = await this.saveCompleteSnapshotToDatabase(
        parsedResponse.validatedTargetSceneName,
        targetSnapshotWithId
      );

      console.log(`   💾 Saved complete target snapshot: ${targetSnapshotId}`);

      // Process background snapshots
      const backgroundSnapshotsMap = new Map<string, DynamicScenarioSnapshot>();

      if (parsedResponse.backgroundSnapshots && parsedResponse.backgroundSnapshots.length > 0) {
        console.log(`   💾 Saving ${parsedResponse.backgroundSnapshots.length} background snapshots...`);

        for (const item of parsedResponse.backgroundSnapshots) {
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

          // Ensure snapshot uses unified time
          const bgSnapshot: DynamicScenarioSnapshot = {
            ...item.snapshot,
            gameTime: currentGameTime
          };

          // Save to database
          const savedBgSnapshot = await this.saveSimplifiedSnapshotToDatabase(
            item.scenarioId,
            bgSnapshot
          );

          // Add to map
          backgroundSnapshotsMap.set(item.scenarioId, savedBgSnapshot);

          console.log(`   ✓ Saved background snapshot for scenario ${item.scenarioId}`);
        }
      }

      // Handle modified connections if present
      let modifiedConnections = null;
      if (parsedResponse.modifiedConnections && parsedResponse.modifiedConnections.length > 0) {
        console.log(`   🔗 Updating scenario connections...`);

        // Find target scenario in scenarioOutlines
        const targetScenarioOutline = dynamicState.scenarioOutlines.find(
          outline => outline.name === parsedResponse.validatedTargetSceneName
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
            JSON.stringify(parsedResponse.modifiedConnections),
            targetScenarioOutline.id
          );

          // Update in-memory scenarioOutline
          // Convert relationshipType to ScenarioConnectionType
          const convertedConnections = parsedResponse.modifiedConnections.map(conn => ({
            scenarioName: conn.scenarioName,
            relationshipType: conn.relationshipType as ScenarioConnectionType,
            description: conn.description,
            blocked: conn.blocked,
            blockReason: conn.blockReason ?? undefined
          }));
          targetScenarioOutline.connections = convertedConnections;
          modifiedConnections = parsedResponse.modifiedConnections;

          console.log(`   ✓ Updated connections for ${parsedResponse.validatedTargetSceneName}`);

          // Log blocked connections if any
          const blockedConnections = parsedResponse.modifiedConnections.filter(c => c.blocked);
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
      console.log(`   - Target: ${parsedResponse.validatedTargetSceneName} (complete)`);
      console.log(`   - Background: ${backgroundSnapshotsMap.size} scenarios (simplified)`);
      if (modifiedConnections) {
        console.log(`   - Connections: ${modifiedConnections.length} updated`);
      }

      return {
        validatedTargetSceneName: parsedResponse.validatedTargetSceneName,
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

    const dynamicState = gameStateManager.getState();
    const currentScenario = dynamicState.currentScenario;
    const currentScenarioId = currentScenario?.id || null;

    try {
      // Get all scenarios with their latest snapshots (excluding player's current scene)
      const scenariosWithSnapshots = await this.getAllScenariosLatestSnapshots(
        currentScenarioId,
        dynamicState.gameDay,
        dynamicState.timeOfDay
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

      const templateContext = {
        currentGameDay: dynamicState.gameDay,
        currentTimeOfDay: dynamicState.timeOfDay,
        playerCurrentScene: currentScenario ? {
          name: currentScenario.name,
          location: currentScenario.location
        } : null,
        scenariosToUpdateJson,
        truthTimelineJson: JSON.stringify(dynamicState.truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(dynamicState.knowledgeMatrix, null, 2),
        previousGlobalTrigger: dynamicState.globalTrigger,
        previousGlobalTriggerJson: dynamicState.globalTrigger ? JSON.stringify(dynamicState.globalTrigger, null, 2) : null
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
        modelClass: ModelClass.SMALL,
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

      // Validate and save snapshots
      if (parsedResponse.updatedSnapshots && parsedResponse.updatedSnapshots.length > 0) {
        console.log(`   💾 Saving ${parsedResponse.updatedSnapshots.length} updated snapshots...`);

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

          // Ensure snapshot uses unified current game time
          const snapshotWithUnifiedTime: DynamicScenarioSnapshot = {
            ...item.snapshot,
            gameTime: currentGameTime // Use unified current game time
          };
          
          // Save to database
          const savedSnapshot = await this.saveSimplifiedSnapshotToDatabase(
            item.scenarioId,
            snapshotWithUnifiedTime
          );

          // Save to state
          gameStateManager.setUpdatedDynamicScenarioSnapshot(item.scenarioId, savedSnapshot);

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
}
