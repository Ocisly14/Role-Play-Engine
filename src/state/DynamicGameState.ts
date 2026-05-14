/**
 * Dynamic Game State
 * Complete state management for DynamicWorld simulation engine.
 * Contains only fields and methods actively used by the tick processor,
 * node handlers, world features, and SimulationRunner.
 */

import type {
  EnvironmentReading,
  FeatureStateScope,
} from "../engine/core/types.js";
import { DEFAULT_ENVIRONMENT_READING } from "../engine/core/types.js";
import type { ScriptedEventState } from "../engine/scriptedEvents/types.js";
import {
  getBlockedConnectionReason,
  makeBlockedConnectionKey,
  resolveBlockedConnectionNodeRef,
} from "./blockedConnections.js";
import { addMinutes, datePart, isSameDay, makeDateTime } from "./gameClock.js";
import type {
  CharacterPosition,
  JunctionNode,
  RoadNode,
  TownTopology,
} from "./topologyTypes.js";
import {
  buildTopology,
  enrichTopologyWithInteriorScenes,
} from "./topologyTypes.js";
import {
  InventoryUtils,
  type ModuleSetup,
  type NPCRelationship,
  type ScenarioOutline,
} from "./types.js";
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

  // === Scenes & Topology Nodes ===
  scenes: Map<string, DynamicScene>;
  junctions: Map<string, JunctionNode>;
  roads: Map<string, RoadNode>;

  // === Time ===
  gameDateTime: string; // In-game ISO datetime, YYYY-MM-DDTHH:MM:SS

  // === Characters ===
  npcCharacters: DynamicNPCProfile[];

  // === Module Metadata ===
  moduleName: string;
  moduleSetup: ModuleSetup | null;
  scenarioOutlines: ScenarioOutline[];

  // === World Feature Runtime State ===
  // Scope-aware buckets: scope -> featureId -> key -> feature-defined data.
  // Scope "scene" is keyed by sceneId, "region" by regionId, "character" by
  // characterId, and "global" uses "" as the sole key.
  scopedFeatureStates: {
    scene: Record<string, Record<string, unknown>>;
    region: Record<string, Record<string, unknown>>;
    character: Record<string, Record<string, unknown>>;
    global: Record<string, Record<string, unknown>>;
  };

  // === Scripted Event Runtime State (Phase C) ===
  // Keyed by ScriptedEvent.id; holds status, scheduled completion tick, and
  // tracker counters. Persistence rides DGSM's existing JSON round-trip.
  scriptedEventStates: Record<string, ScriptedEventState>;

  // === Environment Readings (Phase D) ===
  // Per-location aggregated environmental snapshot (temperature, illumination,
  // oxygen, noise, airborne hazards). Written by the Applier each tick from
  // environment.* StateChanges; read by features via FeatureReadContext.
  environmentReadings: Record<string /* locationId */, EnvironmentReading>;

  // === NPC Planning System Runtime State ===
  npcStats: Record<string, { hp: number; san: number }>;
  npcInventories: Record<string, Item[]>; // npcId -> items
  npcRelationshipGraph: Record<
    string,
    Record<string, { score: number; note: string }>
  >;
  scenarioConditions: Record<
    string,
    import("../engine/core/types.js").SceneCondition[]
  >;
  blockedConnections: Map<string, string>; // "scene:id::road:id" typed canonical edge key -> reason
  npcResidences: Record<string, string>; // npcId -> macroLocationId
  transportEdges: TransportEdge[];

  // === Road & Junction Topology (required) ===
  topology: TownTopology;

  // === Character Positions (NPC) ===
  characterPositions: Record<string, CharacterPosition>;
  hiddenCharacterIds?: string[];

  // === NPC Injection Policy ===
  npcInjectionPolicy: import("./moduleLoader.js").NpcInjectionPolicy | null;

  // === Metadata ===
  loadedAt: Date;
  lastUpdated: Date;
}

/**
 * Create initial DynamicGameState with provided runtime data.
 * Character and gameDateTime should be loaded from DB or module setup.
 */
