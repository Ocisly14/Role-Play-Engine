/**
 * Dynamic Game State
 * Complete state management for DynamicWorld modules
 * Replaces the old GameState with DynamicWorld-specific structure
 */

import type {
  MacroSceneStructure,
  TruthEvent,
  KnowledgeHolder,
  RedHerring,
  MythosEvent,
  EndStateDefinition,
  ScenarioOutline,
  ModuleDigest,
} from "../world_builder/types.js";

import type {
  ActionAnalysis,
  ActionResult,
  NPCResponseAnalysis,
  DirectorDecision,
  SceneChangeRequest,
  SceneTransitionRejection,
  DiscoveredClue,
  TimeConsumption,
} from "../../shared/state/index.js";
import type {
  DynamicCharacterProfile,
  DynamicNPCProfile,
  DynamicScenarioSnapshot,
} from "../world_builder/types.js";
import type { CoCDatabase, CoCDatabaseAdapter } from "../../shared/agents/memory/database/index.js";
import type { ScenarioClue, ScenarioCondition } from "../../shared/agents/models/scenarioTypes.js";
import { InventoryUtils } from "../../shared/agents/models/gameTypes.js";
import { randomUUID } from "crypto";
import { getPrismaClient } from "../../shared/agents/memory/database/prismaClient.js";

/**
 * Temporary Info for Dynamic World
 * Contains temporary state that is cleared at the start of each player turn.
 * Note: RAG is not used in Dynamic World system, so ragResults is removed.
 */
export interface DynamicTemporaryInfo {
  /** Temporary rules injected by action-type rules */
  rules: string[];
  /** Contextual data for agents (e.g., conversation history) */
  contextualData: Record<string, any>;
  /** Action results from Action Agent */
  actionResults: ActionResult[];
  /** Full action outputs from Action Agent (raw JSON response + actor metadata) */
  actionResultsDetailed: Array<Record<string, unknown>>;
  /** Current action analysis from Orchestrator Agent */
  currentActionAnalysis: ActionAnalysis | null;
  /** NPC response analyses from Character Agent */
  npcResponseAnalyses: NPCResponseAnalysis[];
  /** Scene change request from Orchestrator Agent, modified by Action Agent */
  sceneChangeRequest: SceneChangeRequest | null;
  /** Previous scenario snapshot (saved before scene switch for Keeper narrative) */
  previousScenario: DynamicScenarioSnapshot | null;
}

/**
 * Dynamic Game State - Contains all game runtime data + DynamicWorld-specific data
 * This completely replaces the old GameState for DynamicWorld modules
 */
export interface DynamicGameState {
  // === Session & Runtime Data (from old GameState) ===
  sessionId: string;

  // Current scenario
  currentScenario: DynamicScenarioSnapshot | null;

  // Time management
  gameDay: number; // Day number in game
  timeOfDay: string; // Game time in HH:MM format
  scenarioTimeState: {
    sceneStartTime: string;
    playerTimeConsumption: Record<
      string,
      {
        totalShortActions: number;
        lastActionTime: string;
      }
    >;
  };

  // Game tension
  tension: number;

  // Module guidance (synchronized with moduleDigest)
  keeperGuidance: string | null; // Module keeper guidance (permanent information)
  moduleLimitations: string | null; // Module limitation conditions (permanent information)

  // Characters
  playerCharacter: DynamicCharacterProfile;
  npcCharacters: DynamicNPCProfile[];

  // Clues and progression
  discoveredClues: DiscoveredClue[];
  turnsInCurrentScene: number;
  lastPlayerInputTime: Date | null;
  consecutiveProgressionTriggers: number; // Track consecutive progression triggers (max 3)

  // Temporary info (cleared at start of each player turn)
  temporaryInfo: DynamicTemporaryInfo;

  // === DynamicWorld-Specific Data ===

  // Module metadata
  moduleName: string;
  moduleDigest: ModuleDigest | null;

  // Core world data (keeper-only)
  macroScene: MacroSceneStructure | null;
  truthTimeline: TruthEvent[];
  knowledgeMatrix: KnowledgeHolder[];
  redHerrings: RedHerring[];
  mythosEvents: MythosEvent[];
  endState: EndStateDefinition | null;

  // Scenario data
  scenarioOutlines: ScenarioOutline[];

  // Runtime tracking for DynamicWorld features
  revealedTruthEvents: Set<string>; // Truth event IDs that have been revealed to players
  activatedKnowledgeHolders: Set<string>; // Knowledge holder IDs that have been activated/accessed
  deployedRedHerrings: Set<string>; // Red herring IDs that have been deployed
  mythosRevelations: Set<string>; // Mythos event IDs that have been revealed

  // End state tracking
  pointOfNoReturnReached: boolean;
  pointOfNoReturnTrigger: string | null; // The actual trigger value when reached

  // Updated scenario snapshots (simplified versions for non-player scenarios)
  updatedDynamicScenarioSnapshots: Map<string, DynamicScenarioSnapshot[]>; // key: scenarioId, value: 所有历史 snapshot 的数组（按时间顺序）
  globalTrigger: {
    timeRestriction?: string;
    timeReason?: string;
    events?: string[];
    eventReasons?: string[];
    keeperNotes?: string;
  } | null; // 全局触发条件

  // Metadata
  loadedAt: Date; // When this state was loaded
  lastUpdated: Date; // Last time state was updated
}

/**
 * Create initial DynamicGameState with provided runtime data
 * Character, gameDay, and timeOfDay should be loaded from DB or user selection
 */
export const initialDynamicGameState = (params: {
  sessionId: string;
  moduleName: string;
  playerCharacter: DynamicCharacterProfile;
  gameDay?: number;
  timeOfDay?: string;
}): DynamicGameState => ({
  // Session & Runtime Data
  sessionId: params.sessionId,
  currentScenario: null,
  gameDay: params.gameDay ?? 1,
  timeOfDay: params.timeOfDay ?? "08:00",
  scenarioTimeState: {
    sceneStartTime: params.timeOfDay ?? "08:00",
    playerTimeConsumption: {},
  },
  tension: 1,
  keeperGuidance: null,
  moduleLimitations: null,
  playerCharacter: params.playerCharacter,
  npcCharacters: [],
  discoveredClues: [],
  turnsInCurrentScene: 0,
  lastPlayerInputTime: null,
  consecutiveProgressionTriggers: 0,
  temporaryInfo: {
    rules: [],
    contextualData: {},
    actionResults: [],
    actionResultsDetailed: [],
    currentActionAnalysis: null,
    npcResponseAnalyses: [],
    sceneChangeRequest: null,
    previousScenario: null,
  },

  // DynamicWorld-Specific Data
  moduleName: params.moduleName,
  moduleDigest: null,
  macroScene: null,
  truthTimeline: [],
  knowledgeMatrix: [],
  redHerrings: [],
  mythosEvents: [],
  endState: null,
  scenarioOutlines: [],
  revealedTruthEvents: new Set(),
  activatedKnowledgeHolders: new Set(),
  deployedRedHerrings: new Set(),
  mythosRevelations: new Set(),
  pointOfNoReturnReached: false,
  pointOfNoReturnTrigger: null,
  updatedDynamicScenarioSnapshots: new Map(),
  globalTrigger: null,
  loadedAt: new Date(),
  lastUpdated: new Date(),
});

