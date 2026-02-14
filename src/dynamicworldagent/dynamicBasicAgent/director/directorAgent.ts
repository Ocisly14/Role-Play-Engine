import {
  getNpcActionTimelineTemplate,
  getNpcActionTimelineWithPlayerSceneIngressTemplate,
  getTargetSnapshotFromTimelineTemplate,
  getCurrentSceneReactionSnapshotTemplate,
  getBackgroundSimplifiedSnapshotsTemplate,
  getGlobalTriggerEventCheckTemplate,
  getStuckHintNarrativeTemplate,
} from "./directorTemplate.js";
import { composeTemplate } from "../../../template.js";
import type { ScenarioCharacter } from "../../../shared/agents/models/scenarioTypes.js";
import type { DynamicScenarioSnapshot } from "../../world_builder/types.js";
import { ScenarioLoader } from "../../../shared/agents/memory/scenarioloader/index.js";
import type { CoCDatabase, CoCDatabaseAdapter } from "../../../shared/agents/memory/database/index.js";
import type { DynamicGameState } from "../../state/index.js";
import { DynamicGameStateManager } from "../../state/index.js";
import type {
  ActionLogEntry,
  CharacterStatus,
  InventoryItem,
  NPCRelationship,
} from "../../../shared/agents/models/gameTypes.js";
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
import { getPrismaClient } from "../../../shared/agents/memory/database/prismaClient.js";

interface DirectorRuntime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): DirectorRuntime => ({
  modelProvider:
    (process.env.MODEL_PROVIDER as ModelProviderName) ||
    ModelProviderName.OPENAI,
  getSetting: (key: string) => process.env[key],
});

/**
 * Director Agent - Story progression and scene transition director
 * Responsible for monitoring game progress and advancing story development
 */
export class DirectorAgent {
  private scenarioLoader: ScenarioLoader;
  private db: CoCDatabase | CoCDatabaseAdapter;

