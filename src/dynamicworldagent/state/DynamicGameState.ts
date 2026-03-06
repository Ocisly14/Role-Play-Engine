/**
 * Dynamic Game State
 * Complete state management for DynamicWorld modules
 * Replaces the old GameState with DynamicWorld-specific structure
 */

import type {
  EndStateDefinition,
  KnowledgeHolder,
  MacroSceneStructure,
  ModuleDigest,
  MythosEvent,
  RedHerring,
  ScenarioOutline,
  TruthEvent,
} from "../world_builder/types.js";

import type {
  CoCDatabase,
} from "../../shared/agents/memory/database/index.js";
import {
  InventoryUtils,
  type NPCRelationship,
} from "../../shared/agents/models/gameTypes.js";
import type {
  DiscoveredClue,
  GameEndingInfo,
  TimeConsumption,
} from "../../shared/state/index.js";
import type {
  DynamicCharacterProfile,
  DynamicNPCProfile,
  DynamicScene,
} from "../world_builder/types.js";

export interface DefeatedNpcHistoryEntry {
  name: string;
  count: number;
}

export interface ScenarioConnectionState {
  fromScenarioId: string;
  toScenarioId: string;
  blocked: boolean;
  conditions: string[];
}

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
  /** Player plan nodes from Orchestrator (tick-plan system) */
  playerNodes: import("../dynamicBasicAgent/npcPlanning/types.js").PlanNode[];
  /** All character actions from TickProcessor (player + NPC) */
  characterActions: import("../dynamicBasicAgent/npcPlanning/types.js").CharacterAction[];
}

/**
 * Dynamic Game State - Contains all game runtime data + DynamicWorld-specific data
 * This completely replaces the old GameState for DynamicWorld modules
 */
export interface DynamicGameState {
  // === Session & Runtime Data (from old GameState) ===
  sessionId: string;

  // Current scene
  currentSceneId: string | null;
  scenes: Map<string, DynamicScene>;

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

  // Stamina / fatigue tracking
  staminaState: {
    minutesSinceLastRest: number; // Accumulated player-action minutes since last effective rest
    fatigueActive: boolean; // Whether the player is currently fatigued
    fatigueStartedAtGameTime?: string; // Game time when fatigue first activated (optional)
  };

  // Defeated NPC tracking
  defeatedNpcHistory: DefeatedNpcHistoryEntry[];

  // Game ending status (used by frontend to lock input after epilogue)
  gameEnding: GameEndingInfo | null;

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

  globalTrigger: {
    timeRestriction?: string;
    timeReason?: string;
    events?: string[];
    eventReasons?: string[];
    keeperNotes?: string;
  } | null; // 全局触发条件

