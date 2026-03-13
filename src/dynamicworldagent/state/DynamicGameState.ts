/**
 * Dynamic Game State
 * Complete state management for DynamicWorld simulation engine.
 * Contains only fields and methods actively used by the tick processor,
 * node handlers, world features, and SimulationRunner.
 */

import type { ModuleSetup, ScenarioOutline } from "./types.js";

import {
  InventoryUtils,
  type NPCRelationship,
} from "../../shared/agents/models/gameTypes.js";
import type { DiscoveredKnowledge } from "../../shared/state/index.js";
import type {
  CharacterPosition,
  JunctionNode,
  RoadNode,
  TownTopology,
} from "./topologyTypes.js";
import { buildTopology } from "./topologyTypes.js";
import type {
  DynamicNPCProfile,
  DynamicScene,
  Item,
  TransportEdge,
} from "./types.js";

/**
 * Dynamic Game State — runtime data for the simulation engine.
 * All fields here are actively read/written by tick processor, handlers, or features.
 */
export interface DynamicGameState {
  // === Session ===
  sessionId: string;

  // === Scenes ===
  scenes: Map<string, DynamicScene>;

  // === Time ===
  gameDay: number; // Day number in game
  timeOfDay: string; // Game time in HH:MM format

  // === Characters ===
  npcCharacters: DynamicNPCProfile[];

  // === Knowledge & Discovery ===
  discoveredKnowledge: DiscoveredKnowledge[];

  // === Module Metadata ===
  moduleName: string;
  moduleSetup: ModuleSetup | null;
  scenarioOutlines: ScenarioOutline[];

  // === World Feature Runtime State ===
  // Keyed by featureId -> sceneId -> feature-defined data
  featureState: Record<string, Record<string, unknown>>;

  // === NPC Planning System Runtime State ===
  npcLocations: Record<string, string>; // npcId -> sceneId
  npcStats: Record<string, { hp: number; san: number }>;
  npcInventories: Record<string, Item[]>; // npcId -> items
  npcDiscoveredKnowledge: Record<string, string[]>; // npcId -> knowledge IDs
  npcRelationshipGraph: Record<
    string,
    Record<string, { score: number; note: string }>
  >;
  scenarioConditions: Record<
    string,
    import("../dynamicBasicAgent/npcPlanning/types.js").SceneCondition[]
  >;
  blockedConnections: Map<string, string>; // "sceneA::sceneB" -> reason
  npcResidences: Record<string, string>; // npcId -> macroLocationId
  transportEdges: TransportEdge[];

  // === Road & Junction Topology ===
  // null if module has no JUNC/ROAD files
  topology: TownTopology | null;

  // === Character Positions (NPC) ===
  characterPositions: Record<string, CharacterPosition>;

  // === Metadata ===
  loadedAt: Date;
  lastUpdated: Date;
}

/**
 * Create initial DynamicGameState with provided runtime data.
 * Character, gameDay, and timeOfDay should be loaded from DB or user selection.
 */
