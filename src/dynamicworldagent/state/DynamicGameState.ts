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
  GameEndingInfo,
  DiscoveredClue,
  TimeConsumption,
} from "../../state.js";
import type { CharacterProfile } from "../../coc_multiagents_system/agents/models/gameTypes.js";
import { InventoryUtils } from "../../coc_multiagents_system/agents/models/gameTypes.js";
import type { ScenarioSnapshot } from "../../coc_multiagents_system/agents/models/scenarioTypes.js";

export type Phase = "intro" | "investigation" | "confrontation" | "downtime";

export interface VisitedScenarioBasic {
  id: string;
  name: string;
  location: string;
}

/**
 * Dynamic Game State - Contains all game runtime data + DynamicWorld-specific data
 * This completely replaces the old GameState for DynamicWorld modules
 */
export interface DynamicGameState {
  // === Session & Runtime Data (from old GameState) ===
  sessionId: string;
  phase: Phase;

  // Current scenario and visited history
  currentScenario: ScenarioSnapshot | null;
  visitedScenarios: VisitedScenarioBasic[];

  // Time management
  gameDay: number;  // Day number in game
  timeOfDay: string;  // Game time in HH:MM format
  scenarioTimeState: {
    sceneStartTime: string;
    playerTimeConsumption: Record<string, {
      totalShortActions: number;
      lastActionTime: string;
    }>;
  };

  // Game tension
  tension: number;

  // Characters
  playerCharacter: CharacterProfile;
  npcCharacters: CharacterProfile[];

  // Clues and progression
  discoveredClues: DiscoveredClue[];
  turnsInCurrentScene: number;
  lastPlayerInputTime: Date | null;

  // Game ending
  gameEnding: GameEndingInfo | null;

  // Temporary info (cleared at start of each player turn)
  temporaryInfo: {
    actionResults: ActionResult[];
    currentActionAnalysis: ActionAnalysis | null;
    npcResponseAnalyses: NPCResponseAnalysis[];
    directorDecision: DirectorDecision | null;
    sceneChangeRequest: SceneChangeRequest | null;
    transition: boolean;
    sceneTransitionRejection: SceneTransitionRejection | null;
    narrativeDirection: string | null;
    contextualData: Record<string, any>;
  };

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
  revealedTruthEvents: Set<string>;  // Truth event IDs that have been revealed to players
  activatedKnowledgeHolders: Set<string>;  // Knowledge holder IDs that have been activated/accessed
  deployedRedHerrings: Set<string>;  // Red herring IDs that have been deployed
  mythosRevelations: Set<string>;  // Mythos event IDs that have been revealed

  // End state tracking
  pointOfNoReturnReached: boolean;
  pointOfNoReturnTrigger: string | null;  // The actual trigger value when reached

  // Metadata
  loadedAt: Date;  // When this state was loaded
  lastUpdated: Date;  // Last time state was updated
}

/**
 * Create initial DynamicGameState with provided runtime data
 * Character, gameDay, and timeOfDay should be loaded from DB or user selection
 */
