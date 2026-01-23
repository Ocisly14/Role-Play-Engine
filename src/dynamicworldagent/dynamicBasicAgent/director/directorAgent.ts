import { getActionDrivenSceneChangeTemplate, getPlayerIntentAnalysisTemplate, getScenarioUpdateTemplate } from "./directorTemplate.js";
import { composeTemplate } from "../../../template.js";
import type { GameEndingInfo } from "../../../state.js";
import type { ScenarioSnapshot, ScenarioCharacter } from "../../../coc_multiagents_system/agents/models/scenarioTypes.js";
import { ScenarioLoader } from "../../../coc_multiagents_system/agents/memory/scenarioloader/index.js";
import type { CoCDatabase } from "../../../coc_multiagents_system/agents/memory/database/index.js";
import { ModuleLoader } from "../../../coc_multiagents_system/agents/memory/moduleloader/index.js";
import type { ActionResult } from "../../../state.js";
import type { DynamicGameState, DynamicGameStateManager } from "../../state/index.js";
import type { ActionLogEntry, NPCProfile, CharacterProfile } from "../../../coc_multiagents_system/agents/models/gameTypes.js";
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
   * Load map information
   */
  private loadMapData(): any | null {
    try {
      const mapPath = path.join(process.cwd(), "data", "Mods", "Cassandra's Black Carnival", "map.json");
      if (!fs.existsSync(mapPath)) {
        console.warn(`Map file not found at: ${mapPath}`);
        return null;
      }
      const mapContent = fs.readFileSync(mapPath, "utf-8");
      return JSON.parse(mapContent);
    } catch (error) {
      console.error("Error loading map data:", error);
      return null;
    }
  }

  /**
   * Get all scenarios with their snapshots (including timeRestriction)
   */
  private getAllScenariosWithSnapshots(): Array<{
    scenarioName: string;
    scenarioId: string;
    snapshots: Array<{
      snapshotId: string;
      snapshotName: string;
      location: string;
      timeRestriction: string | null;
    }>;
  }> {
    const database = this.db.getDatabase();
    const allScenarios = this.scenarioLoader.getAllScenarios();
    
    const scenariosWithSnapshots = allScenarios.map(scenario => {
      // Get all snapshots for this scenario from database
      const snapshots = database
        .prepare(`SELECT snapshot_id, snapshot_name, location, time_restriction 
                  FROM scenario_snapshots 
                  WHERE scenario_id = ? 
                  ORDER BY 
                    CASE 
                      WHEN time_restriction IS NULL THEN 0 
                      ELSE 1 
                    END,
                    snapshot_id`)
        .all(scenario.id) as Array<{
          snapshot_id: string;
          snapshot_name: string;
          location: string;
          time_restriction: string | null;
        }>;
      
      return {
        scenarioName: scenario.name,
        scenarioId: scenario.id,
        snapshots: snapshots.map(snap => ({
          snapshotId: snap.snapshot_id,
          snapshotName: snap.snapshot_name || scenario.name,
          location: snap.location,
          timeRestriction: snap.time_restriction
        }))
      };
    });
    
    return scenariosWithSnapshots;
  }

  // Time progression removed - scenarios are now static snapshots without timeline

  /**
   * Execute scenario progression - update current scenario based on target scene ID
   * Supports scenarios with multiple snapshots by searching in the database
   */
  private async executeScenarioProgression(
    targetSnapshotId: string, 
    gameStateManager: DynamicGameStateManager,
    estimatedShortActions: number | null = null
  ): Promise<void> {
    try {
      // First try to find in scenario loader's default snapshots (backward compatibility)
      const allScenarios = this.scenarioLoader.getAllScenarios();
      let targetSnapshot: ScenarioSnapshot | null = null;
      let scenarioName = "";

      // Search for target snapshot in all scenarios' default snapshots first
      for (const scenario of allScenarios) {
        if (scenario.snapshot.id === targetSnapshotId) {
          targetSnapshot = scenario.snapshot;
          scenarioName = scenario.name;
          break;
        }
      }

      // If not found in default snapshots, search in database for all snapshots
      if (!targetSnapshot) {
        const database = this.db.getDatabase();
        const snapshotRow = database
          .prepare(`SELECT snapshot_id, scenario_id FROM scenario_snapshots WHERE snapshot_id = ?`)
          .get(targetSnapshotId) as { snapshot_id: string; scenario_id: string } | undefined;

        if (snapshotRow) {
          // Find the scenario name
          const scenario = allScenarios.find(s => s.id === snapshotRow.scenario_id);
          if (scenario) {
            scenarioName = scenario.name;
            // Build complete snapshot object from database
            targetSnapshot = await this.buildSnapshotFromRow(targetSnapshotId);
            if (!targetSnapshot) {
              console.warn(`Director Agent: Failed to build snapshot object for ID "${targetSnapshotId}"`);
              return;
            }
          }
        }
      }

      if (targetSnapshot && scenarioName) {
        // Attach short action estimate to target scenario snapshot for subsequent state tracking
        if (estimatedShortActions && estimatedShortActions > 0) {
          targetSnapshot.estimatedShortActions = estimatedShortActions;
        } else {
          targetSnapshot.estimatedShortActions = undefined;
        }

        // Execute scene update (DynamicGameStateManager has updateCurrentScenario method)
        // Note: For DynamicWorld, we use updateCurrentScenario directly instead of updateCurrentScenarioWithCheckpoint
        // Checkpoint functionality can be added later if needed for DynamicWorld
        gameStateManager.updateCurrentScenario({
          snapshot: targetSnapshot,
          scenarioName: scenarioName
        });
        gameStateManager.setTransitionFlag(true);
        
        console.log(`Director Agent: Progressed to scenario "${scenarioName}" snapshot "${targetSnapshotId}" (checkpoint created)`);
      } else {
        console.warn(`Director Agent: Could not find target snapshot "${targetSnapshotId}" in any scenario`);
      }
    } catch (error) {
      console.error("Error executing scenario progression:", error);
    }
  }

  /**
   * Select snapshot based on current game time
   */
  private selectSnapshotByTime(
    snapshots: Array<{ snapshot_id: string; snapshot_name: string; location: string; description: string; time_restriction: string | null }>,
    currentDay: number,
    currentTime: string
  ): typeof snapshots[0] | null {
    // First, try to find snapshots without time restriction
    const noRestriction = snapshots.find(s => !s.time_restriction);
    if (noRestriction) {
      return noRestriction;
    }
    
    // Then, try to find snapshots that match current time
    const matchingTime = snapshots.find(s => {
      if (!s.time_restriction) return false;
      const restriction = s.time_restriction.toLowerCase();
      
      // Check for "dayX (after)" format - available from day X onwards
      const afterMatch = restriction.match(/day\s*(\d+)\s*\(after\)/i);
      if (afterMatch) {
        const requiredDay = parseInt(afterMatch[1]);
        return currentDay >= requiredDay;
      }
      
      // Check for "dayX evening" format - only available on day X evening
      const eveningMatch = restriction.match(/day\s*(\d+)\s*evening/i);
      if (eveningMatch) {
        const requiredDay = parseInt(eveningMatch[1]);
        return currentDay === requiredDay && (currentTime.includes("evening") || parseInt(currentTime.split(":")[0]) >= 18);
      }
      
      // Check for exact "dayX" match
      const dayMatch = restriction.match(/day\s*(\d+)/i);
      if (dayMatch) {
        const requiredDay = parseInt(dayMatch[1]);
        return currentDay === requiredDay;
      }
      
      return false;
    });
    
    if (matchingTime) {
      return matchingTime;
    }
    
    // If no match, return the first snapshot (fallback)
    return snapshots[0] || null;
  }

  /**
   * Build complete snapshot object from database row
   */
  private async buildSnapshotFromRow(snapshotId: string): Promise<ScenarioSnapshot | null> {
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
    
    // Get scenario for permanent changes
    const scenario = database
      .prepare(`SELECT permanent_changes, map_image_path FROM scenarios WHERE scenario_id = ?`)
      .get(snap.scenario_id) as any;
    
    const snapshot: ScenarioSnapshot = {
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
      events: snap.events ? JSON.parse(snap.events) : [],
      exits: snap.exits ? JSON.parse(snap.exits) : [],
      permanentChanges: scenario?.permanent_changes ? JSON.parse(scenario.permanent_changes) : [],
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
    targetSnapshot: ScenarioSnapshot,
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

    // First, update non-player scenarios before scene transition
    console.log(`\n🔄 [Director Agent] Updating non-player scenarios before scene transition...`);
    try {
      await this.updateNonPlayerScenarios(gameStateManager);
      console.log(`✅ [Director Agent] Non-player scenarios updated`);
    } catch (error) {
      console.error(`❌ [Director Agent] Failed to update non-player scenarios:`, error);
      // Continue with scene transition even if update fails
    }

    const dynamicState = gameStateManager.getState();
    const currentScenario = dynamicState.currentScenario;

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

    // Get scene change request
    const sceneChangeRequest = dynamicState.temporaryInfo.sceneChangeRequest;

    // Get current snapshot info
    const currentSnapshot = currentScenario ? {
      name: currentScenario.name,
      location: currentScenario.location,
      description: currentScenario.description
    } : null;

    // Get available scenarios with their connections and IDs from scenarioOutlines
    const availableScenarios = dynamicState.scenarioOutlines.map(outline => ({
      id: outline.id,
      name: outline.name,
      connections: outline.connections || []
    }));

    // Use LLM to validate and select target scenario
    console.log(`\n🤖 [Using LLM to Select Target Scenario]:`);
    const runtime = createRuntime();
    const template = getActionDrivenSceneChangeTemplate();

    const templateContext = {
      sceneChangeRequest,
      currentSnapshot,
      availableScenarios
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

      // Parse LLM response
      let parsedResponse: {
        targetScenarioName?: string;
        targetScenarioId?: string;
      };
      try {
        // Try to extract JSON from markdown code blocks first
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

      // Validate and execute scene change
      if (parsedResponse?.targetScenarioId && parsedResponse?.targetScenarioName) {
        console.log(`   ✓ LLM returned scenario: ${parsedResponse.targetScenarioName} (ID: ${parsedResponse.targetScenarioId})`);

        // Find the initial snapshot for this scenario
        const database = this.db.getDatabase();
        const initialSnapshot = database
          .prepare(`SELECT snapshot_id FROM scenario_snapshots WHERE scenario_id = ? AND initial_snapshot = 1 LIMIT 1`)
          .get(parsedResponse.targetScenarioId) as { snapshot_id: string } | undefined;

        if (initialSnapshot) {
          // Execute scene progression using snapshot ID
          await this.executeScenarioProgression(
            initialSnapshot.snapshot_id,
            gameStateManager,
            null
          );
        } else {
          console.error(`   ❌ No initial snapshot found for scenario ${parsedResponse.targetScenarioId}`);
        }
      } else {
        console.error(`   ❌ Missing targetScenarioName or targetScenarioId in LLM response`);
      }
    } catch (error) {
      console.error(`   ❌ LLM call failed:`, error);
    }
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
    snapshot: ScenarioSnapshot;
  }>> {
    const database = this.db.getDatabase();
    const allScenarios = this.scenarioLoader.getAllScenarios();
    
    const scenariosWithLatestSnapshots: Array<{
      scenarioId: string;
      scenarioName: string;
      snapshot: ScenarioSnapshot;
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
      let latestSnapshot: ScenarioSnapshot | null = null;
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
   * Get NPCs that should be in a specific scenario at the current time point
   * Based on NPC's currentLocation, actionLog, and scenario conditions
   */
  private getNPCsForScenario(
    scenarioLocation: string,
    scenarioId: string,
    npcCharacters: NPCProfile[],
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
    status: string;
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
      status: string;
      actionLog: ActionLogEntry[];
      instantiatedFrom?: string | null;
      inheritsKnowledge?: string[];
    }> = [];

    for (const npc of npcCharacters) {
      const npcProfile = npc;
      
      // Check if NPC is currently in this scenario location
      // Priority: 1) currentLocation matches, 2) latest actionLog location matches
      let isInScenario = false;
      
      // Check currentLocation
      if (npcProfile.currentLocation && 
          npcProfile.currentLocation.toLowerCase() === scenarioLocation.toLowerCase()) {
        isInScenario = true;
      }
      
      // Check latest actionLog entry location
      if (!isInScenario && npcProfile.actionLog && npcProfile.actionLog.length > 0) {
        const latestLog = npcProfile.actionLog[npcProfile.actionLog.length - 1];
        if (latestLog.location && 
            latestLog.location.toLowerCase() === scenarioLocation.toLowerCase()) {
          isInScenario = true;
        }
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
          status: "alive", // Default status, can be updated by LLM
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
   * Save simplified snapshot to database
   */
  private async saveSimplifiedSnapshotToDatabase(
    scenarioId: string,
    snapshot: ScenarioSnapshot
  ): Promise<ScenarioSnapshot> {
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
      JSON.stringify(snapshot.events || []),
      JSON.stringify(snapshot.exits || []),
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
        // NPCs can move between scenarios based on their actionLog and currentLocation
        const npcsInScenario = this.getNPCsForScenario(
          item.snapshot.location,
          item.scenarioId,
          dynamicState.npcCharacters,
          item.snapshot.gameTime, // Previous snapshot time (for timeline extraction)
          currentGameTime // Current game time (unified for all snapshots)
        );

        // Get scenario outline to access sourcePlaceId
        const scenarioOutline = scenarioOutlineMap.get(item.scenarioId);

        return {
          scenarioId: item.scenarioId,
          scenarioName: item.scenarioName,
          sourcePlaceId: scenarioOutline?.sourcePlaceId || null, // Knowledge holder PLACE ID
          sourcePlaceName: scenarioOutline?.sourcePlaceName || null,
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
        knowledgeMatrixJson: JSON.stringify(dynamicState.knowledgeMatrix, null, 2)
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
          events?: string[];
          keeperNotes?: string;
        };
        updatedSnapshots?: Array<{
          scenarioId: string;
          snapshot: ScenarioSnapshot;
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
          // Validate actionLog format
          if (item.snapshot.characters) {
            for (const char of item.snapshot.characters) {
              const charWithActionLog = char as ScenarioCharacter & { actionLog?: ActionLogEntry[] };
              if (charWithActionLog.actionLog) {
                // Validate each actionLog entry
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
          const snapshotWithUnifiedTime: ScenarioSnapshot = {
            ...item.snapshot,
            gameTime: currentGameTime // Use unified current game time
          };
          
          // Save to database
          const savedSnapshot = await this.saveSimplifiedSnapshotToDatabase(
            item.scenarioId,
            snapshotWithUnifiedTime
          );

          // Save to state
          gameStateManager.setUpdatedScenarioSnapshot(item.scenarioId, savedSnapshot);

          console.log(`   ✓ Updated snapshot for scenario ${item.scenarioId}`);
        }
      }

      // Save global trigger condition
      if (parsedResponse.globalTrigger) {
        gameStateManager.setGlobalScenarioUpdateTrigger(parsedResponse.globalTrigger);
        console.log(`   ✓ Saved global trigger condition`);
        if (parsedResponse.globalTrigger.timeRestriction) {
          console.log(`     - Time: ${parsedResponse.globalTrigger.timeRestriction}`);
        }
        if (parsedResponse.globalTrigger.events && parsedResponse.globalTrigger.events.length > 0) {
          console.log(`     - Events: ${parsedResponse.globalTrigger.events.join(", ")}`);
        }
      }

      console.log(`✅ [Director Agent] Scenario update completed`);
    } catch (error) {
      console.error(`❌ [Director Agent] Failed to update scenarios:`, error);
      throw error;
    }
  }
}