export const initialDynamicGameState = (params: {
  sessionId: string;
  moduleName: string;
  gameDay?: number;
  timeOfDay?: string;
}): DynamicGameState => ({
  sessionId: params.sessionId,
  scenes: new Map(),
  gameDay: params.gameDay ?? 1,
  timeOfDay: params.timeOfDay ?? "08:00",
  npcCharacters: [],
  discoveredKnowledge: [],
  moduleName: params.moduleName,
  moduleSetup: null,
  scenarioOutlines: [],
  featureState: {},
  npcLocations: {},
  npcStats: {},
  npcInventories: {},
  npcDiscoveredKnowledge: {},
  npcRelationshipGraph: {},
  scenarioConditions: {},
  blockedConnections: new Map(),
  npcResidences: {},
  transportEdges: [],
  topology: null,
  characterPositions: {},
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
   * Set database instance for scene management
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

  // === Scene Helpers ===

  /**
   * Get a scene by ID
   */
  getScene(sceneId: string): DynamicScene | null {
    return this.state.scenes.get(sceneId) ?? null;
  }

  /**
   * Insert or replace a scene in the scenes map
   */
  updateScene(sceneId: string, scene: DynamicScene): void {
    this.state.scenes.set(sceneId, scene);
    this.state.lastUpdated = new Date();
  }

  /**
   * Load world data into state.
   * Only loads fields that the simulation engine uses.
   */
  loadWorldData(data: {
    moduleSetup?: ModuleSetup;
    scenarioOutlines?: ScenarioOutline[];
  }): void {
    if (data.moduleSetup) {
      this.state.moduleSetup = data.moduleSetup;
    }
    if (data.scenarioOutlines) {
      this.state.scenarioOutlines = data.scenarioOutlines;
    }

    this.state.lastUpdated = new Date();
  }

  // === Serialization ===

  /**
   * Serialize state for storage (converts Maps to Objects, Dates to ISO strings)
   */
  serialize(): any {
    // Convert scenes Map to plain object
    const scenesObj: Record<string, DynamicScene> = {};
    this.state.scenes.forEach((scene, id) => {
      scenesObj[id] = scene;
    });

    // Convert blockedConnections Map to plain object
    const blockedConnsObj: Record<string, string> = {};
    this.state.blockedConnections.forEach((reason, key) => {
      blockedConnsObj[key] = reason;
    });

    // Convert topology Maps to plain objects
    let topologyObj: any = null;
    if (this.state.topology) {
      const junctionsObj: Record<string, any> = {};
      this.state.topology.junctions.forEach((j, id) => {
        junctionsObj[id] = j;
      });
      const roadsObj: Record<string, any> = {};
      this.state.topology.roads.forEach((r, id) => {
        roadsObj[id] = r;
      });
      topologyObj = { junctions: junctionsObj, roads: roadsObj };
    }

    return {
      ...this.state,
      scenes: scenesObj,
      blockedConnections: blockedConnsObj,
      topology: topologyObj,
      characterPositions: this.state.characterPositions,
      npcResidences: this.state.npcResidences,
      transportEdges: this.state.transportEdges,
      loadedAt: this.state.loadedAt.toISOString(),
      lastUpdated: this.state.lastUpdated.toISOString(),
    };
  }

  /**
   * Deserialize state from storage (converts Objects back to Maps, ISO strings back to Dates)
   * @param data - Serialized state data
   * @param checkpointGameDay - Optional: kept for backward compatibility (unused)
   * @param checkpointTimeOfDay - Optional: kept for backward compatibility (unused)
   */
  static deserialize(
    data: any,
    checkpointGameDay?: number,
    checkpointTimeOfDay?: string
  ): DynamicGameState {
    // Convert scenes from object back to Map
    const scenes = new Map<string, DynamicScene>();
    if (data.scenes) {
      if (data.scenes instanceof Map) {
        data.scenes.forEach((scene: DynamicScene, id: string) =>
          scenes.set(id, scene)
        );
      } else {
        Object.entries(data.scenes).forEach(([id, scene]) => {
          scenes.set(id, scene as DynamicScene);
        });
      }
    }

    // Reconstruct blockedConnections Map
    const blockedConnections = new Map<string, string>();
    if (data.blockedConnections) {
      if (data.blockedConnections instanceof Map) {
        data.blockedConnections.forEach((v: string, k: string) =>
          blockedConnections.set(k, v)
        );
      } else {
        Object.entries(data.blockedConnections).forEach(([k, v]) =>
          blockedConnections.set(k, v as string)
        );
      }
    }

    // Reconstruct topology from serialized junctions/roads
    let topology: TownTopology | null = null;
    if (data.topology?.junctions && data.topology?.roads) {
      const junctions = new Map<string, JunctionNode>();
      Object.entries(data.topology.junctions).forEach(([id, j]) =>
        junctions.set(id, j as JunctionNode)
      );
      const roads = new Map<string, RoadNode>();
      Object.entries(data.topology.roads).forEach(([id, r]) =>
        roads.set(id, r as RoadNode)
      );
      topology = buildTopology(junctions, roads);
    }

    return {
      sessionId: data.sessionId ?? "",
      moduleName: data.moduleName ?? "",
      moduleSetup: data.moduleSetup ?? null,
      gameDay: data.gameDay ?? 1,
      timeOfDay: data.timeOfDay ?? "08:00",
      npcCharacters: data.npcCharacters ?? [],
      discoveredKnowledge: data.discoveredKnowledge ?? [],
      scenarioOutlines: data.scenarioOutlines ?? [],
      scenes,
      blockedConnections,
      featureState: data.featureState ?? {},
      npcLocations: data.npcLocations ?? {},
      npcStats: data.npcStats ?? {},
      npcInventories: data.npcInventories ?? {},
      npcDiscoveredKnowledge: data.npcDiscoveredKnowledge ?? {},
      npcRelationshipGraph: data.npcRelationshipGraph ?? {},
      scenarioConditions: data.scenarioConditions ?? {},
      npcResidences: data.npcResidences ?? {},
      transportEdges: data.transportEdges ?? [],
      topology,
      characterPositions: data.characterPositions ?? {},
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
    };
  }

  /**
   * Create a copy of the state
   */
  clone(): DynamicGameState {
    return {
      ...this.state,
      scenes: new Map(this.state.scenes),
      blockedConnections: new Map(this.state.blockedConnections),
    };
  }

  // === NPC Management ===

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
   * Apply state updates from action agent results
   */
  applyActionUpdate(stateUpdate: any): void {
    if (!stateUpdate) return;

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

  // === Time Management ===

  /**
   * Update game time based on elapsed time in minutes
   */
  updateGameTime(elapsedMinutes: number): {
    dayChanged: boolean;
    previousDay: number;
  } {
    if (!elapsedMinutes || elapsedMinutes <= 0)
      return { dayChanged: false, previousDay: this.state.gameDay };

    const previousDay = this.state.gameDay;

    // Parse current time "HH:MM"
    const [hours, minutes] = this.state.timeOfDay.split(":").map(Number);

    // Calculate new time
    let totalMinutes = hours * 60 + minutes + elapsedMinutes;

    // Handle day overflow (24 hours = 1440 minutes)
    if (totalMinutes >= 1440) {
      const daysElapsed = Math.floor(totalMinutes / 1440);
      this.state.gameDay += daysElapsed;
      totalMinutes = totalMinutes % 1440;
      console.log(`A new day has dawned! It is now Day ${this.state.gameDay}`);
    }

    const newHours = Math.floor(totalMinutes / 60);
    const newMinutes = totalMinutes % 60;

    // Update time in HH:MM format
    this.state.timeOfDay = `${String(newHours).padStart(2, "0")}:${String(newMinutes).padStart(2, "0")}`;
    this.state.lastUpdated = new Date();

    return { dayChanged: this.state.gameDay !== previousDay, previousDay };
  }

  // === NPC Planning System Helpers ===

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
    this.state.npcStats[npcId].hp = Math.max(
      0,
      this.state.npcStats[npcId].hp + delta
    );
  }

  updateNpcSan(npcId: string, delta: number): void {
    if (!this.state.npcStats[npcId]) return;
    this.state.npcStats[npcId].san = Math.max(
      0,
      this.state.npcStats[npcId].san + delta
    );
  }

  getNpcInventory(npcId: string): Item[] {
    return this.state.npcInventories[npcId] ?? [];
  }

  findNpcItem(npcId: string, itemId: string): Item | undefined {
    return this.state.npcInventories[npcId]?.find((i) => i.id === itemId);
  }

  addItemToNpc(npcId: string, item: Item): void {
    if (!this.state.npcInventories[npcId])
      this.state.npcInventories[npcId] = [];
    this.state.npcInventories[npcId].push(item);
  }

  removeItemFromNpc(npcId: string, itemId: string): Item | undefined {
    if (!this.state.npcInventories[npcId]) return undefined;
    const idx = this.state.npcInventories[npcId].findIndex(
      (i) => i.id === itemId
    );
    if (idx === -1) return undefined;
    return this.state.npcInventories[npcId].splice(idx, 1)[0];
  }

  transferKnowledge(
    fromNpcId: string,
    toNpcId: string,
    knowledgeId: string
  ): void {
    if (!this.state.npcDiscoveredKnowledge[toNpcId])
      this.state.npcDiscoveredKnowledge[toNpcId] = [];
    if (!this.state.npcDiscoveredKnowledge[toNpcId].includes(knowledgeId)) {
      this.state.npcDiscoveredKnowledge[toNpcId].push(knowledgeId);
    }
    // Knowledge sharing is a copy, not a move — sender retains the knowledge
  }

  /** Damage an evidence item in the specified scene (e.g., on fumble) */
  damageEvidenceItem(
    itemId: string,
    damagedBy: string,
    reason: string,
    sceneId: string
  ): void {
    const scene = this.getScene(sceneId);
    if (!scene?.items) return;
    const item = scene.items.find(
      (i) => i.id === itemId && i.category === "evidence"
    );
    if (item && !item.damaged) {
      item.damaged = true;
      item.damageDetails = {
        damagedBy,
        damagedAt: new Date().toISOString(),
        reason,
      };
    }
  }

  addNpcKnowledge(
    npcId: string,
    entry: import("../../shared/agents/models/gameTypes.js").NPCKnowledge
  ): void {
    const npc = this.state.npcCharacters.find((n) => n.id === npcId);
    if (!npc) return;
    if (!npc.knowledge) npc.knowledge = [];
    const exists = npc.knowledge.some((k) => k.id === entry.id);
    if (!exists) npc.knowledge.push(entry);
  }

  markNpcKnowledgeRevealed(npcId: string, knowledgeId: string): void {
    const npc = this.state.npcCharacters.find((n) => n.id === npcId);
    if (!npc?.knowledge) return;
    const entry = npc.knowledge.find((k) => k.id === knowledgeId);
    if (entry) entry.revealed = true;
  }

  addDiscoveredKnowledge(entry: DiscoveredKnowledge): void {
    const exists = this.state.discoveredKnowledge.some(
      (k) => k.text === entry.text
    );
    if (!exists) {
      this.state.discoveredKnowledge.push(entry);
    }
  }

  getRelationship(
    npcId: string,
    targetId: string
  ): { score: number; note: string } | undefined {
    return this.state.npcRelationshipGraph[npcId]?.[targetId];
  }

  updateRelationship(
    npcId: string,
    targetId: string,
    scoreDelta: number,
    note: string
  ): void {
    if (!this.state.npcRelationshipGraph[npcId])
      this.state.npcRelationshipGraph[npcId] = {};
    const current = this.state.npcRelationshipGraph[npcId][targetId] ?? {
      score: 0,
      note: "",
    };
    const newScore = Math.max(-100, Math.min(100, current.score + scoreDelta));
    this.state.npcRelationshipGraph[npcId][targetId] = {
      score: newScore,
      note,
    };
    if (!this.state.npcRelationshipGraph[targetId])
      this.state.npcRelationshipGraph[targetId] = {};
    this.state.npcRelationshipGraph[targetId][npcId] = {
      score: newScore,
      note,
    };
  }

  getSceneConditions(
    scenarioId: string
  ): import("../dynamicBasicAgent/npcPlanning/types.js").SceneCondition[] {
    return this.state.scenarioConditions[scenarioId] ?? [];
  }

  appendSceneCondition(
    scenarioId: string,
    condition: import(
      "../dynamicBasicAgent/npcPlanning/types.js"
    ).SceneCondition
  ): void {
    if (!this.state.scenarioConditions[scenarioId])
      this.state.scenarioConditions[scenarioId] = [];
    this.state.scenarioConditions[scenarioId].push(condition);
  }

  // === Feature State ===

  /** Get feature state for a specific scene. Returns undefined if not set. */
  getFeatureSceneState(
    featureId: string,
    sceneId: string
  ): unknown | undefined {
    return this.state.featureState[featureId]?.[sceneId];
  }

  /** Set feature state for a specific scene. */
  setFeatureSceneState(
    featureId: string,
    sceneId: string,
    data: unknown
  ): void {
    if (!this.state.featureState[featureId])
      this.state.featureState[featureId] = {};
    this.state.featureState[featureId][sceneId] = data;
    this.state.lastUpdated = new Date();
  }

  /** Get all scene states for a feature. Returns empty object if none. */
  getFeatureState(featureId: string): Record<string, unknown> {
    return this.state.featureState[featureId] ?? {};
  }

  /** Remove feature state for a specific scene. */
  removeFeatureSceneState(featureId: string, sceneId: string): void {
    if (this.state.featureState[featureId]) {
      delete this.state.featureState[featureId][sceneId];
      this.state.lastUpdated = new Date();
    }
  }

  // === Blocked Connections ===

  isConnectionBlocked(fromId: string, toId: string): boolean {
    const key1 = `${fromId}::${toId}`;
    const key2 = `${toId}::${fromId}`;
    return (
      this.state.blockedConnections.has(key1) ||
      this.state.blockedConnections.has(key2)
    );
  }

  setConnectionBlocked(
    fromId: string,
    toId: string,
    blocked: boolean,
    reason: string
  ): void {
    const key = `${fromId}::${toId}`;
    if (blocked) {
      this.state.blockedConnections.set(key, reason);
    } else {
      this.state.blockedConnections.delete(key);
      this.state.blockedConnections.delete(`${toId}::${fromId}`);
    }
    this.state.lastUpdated = new Date();
  }

  // === Topology ===

  getJunction(junctionId: string): JunctionNode | null {
    return this.state.topology?.junctions.get(junctionId) ?? null;
  }

  getRoad(roadId: string): RoadNode | null {
    return this.state.topology?.roads.get(roadId) ?? null;
  }

  getTopology(): TownTopology | null {
    return this.state.topology;
  }

  setTopology(topology: TownTopology): void {
    this.state.topology = topology;
    this.state.lastUpdated = new Date();
  }

  // === Character Position ===

  getCharacterPosition(characterId: string): CharacterPosition | null {
    return this.state.characterPositions[characterId] ?? null;
  }

  setCharacterPosition(characterId: string, position: CharacterPosition): void {
    this.state.characterPositions[characterId] = position;
    this.state.lastUpdated = new Date();
  }

  getCharactersAtJunction(junctionId: string): string[] {
    return Object.entries(this.state.characterPositions)
      .filter(
        ([_, pos]) => pos.type === "junction" && pos.junctionId === junctionId
      )
      .map(([id]) => id);
  }

  getCharactersOnRoad(
    roadId: string
  ): Array<{ characterId: string; position: number }> {
    return Object.entries(this.state.characterPositions)
      .filter(([_, pos]) => pos.type === "road" && pos.roadId === roadId)
      .map(([id, pos]) => ({
        characterId: id,
        position: (pos as { type: "road"; roadId: string; position: number })
          .position,
      }));
  }

  getCharactersInScene(sceneId: string): string[] {
    return Object.entries(this.state.characterPositions)
      .filter(([_, pos]) => pos.type === "scene" && pos.sceneId === sceneId)
      .map(([id]) => id);
  }

  /**
   * Resolve the "location ID" for a character position, for backward compatibility.
   * Returns the scene/junction/road ID the character is at.
   */
  resolveLocationId(position: CharacterPosition): string {
    switch (position.type) {
      case "junction":
        return position.junctionId;
      case "road":
        return position.roadId;
      case "scene":
        return position.sceneId;
    }
  }
}