/**
 * Dynamic Game State Manager
 * Provides methods to manage DynamicWorld-specific state
 */
export class DynamicGameStateManager {
  private state: DynamicGameState;
  private db: any;

  constructor(state: DynamicGameState, db?: any) {
    this.state = state;
    this.db = db || null;
  }

  /**
   * Set database instance for snapshot management
   */
  setDb(db: any): void {
    this.db = db;
  }

  /**
   * Get current state (read-only)
   */
  getState(): Readonly<DynamicGameState> {
    return this.state;
  }

  /**
   * Load world data into state
   */
  loadWorldData(data: {
    moduleDigest?: ModuleDigest;
    macroScene?: MacroSceneStructure;
    truthTimeline?: TruthEvent[];
    knowledgeMatrix?: KnowledgeHolder[];
    redHerrings?: RedHerring[];
    mythosEvents?: MythosEvent[];
    endState?: EndStateDefinition;
    scenarioOutlines?: ScenarioOutline[];
  }): void {
    if (data.moduleDigest) {
      this.state.moduleDigest = data.moduleDigest;
      // Synchronize top-level fields for compatibility
      this.state.keeperGuidance = data.moduleDigest.keeperGuidance || null;
      this.state.moduleLimitations =
        data.moduleDigest.moduleLimitations || null;
      // Load initial globalTrigger from moduleDigest if present
      if (data.moduleDigest.globalTrigger) {
        this.state.globalTrigger = data.moduleDigest.globalTrigger;
      }
    }
    if (data.macroScene) {
      this.state.macroScene = data.macroScene;
    }
    if (data.truthTimeline) {
      this.state.truthTimeline = data.truthTimeline;
    }
    if (data.knowledgeMatrix) {
      this.state.knowledgeMatrix = data.knowledgeMatrix;
    }
    if (data.redHerrings) {
      this.state.redHerrings = data.redHerrings;
    }
    if (data.mythosEvents) {
      this.state.mythosEvents = data.mythosEvents;
    }
    if (data.endState) {
      this.state.endState = data.endState;
    }
    if (data.scenarioOutlines) {
      this.state.scenarioOutlines = data.scenarioOutlines;
    }

    this.state.lastUpdated = new Date();
  }

  /**
   * Mark a truth event as revealed to players
   */
  revealTruthEvent(eventId: string): void {
    this.state.revealedTruthEvents.add(eventId);
    this.state.lastUpdated = new Date();
  }

  /**
   * Check if a truth event has been revealed
   */
  isTruthEventRevealed(eventId: string): boolean {
    return this.state.revealedTruthEvents.has(eventId);
  }

  /**
   * Get all revealed truth events
   */
  getRevealedTruthEvents(): TruthEvent[] {
    return this.state.truthTimeline.filter((event) =>
      this.state.revealedTruthEvents.has(event.id)
    );
  }

  /**
   * Get all unrevealed truth events
   */
  getUnrevealedTruthEvents(): TruthEvent[] {
    return this.state.truthTimeline.filter(
      (event) => !this.state.revealedTruthEvents.has(event.id)
    );
  }

  /**
   * Mark a knowledge holder as activated/accessed
   */
  activateKnowledgeHolder(holderId: string): void {
    this.state.activatedKnowledgeHolders.add(holderId);
    this.state.lastUpdated = new Date();
  }

  /**
   * Check if a knowledge holder has been activated
   */
  isKnowledgeHolderActivated(holderId: string): boolean {
    return this.state.activatedKnowledgeHolders.has(holderId);
  }

  /**
   * Get knowledge holder by ID
   */
  getKnowledgeHolder(holderId: string): KnowledgeHolder | undefined {
    return this.state.knowledgeMatrix.find((holder) => holder.id === holderId);
  }

  /**
   * Get knowledge holders by type
   */
  getKnowledgeHoldersByType(
    type: "ROLE" | "ORGANIZATION" | "PLACE" | "OBJECT"
  ): KnowledgeHolder[] {
    return this.state.knowledgeMatrix.filter(
      (holder) => holder.holderType === type
    );
  }

  /**
   * Get knowledge holders that know a specific truth event
   */
  getKnowledgeHoldersForTruthEvent(eventId: string): KnowledgeHolder[] {
    return this.state.knowledgeMatrix.filter((holder) =>
      holder.knows.includes(eventId)
    );
  }

  /**
   * Deploy a red herring (mark as used in narrative)
   */
  deployRedHerring(redHerringId: string): void {
    this.state.deployedRedHerrings.add(redHerringId);
    this.state.lastUpdated = new Date();
  }

  /**
   * Check if a red herring has been deployed
   */
  isRedHerringDeployed(redHerringId: string): boolean {
    return this.state.deployedRedHerrings.has(redHerringId);
  }

  /**
   * Get red herring by ID
   */
  getRedHerring(redHerringId: string): RedHerring | undefined {
    return this.state.redHerrings.find((rh) => rh.id === redHerringId);
  }

  /**
   * Reveal a mythos event
   */
  revealMythosEvent(eventIndex: number): void {
    if (eventIndex >= 0 && eventIndex < this.state.mythosEvents.length) {
      this.state.mythosRevelations.add(String(eventIndex));
      this.state.lastUpdated = new Date();
    }
  }

  /**
   * Check if mythos event has been revealed
   */
  isMythosEventRevealed(eventIndex: number): boolean {
    return this.state.mythosRevelations.has(String(eventIndex));
  }

  /**
   * Check if point of no return has been reached
   */
  checkPointOfNoReturn(currentGameDay: number, currentTime: string): boolean {
    if (this.state.pointOfNoReturnReached || !this.state.endState) {
      return this.state.pointOfNoReturnReached;
    }

    const { pointOfNoReturn } = this.state.endState;

    if (pointOfNoReturn.type === "time") {
      // Parse time trigger (e.g., "Day 8 0:00")
      const timeMatch = /Day\s+(\d+)\s+(\d{1,2}):(\d{2})/i.exec(
        pointOfNoReturn.trigger
      );
      if (timeMatch) {
        const triggerDay = parseInt(timeMatch[1], 10);
        const triggerTime = timeMatch[2] + ":" + timeMatch[3];

        if (
          currentGameDay > triggerDay ||
          (currentGameDay === triggerDay && currentTime >= triggerTime)
        ) {
          this.state.pointOfNoReturnReached = true;
          this.state.pointOfNoReturnTrigger = pointOfNoReturn.trigger;
          this.state.lastUpdated = new Date();
          return true;
        }
      }
    } else if (pointOfNoReturn.type === "condition") {
      // Condition-based triggers would need to be checked externally
      // This is a placeholder - actual condition checking should be done by Director Agent
    }

    return false;
  }