export const initialDynamicGameState = (params: {
  sessionId: string;
  moduleName: string;
  gameDateTime?: string;
}): DynamicGameState => ({
  sessionId: params.sessionId,
  scenes: new Map(),
  junctions: new Map(),
  roads: new Map(),
  gameDateTime: params.gameDateTime ?? "1900-01-01T08:00:00",
  npcCharacters: [],
  moduleName: params.moduleName,
  moduleSetup: null,
  scenarioOutlines: [],
  scopedFeatureStates: { scene: {}, region: {}, character: {}, global: {} },
  scriptedEventStates: {},
  environmentReadings: {},
  npcStats: {},
  npcInventories: {},
  npcRelationshipGraph: {},
  scenarioConditions: {},
  blockedConnections: new Map(),
  npcResidences: {},
  transportEdges: [],
  topology: null as unknown as TownTopology,
  characterPositions: {},
  hiddenCharacterIds: [],
  npcInjectionPolicy: null,
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
  private hiddenCharacterIds = new Set<string>();

  /**
   * Tracks per-connection refcount-based block votes for the Applier.
   * Keyed by connectionId; value true means at least one feature is voting blocked.
   * This is an engine-refactor path, separate from the legacy two-id
   * blockedConnections Map used by pathfinding.
   */
  private blockedConnectionsById = new Map<string, boolean>();

  constructor(state?: DynamicGameState, db?: any) {
    this.state =
      state ?? initialDynamicGameState({ sessionId: "", moduleName: "" });
    this.db = db || null;
    this.hiddenCharacterIds = new Set(this.state.hiddenCharacterIds ?? []);
    this.syncHiddenCharacterIds();
  }

  setCharacterHidden(characterId: string, hidden: boolean): void {
    if (hidden) {
      this.hiddenCharacterIds.add(characterId);
    } else {
      this.hiddenCharacterIds.delete(characterId);
    }
    this.syncHiddenCharacterIds();
  }

  isCharacterHidden(characterId: string): boolean {
    return this.hiddenCharacterIds.has(characterId);
  }

  private syncHiddenCharacterIds(): void {
    this.state.hiddenCharacterIds = Array.from(this.hiddenCharacterIds);
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

  // === NPC Injection Policy Helpers ===

  /**
   * Get the set of NPC IDs that should be actively simulated
   * (daily_sim + investigator_sim tiers). If no policy, all NPCs are simulated.
   */
  getSimulatedNpcIds(): Set<string> {
    const policy = this.state.npcInjectionPolicy;
    if (!policy) {
      return new Set(
        this.state.npcCharacters
          .map((n) => n.id)
          .filter((id) => this.isNpcAlive(id))
      );
    }
    const ids = new Set<string>();
    for (const name of policy.tiers.daily_sim ?? []) {
      if (this.isNpcAlive(name)) ids.add(name);
    }
    for (const name of policy.tiers.investigator_sim ?? []) {
      if (this.isNpcAlive(name)) ids.add(name);
    }
    return ids;
  }

  /**
   * Get NPC profiles that should be actively simulated.
   */
  getSimulatedNpcs(): DynamicNPCProfile[] {
    const simIds = this.getSimulatedNpcIds();
    return this.state.npcCharacters.filter((n) => simIds.has(n.id));
  }

  isNpcAlive(npcId: string): boolean {
    const stats = this.state.npcStats[npcId];
    if (stats) return stats.hp > 0;
    const npc = this.state.npcCharacters.find((n) => n.id === npcId);
    return (npc?.status.hp ?? 0) > 0;
  }

  // === Scene Helpers ===

  /**
   * Get a scene, junction, or road by ID.
   * Searches scenes first, then junctions, then roads.
   */
  getScene(sceneId: string): DynamicScene | null {
    return (
      this.state.scenes.get(sceneId) ??
      (this.state.junctions.get(sceneId) as unknown as DynamicScene) ??
      (this.state.roads.get(sceneId) as unknown as DynamicScene) ??
      null
    );
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
    // Convert scenes/junctions/roads Maps to plain objects
    const scenesObj: Record<string, DynamicScene> = {};
    this.state.scenes.forEach((scene, id) => {
      scenesObj[id] = scene;
    });
    const junctionsObj: Record<string, any> = {};
    this.state.junctions.forEach((j, id) => {
      junctionsObj[id] = j;
    });
    const roadsObj: Record<string, any> = {};
    this.state.roads.forEach((r, id) => {
      roadsObj[id] = r;
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
      junctions: junctionsObj,
      roads: roadsObj,
      blockedConnections: blockedConnsObj,
      topology: topologyObj,
      characterPositions: this.state.characterPositions,
      hiddenCharacterIds: Array.from(this.hiddenCharacterIds),
      npcResidences: this.state.npcResidences,
      transportEdges: this.state.transportEdges,
      environmentReadings: this.state.environmentReadings,
      loadedAt: this.state.loadedAt.toISOString(),
      lastUpdated: this.state.lastUpdated.toISOString(),
    };
  }

  /**
   * Deserialize state from storage (converts Objects back to Maps, ISO strings back to Dates)
   */
  static deserialize(data: any): DynamicGameState {
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

    // Reconstruct junctions Map
    const junctions = new Map<string, JunctionNode>();
    if (data.junctions) {
      if (data.junctions instanceof Map) {
        data.junctions.forEach((j: JunctionNode, id: string) =>
          junctions.set(id, j)
        );
      } else {
        Object.entries(data.junctions).forEach(([id, j]) =>
          junctions.set(id, j as JunctionNode)
        );
      }
    }

    // Reconstruct roads Map
    const roads = new Map<string, RoadNode>();
    if (data.roads) {
      if (data.roads instanceof Map) {
        data.roads.forEach((r: RoadNode, id: string) => roads.set(id, r));
      } else {
        Object.entries(data.roads).forEach(([id, r]) =>
          roads.set(id, r as RoadNode)
        );
      }
    }

    // Reconstruct topology from junctions/roads
    let topology: TownTopology | null = null;
    if (junctions.size > 0 || roads.size > 0) {
      topology = buildTopology(junctions, roads);
    } else if (data.topology?.junctions && data.topology?.roads) {
      // Fallback: old serialization format stored topology separately
      const topoJunctions = new Map<string, JunctionNode>();
      Object.entries(data.topology.junctions).forEach(([id, j]) =>
        topoJunctions.set(id, j as JunctionNode)
      );
      const topoRoads = new Map<string, RoadNode>();
      Object.entries(data.topology.roads).forEach(([id, r]) =>
        topoRoads.set(id, r as RoadNode)
      );
      topology = buildTopology(topoJunctions, topoRoads);
    }

    // Enrich topology with interior sub-scenes so pathfinding works for them
    const outlines = data.scenarioOutlines ?? [];
    if (topology && (scenes.size > 0 || outlines.length > 0)) {
      enrichTopologyWithInteriorScenes(topology, scenes, outlines);
    }

    return {
      sessionId: data.sessionId ?? "",
      moduleName: data.moduleName ?? "",
      moduleSetup: data.moduleSetup ?? null,
      gameDateTime:
        typeof data.gameDateTime === "string"
          ? data.gameDateTime
          : makeDateTime(data.moduleSetup?.startDate ?? "1900-01-01", "08:00"),
      npcCharacters: data.npcCharacters ?? [],
      scenarioOutlines: data.scenarioOutlines ?? [],
      scenes,
      junctions,
      roads,
      blockedConnections,
      scopedFeatureStates: (() => {
        const raw = data.scopedFeatureStates;
        if (raw && typeof raw === "object") {
          return {
            scene: raw.scene ?? {},
            region: raw.region ?? {},
            character: raw.character ?? {},
            global: raw.global ?? {},
          };
        }
        return { scene: {}, region: {}, character: {}, global: {} };
      })(),
      scriptedEventStates:
        data.scriptedEventStates && typeof data.scriptedEventStates === "object"
          ? (data.scriptedEventStates as Record<string, ScriptedEventState>)
          : {},
      environmentReadings:
        data.environmentReadings && typeof data.environmentReadings === "object"
          ? (data.environmentReadings as Record<string, EnvironmentReading>)
          : {},
      npcStats: data.npcStats ?? {},
      npcInventories: data.npcInventories ?? {},
      npcRelationshipGraph: data.npcRelationshipGraph ?? {},
      scenarioConditions: data.scenarioConditions ?? {},
      npcResidences: data.npcResidences ?? {},
      transportEdges: data.transportEdges ?? [],
      npcInjectionPolicy: data.npcInjectionPolicy ?? null,
      topology: topology!,
      characterPositions: (() => {
        if (
          data.characterPositions &&
          Object.keys(data.characterPositions).length > 0
        ) {
          return data.characterPositions;
        }
        // Backward compat: convert old npcLocations to characterPositions
        if (data.npcLocations) {
          const positions: Record<string, CharacterPosition> = {};
          for (const [npcId, locId] of Object.entries(data.npcLocations)) {
            positions[npcId] = { type: "scene", sceneId: locId as string };
          }
          return positions;
        }
        return {};
      })(),
      hiddenCharacterIds: Array.isArray(data.hiddenCharacterIds)
        ? data.hiddenCharacterIds.filter(
            (characterId: unknown): characterId is string =>
              typeof characterId === "string"
          )
        : [],
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
      junctions: new Map(this.state.junctions),
      roads: new Map(this.state.roads),
      blockedConnections: new Map(this.state.blockedConnections),
      hiddenCharacterIds: [...(this.state.hiddenCharacterIds ?? [])],
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

    // Update status values (hp, san, mp, etc.)
    if (updates.status) {
      for (const [key, value] of Object.entries(updates.status)) {
        if (key === "conditions" && Array.isArray(value)) {
          const seen = new Set<string>();
          const normalizedConditions: import(
            "../engine/core/types.js"
          ).CharacterCondition[] = [];
          for (const item of value) {
            if (typeof item === "string") {
              const trimmed = item.trim();
              if (trimmed.length === 0 || seen.has(trimmed)) continue;
              seen.add(trimmed);
              normalizedConditions.push({
                id: (globalThis.crypto?.randomUUID?.() ??
                  `${Date.now()}-${Math.random()}`) as string,
                description: trimmed,
              });
            } else if (
              item &&
              typeof item === "object" &&
              typeof (item as { description?: unknown }).description ===
                "string"
            ) {
              const cond = item as import(
                "../engine/core/types.js"
              ).CharacterCondition;
              const desc = cond.description.trim();
              if (desc.length === 0 || seen.has(desc)) continue;
              seen.add(desc);
              normalizedConditions.push({
                ...cond,
                id:
                  cond.id ??
                  ((globalThis.crypto?.randomUUID?.() ??
                    `${Date.now()}-${Math.random()}`) as string),
                description: desc,
              });
            }
          }
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
    previousDateTime: string;
  } {
    if (!elapsedMinutes || elapsedMinutes <= 0)
      return {
        dayChanged: false,
        previousDateTime: this.state.gameDateTime,
      };

    const previousDateTime = this.state.gameDateTime;
    this.state.gameDateTime = addMinutes(previousDateTime, elapsedMinutes);
    if (!isSameDay(previousDateTime, this.state.gameDateTime)) {
      console.log(
        `A new day has dawned! It is now ${datePart(this.state.gameDateTime)}`
      );
    }
    this.state.lastUpdated = new Date();

    return {
      dayChanged: !isSameDay(this.state.gameDateTime, previousDateTime),
      previousDateTime,
    };
  }

  /**
   * Set the in-game clock directly.
   * Used by simulation bootstrap paths such as real-time sync alignment.
   */
  setGameClock(params: { gameDateTime: string }): void {
    this.state.gameDateTime = params.gameDateTime;
    this.state.lastUpdated = new Date();
  }

  // === NPC Planning System Helpers ===

  getNpcStats(npcId: string): { hp: number; san: number } | undefined {
    return this.state.npcStats[npcId];
  }

  updateNpcHp(npcId: string, delta: number): void {
    if (!this.state.npcStats[npcId]) return;
    this.state.npcStats[npcId].hp = Math.max(
      0,
      this.state.npcStats[npcId].hp + delta
    );
    this.syncNpcStatusFromStats(npcId);
    this.state.lastUpdated = new Date();
  }

  updateNpcSan(npcId: string, delta: number): void {
    if (!this.state.npcStats[npcId]) return;
    this.state.npcStats[npcId].san = Math.max(
      0,
      this.state.npcStats[npcId].san + delta
    );
    this.syncNpcStatusFromStats(npcId);
    this.state.lastUpdated = new Date();
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

  /**
   * Generic item damage helper used by the Applier for `scene.damageItem`
   * StateChanges. Unlike `damageEvidenceItem`, this targets ANY item in the
   * scene (not just evidence). Idempotent: a second call on an already-damaged
   * item is a no-op.
   */
  markItemDamaged(
    sceneId: string,
    itemId: string,
    damagedBy: string,
    reason: string
  ): void {
    const scene = this.getScene(sceneId);
    if (!scene?.items) return;
    const item = scene.items.find((i) => i.id === itemId);
    if (!item) return;
    if (item.damaged) return;
    item.damaged = true;
    item.damageDetails = {
      damagedBy,
      damagedAt: new Date().toISOString(),
      reason,
    };
    this.state.lastUpdated = new Date();
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
  ): import("../engine/core/types.js").SceneCondition[] {
    return this.state.scenarioConditions[scenarioId] ?? [];
  }

  appendSceneCondition(
    scenarioId: string,
    condition: import("../engine/core/types.js").SceneCondition
  ): void {
    if (!this.state.scenarioConditions[scenarioId])
      this.state.scenarioConditions[scenarioId] = [];
    this.state.scenarioConditions[scenarioId].push(condition);
    this.state.lastUpdated = new Date();
  }

  /**
   * Remove all conditions in a scene owned by a given featureId.
   * Used by the Applier to implement the replace-wholesale pattern
   * (removeCondition({featureId}) + addCondition(...)).
   */
  removeSceneConditionsByFeatureId(
    scenarioId: string,
    featureId: string
  ): void {
    const existing = this.state.scenarioConditions[scenarioId];
    if (!existing) return;
    this.state.scenarioConditions[scenarioId] = existing.filter(
      (c) => c.featureId !== featureId
    );
    this.state.lastUpdated = new Date();
  }

  replaceSceneConditions(
    scenarioId: string,
    conditions: import("../engine/core/types.js").SceneCondition[]
  ): void {
    this.state.scenarioConditions[scenarioId] = conditions;
    this.state.lastUpdated = new Date();
  }

  // === Scoped Feature State ===

  /** Set feature state at a specific scope+key. */
  setScopedFeatureState(
    featureId: string,
    scope: FeatureStateScope,
    key: string,
    data: unknown
  ): void {
    const bucket = this.state.scopedFeatureStates[scope];
    if (!bucket[featureId]) bucket[featureId] = {};
    bucket[featureId][key] = data;
    this.state.lastUpdated = new Date();
  }

  /** Get feature state at a specific scope+key. */
  getScopedFeatureState<T>(
    featureId: string,
    scope: FeatureStateScope,
    key: string
  ): T | undefined {
    return this.state.scopedFeatureStates[scope][featureId]?.[key] as
      | T
      | undefined;
  }

  /** Get all entries for a feature in a scope. */
  getAllScopedFeatureStates<T>(
    featureId: string,
    scope: FeatureStateScope
  ): Array<{ key: string; state: T }> {
    const bucket = this.state.scopedFeatureStates[scope][featureId] ?? {};
    return Object.entries(bucket).map(([key, state]) => ({
      key,
      state: state as T,
    }));
  }

  /** Remove a single feature state entry at scope+key. */
  removeScopedFeatureState(
    featureId: string,
    scope: FeatureStateScope,
    key: string
  ): void {
    const bucket = this.state.scopedFeatureStates[scope][featureId];
    if (!bucket) return;
    delete bucket[key];
    this.state.lastUpdated = new Date();
  }

  // === Scripted Event State (Phase C) ===

  getScriptedEventState(eventId: string): ScriptedEventState | undefined {
    return this.state.scriptedEventStates[eventId];
  }

  setScriptedEventState(eventId: string, state: ScriptedEventState): void {
    this.state.scriptedEventStates[eventId] = state;
    this.state.lastUpdated = new Date();
  }

  getAllScriptedEventStates(): Record<string, ScriptedEventState> {
    return this.state.scriptedEventStates;
  }

  removeScriptedEventState(eventId: string): void {
    delete this.state.scriptedEventStates[eventId];
    this.state.lastUpdated = new Date();
  }

  // === Environment Readings (Phase D) ===

  getEnvironmentReading(locationId: string): EnvironmentReading {
    return (
      this.state.environmentReadings[locationId] ?? DEFAULT_ENVIRONMENT_READING
    );
  }

  setEnvironmentReading(locationId: string, reading: EnvironmentReading): void {
    this.state.environmentReadings[locationId] = reading;
    this.state.lastUpdated = new Date();
  }

  // === Narrow helpers ===

  getAllSceneIds(): string[] {
    return Array.from(this.state.scenes.keys());
  }

  getRegionIdForScene(sceneId: string): string | undefined {
    return this.state.scenes.get(sceneId)?.parentLocationId;
  }

  getGameDateTime(): string {
    return this.state.gameDateTime;
  }

  setGameDateTime(value: string): void {
    this.state.gameDateTime = value;
    this.state.lastUpdated = new Date();
  }

  getNpcProfile(characterId: string): DynamicNPCProfile | undefined {
    return this.state.npcCharacters.find((n) => n.id === characterId);
  }

  /**
   * Insert/upsert an NPC profile. Used by Applier tests + bootstrap paths.
   */
  registerNpcProfile(profile: DynamicNPCProfile): void {
    const existingIndex = this.state.npcCharacters.findIndex(
      (n) => n.id === profile.id
    );
    if (existingIndex >= 0) {
      this.state.npcCharacters[existingIndex] = profile;
    } else {
      this.state.npcCharacters.push(profile);
    }
    this.state.lastUpdated = new Date();
  }

  /**
   * Directly write a character status field to an absolute value.
   * Thin wrapper used by the Applier after summing deltas + clamping.
   */
  setCharacterField(
    characterId: string,
    field: "hp" | "san" | "fatigue",
    value: number
  ): void {
    const profile = this.state.npcCharacters.find((n) => n.id === characterId);
    if (!profile) return;
    profile.status[field] = value;
    // Keep legacy npcStats mirror in sync for hp/san so planning helpers
    // that read `npcStats` continue to see fresh values.
    if (field === "hp" || field === "san") {
      const stats = this.state.npcStats[characterId];
      if (stats) {
        stats[field] = value;
      }
    }
    this.state.lastUpdated = new Date();
  }

  /**
   * Mark a character as dead. Adds a structured "dead" condition.
   * Does NOT force hp to 0 — caller (Applier) has already clamped hp.
   */
  markCharacterDead(characterId: string): void {
    const profile = this.state.npcCharacters.find((n) => n.id === characterId);
    if (!profile) return;
    const already = profile.status.conditions.some(
      (c) => c.description === "dead"
    );
    if (already) return;
    profile.status.conditions.push({
      id: (globalThis.crypto?.randomUUID?.() ??
        `${Date.now()}-${Math.random()}`) as string,
      description: "dead",
    });
    this.state.lastUpdated = new Date();
  }

  /**
   * Push a character-level condition onto profile.status.conditions.
   */
  addCharacterCondition(
    characterId: string,
    condition: import("../engine/core/types.js").CharacterCondition
  ): void {
    const profile = this.state.npcCharacters.find((n) => n.id === characterId);
    if (!profile) return;
    profile.status.conditions.push(condition);
    this.state.lastUpdated = new Date();
  }

  /**
   * Remove a character-level condition by its id.
   */
  removeCharacterCondition(characterId: string, conditionId: string): void {
    const profile = this.state.npcCharacters.find((n) => n.id === characterId);
    if (!profile) return;
    profile.status.conditions = profile.status.conditions.filter(
      (c) => c.id !== conditionId
    );
    this.state.lastUpdated = new Date();
  }

  /**
   * Ensure a scene exists in state.scenes. Creates a minimal DynamicScene
   * with empty items/conditions/connections if not already present.
   * Used by the Applier + tests to seed scene state.
   */
  ensureScene(sceneId: string): void {
    if (this.state.scenes.has(sceneId)) return;
    this.state.scenes.set(sceneId, {
      id: sceneId,
      name: sceneId,
      description: "",
      parentLocationId: "",
      items: [],
      conditions: [],
      connections: [],
    });
    this.state.lastUpdated = new Date();
  }

  /**
   * Ensure a connection id is known to the refcount-based block store.
   * Current impl is a no-op: setConnectionBlocked/isConnectionBlocked
   * (single-id variants) already handle missing keys safely.
   */
  ensureConnection(_connectionId: string): void {
    // no-op placeholder; single-id block store tolerates missing keys
  }

  // === Blocked Connections ===

  isConnectionBlocked(fromId: string, toId: string): boolean;
  isConnectionBlocked(connectionId: string): boolean;
  isConnectionBlocked(fromId: string, toId?: string): boolean {
    if (toId === undefined) {
      // Single-id form: consult the refcount-based store
      return this.blockedConnectionsById.get(fromId) === true;
    }
    return this.getConnectionBlockReason(fromId, toId) !== undefined;
  }

  getConnectionBlockReason(fromId: string, toId: string): string | undefined {
    const fromRef = resolveBlockedConnectionNodeRef(fromId, this.state);
    const toRef = resolveBlockedConnectionNodeRef(toId, this.state);
    if (!fromRef || !toRef) return undefined;
    return getBlockedConnectionReason(
      this.state.blockedConnections,
      fromRef,
      toRef
    );
  }

  setConnectionBlocked(
    fromId: string,
    toId: string,
    blocked: boolean,
    reason: string
  ): void;
  setConnectionBlocked(connectionId: string, blocked: boolean): void;
  setConnectionBlocked(
    arg1: string,
    arg2: string | boolean,
    arg3?: boolean,
    arg4?: string
  ): void {
    // Single-id form: (connectionId, blocked)
    if (typeof arg2 === "boolean") {
      const connectionId = arg1;
      const blocked = arg2;
      if (blocked) {
        this.blockedConnectionsById.set(connectionId, true);
      } else {
        this.blockedConnectionsById.delete(connectionId);
      }
      this.state.lastUpdated = new Date();
      return;
    }

    // Two-id form: (fromId, toId, blocked, reason) — legacy pathfinding store
    const fromId = arg1;
    const toId = arg2;
    const blocked = arg3 ?? false;
    const reason = arg4 ?? "";
    const fromRef = resolveBlockedConnectionNodeRef(fromId, this.state);
    const toRef = resolveBlockedConnectionNodeRef(toId, this.state);
    if (!fromRef || !toRef) {
      throw new Error(
        `Cannot update blocked connection for unknown endpoints: ${fromId}, ${toId}`
      );
    }

    const key = makeBlockedConnectionKey(fromRef, toRef);
    if (blocked) {
      this.state.blockedConnections.set(key, reason);
    } else {
      this.state.blockedConnections.delete(key);
    }
    this.state.lastUpdated = new Date();
  }

  setConnectionHidden(
    sceneId: string,
    targetId: string,
    hidden: boolean
  ): void {
    const scene = this.state.scenes.get(sceneId);
    if (!scene) return;
    const conn = scene.connections.find((c) => c.targetId === targetId);
    if (conn) {
      conn.hidden = hidden;
      this.state.lastUpdated = new Date();
    }
  }

  // === Topology ===

  getJunction(junctionId: string): JunctionNode | null {
    return this.state.topology?.junctions.get(junctionId) ?? null;
  }

  getRoad(roadId: string): RoadNode | null {
    return this.state.topology?.roads.get(roadId) ?? null;
  }

  getTopology(): TownTopology {
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

  private syncNpcStatusFromStats(npcId: string): void {
    const npc = this.state.npcCharacters.find(
      (candidate) => candidate.id === npcId
    );
    const stats = this.state.npcStats[npcId];
    if (!npc || !stats) return;
    npc.status.hp = stats.hp;
    npc.status.san = stats.san;
  }
}