  // NPC Planning System runtime state
  npcLocations: Record<string, string>;
  npcStats: Record<string, { hp: number; san: number }>;
  npcInventories: Record<string, string[]>;
  npcDiscoveredClues: Record<string, string[]>;
  npcRelationshipGraph: Record<string, Record<string, { score: number; note: string }>>;
  scenarioConditions: Record<string, import("../dynamicBasicAgent/npcPlanning/types.js").SceneCondition[]>;
  connectionStates: ScenarioConnectionState[];

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
  currentSceneId: null,
  scenes: new Map(),
  gameDay: params.gameDay ?? 1,
  timeOfDay: params.timeOfDay ?? "08:00",
  scenarioTimeState: {
    sceneStartTime: params.timeOfDay ?? "08:00",
    playerTimeConsumption: {},
  },
  staminaState: {
    minutesSinceLastRest: 0,
    fatigueActive: false,
  },
  defeatedNpcHistory: [],
  gameEnding: null,
  keeperGuidance: null,
  moduleLimitations: null,
  playerCharacter: params.playerCharacter,
  npcCharacters: [],
  discoveredClues: [],
  turnsInCurrentScene: 0,
  lastPlayerInputTime: null,
  temporaryInfo: {
    rules: [],
    contextualData: {},
    playerNodes: [],
    characterActions: [],
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
  globalTrigger: null,
  npcLocations: {},
  npcStats: {},
  npcInventories: {},
  npcDiscoveredClues: {},
  npcRelationshipGraph: {},
  scenarioConditions: {},
  connectionStates: [],
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

  // === Scene helpers ===

  /**
   * Get the current scene (resolved from currentSceneId + scenes map)
   */
  getCurrentScene(): DynamicScene | null {
    if (!this.state.currentSceneId) return null;
    return this.state.scenes.get(this.state.currentSceneId) ?? null;
  }

  /**
   * Get a scene by ID
   */
  getScene(sceneId: string): DynamicScene | null {
    return this.state.scenes.get(sceneId) ?? null;
  }

  /**
   * Set the current scene ID (the scene data must already exist in scenes map)
   */
  setCurrentSceneId(sceneId: string): void {
    this.state.currentSceneId = sceneId;
    this.state.lastUpdated = new Date();
  }

  /**
   * Insert or replace a scene in the scenes map
   */
  updateScene(sceneId: string, scene: DynamicScene): void {
    this.state.scenes.set(sceneId, scene);
    this.state.lastUpdated = new Date();
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
        const triggerDay = Number.parseInt(timeMatch[1], 10);
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
   * Serialize state for storage (converts Sets to Arrays, Maps to Objects)
   */
  serialize(): any {
    // Convert scenes Map to plain object
    const scenesObj: Record<string, DynamicScene> = {};
    this.state.scenes.forEach((scene, id) => {
      scenesObj[id] = scene;
    });

    return {
      ...this.state,
      scenes: scenesObj,
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
    // Convert scenes from object back to Map
    const scenes = new Map<string, DynamicScene>();
    if (data.scenes) {
      if (data.scenes instanceof Map) {
        data.scenes.forEach((scene: DynamicScene, id: string) => scenes.set(id, scene));
      } else {
        Object.entries(data.scenes).forEach(([id, scene]) => {
          scenes.set(id, scene as DynamicScene);
        });
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
      defeatedNpcHistory: Array.isArray(data.defeatedNpcHistory)
        ? data.defeatedNpcHistory
            .map((item: any) => ({
              name:
                typeof item?.name === "string"
                  ? item.name
                  : String(item?.name ?? "").trim(),
              count:
                typeof item?.count === "number" &&
                Number.isFinite(item.count) &&
                item.count > 0
                  ? Math.floor(item.count)
                  : 0,
            }))
            .filter((item: DefeatedNpcHistoryEntry) => item.name.length > 0)
        : [],
      revealedTruthEvents: new Set(data.revealedTruthEvents || []),
      activatedKnowledgeHolders: new Set(data.activatedKnowledgeHolders || []),
      deployedRedHerrings: new Set(data.deployedRedHerrings || []),
      mythosRevelations: new Set(data.mythosRevelations || []),
      currentSceneId: data.currentSceneId ?? null,
      scenes,
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
        gameDay: Number.parseInt(match[1], 10),
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
   * Create a copy of the state
   */
  clone(): DynamicGameState {
    return {
      ...this.state,
      scenes: new Map(this.state.scenes),
      revealedTruthEvents: new Set(this.state.revealedTruthEvents),
      activatedKnowledgeHolders: new Set(this.state.activatedKnowledgeHolders),
      deployedRedHerrings: new Set(this.state.deployedRedHerrings),
      mythosRevelations: new Set(this.state.mythosRevelations),
    };
  }

  // === Runtime State Management Methods (similar to GameStateManager) ===

  /**
   * Clear temporary action state (plan nodes + character actions)
   */
  clearActionResults(): void {
    this.state.temporaryInfo.playerNodes = [];
    this.state.temporaryInfo.characterActions = [];
    this.state.lastUpdated = new Date();
  }

  setPlayerNodes(nodes: import("../dynamicBasicAgent/npcPlanning/types.js").PlanNode[]): void {
    this.state.temporaryInfo.playerNodes = nodes;
  }

  getPlayerNodes(): import("../dynamicBasicAgent/npcPlanning/types.js").PlanNode[] {
    return this.state.temporaryInfo.playerNodes;
  }

  setCharacterActions(actions: import("../dynamicBasicAgent/npcPlanning/types.js").CharacterAction[]): void {
    this.state.temporaryInfo.characterActions = actions;
  }

  getCharacterActions(): import("../dynamicBasicAgent/npcPlanning/types.js").CharacterAction[] {
    return this.state.temporaryInfo.characterActions;
  }

  /**
   * Update player input timestamp
   */
  updatePlayerInputTime(): void {
    this.state.lastPlayerInputTime = new Date();
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
   * Set contextual data
   */
  setContextualData(key: string, value: any): void {
    this.state.temporaryInfo.contextualData[key] = value;
    this.state.lastUpdated = new Date();
  }

  /**
   * Set game ending status
   */
  setGameEnding(gameEnding: GameEndingInfo | null): void {
    this.state.gameEnding = gameEnding;
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
   * Switch to a different scene by ID (scene data must already be in the scenes map).
   * Resets time consumption state for the new scene.
   */
  switchToScene(sceneId: string): void {
    this.state.currentSceneId = sceneId;

    // Reset time consumption state for any scene switch
    this.resetScenarioTimeState();

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
        if (key === "conditions" && Array.isArray(value)) {
          const normalizedConditions = Array.from(
            new Set(
              value
                .filter((item): item is string => typeof item === "string")
                .map((item) => item.trim())
                .filter((item) => item.length > 0)
            )
          );
          character.status.conditions = normalizedConditions;
          continue;
        }

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

    // Update appearance if provided
    if (typeof updates.appearance === "string") {
      const nextAppearance = updates.appearance.trim();
      if (nextAppearance.length > 0) {
        character.appearance = nextAppearance;
      }
    }

    // Update relationships for NPCs if provided
    if (
      Array.isArray(updates.relationships) &&
      Array.isArray(character.relationships)
    ) {
      const sanitizedRelationships: NPCRelationship[] = [];
      for (const rel of updates.relationships) {
        if (!rel || typeof rel !== "object") continue;
        const targetId = (rel as any).targetId;
        const targetName = (rel as any).targetName;
        const relationshipType = (rel as any).relationshipType;
        const attitude = (rel as any).attitude;
        if (
          typeof targetId !== "string" ||
          typeof targetName !== "string" ||
          typeof relationshipType !== "string" ||
          typeof attitude !== "number"
        ) {
          continue;
        }

        const clampedAttitude = Math.max(
          -100,
          Math.min(100, Math.round(attitude))
        );
        sanitizedRelationships.push({
          targetId,
          targetName,
          relationshipType:
            relationshipType as NPCRelationship["relationshipType"],
          attitude: clampedAttitude,
          ...(typeof (rel as any).description === "string"
            ? { description: (rel as any).description }
            : {}),
          ...(typeof (rel as any).history === "string"
            ? { history: (rel as any).history }
            : {}),
        });
      }

      const merged = [...character.relationships];
      for (const newRel of sanitizedRelationships) {
        const existingIndex = merged.findIndex(
          (existingRel) => existingRel.targetId === newRel.targetId
        );
        if (existingIndex >= 0) {
          merged[existingIndex] = newRel;
        } else {
          merged.push(newRel);
        }
      }
      character.relationships = merged;
    }
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

      case "medium":
      case "long":
      case "very long":
        // Medium/long/very long actions are significant time consumers
        // They count as reaching the short-action cap for this scenario
        playerTime.totalShortActions = Math.max(
          playerTime.totalShortActions,
          shortActionCap
        );
        playerTime.lastActionTime = timeConsumption;
        break;
    }
  }

  /**
   * Short action cap for the current scenario; default to 3 if undefined.
   * Reads estimatedShortActions from the matching ScenarioOutline.
   */
  private getScenarioShortActionCap(): number {
    const sceneId = this.state.currentSceneId;
    if (!sceneId) return 3;
    const outline = this.state.scenarioOutlines.find((o) => o.id === sceneId);
    return outline?.estimatedShortActions || 3;
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

  // =====================================================================
  // Stamina / Fatigue System
  // =====================================================================

  /** Fatigue threshold: 6 hours of uninterrupted player-action time */
  private static readonly FATIGUE_TRIGGER_MINUTES = 360;

  /**
   * Accumulate player-action minutes toward fatigue.
   * Call this after every player action that advances game time.
   */
  addFatigueMinutes(minutes: number): void {
    if (!minutes || minutes <= 0) return;
    const stamina = this.state.staminaState;
    stamina.minutesSinceLastRest += minutes;
    if (
      !stamina.fatigueActive &&
      stamina.minutesSinceLastRest >= DynamicGameStateManager.FATIGUE_TRIGGER_MINUTES
    ) {
      stamina.fatigueActive = true;
      stamina.fatigueStartedAtGameTime = this.state.timeOfDay;
      console.log(
        `😴 [Stamina] Player is now fatigued! Accumulated: ${stamina.minutesSinceLastRest} minutes`
      );
    }
    this.state.lastUpdated = new Date();
  }

  /** Whether the player is currently fatigued */
  isFatigued(): boolean {
    return this.state.staminaState.fatigueActive;
  }

  /**
   * Apply rest recovery and return a description of the result.
   * - < 240 min  → no benefit
   * - 240-479 min → short rest (clear fatigue)
   * - >= 480 min  → long rest (clear fatigue + restore HP/SAN)
   *
   * Returns a summary string for the fixed action log.
   */
  applyRest(restMinutes: number): {
    restType: "none" | "short" | "long";
    hpRestored: number;
    sanRestored: number;
    summary: string;
  } {
    if (restMinutes < 240) {
      return {
        restType: "none",
        hpRestored: 0,
        sanRestored: 0,
        summary: `休息了 ${restMinutes} 分钟，时间不足，未能有效恢复（需至少4小时）。`,
      };
    }

    const stamina = this.state.staminaState;
    stamina.fatigueActive = false;
    stamina.minutesSinceLastRest = 0;
    delete stamina.fatigueStartedAtGameTime;

    if (restMinutes < 480) {
      // Short rest: 4–8 h, clears fatigue only
      this.state.lastUpdated = new Date();
      const hours = Math.round(restMinutes / 60);
      return {
        restType: "short",
        hpRestored: 0,
        sanRestored: 0,
        summary: `进行了 ${hours} 小时的短暂休息，疲劳状态已解除。`,
      };
    }

    // Long rest: ≥ 8 h, restore HP and SAN
    const player = this.state.playerCharacter;
    const maxHP: number = (player as any).maxHp ?? player.attributes?.siz ?? 10;
    const initialSAN: number =
      (player as any).initialSan ?? player.attributes?.pow ?? 50;
    const recoveryScale = restMinutes / 480;

    const hpGain = Math.ceil(maxHP * 0.3 * recoveryScale);
    const sanGain = Math.ceil(initialSAN * 0.1 * recoveryScale);

    const currentHP = player.status?.hp ?? maxHP;
    const currentSAN = player.status?.sanity ?? initialSAN;
    const newHP = Math.min(maxHP, currentHP + hpGain);
    const newSAN = Math.min(initialSAN, currentSAN + sanGain);

    const actualHpRestored = newHP - currentHP;
    const actualSanRestored = newSAN - currentSAN;

    if (player.status) {
      player.status.hp = newHP;
      player.status.sanity = newSAN;
    }

    this.state.lastUpdated = new Date();
    const hours = Math.round(restMinutes / 60);
    const restoreDesc =
      actualHpRestored > 0 || actualSanRestored > 0
        ? `恢复了 ${actualHpRestored} HP 和 ${actualSanRestored} SAN。`
        : `HP与SAN已满，无需恢复。`;
    return {
      restType: "long",
      hpRestored: actualHpRestored,
      sanRestored: actualSanRestored,
      summary: `进行了 ${hours} 小时的深度休息，疲劳解除。${restoreDesc}`,
    };
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
   * Update current scene based on player actions
   */
  updateScenarioState(scenarioUpdates: any): void {
    const currentScene = this.getCurrentScene();
    if (!scenarioUpdates || !currentScene) return;

    // Update scene description if provided
    if (scenarioUpdates.description) {
      currentScene.description = scenarioUpdates.description;
    }

    // Update environmental conditions
    if (
      scenarioUpdates.conditions &&
      Array.isArray(scenarioUpdates.conditions)
    ) {
      for (const newCondition of scenarioUpdates.conditions) {
        const existingIndex = currentScene.conditions.findIndex(
          (condition) => condition.type === newCondition.type
        );

        if (existingIndex >= 0) {
          // Update existing condition
          currentScene.conditions[existingIndex] = newCondition;
        } else {
          // Add new condition
          currentScene.conditions.push(newCondition);
        }
      }
    }

    // Update clue states
    if (scenarioUpdates.clues && Array.isArray(scenarioUpdates.clues)) {
      for (const clueUpdate of scenarioUpdates.clues) {
        const existingIndex = currentScene.clues.findIndex(
          (clue) => clue.id === clueUpdate.id
        );

        if (existingIndex >= 0) {
          // Update existing clue
          currentScene.clues[existingIndex] = {
            ...currentScene.clues[existingIndex],
            ...clueUpdate,
          };
        } else if (clueUpdate.id) {
          // Add new clue
          currentScene.clues.push(clueUpdate);
        }
      }
    }

    this.state.lastUpdated = new Date();
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

  // === NPC Planning System helpers ===

  getNpcLocation(npcId: string): string | undefined {
    return this.state.npcLocations[npcId];
  }

  setNpcLocation(npcId: string, scenarioId: string): void {
    this.state.npcLocations[npcId] = scenarioId;
  }

  getNpcStats(npcId: string): { hp: number; san: number } | undefined {
    return this.state.npcStats[npcId];
  }

  updateNpcHp(npcId: string, delta: number): void {
    if (!this.state.npcStats[npcId]) return;
    this.state.npcStats[npcId].hp = Math.max(0, this.state.npcStats[npcId].hp + delta);
  }

  updateNpcSan(npcId: string, delta: number): void {
    if (!this.state.npcStats[npcId]) return;
    this.state.npcStats[npcId].san = Math.max(0, this.state.npcStats[npcId].san + delta);
  }

  getNpcInventory(npcId: string): string[] {
    return this.state.npcInventories[npcId] ?? [];
  }

  addItemToNpc(npcId: string, itemId: string): void {
    if (!this.state.npcInventories[npcId]) this.state.npcInventories[npcId] = [];
    this.state.npcInventories[npcId].push(itemId);
  }

  removeItemFromNpc(npcId: string, itemId: string): void {
    if (!this.state.npcInventories[npcId]) return;
    this.state.npcInventories[npcId] = this.state.npcInventories[npcId].filter(id => id !== itemId);
  }

  transferClue(fromNpcId: string, toNpcId: string, clueId: string): void {
    if (!this.state.npcDiscoveredClues[toNpcId]) this.state.npcDiscoveredClues[toNpcId] = [];
    if (!this.state.npcDiscoveredClues[toNpcId].includes(clueId)) {
      this.state.npcDiscoveredClues[toNpcId].push(clueId);
    }
    if (this.state.npcDiscoveredClues[fromNpcId]) {
      this.state.npcDiscoveredClues[fromNpcId] = this.state.npcDiscoveredClues[fromNpcId].filter(id => id !== clueId);
    }
  }

  markScenarioClueDiscovered(clueId: string, discoveredBy: string): void {
    const scene = this.getCurrentScene();
    if (!scene?.clues) return;
    const clue = scene.clues.find((c) => c.id === clueId);
    if (clue && !clue.discovered) {
      clue.discovered = true;
      clue.discoveryDetails = {
        discoveredBy,
        discoveredAt: new Date().toISOString(),
        method: "tick_discovery",
      };
    }
  }

  damageScenarioClue(clueId: string, damagedBy: string, reason: string): void {
    const scene = this.getCurrentScene();
    if (!scene?.clues) return;
    const clue = scene.clues.find((c) => c.id === clueId);
    if (clue && !clue.discovered && !clue.damaged) {
      clue.damaged = true;
      clue.damageDetails = {
        damagedBy,
        damagedAt: new Date().toISOString(),
        reason,
      };
    }
  }

  markNpcClueRevealed(npcId: string, clueId: string): void {
    const npc = this.state.npcCharacters.find((n) => n.id === npcId);
    if (!npc?.clues) return;
    // Handle regular NPC clues
    const clue = npc.clues.find((c) => c.id === clueId);
    if (clue) clue.revealed = true;
  }

  addDiscoveredClue(clue: DiscoveredClue): void {
    const exists = this.state.discoveredClues.some((c) => c.text === clue.text);
    if (!exists) {
      this.state.discoveredClues.push(clue);
    }
  }

  getRelationship(npcId: string, targetId: string): { score: number; note: string } | undefined {
    return this.state.npcRelationshipGraph[npcId]?.[targetId];
  }

  updateRelationship(npcId: string, targetId: string, scoreDelta: number, note: string): void {
    if (!this.state.npcRelationshipGraph[npcId]) this.state.npcRelationshipGraph[npcId] = {};
    const current = this.state.npcRelationshipGraph[npcId][targetId] ?? { score: 0, note: "" };
    const newScore = Math.max(-100, Math.min(100, current.score + scoreDelta));
    this.state.npcRelationshipGraph[npcId][targetId] = { score: newScore, note };
    if (!this.state.npcRelationshipGraph[targetId]) this.state.npcRelationshipGraph[targetId] = {};
    this.state.npcRelationshipGraph[targetId][npcId] = { score: newScore, note };
  }

  getSceneConditions(scenarioId: string): import("../dynamicBasicAgent/npcPlanning/types.js").SceneCondition[] {
    return this.state.scenarioConditions[scenarioId] ?? [];
  }

  appendSceneCondition(scenarioId: string, condition: import("../dynamicBasicAgent/npcPlanning/types.js").SceneCondition): void {
    if (!this.state.scenarioConditions[scenarioId]) this.state.scenarioConditions[scenarioId] = [];
    this.state.scenarioConditions[scenarioId].push(condition);
  }

  isConnectionBlocked(fromId: string, toId: string): boolean {
    const conn = this.state.connectionStates.find(
      c => (c.fromScenarioId === fromId && c.toScenarioId === toId) ||
           (c.fromScenarioId === toId && c.toScenarioId === fromId)
    );
    return conn?.blocked ?? false;
  }

  setConnectionBlocked(fromId: string, toId: string, blocked: boolean, reason: string): void {
    let conn = this.state.connectionStates.find(
      c => (c.fromScenarioId === fromId && c.toScenarioId === toId) ||
           (c.fromScenarioId === toId && c.toScenarioId === fromId)
    );
    if (!conn) {
      conn = { fromScenarioId: fromId, toScenarioId: toId, blocked, conditions: [] };
      this.state.connectionStates.push(conn);
    }
    conn.blocked = blocked;
    conn.conditions.push(reason);
  }
}