export const initialDynamicGameState = (params: {
  sessionId: string;
  moduleName: string;
  playerCharacter: CharacterProfile;
  gameDay?: number;
  timeOfDay?: string;
}): DynamicGameState => ({
  // Session & Runtime Data
  sessionId: params.sessionId,
  phase: "intro",
  currentScenario: null,
  visitedScenarios: [],
  gameDay: params.gameDay ?? 1,
  timeOfDay: params.timeOfDay ?? "08:00",
  scenarioTimeState: {
    sceneStartTime: params.timeOfDay ?? "08:00",
    playerTimeConsumption: {},
  },
  tension: 1,
  playerCharacter: params.playerCharacter,
  npcCharacters: [],
  discoveredClues: [],
  turnsInCurrentScene: 0,
  lastPlayerInputTime: null,
  gameEnding: null,
  temporaryInfo: {
    actionResults: [],
    currentActionAnalysis: null,
    npcResponseAnalyses: [],
    directorDecision: null,
    sceneChangeRequest: null,
    transition: false,
    sceneTransitionRejection: null,
    narrativeDirection: null,
    contextualData: {},
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
  loadedAt: new Date(),
  lastUpdated: new Date(),
});

/**
 * Dynamic Game State Manager
 * Provides methods to manage DynamicWorld-specific state
 */
export class DynamicGameStateManager {
  private state: DynamicGameState;

  constructor(state: DynamicGameState) {
    this.state = state;
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
    return this.state.truthTimeline.filter(event => 
      this.state.revealedTruthEvents.has(event.id)
    );
  }

  /**
   * Get all unrevealed truth events
   */
  getUnrevealedTruthEvents(): TruthEvent[] {
    return this.state.truthTimeline.filter(event => 
      !this.state.revealedTruthEvents.has(event.id)
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
    return this.state.knowledgeMatrix.find(holder => holder.id === holderId);
  }

  /**
   * Get knowledge holders by type
   */
  getKnowledgeHoldersByType(
    type: "ROLE" | "ORGANIZATION" | "PLACE" | "OBJECT"
  ): KnowledgeHolder[] {
    return this.state.knowledgeMatrix.filter(holder => holder.holderType === type);
  }

  /**
   * Get knowledge holders that know a specific truth event
   */
  getKnowledgeHoldersForTruthEvent(eventId: string): KnowledgeHolder[] {
    return this.state.knowledgeMatrix.filter(holder => 
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
    return this.state.redHerrings.find(rh => rh.id === redHerringId);
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
      const timeMatch = /Day\s+(\d+)\s+(\d{1,2}):(\d{2})/i.exec(pointOfNoReturn.trigger);
      if (timeMatch) {
        const triggerDay = parseInt(timeMatch[1], 10);
        const triggerTime = timeMatch[2] + ":" + timeMatch[3];
        
        if (currentGameDay > triggerDay || 
            (currentGameDay === triggerDay && currentTime >= triggerTime)) {
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
    return allNPCs.filter(npc => {
      if (holder.holderType === "ROLE") {
        return npc.occupation === holder.holderName || 
               npc.notes?.includes(holder.holderName);
      } else if (holder.holderType === "ORGANIZATION") {
        return npc.background?.includes(holder.holderName) ||
               npc.notes?.includes(holder.holderName);
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
      activatedKnowledgeHolders: Array.from(this.state.activatedKnowledgeHolders),
      deployedRedHerrings: Array.from(this.state.deployedRedHerrings),
      mythosRevelations: Array.from(this.state.mythosRevelations),
      loadedAt: this.state.loadedAt.toISOString(),
      lastUpdated: this.state.lastUpdated.toISOString(),
    };
  }

  /**
   * Deserialize state from storage (converts Arrays back to Sets)
   */
  static deserialize(data: any): DynamicGameState {
    return {
      ...data,
      revealedTruthEvents: new Set(data.revealedTruthEvents || []),
      activatedKnowledgeHolders: new Set(data.activatedKnowledgeHolders || []),
      deployedRedHerrings: new Set(data.deployedRedHerrings || []),
      mythosRevelations: new Set(data.mythosRevelations || []),
      loadedAt: data.loadedAt ? new Date(data.loadedAt) : new Date(),
      lastUpdated: data.lastUpdated ? new Date(data.lastUpdated) : new Date(),
    };
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
   * Clear narrative direction
   */
  clearNarrativeDirection(): void {
    this.state.temporaryInfo.narrativeDirection = null;
    this.state.lastUpdated = new Date();
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
   * Set action results
   */
  setActionResults(results: ActionResult[]): void {
    this.state.temporaryInfo.actionResults = results;
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
   * Set narrative direction
   */
  setNarrativeDirection(direction: string | null): void {
    this.state.temporaryInfo.narrativeDirection = direction;
    this.state.lastUpdated = new Date();
  }

  /**
   * Set scene change request
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
   * Set director decision
   */
  setDirectorDecision(decision: DirectorDecision | null): void {
    this.state.temporaryInfo.directorDecision = decision;
    this.state.lastUpdated = new Date();
  }

  /**
   * Set transition flag
   */
  setTransition(transition: boolean): void {
    this.state.temporaryInfo.transition = transition;
    this.state.lastUpdated = new Date();
  }

  /**
   * Set scene transition rejection
   */
  setSceneTransitionRejection(rejection: SceneTransitionRejection | null): void {
    this.state.temporaryInfo.sceneTransitionRejection = rejection;
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

  // === GameStateManager-compatible methods ===

  /**
   * Update or add NPCs to the game state (adds all NPCs without filtering)
   */
  updateNpcs(npcData: CharacterProfile[]): void {
    if (!npcData || npcData.length === 0) return;

    for (const newNpc of npcData) {
      const existingIndex = this.state.npcCharacters.findIndex(
        npc => npc.id === newNpc.id
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
  updateCurrentScenario(scenarioData: { snapshot: ScenarioSnapshot; scenarioName: string } | null): void {
    if (!scenarioData) return;

    const newScenario = scenarioData.snapshot;
    
    // If we already have a current scenario, move it to visited scenarios
    if (this.state.currentScenario) {
      this.addVisitedScenario(this.state.currentScenario);
    }

    // Set new current scenario
    this.state.currentScenario = newScenario;
    
    // Automatically update NPC locations in the scene
    this.updateNpcLocationsForScenario(newScenario);
    
    // Reset time consumption state for any scenario update
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
   * Automatically update NPC current locations based on character list in scenario
   */
  private updateNpcLocationsForScenario(scenario: ScenarioSnapshot): void {
    if (!scenario || !scenario.characters || scenario.characters.length === 0) {
      return;
    }

    const scenarioLocation = scenario.location;
    const scenarioCharacters = scenario.characters;

    // Iterate through characters in scene, update matching NPC locations
    for (const scenarioChar of scenarioCharacters) {
      // Find matching character in NPC list (using 80% similarity fuzzy matching)
      const matchingNpc = this.state.npcCharacters.find(npc => {
        return this.isNameSimilar(npc.name, scenarioChar.name);
      });

      if (matchingNpc) {
        const npcProfile = matchingNpc as any;
        const oldLocation = npcProfile.currentLocation || null;
        npcProfile.currentLocation = scenarioLocation;
        
        if (oldLocation !== scenarioLocation) {
          const oldLocationDisplay = oldLocation || "Unknown";
          console.log(`📍 [Scene Transition] NPC ${matchingNpc.name} location updated: ${oldLocationDisplay} → ${scenarioLocation}`);
        }
      }
    }
  }

  /**
   * Add a scenario snapshot to the visited list while keeping the list bounded
   */
  addVisitedScenario(scenario: ScenarioSnapshot): void {
    // Check if this scenario is already in visited list
    const existingIndex = this.state.visitedScenarios.findIndex(
      visited => visited.id === scenario.id
    );
    
    if (existingIndex === -1) {
      // Extract only basic information for visited scenarios
      const basicScenario: VisitedScenarioBasic = {
        id: scenario.id,
        name: scenario.name,
        location: scenario.location
      };
      
      // Add scenario to visited list
      this.state.visitedScenarios.unshift(basicScenario);
      
      // Keep only the most recent 3 visited scenarios
      if (this.state.visitedScenarios.length > 3) {
        this.state.visitedScenarios = this.state.visitedScenarios.slice(0, 3);
      }
      this.state.lastUpdated = new Date();
    }
  }

  /**
   * Apply state updates from action agent results
   */
  applyActionUpdate(stateUpdate: any): void {
    if (!stateUpdate) return;

    // Update player character
    if (stateUpdate.playerCharacter) {
      this.updateCharacter(this.state.playerCharacter, stateUpdate.playerCharacter);
    }

    // Update NPC characters
    if (stateUpdate.npcCharacters && Array.isArray(stateUpdate.npcCharacters)) {
      for (const npcUpdate of stateUpdate.npcCharacters) {
        const existingNpc = this.state.npcCharacters.find(npc => npc.id === npcUpdate.id);
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
        if (typeof value === 'number' && key in character.status) {
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
        if (typeof value === 'number' && key in character.attributes) {
          character.attributes[key] += value;
        }
      }
    }
    
    // Update skills if provided
    if (updates.skills) {
      for (const [skillName, value] of Object.entries(updates.skills)) {
        if (typeof value === 'number') {
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
      character.inventory = InventoryUtils.normalizeInventory(character.inventory);
      
      if (Array.isArray(updates.inventory)) {
        // Replace entire inventory with InventoryItem[]
        character.inventory = InventoryUtils.normalizeInventory(updates.inventory);
      } else if (typeof updates.inventory === 'object' && !Array.isArray(updates.inventory)) {
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
    this.updatePlayerTimeConsumption(actionResult.character, actionResult.timeConsumption);
    
    this.state.temporaryInfo.actionResults.push(actionResult);
    
    // Keep only the most recent 10 action results to avoid memory bloat
    if (this.state.temporaryInfo.actionResults.length > 10) {
      this.state.temporaryInfo.actionResults = this.state.temporaryInfo.actionResults.slice(-10);
    }

    this.state.lastUpdated = new Date();
  }

  /**
   * Update player time consumption tracking
   */
  private updatePlayerTimeConsumption(playerName: string, timeConsumption: TimeConsumption): void {
    // Initialize player record if doesn't exist
    if (!this.state.scenarioTimeState.playerTimeConsumption[playerName]) {
      this.state.scenarioTimeState.playerTimeConsumption[playerName] = {
        totalShortActions: 0,
        lastActionTime: timeConsumption
      };
    }

    const playerTime = this.state.scenarioTimeState.playerTimeConsumption[playerName];
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
        playerTime.totalShortActions = Math.max(playerTime.totalShortActions, shortActionCap);
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
    const playerTime = this.state.scenarioTimeState.playerTimeConsumption[playerName];
    return playerTime ? playerTime.totalShortActions : 0;
  }

  /**
   * Get player's last action time consumption
   */
  getPlayerLastActionTime(playerName: string): TimeConsumption | null {
    const playerTime = this.state.scenarioTimeState.playerTimeConsumption[playerName];
    return playerTime ? playerTime.lastActionTime as TimeConsumption : null;
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
    if (tension <= 3) return 4;      // Low tension (1-3): 4 turns
    if (tension <= 6) return 3;      // Medium tension (4-6): 3 turns
    if (tension <= 8) return 2;      // High tension (7-8): 2 turns
    return 1;                         // Critical tension (9-10): 1 turn
  }

  /**
   * Check if progression should trigger based on turn count OR time elapsed
   * @returns true if either condition is met
   */
  shouldTriggerProgression(): boolean {
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
    const [hours, minutes] = this.state.timeOfDay.split(':').map(Number);
    
    // Calculate new time
    let totalMinutes = hours * 60 + minutes + elapsedMinutes;
    
    // Handle day overflow (24 hours = 1440 minutes)
    if (totalMinutes >= 1440) {
      const daysElapsed = Math.floor(totalMinutes / 1440);
      this.state.gameDay += daysElapsed;
      totalMinutes = totalMinutes % 1440;
      console.log(`🌅 A new day has dawned! It is now Day ${this.state.gameDay}`);
    }
    
    const newHours = Math.floor(totalMinutes / 60);
    const newMinutes = totalMinutes % 60;
    
    // Update time in HH:MM format
    this.state.timeOfDay = 
      `${String(newHours).padStart(2, '0')}:${String(newMinutes).padStart(2, '0')}`;
    this.state.lastUpdated = new Date();
  }

  /**
   * Get human-readable time of day description
   */
  getTimeOfDayDescription(): string {
    const [hours] = this.state.timeOfDay.split(':').map(Number);
    
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
   * Clear director decision
   */
  clearDirectorDecision(): void {
    this.state.temporaryInfo.directorDecision = null;
    this.state.lastUpdated = new Date();
  }

  /**
   * Set transition flag to indicate a scene change has occurred
   */
  setTransitionFlag(isTransition: boolean): void {
    this.state.temporaryInfo.transition = isTransition;
    this.state.lastUpdated = new Date();
  }

  /**
   * Clear transition flag
   */
  clearTransitionFlag(): void {
    this.state.temporaryInfo.transition = false;
    this.state.lastUpdated = new Date();
  }

  /**
   * Set scene transition rejection info (when Director denies player's transition request)
   */
  setSceneTransitionRejectionReasoning(reasoning: string): void {
    this.state.temporaryInfo.sceneTransitionRejection = {
      wasRequested: true,
      reasoning,
      timestamp: new Date()
    };
    this.state.lastUpdated = new Date();
  }

  /**
   * Set game ending information (marks the game as ended)
   */
  setGameEnding(endingInfo: GameEndingInfo): void {
    this.state.gameEnding = endingInfo;
    this.state.lastUpdated = new Date();
  }

  /**
   * Check if the game has ended
   */
  isGameEnded(): boolean {
    return this.state.gameEnding?.isEnded ?? false;
  }

  /**
   * Get game ending information
   */
  getGameEnding(): GameEndingInfo | null {
    return this.state.gameEnding;
  }

  /**
   * Update current scenario based on player actions
   */
  updateScenarioState(scenarioUpdates: any): void {
    if (!scenarioUpdates || !this.state.currentScenario) return;

    // Update scenario description if provided
    if (scenarioUpdates.description) {
      // Record description change as a permanent scenario change so it persists across snapshots
      const descriptionChange = `Scene description updated: ${scenarioUpdates.description}`;
      this.addPermanentScenarioChange(descriptionChange);
    }

    // Update environmental conditions
    if (scenarioUpdates.conditions && Array.isArray(scenarioUpdates.conditions)) {
      for (const newCondition of scenarioUpdates.conditions) {
        const existingIndex = this.state.currentScenario.conditions.findIndex(
          condition => condition.type === newCondition.type
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

    // Add new events
    if (scenarioUpdates.events && Array.isArray(scenarioUpdates.events)) {
      this.state.currentScenario.events.push(...scenarioUpdates.events);
    }

    // Update exits/entrances
    if (scenarioUpdates.exits && Array.isArray(scenarioUpdates.exits)) {
      for (const exitUpdate of scenarioUpdates.exits) {
        if (!this.state.currentScenario.exits) {
          this.state.currentScenario.exits = [];
        }
        
        const existingIndex = this.state.currentScenario.exits.findIndex(
          exit => exit.direction === exitUpdate.direction
        );
        
        if (existingIndex >= 0) {
          // Update existing exit
          this.state.currentScenario.exits[existingIndex] = exitUpdate;
        } else {
          // Add new exit
          this.state.currentScenario.exits.push(exitUpdate);
        }
      }
    }

    // Update clue states
    if (scenarioUpdates.clues && Array.isArray(scenarioUpdates.clues)) {
      for (const clueUpdate of scenarioUpdates.clues) {
        const existingIndex = this.state.currentScenario.clues.findIndex(
          clue => clue.id === clueUpdate.id
        );
        
        if (existingIndex >= 0) {
          // Update existing clue
          this.state.currentScenario.clues[existingIndex] = {
            ...this.state.currentScenario.clues[existingIndex],
            ...clueUpdate
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
   * Add permanent change to the scenario (scenario-level, shared across all timeline snapshots)
   */
  addPermanentScenarioChange(changeDescription: string): void {
    if (!this.state.currentScenario || !changeDescription) return;
    
    // Initialize permanentChanges array if it doesn't exist
    if (!this.state.currentScenario.permanentChanges) {
      this.state.currentScenario.permanentChanges = [];
    }
    
    // Add the permanent change to current snapshot's array
    this.state.currentScenario.permanentChanges.push(changeDescription);
    this.state.lastUpdated = new Date();
  }
}