  /**
   * Get NPCs that should know specific truth events based on knowledge matrix
   */
  getNPCsForKnowledgeHolder(holderId: string, allNPCs: any[]): any[] {
    const holder = this.getKnowledgeHolder(holderId);
    if (!holder) return [];

    // Match NPCs based on holder type and name
    // This is a simplified matching - actual implementation may need more sophisticated logic
    return allNPCs.filter((npc) => {
      if (holder.holderType === "ROLE") {
        return (
          npc.occupation === holder.holderName ||
          npc.notes?.includes(holder.holderName)
        );
      } else if (holder.holderType === "ORGANIZATION") {
        return (
          npc.background?.includes(holder.holderName) ||
          npc.notes?.includes(holder.holderName)
        );
      }
      // For PLACE and OBJECT types, matching would be based on location/items
      return false;
    });
  }

  /**
   * Serialize state for storage (converts Sets to Arrays)
   */
  serialize(): any {
    return {
      ...this.state,
      revealedTruthEvents: Array.from(this.state.revealedTruthEvents),
      activatedKnowledgeHolders: Array.from(
        this.state.activatedKnowledgeHolders
      ),
      deployedRedHerrings: Array.from(this.state.deployedRedHerrings),
      mythosRevelations: Array.from(this.state.mythosRevelations),
      loadedAt: this.state.loadedAt.toISOString(),
      lastUpdated: this.state.lastUpdated.toISOString(),
    };
  }

  /**
   * Deserialize state from storage (converts Arrays back to Sets, Objects back to Maps, ISO strings back to Dates)
   * @param data - Serialized state data
   * @param checkpointGameDay - Optional: filter snapshots by checkpoint game day
   * @param checkpointTimeOfDay - Optional: filter snapshots by checkpoint time of day
   * @param db - Optional: database instance (not used for snapshot loading, only kept for backward compatibility)
   */
  static deserialize(
    data: any,
    checkpointGameDay?: number,
    checkpointTimeOfDay?: string,
    db?: CoCDatabase
  ): DynamicGameState {
    // Convert updatedDynamicScenarioSnapshots from object back to Map
    // Only loads the latest snapshot per scenario (historical snapshots remain in database)
    const updatedDynamicScenarioSnapshots = new Map<
      string,
      DynamicScenarioSnapshot[]
    >();
    if (data.updatedDynamicScenarioSnapshots) {
      if (data.updatedDynamicScenarioSnapshots instanceof Map) {
        // Already a Map (legacy format with all snapshots)
        // For backward compatibility, only take the latest snapshot
        data.updatedDynamicScenarioSnapshots.forEach(
          (snapshots: any[], scenarioId: string) => {
            if (snapshots.length > 0) {
              // Only take the latest snapshot
              const latestSnapshot = snapshots[snapshots.length - 1];
              const processedSnapshot = {
                ...latestSnapshot,
                timestamp: latestSnapshot.timestamp
                  ? typeof latestSnapshot.timestamp === "string"
                    ? new Date(latestSnapshot.timestamp)
                    : latestSnapshot.timestamp
                  : undefined,
              };
              updatedDynamicScenarioSnapshots.set(scenarioId, [
                processedSnapshot,
              ]);
            }
          }
        );
      } else {
        // Object format from JSON - new format: only latest snapshot per scenario
        Object.entries(data.updatedDynamicScenarioSnapshots).forEach(
          ([scenarioId, snapshotData]: [string, any]) => {
            // Latest snapshot from checkpoint (single snapshot, not array)
            const latestSnapshot: any = Array.isArray(snapshotData)
              ? snapshotData[snapshotData.length - 1]
              : snapshotData;
            const processedLatestSnapshot = {
              ...latestSnapshot,
              timestamp: latestSnapshot.timestamp
                ? typeof latestSnapshot.timestamp === "string"
                  ? new Date(latestSnapshot.timestamp)
                  : latestSnapshot.timestamp
                : undefined,
            };

            // Only load the latest snapshot (no historical snapshots)
            // Historical snapshots remain in database but are not loaded into state
            if (processedLatestSnapshot) {
              updatedDynamicScenarioSnapshots.set(scenarioId, [
                processedLatestSnapshot,
              ]);
            }
          }
        );
      }
    }

    // Filter actionLog entries by checkpoint gameTime if provided
    let playerCharacter = data.playerCharacter;
    let npcCharacters = data.npcCharacters || [];

    if (checkpointGameDay !== undefined && checkpointTimeOfDay !== undefined) {
      // Filter player character's actionLog
      if (
        playerCharacter &&
        playerCharacter.actionLog &&
        Array.isArray(playerCharacter.actionLog)
      ) {
        playerCharacter = {
          ...playerCharacter,
          actionLog: this.filterActionLogByGameTime(
            playerCharacter.actionLog,
            checkpointGameDay,
            checkpointTimeOfDay
          ),
        };
      }

      // Filter NPC characters' actionLog
      npcCharacters = npcCharacters.map((npc: any) => {
        if (npc.actionLog && Array.isArray(npc.actionLog)) {
          return {
            ...npc,
            actionLog: this.filterActionLogByGameTime(
              npc.actionLog,
              checkpointGameDay,
              checkpointTimeOfDay
            ),
          };
        }
        return npc;
      });
    }

    return {
      ...data,
      playerCharacter,
      npcCharacters,
      revealedTruthEvents: new Set(data.revealedTruthEvents || []),
      activatedKnowledgeHolders: new Set(data.activatedKnowledgeHolders || []),
      deployedRedHerrings: new Set(data.deployedRedHerrings || []),
      mythosRevelations: new Set(data.mythosRevelations || []),
      updatedDynamicScenarioSnapshots,
      loadedAt: data.loadedAt
        ? typeof data.loadedAt === "string"
          ? new Date(data.loadedAt)
          : data.loadedAt
        : new Date(),
      lastUpdated: data.lastUpdated
        ? typeof data.lastUpdated === "string"
          ? new Date(data.lastUpdated)
          : data.lastUpdated
        : new Date(),
      lastPlayerInputTime: data.lastPlayerInputTime
        ? typeof data.lastPlayerInputTime === "string"
          ? new Date(data.lastPlayerInputTime)
          : data.lastPlayerInputTime
        : null,
      consecutiveProgressionTriggers: data.consecutiveProgressionTriggers ?? 0,
    };
  }