  constructor(scenarioLoader: ScenarioLoader, db: CoCDatabase | CoCDatabaseAdapter) {
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
        scenarioName: scenarioName,
      });
      // Note: Scene change is now tracked via temporaryInfo.sceneChangeRequest

      const updatedState = gameStateManager.getState();

      console.log(`   ✓ Scene transition completed successfully`);
      console.log(`\n📍 [Post-Transition State]:`);
      console.log(
        `   Current Scene: ${updatedState.currentScenario?.name || "None"}`
      );
      console.log(`   Scene ID: ${updatedState.currentScenario?.id || "None"}`);
      console.log(
        `   Location: ${updatedState.currentScenario?.location || "None"}`
      );

      console.log(`\n✅ [Director Agent] Scene transition completed`);
      console.log(
        `🎬 [Director Agent] ========================================\n`
      );
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
    console.log(
      `\n🎬 [Director Agent] ========================================`
    );
    console.log(
      `🎬 [Director Agent] Starting to process Action-driven scene transition`
    );
    console.log(`🎬 [Director Agent] ========================================`);

    const dynamicState = gameStateManager.getState();
    const currentScenario = dynamicState.currentScenario;
    const sceneChangeRequest = dynamicState.temporaryInfo.sceneChangeRequest;

    // Save current scenario as previousScenario for Keeper to access
    if (currentScenario) {
      dynamicState.temporaryInfo.previousScenario = { ...currentScenario };
      console.log(
        `\n💾 [Director Agent] Saved previous scenario: ${currentScenario.name}`
      );
    }

    // Log current state
    console.log(`\n📍 [Current Scene State]:`);
    if (currentScenario) {
      console.log(`   Scene Name: ${currentScenario.name}`);
      console.log(`   Scene ID: ${currentScenario.id}`);
      console.log(`   Location: ${currentScenario.location}`);
      console.log(
        `   Description: ${currentScenario.description ? currentScenario.description.substring(0, 100) + "..." : "None"}`
      );
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
    let updateResult =
      await this.updateScenariosForSceneSwitch(gameStateManager);

    if (!updateResult) {
      const currentProvider =
        (process.env.MODEL_PROVIDER as ModelProviderName) ||
        ModelProviderName.OPENAI;
      const canFallbackToOpenAI =
        currentProvider !== ModelProviderName.OPENAI &&
        Boolean(process.env.OPENAI_API_KEY?.trim());

      if (canFallbackToOpenAI) {
        console.warn(
          `   ⚠️ Scene switch validation failed with ${currentProvider}, retrying scene switch generation with openai...`
        );
        updateResult = await this.updateScenariosForSceneSwitch(gameStateManager, {
          providerOverride: ModelProviderName.OPENAI,
        });

        if (updateResult) {
          console.log(`   ✓ OpenAI scene switch retry succeeded`);
        }
      }
    }

    if (!updateResult) {
      // Validation failed, clear scene change request and return
      console.error(`   ❌ Scene change validation failed`);
      gameStateManager.clearSceneChangeRequest();
      return;
    }

    const {
      validatedTargetSceneName,
      targetSnapshot,
      backgroundSnapshots,
      modifiedConnections,
    } = updateResult;

    console.log(`   ✓ Validated target scene: ${validatedTargetSceneName}`);
    console.log(`   ✓ Generated complete target snapshot`);
    console.log(`   ✓ Background simplified snapshots completed`);
    if (modifiedConnections) {
      console.log(
        `   ✓ Updated ${modifiedConnections.length} connections for target scene`
      );
    }

    // Step 2: Find target scenario outline to get scenarioId
    const targetScenarioOutline = dynamicState.scenarioOutlines.find(
      (outline) => outline.name === validatedTargetSceneName
    );

    if (!targetScenarioOutline) {
      console.error(
        `   ❌ Target scenario outline not found for: ${validatedTargetSceneName}`
      );
      gameStateManager.clearSceneChangeRequest();
      return;
    }

    // Step 3: Save target snapshot to state (using scenarioId as key)
    // Ensure gameStateManager has db for snapshot management
    gameStateManager.setDb(this.db);
    await gameStateManager.setUpdatedDynamicScenarioSnapshot(
      targetScenarioOutline.id,
      targetSnapshot
    );

    if (backgroundSnapshots.size > 0) {
      for (const [scenarioId, snapshot] of backgroundSnapshots) {
        await gameStateManager.setUpdatedDynamicScenarioSnapshot(
          scenarioId,
          snapshot
        );
      }
    }

    console.log(`   ✓ Saved target snapshot to state`);

    // Step 4: Execute scene transition using the UPDATED complete snapshot
    await this.executeSceneTransition(
      targetSnapshot,
      validatedTargetSceneName,
      gameStateManager
    );

    // Step 5: Clean up scene change request
    gameStateManager.clearSceneChangeRequest();

    console.log(`✅ [Director Agent] Scene change completed successfully`);
    console.log(
      `🎬 [Director Agent] ========================================\n`
    );
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
    console.log(
      `   Consecutive triggers: ${dynamicState.consecutiveProgressionTriggers} / 3`
    );

    // Check if either threshold is reached
    const shouldTrigger = gameStateManager.shouldTriggerProgression();

    if (!shouldTrigger) {
      if (dynamicState.consecutiveProgressionTriggers >= 3) {
        console.log(
          `   ⚠️ Max consecutive triggers reached (3), skipping to prevent infinite loop`
        );
      } else {
        console.log(`   ✓ No trigger conditions met`);
      }
      return { shouldTrigger: false, recentActionLog: [] };
    }

    // Increment consecutive trigger count
    gameStateManager.incrementConsecutiveTriggers();
    const currentTriggerCount =
      gameStateManager.getState().consecutiveProgressionTriggers;

    // Log which condition triggered
    if (turnsInScene >= threshold) {
      console.log(
        `   ⚠️ Turn threshold reached! Getting recent player actions... (trigger ${currentTriggerCount}/3)`
      );
    } else if (minutesSinceInput >= 3) {
      console.log(
        `   ⚠️ Time threshold reached (3 min idle)! Getting recent player actions... (trigger ${currentTriggerCount}/3)`
      );
    }

    // Get player's actionLog from the last 3 turns
    const playerActionLog = dynamicState.playerCharacter.actionLog || [];

    // Get recent conversation history to determine which actionLog entries belong to last 3 turns
    const conversationHistory =
      (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
        turnNumber: number;
        characterInput: string;
        keeperNarrative: string | null;
        actionAnalysis?: any;
      }>) || [];

    // Get last 3 turns
    const last3Turns = conversationHistory.slice(-3);
    const last3TurnNumbers = new Set(last3Turns.map((t) => t.turnNumber));

    // Filter actionLog entries that belong to the last 3 turns
    // We'll use a simple approach: get the last N entries where N is roughly the number of actions in 3 turns
    // Or we can get all actionLog entries and let Character Agent analyze them
    // For simplicity, let's get the last 10-15 entries (assuming 3-5 actions per turn)
    const recentActionLog = playerActionLog.slice(-15);

    if (recentActionLog.length > 0) {
      console.log(
        `   ✓ Found ${recentActionLog.length} recent actionLog entries`
      );
      console.log(
        `   Latest actions: ${recentActionLog
          .slice(-3)
          .map((a) => a.summary)
          .join("; ")}`
      );
    } else {
      console.log(`   ⚠️ No recent actionLog entries found`);
    }

    return { shouldTrigger: true, recentActionLog };
  }

  /**
   * Parse game time from snapshot gameTime string or actionLog time
   * Format: "Day N, HH:MM" or "initial" or other formats
   */
  private parseGameTimeFromSnapshot(
    gameTime?: string
  ): { gameDay: number; timeOfDay: string } | null {
    if (!gameTime) return null;

    // Handle "initial" or other non-standard formats
    if (gameTime.toLowerCase() === "initial" || !gameTime.includes("Day")) {
      return null; // Cannot parse, treat as before any valid time
    }

    const match = gameTime.match(/Day\s*(\d+),\s*(\d{2}:\d{2})/i);
    if (match) {
      return {
        gameDay: parseInt(match[1], 10),
        timeOfDay: match[2],
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
  ): Promise<
    Array<{
      scenarioId: string;
      scenarioName: string;
      snapshot: DynamicScenarioSnapshot;
    }>
  > {
    const allScenarios = await this.scenarioLoader.getAllScenarios();

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
      const snapshots = dynamicState.updatedDynamicScenarioSnapshots.get(
        scenario.id
      );
      let snapshot: DynamicScenarioSnapshot | null = null;

      if (snapshots && snapshots.length > 0) {
        // Get the latest snapshot (last in array)
        snapshot = snapshots[snapshots.length - 1];
      }

      // If no updated snapshot, get initial snapshot from scenarioLoader
      if (!snapshot) {
        const scenarioProfile = await this.scenarioLoader.getScenarioById(
          scenario.id
        );
        if (scenarioProfile && scenarioProfile.snapshot) {
          snapshot = scenarioProfile.snapshot;
        }
      }

      if (snapshot) {
        scenariosWithLatestSnapshots.push({
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          snapshot: snapshot,
        });
      }
    }

    return scenariosWithLatestSnapshots;
  }

  /**
   * Get current location from actionLog (latest entry with location)
   */
  private getCurrentLocationFromActionLog(
    actionLog?: ActionLogEntry[]
  ): string | null {
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
   * Convert full character data to lightweight ScenarioCharacter format
   * This prevents data duplication in snapshots (full data is in gameState.npcCharacters)
   */
  private convertToLightweightScenarioCharacter(
    char: ScenarioCharacter & {
      actionLog?: ActionLogEntry[];
      status?: any;
      inventory?: any;
      relationships?: any;
    }
  ): ScenarioCharacter {
    // Extract latest location from actionLog if available
    let location = char.location;
    if (char.actionLog && char.actionLog.length > 0) {
      const latestLog = char.actionLog[char.actionLog.length - 1];
      if (latestLog.location) {
        location = latestLog.location;
      }
    }

    // Determine status string based on character state
    let statusString = 'active'; // Default status

    // If status is already a string, use it
    if (typeof char.status === 'string') {
      statusString = char.status;
    }
    // If status is an object with HP/sanity deltas, infer status
    else if (char.status && typeof char.status === 'object') {
      const statusObj = char.status as Partial<CharacterStatus>;

      // Check for negative HP changes (injuries)
      if (statusObj.hp !== undefined && statusObj.hp < -5) {
        statusString = 'injured';
      } else if (statusObj.hp !== undefined && statusObj.hp < -10) {
        statusString = 'critically_injured';
      }
      // Check for negative sanity changes (mental state)
      else if (statusObj.sanity !== undefined && statusObj.sanity < -5) {
        statusString = 'shaken';
      } else if (statusObj.sanity !== undefined && statusObj.sanity < -10) {
        statusString = 'disturbed';
      }
      // Check for conditions
      else if (statusObj.conditions && Array.isArray(statusObj.conditions) && statusObj.conditions.length > 0) {
        statusString = statusObj.conditions[0]; // Use first condition as status
      }
    }

    // Return lightweight ScenarioCharacter (only essential presence info)
    return {
      id: char.id,
      name: char.name,
      role: char.role || 'npc',
      status: statusString,
      location: location || 'unknown',
      notes: char.notes,
    };
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
      const currentLocation = this.getCurrentLocationFromActionLog(
        npcProfile.actionLog
      );
      let isInScenario = false;

      if (
        currentLocation &&
        currentLocation.toLowerCase() === scenarioLocation.toLowerCase()
      ) {
        isInScenario = true;
      }

      if (isInScenario) {
        // Extract timeline actionLog from previous snapshot time to current time
        // This creates a timeline of events that happened in this scenario during the time period
        let timelineActionLog: ActionLogEntry[] = [];

        if (npcProfile.actionLog && npcProfile.actionLog.length > 0) {
          // Filter actionLog entries that fall between previous snapshot time and current time
          // This represents what happened in the scenario during this time period
          timelineActionLog = npcProfile.actionLog.filter((log) => {
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
            return (
              this.isTimeAfter(log.time, previousSnapshotTime) &&
              this.isTimeBeforeOrEqual(log.time, currentGameTime)
            );
          });

          // Sort by time to ensure chronological order
          timelineActionLog.sort((a, b) => {
            const timeA = this.parseGameTimeFromSnapshot(a.time);
            const timeB = this.parseGameTimeFromSnapshot(b.time);
            if (!timeA || !timeB) return 0;
            if (timeA.gameDay !== timeB.gameDay)
              return timeA.gameDay - timeB.gameDay;
            const [hA, mA] = timeA.timeOfDay.split(":").map(Number);
            const [hB, mB] = timeB.timeOfDay.split(":").map(Number);
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
          inheritsKnowledge: npcProfile.inheritsKnowledge || [], // Truth event IDs this NPC knows
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
    const [h1, m1] = t1.timeOfDay.split(":").map(Number);
    const [h2, m2] = t2.timeOfDay.split(":").map(Number);

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
    const [h1, m1] = t1.timeOfDay.split(":").map(Number);
    const [h2, m2] = t2.timeOfDay.split(":").map(Number);

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
    const exactMatch = npcCharacters.find((npc) => npc.id === targetId);
    if (exactMatch) {
      return exactMatch;
    }

    // Stage 2: Fuzzy match by ID (case-insensitive, normalized)
    const normalizeId = (id: string) =>
      id
        .toLowerCase()
        .trim()
        .replace(/[\s_-]/g, "");
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
      } else if (
        normalizedNpcId.includes(normalizedTargetId) ||
        normalizedTargetId.includes(normalizedNpcId)
      ) {
        score = 0.7; // Medium score for substring match
      }

      // Bonus: Check name similarity if provided
      if (targetName && npc.name) {
        const normalizedTargetName = normalizeId(targetName);
        const normalizedNpcName = normalizeId(npc.name);

        if (normalizedNpcName === normalizedTargetName) {
          score += 0.3;
        } else if (
          normalizedNpcName.includes(normalizedTargetName) ||
          normalizedTargetName.includes(normalizedNpcName)
        ) {
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
      console.log(
        `   ℹ️  Fuzzy matched "${targetId}"${targetName ? ` (${targetName})` : ""} → "${bestMatch?.id}" (${bestMatch?.name}) [score: ${bestScore.toFixed(2)}]`
      );
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
      inventory?:
        | { add?: InventoryItem[]; remove?: InventoryItem[] }
        | InventoryItem[];
      relationships?: NPCRelationship[];
      actionLog?: ActionLogEntry[];
    }
  ): void {
    // Apply status delta (only changed attributes)
    if (delta.status) {
      for (const [key, value] of Object.entries(delta.status)) {
        if (typeof value === "number" && key in npc.status) {
          // Apply differential update (e.g., hp: -2 means subtract 2)
          (npc.status as any)[key] += value;

          // Ensure values don't go below 0 (except for conditions array)
          if (key !== "conditions" && (npc.status as any)[key] < 0) {
            (npc.status as any)[key] = 0;
          }

          // Ensure hp/sanity don't exceed max
          if (key === "hp" && npc.status.hp > npc.status.maxHp) {
            npc.status.hp = npc.status.maxHp;
          }
          if (key === "sanity" && npc.status.sanity > npc.status.maxSanity) {
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
      } else if (
        typeof delta.inventory === "object" &&
        !Array.isArray(delta.inventory)
      ) {
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
        const existingIndex = npc.relationships.findIndex(
          (r) => r.targetId === newRel.targetId
        );
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
          (existing) =>
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
        if (timeA.gameDay !== timeB.gameDay)
          return timeA.gameDay - timeB.gameDay;
        const [hA, mA] = timeA.timeOfDay.split(":").map(Number);
        const [hB, mB] = timeB.timeOfDay.split(":").map(Number);
        return hA * 60 + mA - (hB * 60 + mB);
      });
    }
  }

  private parseModelJson<T>(response: string, label: string): T | null {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as T;
      }
      return JSON.parse(response) as T;
    } catch (error) {
      console.error(`❌ Failed to parse ${label} response as JSON:`, error);
      console.error(`Raw ${label} response:`, response);
      return null;
    }
  }

  private getLatestActionLogAtOrBefore(
    actionLog: ActionLogEntry[] | undefined,
    cutoffGameTime: string
  ): ActionLogEntry | null {
    if (!actionLog || actionLog.length === 0) {
      return null;
    }

    for (let i = actionLog.length - 1; i >= 0; i--) {
      const entry = actionLog[i];
      if (!entry.time || !entry.location) {
        continue;
      }
      if (this.isTimeBeforeOrEqual(entry.time, cutoffGameTime)) {
        return entry;
      }
    }

    return null;
  }

  private getPlayerActionLogInWindow(
    playerActionLog: ActionLogEntry[] | undefined,
    previousSnapshotTime: string | undefined,
    currentGameTime: string
  ): ActionLogEntry[] {
    if (!playerActionLog || playerActionLog.length === 0) {
      return [];
    }

    const filtered = playerActionLog.filter((entry) => {
      if (!entry.time || !entry.location || !entry.summary) {
        return false;
      }
      if (!this.isTimeBeforeOrEqual(entry.time, currentGameTime)) {
        return false;
      }
      if (!previousSnapshotTime) {
        return true;
      }
      return this.isTimeAfter(entry.time, previousSnapshotTime);
    });

    filtered.sort((a, b) => {
      const timeA = this.parseGameTimeFromSnapshot(a.time);
      const timeB = this.parseGameTimeFromSnapshot(b.time);
      if (!timeA || !timeB) return 0;
      if (timeA.gameDay !== timeB.gameDay) {
        return timeA.gameDay - timeB.gameDay;
      }
      const [hA, mA] = timeA.timeOfDay.split(":").map(Number);
      const [hB, mB] = timeB.timeOfDay.split(":").map(Number);
      return hA * 60 + mA - (hB * 60 + mB);
    });

    return filtered;
  }

  private buildLightweightCharactersForScene(
    sceneLocation: string,
    currentGameTime: string,
    npcs: DynamicNPCProfile[]
  ): ScenarioCharacter[] {
    const characters: ScenarioCharacter[] = [];
    const normalizedSceneLocation = sceneLocation.toLowerCase().trim();

    for (const npc of npcs) {
      const latestEntry = this.getLatestActionLogAtOrBefore(
        npc.actionLog,
        currentGameTime
      );
      if (!latestEntry || !latestEntry.location) {
        continue;
      }

      if (latestEntry.location.toLowerCase().trim() !== normalizedSceneLocation) {
        continue;
      }

      const lightweight = this.convertToLightweightScenarioCharacter({
        id: npc.id,
        name: npc.name,
        role: "npc",
        status: "active",
        location: latestEntry.location,
        notes: latestEntry.summary,
      });

      characters.push(lightweight);
    }

    return characters;
  }

  private async getLatestScenarioSnapshot(
    scenarioId: string,
    dynamicState: DynamicGameState
  ): Promise<DynamicScenarioSnapshot | null> {
    const updatedSnapshots =
      dynamicState.updatedDynamicScenarioSnapshots.get(scenarioId);
    if (updatedSnapshots && updatedSnapshots.length > 0) {
      return updatedSnapshots[updatedSnapshots.length - 1];
    }

    const scenarioProfile = await this.scenarioLoader.getScenarioById(scenarioId);
    return scenarioProfile?.snapshot || null;
  }

  private async applyScenarioConnectionsUpdate(
    dynamicState: DynamicGameState,
    scenarioName: string,
    modifiedConnections: Array<{
      scenarioName: string;
      relationshipType: string;
      description?: string;
      blocked?: boolean;
      blockReason?: string | null;
    }>
  ): Promise<void> {
    if (!modifiedConnections || modifiedConnections.length === 0) {
      return;
    }

    const targetScenarioOutline = dynamicState.scenarioOutlines.find(
      (outline) => outline.name === scenarioName
    );

    if (!targetScenarioOutline) {
      console.warn(
        `   ⚠️ Target scenario outline not found for connection update: ${scenarioName}`
      );
      return;
    }

    const prisma = getPrismaClient();
    await prisma.scenario.update({
      where: { scenarioId: targetScenarioOutline.id },
      data: { connections: modifiedConnections as any },
    });

    const convertedConnections = modifiedConnections.map((conn) => {
      const linkedScenario = dynamicState.scenarioOutlines.find(
        (outline) =>
          outline.name === conn.scenarioName || outline.id === conn.scenarioName
      );

      return {
        scenarioName: linkedScenario?.name || conn.scenarioName,
        scenarioId: linkedScenario?.id || conn.scenarioName,
        relationshipType: conn.relationshipType as ScenarioConnectionType,
        description: conn.description,
        blocked: conn.blocked,
        blockReason: conn.blockReason ?? undefined,
      };
    });

    targetScenarioOutline.connections = convertedConnections;
  }

  /**
   * Update scenarios for scene switch in 3 phases:
   * 1) Generate background NPC action timeline + merge deltas
   * 2) Generate target snapshot + optional global trigger
   * 3) Generate and apply background simplified snapshot updates
   */
  async updateScenariosForSceneSwitch(
    gameStateManager: DynamicGameStateManager,
    options?: {
      providerOverride?: ModelProviderName;
    }
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

    gameStateManager.setDb(this.db);

    const dynamicState = gameStateManager.getState();
    const sceneChangeRequest = dynamicState.temporaryInfo.sceneChangeRequest;
    const currentScenario = dynamicState.currentScenario;
    const currentScenarioName = currentScenario?.name || null;

    if (!sceneChangeRequest) {
      console.error(`   ❌ No scene change request found`);
      return null;
    }

    console.log(
      `   📋 Scene change request: ${sceneChangeRequest.targetSceneName}`
    );
    console.log(`   📍 Current scenario: ${currentScenarioName}`);

    try {
      const currentGameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
      const runtime = createRuntime();

      const allScenarios = await this.scenarioLoader.getAllScenarios();
      const scenarioOutlineMap = new Map(
        dynamicState.scenarioOutlines.map((outline) => [outline.id, outline])
      );

      const allScenariosData: Array<{
        scenarioId: string;
        scenarioName: string;
        sourcePlaceId: string | null;
        sourcePlaceName: string | null;
        connections: unknown[];
        snapshot: {
          id: string;
          name: string;
          location: string;
          description: string;
          clues: unknown[];
          conditions: unknown[];
          previousGameTime: string | null;
        };
      }> = [];

      for (const scenario of allScenarios) {
        const latestSnapshot = await this.getLatestScenarioSnapshot(
          scenario.id,
          dynamicState
        );
        if (!latestSnapshot) {
          continue;
        }

        const scenarioOutline = scenarioOutlineMap.get(scenario.id);
        allScenariosData.push({
          scenarioId: scenario.id,
          scenarioName: scenario.name,
          sourcePlaceId: scenarioOutline?.sourcePlaceId || null,
          sourcePlaceName: scenarioOutline?.sourcePlaceName || null,
          connections: scenarioOutline?.connections || [],
          snapshot: {
            id: latestSnapshot.id,
            name: latestSnapshot.name,
            location: latestSnapshot.location,
            description: latestSnapshot.description,
            clues: latestSnapshot.clues || [],
            conditions: latestSnapshot.conditions || [],
            previousGameTime: latestSnapshot.gameTime || null,
          },
        });
      }

      const targetScenarioData = allScenariosData.find(
        (s) =>
          s.scenarioName === sceneChangeRequest.targetSceneName ||
          s.scenarioId === sceneChangeRequest.targetSceneName
      );

      if (!targetScenarioData) {
        console.error(
          `   ❌ Target scenario "${sceneChangeRequest.targetSceneName}" not found in scenario list`
        );
        return null;
      }

      const previousSnapshotTime =
        targetScenarioData.snapshot.previousGameTime ||
        currentScenario?.gameTime ||
        currentGameTime;

      const currentSceneLocation = currentScenario?.location?.toLowerCase().trim();
      const excludedNpcIds = new Set<string>();

      if (currentSceneLocation) {
        for (const npc of dynamicState.npcCharacters) {
          const latest = this.getLatestActionLogAtOrBefore(
            npc.actionLog,
            currentGameTime
          );
          if (
            latest?.location &&
            latest.location.toLowerCase().trim() === currentSceneLocation
          ) {
            excludedNpcIds.add(npc.id);
          }
        }
      }

      const backgroundNpcs = dynamicState.npcCharacters
        .filter((npc) => !excludedNpcIds.has(npc.id))
        .map((npc) => ({
          ...npc,
          actionLog: npc.actionLog || [],
        }));

      console.log(
        `   📋 Phase 1: Generating timeline for ${backgroundNpcs.length} background NPCs...`
      );

      const phase1Context = {
        currentGameDay: dynamicState.gameDay,
        currentTimeOfDay: dynamicState.timeOfDay,
        previousSnapshotTime,
        currentGameTime,
        truthTimelineJson: JSON.stringify(dynamicState.truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(dynamicState.knowledgeMatrix, null, 2),
        previousGlobalTrigger: dynamicState.globalTrigger,
        previousGlobalTriggerJson: dynamicState.globalTrigger
          ? JSON.stringify(dynamicState.globalTrigger, null, 2)
          : null,
        playerCurrentSceneJson: JSON.stringify(
          currentScenario
            ? {
                id: currentScenario.id,
                name: currentScenario.name,
                location: currentScenario.location,
              }
            : null,
          null,
          2
        ),
        allScenariosJson: JSON.stringify(allScenariosData, null, 2),
        backgroundNpcsJson: JSON.stringify(backgroundNpcs, null, 2),
      };

      const phase1Prompt = composeTemplate(
        getNpcActionTimelineTemplate(),
        { dynamicGameState: dynamicState },
        phase1Context,
        "handlebars"
      );

      const phase1Response = await generateText({
        runtime,
        context: phase1Prompt,
        modelClass: ModelClass.MEDIUM,
        providerOverride: options?.providerOverride,
      });

      type TimelineNpcUpdate = {
        id: string;
        actionLog?: ActionLogEntry[];
        statusDelta?: Partial<CharacterStatus>;
        inventoryDelta?: { add?: InventoryItem[]; remove?: InventoryItem[] };
      };
      type TimelineBucket = {
        time?: string;
        npcActionLogUpdates?: TimelineNpcUpdate[];
      };
      const parsedTimeline = this.parseModelJson<{
        actionTimeline?: TimelineBucket[];
      }>(phase1Response, "Phase 1 timeline");

      if (!parsedTimeline?.actionTimeline || parsedTimeline.actionTimeline.length === 0) {
        console.error(`   ❌ Phase 1 response missing actionTimeline`);
        return null;
      }

      const cleanedTimeline: TimelineBucket[] = [];
      let mergedNpcUpdates = 0;

      for (const bucket of parsedTimeline.actionTimeline) {
        if (!bucket?.time || !this.isTimeBeforeOrEqual(bucket.time, currentGameTime)) {
          continue;
        }

        const cleanedNpcUpdates: TimelineNpcUpdate[] = [];
        const updates = bucket.npcActionLogUpdates || [];
        for (const update of updates) {
          if (!update?.id || excludedNpcIds.has(update.id)) {
            continue;
          }

          const npc = this.findNPCById(dynamicState.npcCharacters, update.id);
          if (!npc) {
            console.warn(`   ⚠️ NPC "${update.id}" not found, skipping timeline update`);
            continue;
          }

          const validActionLog = (update.actionLog || [])
            .map((entry) => ({
              ...entry,
              time: entry.time || bucket.time || "",
            }))
            .filter((entry) => {
              if (!entry.time || !entry.location || !entry.summary) {
                return false;
              }
              if (!this.isTimeBeforeOrEqual(entry.time, currentGameTime)) {
                return false;
              }
              if (previousSnapshotTime && !this.isTimeAfter(entry.time, previousSnapshotTime)) {
                return false;
              }
              return true;
            });

          // Apply delta only when there is at least one valid actionLog entry in window
          if (validActionLog.length === 0) {
            continue;
          }

          this.mergeCharacterDeltaToNPC(npc, {
            actionLog: validActionLog,
            status: update.statusDelta,
            inventory: update.inventoryDelta,
          });

          cleanedNpcUpdates.push({
            id: update.id,
            actionLog: validActionLog,
            statusDelta: update.statusDelta,
            inventoryDelta: update.inventoryDelta,
          });
          mergedNpcUpdates += 1;
        }

        if (cleanedNpcUpdates.length > 0) {
          cleanedTimeline.push({
            time: bucket.time,
            npcActionLogUpdates: cleanedNpcUpdates,
          });
        }
      }

      console.log(`   ✓ Phase 1 merged updates for ${mergedNpcUpdates} NPC entries`);

      const playerActionWindow = this.getPlayerActionLogInWindow(
        dynamicState.playerCharacter.actionLog,
        previousSnapshotTime,
        currentGameTime
      );

      const currentSceneId = currentScenario?.id || null;
      const currentSceneName = currentScenario?.name || null;
      const scenesToUpdateInBackground = allScenariosData.filter((scene) => {
        if (scene.scenarioId === targetScenarioData.scenarioId) {
          return false;
        }
        if (currentSceneId && scene.scenarioId === currentSceneId) {
          return false;
        }
        if (currentSceneName && scene.scenarioName === currentSceneName) {
          return false;
        }
        return true;
      });

      // Phase 3 runs in parallel with Phase 2
      const phase3Promise = this.updateBackgroundSimplifiedSnapshotsForSceneSwitch(
        gameStateManager,
        currentGameTime,
        previousSnapshotTime,
        scenesToUpdateInBackground,
        cleanedTimeline,
        playerActionWindow,
        options
      );

      console.log(`   📋 Phase 2: Generating target scene snapshot...`);

      const phase2Context = {
        currentGameDay: dynamicState.gameDay,
        currentTimeOfDay: dynamicState.timeOfDay,
        previousSnapshotTime,
        currentGameTime,
        targetSceneJson: JSON.stringify(
          {
            scenarioId: targetScenarioData.scenarioId,
            scenarioName: targetScenarioData.scenarioName,
            location: targetScenarioData.snapshot.location,
            connections: targetScenarioData.connections,
          },
          null,
          2
        ),
        targetBaselineSnapshotJson: JSON.stringify(targetScenarioData.snapshot, null, 2),
        actionTimelineJson: JSON.stringify({ actionTimeline: cleanedTimeline }, null, 2),
        playerActionWindowJson: JSON.stringify(playerActionWindow, null, 2),
        truthTimelineJson: JSON.stringify(dynamicState.truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(dynamicState.knowledgeMatrix, null, 2),
        endStateJson: dynamicState.endState
          ? JSON.stringify(dynamicState.endState, null, 2)
          : "null",
        previousGlobalTrigger: dynamicState.globalTrigger,
        previousGlobalTriggerJson: dynamicState.globalTrigger
          ? JSON.stringify(dynamicState.globalTrigger, null, 2)
          : null,
      };

      const phase2Prompt = composeTemplate(
        getTargetSnapshotFromTimelineTemplate(),
        { dynamicGameState: dynamicState },
        phase2Context,
        "handlebars"
      );

      const phase2Response = await generateText({
        runtime,
        context: phase2Prompt,
        modelClass: ModelClass.MEDIUM,
        providerOverride: options?.providerOverride,
      });

      const parsedPhase2 = this.parseModelJson<{
        targetSnapshot?: {
          scenarioId: string;
          snapshot: DynamicScenarioSnapshot;
          connections?: Array<{
            scenarioName: string;
            relationshipType: string;
            description?: string;
            blocked?: boolean;
            blockReason?: string | null;
          }>;
        };
        globalTrigger?: {
          timeRestriction?: string;
          timeReason?: string;
          events?: string[];
          eventReasons?: string[];
          keeperNotes?: string;
        };
      }>(phase2Response, "Phase 2 target snapshot");

      if (!parsedPhase2?.targetSnapshot?.snapshot) {
        console.error(`   ❌ Phase 2 response missing targetSnapshot`);
        return null;
      }

      const modifiedConnections = parsedPhase2.targetSnapshot.connections || null;
      const validatedTargetSceneName =
        parsedPhase2.targetSnapshot.snapshot.name || targetScenarioData.scenarioName;

      const targetSnapshot: DynamicScenarioSnapshot = {
        ...parsedPhase2.targetSnapshot.snapshot,
        id:
          parsedPhase2.targetSnapshot.snapshot.id || targetScenarioData.snapshot.id,
        name:
          parsedPhase2.targetSnapshot.snapshot.name ||
          targetScenarioData.snapshot.name,
        location:
          parsedPhase2.targetSnapshot.snapshot.location ||
          targetScenarioData.snapshot.location,
        description:
          parsedPhase2.targetSnapshot.snapshot.description ||
          targetScenarioData.snapshot.description,
        gameTime: currentGameTime,
        snapshotType: "complete",
        clues: Array.isArray(parsedPhase2.targetSnapshot.snapshot.clues)
          ? parsedPhase2.targetSnapshot.snapshot.clues
          : (targetScenarioData.snapshot.clues as DynamicScenarioSnapshot["clues"]),
        conditions: Array.isArray(parsedPhase2.targetSnapshot.snapshot.conditions)
          ? parsedPhase2.targetSnapshot.snapshot.conditions
          : (targetScenarioData.snapshot
              .conditions as DynamicScenarioSnapshot["conditions"]),
        characters: Array.isArray(parsedPhase2.targetSnapshot.snapshot.characters)
          ? (parsedPhase2.targetSnapshot.snapshot
              .characters as DynamicScenarioSnapshot["characters"])
          : this.buildLightweightCharactersForScene(
              parsedPhase2.targetSnapshot.snapshot.location ||
                targetScenarioData.snapshot.location,
              currentGameTime,
              dynamicState.npcCharacters
            ),
      };

      if (modifiedConnections && modifiedConnections.length > 0) {
        await this.applyScenarioConnectionsUpdate(
          dynamicState,
          validatedTargetSceneName,
          modifiedConnections
        );
        console.log(
          `   ✓ Updated ${modifiedConnections.length} connections for target scene`
        );
      }

      if (parsedPhase2.globalTrigger) {
        gameStateManager.setGlobalTrigger(parsedPhase2.globalTrigger);
        console.log(`   ✓ Saved global trigger condition`);
      }

      // Wait for phase 3 completion before returning to avoid mid-save inconsistency
      try {
        await phase3Promise;
      } catch (error) {
        console.error(`   ❌ Background simplified snapshot update failed:`, error);
      }

      console.log(`✅ [Director Agent] Scene switch update completed`);
      console.log(`   - Target: ${validatedTargetSceneName} (complete snapshot)`);
      console.log(`   - Timeline merged updates: ${mergedNpcUpdates}`);

      return {
        validatedTargetSceneName,
        targetSnapshot,
        backgroundSnapshots: new Map(),
        modifiedConnections,
      };
    } catch (error) {
      console.error(
        `❌ [Director Agent] Failed to update scenarios for scene switch:`,
        error
      );
      return null;
    }
  }

  private async updateBackgroundSimplifiedSnapshotsForSceneSwitch(
    gameStateManager: DynamicGameStateManager,
    currentGameTime: string,
    previousSnapshotTime: string,
    scenesToUpdate: Array<{
      scenarioId: string;
      scenarioName: string;
      sourcePlaceId: string | null;
      sourcePlaceName: string | null;
      connections: unknown[];
      snapshot: {
        id: string;
        name: string;
        location: string;
        description: string;
        clues: unknown[];
        conditions: unknown[];
        previousGameTime: string | null;
      };
    }>,
    cleanedTimeline: Array<{
      time?: string;
      npcActionLogUpdates?: Array<{
        id: string;
        actionLog?: ActionLogEntry[];
        statusDelta?: Partial<CharacterStatus>;
        inventoryDelta?: { add?: InventoryItem[]; remove?: InventoryItem[] };
      }>;
    }>,
    playerActionWindow: ActionLogEntry[],
    options?: {
      providerOverride?: ModelProviderName;
    }
  ): Promise<void> {
    if (scenesToUpdate.length === 0) {
      return;
    }

    const dynamicState = gameStateManager.getState();
    const runtime = createRuntime();
    const templateContext = {
      currentGameDay: dynamicState.gameDay,
      currentTimeOfDay: dynamicState.timeOfDay,
      previousSnapshotTime,
      currentGameTime,
      scenesToUpdateJson: JSON.stringify(
        scenesToUpdate.map((scene) => ({
          scenarioId: scene.scenarioId,
          scenarioName: scene.scenarioName,
          location: scene.snapshot.location,
          connections: scene.connections,
        })),
        null,
        2
      ),
      baselineSnapshotsJson: JSON.stringify(
        scenesToUpdate.map((scene) => ({
          scenarioId: scene.scenarioId,
          snapshot: scene.snapshot,
        })),
        null,
        2
      ),
      actionTimelineJson: JSON.stringify({ actionTimeline: cleanedTimeline }, null, 2),
      playerActionWindowJson: JSON.stringify(playerActionWindow, null, 2),
      truthTimelineJson: JSON.stringify(dynamicState.truthTimeline, null, 2),
      knowledgeMatrixJson: JSON.stringify(dynamicState.knowledgeMatrix, null, 2),
    };

    const prompt = composeTemplate(
      getBackgroundSimplifiedSnapshotsTemplate(),
      { dynamicGameState: dynamicState },
      templateContext,
      "handlebars"
    );

    const response = await generateText({
      runtime,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
      providerOverride: options?.providerOverride,
    });

    const parsed = this.parseModelJson<{
      updatedSimplifiedSnapshots?: Array<{
        scenarioId: string;
        snapshot: Partial<DynamicScenarioSnapshot>;
        connections?: Array<{
          scenarioName: string;
          relationshipType: string;
          description?: string;
          blocked?: boolean;
          blockReason?: string | null;
        }>;
      }>;
    }>(response, "Phase 3 simplified snapshots");

    if (!parsed?.updatedSimplifiedSnapshots?.length) {
      console.log(`   ℹ️ Phase 3 returned no simplified snapshot updates`);
      return;
    }

    let updatedCount = 0;
    for (const item of parsed.updatedSimplifiedSnapshots) {
      const baseline = scenesToUpdate.find((scene) => scene.scenarioId === item.scenarioId);
      if (!baseline) {
        continue;
      }

      const latestSnapshot = await this.getLatestScenarioSnapshot(
        item.scenarioId,
        dynamicState
      );
      if (!latestSnapshot) {
        continue;
      }

      const updatedSnapshot: DynamicScenarioSnapshot = {
        ...latestSnapshot,
        description: item.snapshot.description || latestSnapshot.description,
        clues: Array.isArray(item.snapshot.clues)
          ? item.snapshot.clues
          : latestSnapshot.clues,
        conditions: Array.isArray(item.snapshot.conditions)
          ? item.snapshot.conditions
          : latestSnapshot.conditions,
        gameTime: currentGameTime,
        snapshotType: "simplified",
      };

      await gameStateManager.setUpdatedDynamicScenarioSnapshot(
        item.scenarioId,
        updatedSnapshot
      );
      updatedCount += 1;

      if (item.connections && item.connections.length > 0) {
        await this.applyScenarioConnectionsUpdate(
          dynamicState,
          baseline.scenarioName,
          item.connections
        );
      }
    }

    console.log(
      `   ✓ Phase 3 background simplified snapshot updates: ${updatedCount}`
    );
  }

  /**
   * Update non-player scenarios with simplified snapshots
   */
  async updateNonPlayerScenarios(
    gameStateManager: DynamicGameStateManager
  ): Promise<void> {
    console.log(
      `\n🎬 [Director Agent] Starting scenario update for non-player scenes...`
    );

    // Ensure gameStateManager has db for snapshot management
    gameStateManager.setDb(this.db);

    const dynamicState = gameStateManager.getState();
    const currentScenario = dynamicState.currentScenario;
    const currentScenarioId = currentScenario?.id || null;

    // Save checkpoint before scenario update
    await saveDynamicGameStateCheckpoint(
      this.db,
      dynamicState,
      "auto",
      "Before non-player scenario update"
    );

    try {
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

      const currentGameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
      const scenarioOutlineMap = new Map(
        dynamicState.scenarioOutlines.map((outline) => [outline.id, outline])
      );

      const allScenariosData: Array<{
        scenarioId: string;
        scenarioName: string;
        sourcePlaceId: string | null;
        sourcePlaceName: string | null;
        connections: unknown[];
        snapshot: {
          id: string;
          name: string;
          location: string;
          description: string;
          clues: unknown[];
          conditions: unknown[];
          previousGameTime: string | null;
        };
      }> = scenariosWithSnapshots.map((item) => {
        const scenarioOutline = scenarioOutlineMap.get(item.scenarioId);
        return {
          scenarioId: item.scenarioId,
          scenarioName: item.scenarioName,
          sourcePlaceId: scenarioOutline?.sourcePlaceId || null,
          sourcePlaceName: scenarioOutline?.sourcePlaceName || null,
          connections: scenarioOutline?.connections || [],
          snapshot: {
            id: item.snapshot.id,
            name: item.snapshot.name,
            location: item.snapshot.location,
            description: item.snapshot.description,
            clues: item.snapshot.clues || [],
            conditions: item.snapshot.conditions || [],
            previousGameTime: item.snapshot.gameTime || null,
          },
        };
      });

      const previousSnapshotCandidates = allScenariosData
        .map((scene) => scene.snapshot.previousGameTime)
        .filter((time): time is string => {
          const parsed = this.parseGameTimeFromSnapshot(time || undefined);
          return Boolean(parsed);
        });
      const previousSnapshotTime =
        previousSnapshotCandidates.length > 0
          ? previousSnapshotCandidates.reduce((earliest, current) =>
              this.isTimeBeforeOrEqual(current, earliest) ? current : earliest
            )
          : currentGameTime;

      const currentSceneLocation = currentScenario?.location?.toLowerCase().trim();
      const excludedNpcIds = new Set<string>();
      if (currentSceneLocation) {
        for (const npc of dynamicState.npcCharacters) {
          const latest = this.getLatestActionLogAtOrBefore(
            npc.actionLog,
            currentGameTime
          );
          if (
            latest?.location &&
            latest.location.toLowerCase().trim() === currentSceneLocation
          ) {
            excludedNpcIds.add(npc.id);
          }
        }
      }

      const backgroundNpcs = dynamicState.npcCharacters
        .filter((npc) => !excludedNpcIds.has(npc.id))
        .map((npc) => ({
          ...npc,
          actionLog: npc.actionLog || [],
        }));
      const scenesToUpdateInBackground = allScenariosData.filter((scene) => {
        if (
          currentScenario?.name &&
          scene.scenarioName === currentScenario.name
        ) {
          return false;
        }
        if (
          currentSceneLocation &&
          scene.snapshot.location?.toLowerCase().trim() === currentSceneLocation
        ) {
          return false;
        }
        return true;
      });
      console.log(
        `   📋 Phase 1: Generating timeline for ${backgroundNpcs.length} background NPCs...`
      );

      const runtime = createRuntime();
      const phase1Context = {
        currentGameDay: dynamicState.gameDay,
        currentTimeOfDay: dynamicState.timeOfDay,
        previousSnapshotTime,
        currentGameTime,
        truthTimelineJson: JSON.stringify(dynamicState.truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(dynamicState.knowledgeMatrix, null, 2),
        previousGlobalTrigger: dynamicState.globalTrigger,
        previousGlobalTriggerJson: dynamicState.globalTrigger
          ? JSON.stringify(dynamicState.globalTrigger, null, 2)
          : null,
        playerCurrentSceneJson: JSON.stringify(
          currentScenario
            ? {
                id: currentScenario.id,
                name: currentScenario.name,
                location: currentScenario.location,
              }
            : null,
          null,
          2
        ),
        allScenariosJson: JSON.stringify(allScenariosData, null, 2),
        backgroundNpcsJson: JSON.stringify(backgroundNpcs, null, 2),
      };
      const phase1Prompt = composeTemplate(
        getNpcActionTimelineWithPlayerSceneIngressTemplate(),
        { dynamicGameState: dynamicState },
        phase1Context,
        "handlebars"
      );
      const phase1Response = await generateText({
        runtime,
        context: phase1Prompt,
        modelClass: ModelClass.MEDIUM,
      });

      type TimelineNpcUpdate = {
        id: string;
        actionLog?: ActionLogEntry[];
        statusDelta?: Partial<CharacterStatus>;
        inventoryDelta?: { add?: InventoryItem[]; remove?: InventoryItem[] };
      };
      type SuddenActionNpcUpdate = {
        id: string;
        name?: string;
        actionLog?: ActionLogEntry[];
      };
      type TimelineBucket = {
        time?: string;
        npcActionLogUpdates?: TimelineNpcUpdate[];
      };
      const parsedTimeline = this.parseModelJson<{
        actionTimeline?: TimelineBucket[];
        SuddenActionLogs?: SuddenActionNpcUpdate[];
      }>(phase1Response, "Non-player Phase 1 timeline");
      if (
        !parsedTimeline ||
        ((!parsedTimeline.actionTimeline || parsedTimeline.actionTimeline.length === 0) &&
          (!parsedTimeline.SuddenActionLogs ||
            parsedTimeline.SuddenActionLogs.length === 0))
      ) {
        console.error(
          `   ❌ Non-player Phase 1 response missing actionTimeline/SuddenActionLogs`
        );
        return;
      }

      const cleanedTimeline: TimelineBucket[] = [];
      let mergedNpcUpdates = 0;
      const normalTimeline = parsedTimeline.actionTimeline || [];
      for (const bucket of normalTimeline) {
        if (!bucket?.time || !this.isTimeBeforeOrEqual(bucket.time, currentGameTime)) {
          continue;
        }

        const cleanedNpcUpdates: TimelineNpcUpdate[] = [];
        for (const update of bucket.npcActionLogUpdates || []) {
          if (!update?.id || excludedNpcIds.has(update.id)) {
            continue;
          }

          const npc = this.findNPCById(dynamicState.npcCharacters, update.id);
          if (!npc) {
            console.warn(`   ⚠️ NPC "${update.id}" not found, skipping timeline update`);
            continue;
          }

          const validActionLog = (update.actionLog || [])
            .map((entry) => ({
              ...entry,
              time: entry.time || bucket.time || "",
            }))
            .filter((entry) => {
              if (!entry.time || !entry.location || !entry.summary) {
                return false;
              }
              if (!this.isTimeBeforeOrEqual(entry.time, currentGameTime)) {
                return false;
              }
              if (previousSnapshotTime && !this.isTimeAfter(entry.time, previousSnapshotTime)) {
                return false;
              }
              return true;
            });

          // Apply delta only when there is at least one valid actionLog entry in window
          if (validActionLog.length === 0) {
            continue;
          }

          this.mergeCharacterDeltaToNPC(npc, {
            actionLog: validActionLog,
            status: update.statusDelta,
            inventory: update.inventoryDelta,
          });

          cleanedNpcUpdates.push({
            id: update.id,
            actionLog: validActionLog,
            statusDelta: update.statusDelta,
            inventoryDelta: update.inventoryDelta,
          });
          mergedNpcUpdates += 1;
        }

        if (cleanedNpcUpdates.length > 0) {
          cleanedTimeline.push({
            time: bucket.time,
            npcActionLogUpdates: cleanedNpcUpdates,
          });
        }
      }

      const suddenActionLogsForKeeper: Array<{
        id: string;
        name: string;
        actionLog: ActionLogEntry[];
      }> = [];
      let suddenMergedNpcUpdates = 0;
      if (parsedTimeline.SuddenActionLogs && parsedTimeline.SuddenActionLogs.length > 0) {
        const currentSceneLocationNormalized = currentScenario?.location
          ?.toLowerCase()
          .trim();
        const currentSceneNameNormalized = currentScenario?.name?.toLowerCase().trim();

        for (const update of parsedTimeline.SuddenActionLogs) {
          if (!update?.id || excludedNpcIds.has(update.id)) {
            continue;
          }

          const npc = this.findNPCById(dynamicState.npcCharacters, update.id);
          if (!npc) {
            console.warn(`   ⚠️ NPC "${update.id}" not found, skipping sudden actionLog`);
            continue;
          }

          const validActionLog = (update.actionLog || []).filter((entry) => {
            if (!entry.time || !entry.location || !entry.summary) {
              return false;
            }
            if (!this.isTimeBeforeOrEqual(entry.time, currentGameTime)) {
              return false;
            }
            if (previousSnapshotTime && !this.isTimeAfter(entry.time, previousSnapshotTime)) {
              return false;
            }

            if (currentSceneLocationNormalized || currentSceneNameNormalized) {
              const normalizedLocation = entry.location.toLowerCase().trim();
              const matchesCurrentScene =
                (currentSceneLocationNormalized &&
                  normalizedLocation === currentSceneLocationNormalized) ||
                (currentSceneNameNormalized &&
                  normalizedLocation === currentSceneNameNormalized);
              if (!matchesCurrentScene) {
                return false;
              }
            }
            return true;
          });

          // SuddenActionLogs requires exactly one in-window action for each NPC
          if (validActionLog.length !== 1) {
            continue;
          }

          this.mergeCharacterDeltaToNPC(npc, {
            actionLog: validActionLog,
          });

          suddenActionLogsForKeeper.push({
            id: npc.id,
            name:
              (typeof update.name === "string" && update.name.trim()) || npc.name,
            actionLog: validActionLog,
          });
          suddenMergedNpcUpdates += 1;
        }
      }

      dynamicState.temporaryInfo.contextualData =
        dynamicState.temporaryInfo.contextualData || {};
      dynamicState.temporaryInfo.contextualData.suddenActionLogs =
        suddenActionLogsForKeeper;
      dynamicState.temporaryInfo.contextualData.suddenActionLogsGameTime =
        currentGameTime;
      dynamicState.temporaryInfo.contextualData.suddenActionLogsTurnInScene =
        dynamicState.turnsInCurrentScene;

      console.log(
        `   ✓ Phase 1 merged updates for ${mergedNpcUpdates} NPC entries (+${suddenMergedNpcUpdates} sudden)`
      );

      const playerActionWindow = this.getPlayerActionLogInWindow(
        dynamicState.playerCharacter.actionLog,
        previousSnapshotTime,
        currentGameTime
      );

      console.log(`   📋 Phase 3: Generating simplified background snapshots...`);
      const phase3Promise = this.updateBackgroundSimplifiedSnapshotsForSceneSwitch(
        gameStateManager,
        currentGameTime,
        previousSnapshotTime,
        scenesToUpdateInBackground,
        cleanedTimeline,
        playerActionWindow
      );

      let reactionMergedNpcUpdates = 0;
      if (currentScenario && suddenActionLogsForKeeper.length > 0) {
        try {
          console.log(`   📋 Phase 2: Updating current scene from sudden logs...`);
          const previousCurrentSceneSnapshot = JSON.parse(
            JSON.stringify(currentScenario)
          ) as DynamicScenarioSnapshot;

          const currentScenarioOutline =
            scenarioOutlineMap.get(currentScenario.id) ||
            dynamicState.scenarioOutlines.find(
              (outline) =>
                outline.id === currentScenario.id ||
                outline.name === currentScenario.name
            );
          const currentScenarioStorageId =
            currentScenarioOutline?.id || currentScenario.id;
          const currentSceneNpcs = this.getNPCsForScenario(
            currentScenario.location,
            currentScenarioStorageId,
            dynamicState.npcCharacters,
            previousSnapshotTime,
            currentGameTime
          );

          const phase2Context = {
            currentGameDay: dynamicState.gameDay,
            currentTimeOfDay: dynamicState.timeOfDay,
            previousSnapshotTime,
            currentGameTime,
            currentSceneJson: JSON.stringify(
              {
                scenarioId: currentScenarioStorageId,
                scenarioName: currentScenario.name,
                location: currentScenario.location,
                connections: currentScenarioOutline?.connections || [],
              },
              null,
              2
            ),
            currentBaselineSnapshotJson: JSON.stringify(currentScenario, null, 2),
            suddenActionLogsJson: JSON.stringify(
              { SuddenActionLogs: suddenActionLogsForKeeper },
              null,
              2
            ),
            currentSceneNpcProfilesJson: JSON.stringify(currentSceneNpcs, null, 2),
          };

          const phase2Prompt = composeTemplate(
            getCurrentSceneReactionSnapshotTemplate(),
            { dynamicGameState: dynamicState },
            phase2Context,
            "handlebars"
          );

          const phase2Response = await generateText({
            runtime,
            context: phase2Prompt,
            modelClass: ModelClass.MEDIUM,
          });

          type ReactionNpcUpdate = {
            id: string;
            name?: string;
            actionLog?: ActionLogEntry[];
          };
          const parsedPhase2 = this.parseModelJson<{
            currentSceneUpdate?: {
              scenarioId?: string;
              snapshot?: Partial<DynamicScenarioSnapshot>;
              connections?: Array<{
                scenarioName: string;
                relationshipType: string;
                description?: string;
                blocked?: boolean;
                blockReason?: string | null;
              }>;
            };
            reactionNpcActionLogUpdates?: ReactionNpcUpdate[];
          }>(phase2Response, "Non-player Phase 2 current scene snapshot");

          if (parsedPhase2?.reactionNpcActionLogUpdates?.length) {
            const currentSceneLocationNormalized = currentScenario.location
              ?.toLowerCase()
              .trim();
            const currentSceneNameNormalized = currentScenario.name
              ?.toLowerCase()
              .trim();

            for (const update of parsedPhase2.reactionNpcActionLogUpdates) {
              if (!update?.id) {
                continue;
              }
              const npc = this.findNPCById(dynamicState.npcCharacters, update.id);
              if (!npc) {
                continue;
              }

              const validActionLog = (update.actionLog || [])
                .map((entry) => ({
                  ...entry,
                  time: entry.time || currentGameTime,
                }))
                .filter((entry) => {
                  if (!entry.time || !entry.location || !entry.summary) {
                    return false;
                  }
                  if (!this.isTimeBeforeOrEqual(entry.time, currentGameTime)) {
                    return false;
                  }
                  if (
                    previousSnapshotTime &&
                    !this.isTimeAfter(entry.time, previousSnapshotTime)
                  ) {
                    return false;
                  }
                  if (currentSceneLocationNormalized || currentSceneNameNormalized) {
                    const normalizedLocation = entry.location.toLowerCase().trim();
                    const matchesCurrentScene =
                      (currentSceneLocationNormalized &&
                        normalizedLocation === currentSceneLocationNormalized) ||
                      (currentSceneNameNormalized &&
                        normalizedLocation === currentSceneNameNormalized);
                    if (!matchesCurrentScene) {
                      return false;
                    }
                  }
                  return true;
                });

              if (validActionLog.length === 0) {
                continue;
              }

              this.mergeCharacterDeltaToNPC(npc, {
                actionLog: validActionLog,
              });
              reactionMergedNpcUpdates += 1;
            }
          }

          if (parsedPhase2?.currentSceneUpdate?.snapshot && currentScenario.id) {
            const modelSnapshot = parsedPhase2.currentSceneUpdate.snapshot;
            const updatedCurrentSnapshot: DynamicScenarioSnapshot = {
              ...currentScenario,
              ...modelSnapshot,
              id: modelSnapshot.id || currentScenario.id,
              name: modelSnapshot.name || currentScenario.name,
              location: modelSnapshot.location || currentScenario.location,
              description: modelSnapshot.description || currentScenario.description,
              gameTime: currentGameTime,
              snapshotType: "complete",
              clues: Array.isArray(modelSnapshot.clues)
                ? modelSnapshot.clues
                : currentScenario.clues,
              conditions: Array.isArray(modelSnapshot.conditions)
                ? modelSnapshot.conditions
                : currentScenario.conditions,
              characters: Array.isArray(modelSnapshot.characters)
                ? (modelSnapshot.characters as DynamicScenarioSnapshot["characters"])
                : this.buildLightweightCharactersForScene(
                    modelSnapshot.location || currentScenario.location,
                    currentGameTime,
                    dynamicState.npcCharacters
                  ),
            };

            await gameStateManager.setUpdatedDynamicScenarioSnapshot(
              currentScenarioStorageId,
              updatedCurrentSnapshot
            );
            gameStateManager.refreshCurrentScenarioSnapshot(updatedCurrentSnapshot);

            const modifiedConnections = parsedPhase2.currentSceneUpdate.connections;
            if (modifiedConnections && modifiedConnections.length > 0) {
              await this.applyScenarioConnectionsUpdate(
                dynamicState,
                updatedCurrentSnapshot.name || currentScenario.name,
                modifiedConnections
              );
              console.log(
                `   ✓ Updated ${modifiedConnections.length} connections for current scene`
              );
            }

            dynamicState.temporaryInfo.contextualData =
              dynamicState.temporaryInfo.contextualData || {};
            dynamicState.temporaryInfo.contextualData.worldlineSceneUpdate = {
              previousSnapshot: previousCurrentSceneSnapshot,
              updatedSnapshot: updatedCurrentSnapshot,
              suddenActionLogs: suddenActionLogsForKeeper,
              reactionNpcActionLogUpdates:
                parsedPhase2.reactionNpcActionLogUpdates || [],
              gameTime: currentGameTime,
            };

            console.log(`   ✓ Phase 2 updated current scene snapshot`);
          }
        } catch (error) {
          console.error(`   ❌ Phase 2 current scene update failed:`, error);
        }
      } else {
        console.log(`   ℹ️ Phase 2 skipped (no sudden logs affecting current scene)`);
      }

      try {
        await phase3Promise;
      } catch (error) {
        console.error(`   ❌ Background simplified snapshot update failed:`, error);
      }

      console.log(`✅ [Director Agent] Scenario update completed`);
      console.log(
        `   - Timeline merged updates: ${mergedNpcUpdates} (+${reactionMergedNpcUpdates} reactions)`
      );
    } catch (error) {
      console.error(`❌ [Director Agent] Failed to update scenarios:`, error);
      throw error;
    }
  }

  /**
   * Check if global trigger time restriction has been reached
   * @returns true if current game time >= trigger time, false otherwise
   */
  checkGlobalTriggerTime(gameStateManager: DynamicGameStateManager): boolean {
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
      console.warn(
        `   ⚠️ Failed to parse time: current="${currentGameTime}", trigger="${triggerTime}"`
      );
      return false;
    }

    // Check if current time >= trigger time
    const timeReached =
      currentTime.gameDay > targetTime.gameDay ||
      (currentTime.gameDay === targetTime.gameDay &&
        this.compareTimeOfDay(currentTime.timeOfDay, targetTime.timeOfDay) >=
          0);

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

    console.log(
      `\n🔍 [Director Agent] Checking global trigger and game end conditions...`
    );

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
      const conversationHistory =
        (dynamicState.temporaryInfo.contextualData
          ?.conversationHistory as Array<{
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
              const resultTime =
                result.gameTime ||
                `Day ${dynamicState.gameDay}, ${result.timeOfDay || dynamicState.timeOfDay}`;
              if (
                !earliestTime ||
                this.isTimeBeforeOrEqual(resultTime, earliestTime)
              ) {
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
            actionLog: dynamicState.playerCharacter.actionLog || [],
          },
          ...dynamicState.npcCharacters.map((npc) => ({
            id: npc.id,
            name: npc.name,
            actionLog: npc.actionLog || [],
          })),
        ];

        // Filter actionLog entries within the time range
        for (const character of allCharacters) {
          const filteredActionLog = character.actionLog.filter((entry) => {
            return (
              this.isTimeBeforeOrEqual(earliestTime, entry.time) &&
              this.isTimeBeforeOrEqual(entry.time, currentGameTime)
            );
          });

          if (filteredActionLog.length > 0) {
            recentActionLogs.push({
              turnNumber: recentTurns[0]?.turnNumber || 0,
              characterId: character.id,
              characterName: character.name,
              actionLog: filteredActionLog,
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
            recentActionLogsJson: JSON.stringify(recentActionLogs, null, 2),
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
            let parsed: {
              triggered: boolean;
              causesGameEnd: boolean;
              reason?: string;
            };
            try {
              const jsonMatch = response.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                parsed = JSON.parse(jsonMatch[0]);
              } else {
                parsed = JSON.parse(response);
              }
            } catch (error) {
              console.error(
                "   ❌ Failed to parse trigger check response:",
                error
              );
              return { triggered: false, causesGameEnd: false };
            }

            if (parsed.triggered) {
              triggered = true;
              triggerReason = parsed.reason || "事件已完成";

              if (parsed.causesGameEnd) {
                console.log(
                  `   ✅ Global trigger triggered AND causes game end`
                );
                console.log(`      Reason: ${triggerReason}`);
                return {
                  triggered: true,
                  causesGameEnd: true,
                  reason: triggerReason,
                };
              } else {
                console.log(
                  `   ✅ Global trigger triggered but does NOT cause game end`
                );
                console.log(`      Reason: ${triggerReason}`);
                return {
                  triggered: true,
                  causesGameEnd: false,
                  reason: triggerReason,
                };
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
          console.log(
            `   ✅ Global trigger time reached AND causes game end (point of no return)`
          );
          return {
            triggered: true,
            causesGameEnd: true,
            reason: triggerReason,
          };
        }
      }
      console.log(
        `   ✅ Global trigger time reached but does NOT cause game end`
      );
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

    if (
      !globalTrigger ||
      !globalTrigger.events ||
      globalTrigger.events.length === 0
    ) {
      return false;
    }

    console.log(`\n🔍 [Director Agent] Checking global trigger events...`);

    // Get conversation history from last 3 turns (including current turn)
    const conversationHistory =
      (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
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
          const resultTime =
            result.gameTime ||
            `Day ${dynamicState.gameDay}, ${result.timeOfDay || dynamicState.timeOfDay}`;
          if (
            !earliestTime ||
            this.isTimeBeforeOrEqual(resultTime, earliestTime)
          ) {
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
        actionLog: dynamicState.playerCharacter.actionLog || [],
      },
      ...dynamicState.npcCharacters.map((npc) => ({
        id: npc.id,
        name: npc.name,
        actionLog: npc.actionLog || [],
      })),
    ];

    // Filter actionLog entries within the time range
    for (const character of allCharacters) {
      const filteredActionLog = character.actionLog.filter((entry) => {
        // Include entries that are within the time range (earliestTime to currentGameTime)
        return (
          this.isTimeBeforeOrEqual(earliestTime, entry.time) &&
          this.isTimeBeforeOrEqual(entry.time, currentGameTime)
        );
      });

      if (filteredActionLog.length > 0) {
        recentActionLogs.push({
          turnNumber: recentTurns[0]?.turnNumber || 0,
          characterId: character.id,
          characterName: character.name,
          actionLog: filteredActionLog,
        });
      }
    }

    if (recentActionLogs.length === 0) {
      console.log(
        `   ℹ️  No recent actionLog entries found in the last 3 turns`
      );
      return false;
    }

    console.log(
      `   📋 Found ${recentActionLogs.length} characters with actionLog entries in recent 3 turns`
    );

    // Prepare template context
    const runtime = createRuntime();
    const template = getGlobalTriggerEventCheckTemplate();

    const templateContext = {
      globalTriggerJson: JSON.stringify(globalTrigger, null, 2),
      recentActionLogsJson: JSON.stringify(recentActionLogs, null, 2),
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
  async generateStuckHintNarrative(
    gameStateManager: DynamicGameStateManager
  ): Promise<string | null> {
    const dynamicState = gameStateManager.getState();
    const currentScenario = dynamicState.currentScenario;

    if (!currentScenario) {
      return null;
    }

    const gameTime = `Day ${dynamicState.gameDay}, ${dynamicState.timeOfDay}`;
    const tension = dynamicState.tension;

    const currentSceneSnapshotJson = JSON.stringify(currentScenario, null, 2);

    const currentScenarioOutline = dynamicState.scenarioOutlines.find(
      (outline) =>
        outline.id === currentScenario.id ||
        outline.name === currentScenario.name
    );
    const rawConnections = currentScenarioOutline?.connections || [];
    const connections = rawConnections.map((conn) => {
      const targetScenario = dynamicState.scenarioOutlines.find(
        (outline) =>
          outline.name === conn.scenarioName || outline.id === conn.scenarioName
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

    const conversationHistory =
      (dynamicState.temporaryInfo.contextualData?.conversationHistory as Array<{
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
      console.error(
        "[Director Agent] generateStuckHintNarrative failed:",
        error
      );
      return null;
    }
  }

  /**
   * Compare two time-of-day strings (HH:MM format)
   * @returns negative if time1 < time2, 0 if equal, positive if time1 > time2
   */
  private compareTimeOfDay(time1: string, time2: string): number {
    const [h1, m1] = time1.split(":").map(Number);
    const [h2, m2] = time2.split(":").map(Number);

    const minutes1 = h1 * 60 + m1;
    const minutes2 = h2 * 60 + m2;

    return minutes1 - minutes2;
  }
}