  /**
   * Parse game time from string format "Day X, HH:MM"
   * Returns { gameDay, timeOfDay } or null if cannot parse
   */
  private static parseGameTime(
    gameTime: string
  ): { gameDay: number; timeOfDay: string } | null {
    if (!gameTime) return null;

    // Handle "initial" or other non-standard formats
    if (gameTime.toLowerCase() === "initial" || !gameTime.includes("Day")) {
      return null;
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
   * Compare two game times
   * Returns: -1 if time1 < time2, 0 if equal, 1 if time1 > time2
   * Returns null if either time cannot be parsed
   */
  private static compareGameTime(
    time1: string | undefined,
    time2: string | undefined
  ): number | null {
    if (!time1 || !time2) return null;

    const parsed1 = this.parseGameTime(time1);
    const parsed2 = this.parseGameTime(time2);

    if (!parsed1 || !parsed2) return null;

    // Compare day first
    if (parsed1.gameDay < parsed2.gameDay) return -1;
    if (parsed1.gameDay > parsed2.gameDay) return 1;

    // Same day, compare time
    if (parsed1.timeOfDay < parsed2.timeOfDay) return -1;
    if (parsed1.timeOfDay > parsed2.timeOfDay) return 1;

    return 0;
  }

  /**
   * Filter snapshots by checkpoint game time
   * Only keeps snapshots that were created at or before the checkpoint time
   */
  private static filterSnapshotsByGameTime(
    snapshots: DynamicScenarioSnapshot[],
    checkpointGameDay: number,
    checkpointTimeOfDay: string
  ): DynamicScenarioSnapshot[] {
    const checkpointTime = `Day ${checkpointGameDay}, ${checkpointTimeOfDay}`;

    return snapshots.filter((snapshot) => {
      if (!snapshot.gameTime) {
        // If snapshot has no gameTime, keep it (assume it's before checkpoint)
        return true;
      }

      const comparison = this.compareGameTime(
        snapshot.gameTime,
        checkpointTime
      );
      if (comparison === null) {
        // Cannot compare, keep it to be safe
        return true;
      }

      // Keep snapshots at or before checkpoint time
      return comparison <= 0;
    });
  }

  /**
   * Filter actionLog entries by checkpoint game time
   * Only keeps actionLog entries that occurred at or before the checkpoint time
   */
  private static filterActionLogByGameTime(
    actionLog: Array<{ time: string; location: string; summary: string }>,
    checkpointGameDay: number,
    checkpointTimeOfDay: string
  ): Array<{ time: string; location: string; summary: string }> {
    const checkpointTime = `Day ${checkpointGameDay}, ${checkpointTimeOfDay}`;

    return actionLog.filter((entry) => {
      if (!entry.time) {
        // If entry has no time, keep it (assume it's before checkpoint)
        return true;
      }

      const comparison = this.compareGameTime(entry.time, checkpointTime);
      if (comparison === null) {
        // Cannot compare, keep it to be safe
        return true;
      }

      // Keep entries at or before checkpoint time
      return comparison <= 0;
    });
  }

  /**
   * Load historical snapshots from database for a scenario
   * Only loads snapshots that are marked as dynamic historical and are at or before checkpoint time
   */
  private static async loadHistoricalSnapshotsFromDatabase(
    db: CoCDatabase | CoCDatabaseAdapter,
    scenarioId: string,
    checkpointGameDay: number,
    checkpointTimeOfDay: string
  ): Promise<DynamicScenarioSnapshot[]> {
    try {
      const prisma = getPrismaClient();

      // Query all historical snapshots for this scenario
      // Include related characters, clues, and conditions
      const snapshotRows = await prisma.scenarioSnapshot.findMany({
        where: {
          scenarioId,
          isDynamicHistorical: true,
        },
        include: {
          characters: true,
          clues: true,
          conditions: true,
        },
        orderBy: [
          { gameTime: "asc" },
          { createdAt: "asc" },
        ],
      });

      const checkpointTime = `Day ${checkpointGameDay}, ${checkpointTimeOfDay}`;
      const historicalSnapshots: DynamicScenarioSnapshot[] = [];

      for (const row of snapshotRows) {
        // Filter by checkpoint gameTime
        if (row.gameTime) {
          const comparison = this.compareGameTime(
            row.gameTime,
            checkpointTime
          );
          if (comparison !== null && comparison > 0) {
            // Skip snapshots after checkpoint time
            continue;
          }
        }
        // If gameTime is null, keep it (assume it's before checkpoint)

        // Build snapshot object
        const snapshot: DynamicScenarioSnapshot = {
          id: row.snapshotId,
          name: row.snapshotName || `Historical snapshot for ${scenarioId}`,
          location: row.location,
          description: row.description,
          gameTime: row.gameTime || undefined,
          showMap: row.showMap === true,
          keeperNotes: row.keeperNotes || undefined,
          timeRestriction: row.timeRestriction || undefined,
          characters: row.characters.map((char) => ({
            id: char.id,
            name: char.characterName,
            role: char.characterRole,
            status: char.characterStatus,
            location: char.characterLocation || undefined,
            notes: char.characterNotes || undefined,
          })),
          clues: row.clues.map((clue) => ({
            id: clue.clueId,
            clueText: clue.clueText,
            category: clue.category as ScenarioClue["category"],
            difficulty: clue.difficulty as ScenarioClue["difficulty"],
            location: clue.clueLocation,
            discoveryMethod: clue.discoveryMethod || undefined,
            reveals: (clue.reveals as any[]) || [],
            discovered: clue.discovered === true,
            discoveryDetails: (clue.discoveryDetails as any) || undefined,
          })),
          conditions: row.conditions.map((cond) => ({
            type: cond.conditionType as ScenarioCondition["type"],
            description: cond.description,
            mechanicalEffect: cond.mechanicalEffect || undefined,
          })),
        };

        historicalSnapshots.push(snapshot);
      }

      return historicalSnapshots;
    } catch (error) {
      console.error(
        `[DynamicGameState] Failed to load historical snapshots from database:`,
        error
      );
      return [];
    }
  }

  /**
   * Create a copy of the state
   */
  clone(): DynamicGameState {
    return {
      ...this.state,
      revealedTruthEvents: new Set(this.state.revealedTruthEvents),
      activatedKnowledgeHolders: new Set(this.state.activatedKnowledgeHolders),
      deployedRedHerrings: new Set(this.state.deployedRedHerrings),
      mythosRevelations: new Set(this.state.mythosRevelations),
    };
  }

  // === Runtime State Management Methods (similar to GameStateManager) ===

  /**
   * Clear action results
   */
  clearActionResults(): void {
    this.state.temporaryInfo.actionResults = [];
    this.state.temporaryInfo.actionResultsDetailed = [];
    this.state.lastUpdated = new Date();
  }

  /**
   * Clear NPC response analyses
   */
  clearNPCResponseAnalyses(): void {
    this.state.temporaryInfo.npcResponseAnalyses = [];
    this.state.lastUpdated = new Date();
  }

  /**
   * Clear action analysis
   */
  clearActionAnalysis(): void {
    this.state.temporaryInfo.currentActionAnalysis = null;
    this.state.lastUpdated = new Date();
  }

  /**
   * Clear previous scenario (saved for scene transition narrative)
   */
  clearPreviousScenario(): void {
    this.state.temporaryInfo.previousScenario = null;
    this.state.lastUpdated = new Date();
  }

  /**
   * Update player input timestamp (resets consecutive progression triggers)
   */
  updatePlayerInputTime(): void {
    this.state.lastPlayerInputTime = new Date();
    this.state.lastUpdated = new Date();
    // Reset consecutive triggers when player provides input
    this.state.consecutiveProgressionTriggers = 0;
  }

  /**
   * Only update lastPlayerInputTime, without resetting consecutiveProgressionTriggers.
   * Used after a stuck-hint so the next hint is 5 min later, while still counting toward the max-3 limit.
   */
  touchIdleTimerOnly(): void {
    this.state.lastPlayerInputTime = new Date();
    this.state.lastUpdated = new Date();
  }

  /**
   * Increment consecutive progression trigger count
   */
  incrementConsecutiveTriggers(): void {
    this.state.consecutiveProgressionTriggers =
      (this.state.consecutiveProgressionTriggers || 0) + 1;
    this.state.lastUpdated = new Date();
  }

  /**
   * Increment turn counter for current scene
   */
  incrementTurnCounter(): void {
    this.state.turnsInCurrentScene += 1;
    this.state.lastUpdated = new Date();
  }

  /**
   * Get turns in current scene
   */
  getTurnsInCurrentScene(): number {
    return this.state.turnsInCurrentScene;
  }

  /**
   * Set action results
   */
  setActionResults(results: ActionResult[]): void {
    this.state.temporaryInfo.actionResults = results;
    this.state.lastUpdated = new Date();
  }

  /**
   * Add detailed action result to temporary storage
   */
  addActionResultDetail(detail: Record<string, unknown>): void {
    if (!detail) return;
    this.state.temporaryInfo.actionResultsDetailed.push(detail);

    // Keep only the most recent 10 detailed action results to avoid memory bloat
    if (this.state.temporaryInfo.actionResultsDetailed.length > 10) {
      this.state.temporaryInfo.actionResultsDetailed =
        this.state.temporaryInfo.actionResultsDetailed.slice(-10);
    }

    this.state.lastUpdated = new Date();
  }

  /**
   * Set action analysis
   */
  setActionAnalysis(analysis: ActionAnalysis | null): void {
    this.state.temporaryInfo.currentActionAnalysis = analysis;
    this.state.lastUpdated = new Date();
  }

  /**
   * Set NPC response analyses
   */
  setNPCResponseAnalyses(analyses: NPCResponseAnalysis[]): void {
    this.state.temporaryInfo.npcResponseAnalyses = analyses;
    this.state.lastUpdated = new Date();
  }

  /**
   * Set scene change request (from Orchestrator, modified by Action Agent)
   */
  setSceneChangeRequest(request: SceneChangeRequest | null): void {
    this.state.temporaryInfo.sceneChangeRequest = request;
    this.state.lastUpdated = new Date();
  }

  /**
   * Clear scene change request
   */
  clearSceneChangeRequest(): void {
    this.state.temporaryInfo.sceneChangeRequest = null;
    this.state.lastUpdated = new Date();
  }

  /**
   * Set contextual data
   */
  setContextualData(key: string, value: any): void {
    this.state.temporaryInfo.contextualData[key] = value;
    this.state.lastUpdated = new Date();
  }

  /**
   * Get contextual data
   */
  getContextualData(key: string): any {
    return this.state.temporaryInfo.contextualData[key];
  }

  /**
   * Add temporary rules to game state
   */
  addTemporaryRules(ruleData: { rules: any[]; count: number }): void {
    if (!ruleData || !ruleData.rules || ruleData.rules.length === 0) return;

    for (const rule of ruleData.rules) {
      const ruleText = `${rule.title}: ${rule.description}`;
      if (!this.state.temporaryInfo.rules.includes(ruleText)) {
        this.state.temporaryInfo.rules.push(ruleText);
      }
    }
    this.state.lastUpdated = new Date();
  }

  // === GameStateManager-compatible methods ===

  /**
   * Update or add NPCs to the game state (adds all NPCs without filtering)
   */
  updateNpcs(npcData: DynamicNPCProfile[]): void {
    if (!npcData || npcData.length === 0) return;

    for (const newNpc of npcData) {
      const existingIndex = this.state.npcCharacters.findIndex(
        (npc) => npc.id === newNpc.id
      );

      if (existingIndex >= 0) {
        // Update existing NPC
        this.state.npcCharacters[existingIndex] = newNpc;
      } else {
        // Add new NPC
        this.state.npcCharacters.push(newNpc);
      }
    }
    this.state.lastUpdated = new Date();
  }

  /**
   * Update current scenario and manage visited scenarios history
   */
  updateCurrentScenario(
    scenarioData: {
      snapshot: DynamicScenarioSnapshot;
      scenarioName: string;
    } | null
  ): void {
    if (!scenarioData) return;

    const newScenario = scenarioData.snapshot;

    // Set new current scenario
    this.state.currentScenario = newScenario;

    // Automatically update NPC locations in the scene
    this.updateNpcLocationsForScenario(newScenario);

    // Reset time consumption state for any scenario update
    this.resetScenarioTimeState();

    this.state.lastUpdated = new Date();
  }

  /**
   * Refresh current scenario snapshot without triggering scene-transition side effects.
   * Unlike updateCurrentScenario(), this does NOT reset scenario time state or turn counter.
   */
  refreshCurrentScenarioSnapshot(snapshot: DynamicScenarioSnapshot): void {
    this.state.currentScenario = snapshot;
    this.updateNpcLocationsForScenario(snapshot);
    this.state.lastUpdated = new Date();
  }

  /**
   * Normalize name (for fuzzy matching)
   */
  private normalizeName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
      .trim();
  }

  /**
   * Calculate Levenshtein distance (edit distance) between two strings
   */
  private levenshtein(a: string, b: string): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () =>
      Array(n + 1).fill(0)
    );

    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + cost
        );
      }
    }
    return dp[m][n];
  }

  /**
   * Determine if two names are similar (similarity >= 80%)
   */
  private isNameSimilar(name1: string, name2: string): boolean {
    const na = this.normalizeName(name1);
    const nb = this.normalizeName(name2);
    if (!na || !nb) return false;
    if (na === nb) return true;

    // If first word is the same, consider similar
    const tokensA = na.split(/\s+/);
    const tokensB = nb.split(/\s+/);
    if (tokensA[0] && tokensA[0] === tokensB[0]) return true;

    // Calculate Levenshtein distance and convert to similarity
    const dist = this.levenshtein(na, nb);
    const maxLen = Math.max(na.length, nb.length);
    if (maxLen === 0) return false;
    const similarity = 1 - dist / maxLen;
    return similarity >= 0.8; // 80% similarity threshold
  }

  /**
   * Note: NPC locations are now tracked via actionLog, not currentLocation
   * This method is kept for compatibility but no longer updates currentLocation
   */
  private updateNpcLocationsForScenario(
    scenario: DynamicScenarioSnapshot
  ): void {
    if (!scenario || !scenario.characters || scenario.characters.length === 0) {
      return;
    }

    // NPC locations are tracked via actionLog entries, not currentLocation
    // The Director Agent will add appropriate actionLog entries when NPCs move between scenes
    // This method is kept for compatibility but does nothing
  }

  /**
   * Apply state updates from action agent results
   */
  applyActionUpdate(stateUpdate: any): void {
    if (!stateUpdate) return;

    // Update player character
    if (stateUpdate.playerCharacter) {
      this.updateCharacter(
        this.state.playerCharacter,
        stateUpdate.playerCharacter
      );
    }

    // Update NPC characters
    if (stateUpdate.npcCharacters && Array.isArray(stateUpdate.npcCharacters)) {
      for (const npcUpdate of stateUpdate.npcCharacters) {
        const existingNpc = this.state.npcCharacters.find(
          (npc) => npc.id === npcUpdate.id
        );
        if (existingNpc) {
          this.updateCharacter(existingNpc, npcUpdate);
        }
      }
    }
    this.state.lastUpdated = new Date();
  }

  /**
   * Update individual character data
   */
  private updateCharacter(character: any, updates: any): void {
    // Update character name if provided
    if (updates.name) {
      character.name = updates.name;
    }

    // Update status values (hp, sanity, mp, etc.)
    if (updates.status) {
      for (const [key, value] of Object.entries(updates.status)) {
        if (typeof value === "number" && key in character.status) {
          // Apply differential update (e.g., hp: -2 means subtract 2)
          character.status[key] += value;

          // Ensure values don't go below 0
          if (character.status[key] < 0) {
            character.status[key] = 0;
          }
        }
      }
    }

    // Update attributes if provided
    if (updates.attributes) {
      for (const [key, value] of Object.entries(updates.attributes)) {
        if (typeof value === "number" && key in character.attributes) {
          character.attributes[key] += value;
        }
      }
    }

    // Update skills if provided
    if (updates.skills) {
      for (const [skillName, value] of Object.entries(updates.skills)) {
        if (typeof value === "number") {
          if (skillName in character.skills) {
            character.skills[skillName] += value;
          } else {
            character.skills[skillName] = value;
          }
        }
      }
    }

    // Update inventory if provided
    if (updates.inventory !== undefined) {
      // Normalize existing inventory to InventoryItem[]
      character.inventory = InventoryUtils.normalizeInventory(
        character.inventory
      );

      if (Array.isArray(updates.inventory)) {
        // Replace entire inventory with InventoryItem[]
        character.inventory = InventoryUtils.normalizeInventory(
          updates.inventory
        );
      } else if (
        typeof updates.inventory === "object" &&
        !Array.isArray(updates.inventory)
      ) {
        // Support operations like { add: [...], remove: [...] }
        if (updates.inventory.add) {
          const itemsToAdd = Array.isArray(updates.inventory.add)
            ? updates.inventory.add
            : [updates.inventory.add];
          character.inventory = InventoryUtils.addItems(
            character.inventory,
            InventoryUtils.normalizeInventory(itemsToAdd)
          );
        }

        if (updates.inventory.remove) {
          const itemsToRemove = Array.isArray(updates.inventory.remove)
            ? updates.inventory.remove
            : [updates.inventory.remove];
          character.inventory = InventoryUtils.removeItems(
            character.inventory,
            InventoryUtils.normalizeInventory(itemsToRemove)
          );
        }
      }
    }
  }

  /**
   * Add action result to temporary storage and update player time consumption
   */
  addActionResult(actionResult: ActionResult): void {
    if (!actionResult) return;

    // Update player time consumption
    this.updatePlayerTimeConsumption(
      actionResult.character,
      actionResult.timeConsumption
    );

    this.state.temporaryInfo.actionResults.push(actionResult);

    // Keep only the most recent 10 action results to avoid memory bloat
    if (this.state.temporaryInfo.actionResults.length > 10) {
      this.state.temporaryInfo.actionResults =
        this.state.temporaryInfo.actionResults.slice(-10);
    }

    this.state.lastUpdated = new Date();
  }

  /**
   * Update player time consumption tracking
   */
  private updatePlayerTimeConsumption(
    playerName: string,
    timeConsumption: TimeConsumption
  ): void {
    // Initialize player record if doesn't exist
    if (!this.state.scenarioTimeState.playerTimeConsumption[playerName]) {
      this.state.scenarioTimeState.playerTimeConsumption[playerName] = {
        totalShortActions: 0,
        lastActionTime: timeConsumption,
      };
    }

    const playerTime =
      this.state.scenarioTimeState.playerTimeConsumption[playerName];
    const shortActionCap = this.getScenarioShortActionCap();

    // Update based on time consumption type
    switch (timeConsumption) {
      case "instant":
        // Instant actions don't affect time tracking
        playerTime.lastActionTime = timeConsumption;
        break;

      case "short":
        // Track short actions count
        playerTime.totalShortActions += 1;
        playerTime.lastActionTime = timeConsumption;
        break;

      case "scene":
        // Scene actions are significant time consumers
        // Scene action counts as reaching the short-action cap for this scenario
        playerTime.totalShortActions = Math.max(
          playerTime.totalShortActions,
          shortActionCap
        );
        playerTime.lastActionTime = timeConsumption;
        break;
    }
  }

  /**
   * Short action cap for the current scenario; default to 3 if undefined
   */
  private getScenarioShortActionCap(): number {
    return this.state.currentScenario?.estimatedShortActions || 3;
  }

  /**
   * Get player's short action count in current scenario
   */
  getPlayerShortActions(playerName: string): number {
    const playerTime =
      this.state.scenarioTimeState.playerTimeConsumption[playerName];
    return playerTime ? playerTime.totalShortActions : 0;
  }

  /**
   * Get player's last action time consumption
   */
  getPlayerLastActionTime(playerName: string): TimeConsumption | null {
    const playerTime =
      this.state.scenarioTimeState.playerTimeConsumption[playerName];
    return playerTime ? (playerTime.lastActionTime as TimeConsumption) : null;
  }

  /**
   * Reset time consumption for new scenario (called when scenario changes)
   */
  resetScenarioTimeState(): void {
    this.state.scenarioTimeState.playerTimeConsumption = {};
    this.state.scenarioTimeState.sceneStartTime = this.state.timeOfDay;
    // Reset turn counter on scenario change
    this.state.turnsInCurrentScene = 0;
    this.state.lastUpdated = new Date();
  }

  /**
   * Get minutes since last player input
   */
  getMinutesSinceLastInput(): number {
    if (!this.state.lastPlayerInputTime) {
      return 0;
    }
    const now = new Date();
    const diffMs = now.getTime() - this.state.lastPlayerInputTime.getTime();
    return Math.floor(diffMs / 60000); // Convert to minutes
  }

  /**
   * Calculate dynamic threshold based on tension
   * Lower tension = higher threshold (slower progression)
   * Higher tension = lower threshold (faster progression)
   */
  getProgressionThreshold(): number {
    const tension = this.state.tension;
    if (tension <= 3) return 5; // Low tension (1-3): 5 turns
    if (tension <= 6) return 4; // Medium tension (4-6): 4 turns
    if (tension <= 8) return 3; // High tension (7-8): 3 turns
    return 2; // Critical tension (9-10): 2 turns
  }

  /**
   * Check if progression should trigger based on turn count OR time elapsed
   * @returns true if either condition is met AND consecutive triggers < 3
   */
  shouldTriggerProgression(): boolean {
    // Check if already reached max consecutive triggers (3)
    if (this.state.consecutiveProgressionTriggers >= 3) {
      return false;
    }

    // Check turn count threshold
    const turnsInScene = this.getTurnsInCurrentScene();
    const threshold = this.getProgressionThreshold();

    if (turnsInScene >= threshold) {
      return true;
    }

    // Check time threshold (3 minutes)
    const minutesSinceInput = this.getMinutesSinceLastInput();
    if (minutesSinceInput >= 3) {
      return true;
    }

    return false;
  }

  /**
   * Update game time based on elapsed time in minutes
   */
  updateGameTime(elapsedMinutes: number): void {
    if (!elapsedMinutes || elapsedMinutes <= 0) return;

    // Parse current time "HH:MM"
    const [hours, minutes] = this.state.timeOfDay.split(":").map(Number);

    // Calculate new time
    let totalMinutes = hours * 60 + minutes + elapsedMinutes;

    // Handle day overflow (24 hours = 1440 minutes)
    if (totalMinutes >= 1440) {
      const daysElapsed = Math.floor(totalMinutes / 1440);
      this.state.gameDay += daysElapsed;
      totalMinutes = totalMinutes % 1440;
      console.log(
        `🌅 A new day has dawned! It is now Day ${this.state.gameDay}`
      );
    }

    const newHours = Math.floor(totalMinutes / 60);
    const newMinutes = totalMinutes % 60;

    // Update time in HH:MM format
    this.state.timeOfDay = `${String(newHours).padStart(2, "0")}:${String(newMinutes).padStart(2, "0")}`;
    this.state.lastUpdated = new Date();
  }

  /**
   * Get human-readable time of day description
   */
  getTimeOfDayDescription(): string {
    const [hours] = this.state.timeOfDay.split(":").map(Number);

    if (hours >= 5 && hours < 8) return "Dawn";
    if (hours >= 8 && hours < 12) return "Morning";
    if (hours >= 12 && hours < 14) return "Noon";
    if (hours >= 14 && hours < 17) return "Afternoon";
    if (hours >= 17 && hours < 20) return "Evening";
    if (hours >= 20 && hours < 23) return "Night";
    return "Midnight";
  }

  /**
   * Get full game time display with day and time
   */
  getFullGameTime(): string {
    const timeDesc = this.getTimeOfDayDescription();
    return `Day ${this.state.gameDay}, ${this.state.timeOfDay} (${timeDesc})`;
  }

  /**
   * Update tension level (1-10 scale)
   */
  updateTension(newTension: number): void {
    // Clamp between 1 and 10
    this.state.tension = Math.max(1, Math.min(10, Math.round(newTension)));
    this.state.lastUpdated = new Date();
  }

  /**
   * Update current scenario based on player actions
   */
  updateScenarioState(scenarioUpdates: any): void {
    if (!scenarioUpdates || !this.state.currentScenario) return;

    // Update scenario description if provided
    if (scenarioUpdates.description) {
      this.state.currentScenario.description = scenarioUpdates.description;
    }

    // Update environmental conditions
    if (
      scenarioUpdates.conditions &&
      Array.isArray(scenarioUpdates.conditions)
    ) {
      for (const newCondition of scenarioUpdates.conditions) {
        const existingIndex = this.state.currentScenario.conditions.findIndex(
          (condition) => condition.type === newCondition.type
        );

        if (existingIndex >= 0) {
          // Update existing condition
          this.state.currentScenario.conditions[existingIndex] = newCondition;
        } else {
          // Add new condition
          this.state.currentScenario.conditions.push(newCondition);
        }
      }
    }

    // Update clue states
    if (scenarioUpdates.clues && Array.isArray(scenarioUpdates.clues)) {
      for (const clueUpdate of scenarioUpdates.clues) {
        const existingIndex = this.state.currentScenario.clues.findIndex(
          (clue) => clue.id === clueUpdate.id
        );

        if (existingIndex >= 0) {
          // Update existing clue
          this.state.currentScenario.clues[existingIndex] = {
            ...this.state.currentScenario.clues[existingIndex],
            ...clueUpdate,
          };
        } else if (clueUpdate.id) {
          // Add new clue
          this.state.currentScenario.clues.push(clueUpdate);
        }
      }
    }

    this.state.lastUpdated = new Date();
  }

  /**
   * Save old snapshot to database
   */
  private async saveOldSnapshotToDatabase(
    scenarioId: string,
    snapshot: DynamicScenarioSnapshot
  ): Promise<void> {
    if (!this.db) {
      console.warn(
        `[DynamicGameState] Cannot save old snapshot to database: no database instance provided`
      );
      return;
    }

    try {
      const prisma = getPrismaClient();
      const sessionScope = await prisma.session.findUnique({
        where: { sessionId: this.state.sessionId },
        select: { moduleId: true },
      });
      const scenarioRow = await prisma.scenario.findFirst({
        where: {
          scenarioId,
          ...(sessionScope?.moduleId ? { moduleId: sessionScope.moduleId } : {}),
        },
        select: { moduleId: true },
      });
      if (!scenarioRow?.moduleId) {
        console.warn(
          `[DynamicGameState] Cannot save snapshot, scenario missing module scope: ${scenarioId}`
        );
        return;
      }
      const moduleId = scenarioRow.moduleId;

      // Generate a unique snapshot ID for historical snapshot
      const historicalSnapshotId = `hist-${scenarioId}-${Date.now()}-${randomUUID().slice(0, 8)}`;

      // Check if snapshot already exists (shouldn't happen for historical snapshots, but check anyway)
      const existing = await prisma.scenarioSnapshot.findUnique({
        where: { snapshotId: historicalSnapshotId },
        select: { snapshotId: true },
      });

      if (existing) {
        console.warn(
          `[DynamicGameState] Historical snapshot ${historicalSnapshotId} already exists, skipping`
        );
        return;
      }

      // Insert snapshot with all related data in a transaction
      await prisma.scenarioSnapshot.create({
        data: {
          snapshotId: historicalSnapshotId,
          scenarioId,
          moduleId,
          snapshotName: snapshot.name || `Historical snapshot for ${scenarioId}`,
          location: snapshot.location,
          description: snapshot.description,
          events: [],
          exits: [],
          keeperNotes: snapshot.keeperNotes || null,
          timeRestriction: snapshot.timeRestriction || null,
          showMap: snapshot.showMap !== false,
          initialSnapshot: false,
          gameTime: snapshot.gameTime || null,
          isDynamicHistorical: true,
          // Create related characters
          characters: snapshot.characters && snapshot.characters.length > 0
            ? {
                create: snapshot.characters.map((char) => ({
                  id: char.id || `${historicalSnapshotId}-char-${randomUUID().slice(0, 8)}`,
                  moduleId,
                  characterName: char.name,
                  characterRole: char.role,
                  characterStatus: char.status,
                  characterLocation: char.location || null,
                  characterNotes: char.notes || null,
                })),
              }
            : undefined,
          // Create related clues
          clues: snapshot.clues && snapshot.clues.length > 0
            ? {
                create: snapshot.clues.map((clue) => ({
                  clueId: clue.id || `${historicalSnapshotId}-clue-${randomUUID().slice(0, 8)}`,
                  moduleId,
                  clueText: clue.clueText,
                  category: clue.category,
                  difficulty: clue.difficulty,
                  clueLocation: clue.location,
                  discoveryMethod: clue.discoveryMethod || null,
                  reveals: clue.reveals || [],
                  discovered: clue.discovered === true,
                  discoveryDetails: (clue.discoveryDetails || undefined) as any,
                })),
              }
            : undefined,
          // Create related conditions
          conditions: snapshot.conditions && snapshot.conditions.length > 0
            ? {
                create: snapshot.conditions.map((condition) => ({
                  conditionId: `${historicalSnapshotId}-cond-${randomUUID().slice(0, 8)}`,
                  moduleId,
                  conditionType: condition.type,
                  description: condition.description,
                  mechanicalEffect: condition.mechanicalEffect || null,
                })),
              }
            : undefined,
        },
      });

      console.log(
        `[DynamicGameState] Saved old snapshot to database: ${historicalSnapshotId} for scenario ${scenarioId}`
      );
    } catch (error) {
      console.error(
        `[DynamicGameState] Failed to save old snapshot to database:`,
        error
      );
      // Don't throw - snapshot save failure shouldn't block game updates
    }
  }

  /**
   * Add updated scenario snapshot (appends to history, does not overwrite)
   * Automatically adds timestamp if not present
   * Keeps only the latest 2 snapshots in state, saves older ones to database
   */
  async setUpdatedDynamicScenarioSnapshot(
    scenarioId: string,
    snapshot: DynamicScenarioSnapshot
  ): Promise<void> {
    // Add timestamp if not present
    const snapshotWithTimestamp: DynamicScenarioSnapshot = {
      ...snapshot,
      timestamp: snapshot.timestamp || new Date(),
    };

    const snapshots =
      this.state.updatedDynamicScenarioSnapshots.get(scenarioId) || [];

    // Add the new snapshot first
    snapshots.push(snapshotWithTimestamp);

    // If we have more than 2 snapshots, save the oldest ones to database and remove them
    if (snapshots.length > 2) {
      // Save all snapshots except the latest 2
      const snapshotsToSave = snapshots.slice(0, snapshots.length - 2);
      for (const oldSnapshot of snapshotsToSave) {
        await this.saveOldSnapshotToDatabase(scenarioId, oldSnapshot);
      }

      // Keep only the latest 2 snapshots
      const latestTwo = snapshots.slice(-2);
      snapshots.length = 0;
      snapshots.push(...latestTwo);
    }

    this.state.updatedDynamicScenarioSnapshots.set(scenarioId, snapshots);
    this.state.lastUpdated = new Date();
  }

  /**
   * Get latest updated scenario snapshot by scenario ID
   */
  getUpdatedDynamicScenarioSnapshot(
    scenarioId: string
  ): DynamicScenarioSnapshot | null {
    const snapshots =
      this.state.updatedDynamicScenarioSnapshots.get(scenarioId);
    if (!snapshots || snapshots.length === 0) {
      return null;
    }
    // Return the latest snapshot (last in array)
    return snapshots[snapshots.length - 1];
  }

  /**
   * Get all historical snapshots for a scenario
   */
  getHistoricalSnapshots(scenarioId: string): DynamicScenarioSnapshot[] {
    return this.state.updatedDynamicScenarioSnapshots.get(scenarioId) || [];
  }

  /**
   * Get all updated scenario snapshots (returns Map with arrays)
   */
  getAllUpdatedDynamicScenarioSnapshots(): Map<
    string,
    DynamicScenarioSnapshot[]
  > {
    return this.state.updatedDynamicScenarioSnapshots;
  }

  /**
   * Set global trigger
   */
  setGlobalTrigger(
    trigger: {
      timeRestriction?: string;
      timeReason?: string;
      events?: string[];
      eventReasons?: string[];
      keeperNotes?: string;
    } | null
  ): void {
    this.state.globalTrigger = trigger;
    this.state.lastUpdated = new Date();
  }

  /**
   * Get global trigger
   */
  getGlobalTrigger(): {
    timeRestriction?: string;
    timeReason?: string;
    events?: string[];
    eventReasons?: string[];
    keeperNotes?: string;
  } | null {
    return this.state.globalTrigger;
  }
}
