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
import { normalizeSpot } from "./characterSpot.js";
import {
  type ConnectionEdge,
  type ConnectionRegistry,
  buildConnectionRegistry,
  resolveConnectionEdge,
} from "./connectionRegistry.js";
import { makeDateTime } from "./gameClock.js";
import type {
  CharacterPosition,
  RoadNode,
  TownTopology,
  VehicleState,
} from "./topologyTypes.js";
import { buildTopology } from "./topologyTypes.js";
import type { ModuleSetup } from "./types.js";
import type {
  DynamicNPCProfile,
  DynamicScene,
  Item,
  SceneConnection,
  TransportEdge,
} from "./types.js";

/**
 * Dynamic Game State — runtime data for the simulation engine.
 * All fields here are actively read/written by tick processor, handlers, or features.
 */
export interface DynamicGameState {
  // === Scenes & Topology Nodes ===
  // Top-level scenes (no parentLocationId) are the geography nodes the road
  // network runs between; there is no separate junction type.
  scenes: Map<string, DynamicScene>;
  roads: Map<string, RoadNode>;

  // === Time ===
  gameDateTime: string; // In-game ISO datetime, YYYY-MM-DDTHH:MM:SS

  // === Characters ===
  npcCharacters: DynamicNPCProfile[];

  // === Module Configuration ===
  moduleSetup: ModuleSetup | null;

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

  // === World Runtime State ===
  npcInventories: Record<string, Item[]>; // npcId -> items
  /** What each character holds about another. `knownAs` is what they CALL
   *  them — present only once they have actually learned it, which is what
   *  makes someone "known" rather than a face they have an opinion about. */
  npcRelationshipGraph: Record<
    string,
    Record<string, { score: number; note: string; knownAs?: string }>
  >;
  blockedConnections: Map<string, string>; // "scene:id::road:id" typed canonical edge key -> reason
  /** Vehicles: movable perception boundaries (see VehicleState). */
  vehicles: VehicleState[];
  transportEdges: TransportEdge[];

  // === Road Topology (required) ===
  topology: TownTopology;

  // === Character Positions (NPC) ===
  characterPositions: Record<string, CharacterPosition>;
  /**
   * characterId → where they are WITHIN their location, as prose. Absent =
   * nothing worth saying, which is the normal case. Narrative only: nothing
   * is computed from it and nobody is stopped by it.
   */
  characterSpots: Record<string, string>;
}

/**
 * Create initial DynamicGameState with provided runtime data.
 * Character and gameDateTime should be loaded from DB or module setup.
 */
export const initialDynamicGameState = (
  gameDateTime = "1900-01-01T08:00:00"
): DynamicGameState => ({
  scenes: new Map(),
  roads: new Map(),
  gameDateTime,
  npcCharacters: [],
  moduleSetup: null,
  scopedFeatureStates: { scene: {}, region: {}, character: {}, global: {} },
  scriptedEventStates: {},
  environmentReadings: {},
  npcInventories: {},
  npcRelationshipGraph: {},
  blockedConnections: new Map(),
  vehicles: [],
  transportEdges: [],
  topology: null as unknown as TownTopology,
  characterPositions: {},
  characterSpots: {},
});

/**
 * Dynamic Game State Manager
 * Provides methods to manage DynamicWorld-specific state
 */
export class DynamicGameStateManager {
  private state: DynamicGameState;

  /**
   * Lazily built id-addressed index over every authored connection.
   * Topology never gains or loses connections at runtime (only flags like
   * `hidden`/blocked flip), so building it once is enough. Derivable from
   * state — never serialized.
   */
  private connectionRegistry: ConnectionRegistry | null = null;

  constructor(state?: DynamicGameState) {
    this.state = state ?? initialDynamicGameState();
  }

  /**
   * Get current state (read-only)
   */
  getState(): Readonly<DynamicGameState> {
    return this.state;
  }

  isNpcAlive(npcId: string): boolean {
    const npc = this.state.npcCharacters.find((n) => n.id === npcId);
    return (npc?.status.hp ?? 0) > 0;
  }

  // === Scene Helpers ===

  /**
   * Get a scene or road by ID. Searches scenes first, then roads.
   */
  getScene(sceneId: string): DynamicScene | null {
    return (
      this.state.scenes.get(sceneId) ??
      (this.state.roads.get(sceneId) as unknown as DynamicScene) ??
      null
    );
  }

  /**
   * Insert or replace a scene in the scenes map
   */
  updateScene(sceneId: string, scene: DynamicScene): void {
    this.state.scenes.set(sceneId, scene);
  }

  /**
   * Load world data into state.
   * Only loads fields that the simulation engine uses.
   */
  loadWorldData(data: {
    moduleSetup?: ModuleSetup;
  }): void {
    if (data.moduleSetup) {
      this.state.moduleSetup = data.moduleSetup;
    }
  }

  // === Serialization ===

  /**
   * Serialize state for storage (converts Maps to Objects, Dates to ISO strings)
   */
  serialize(): any {
    // Convert scenes/roads Maps to plain objects
    const scenesObj: Record<string, DynamicScene> = {};
    this.state.scenes.forEach((scene, id) => {
      scenesObj[id] = scene;
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

    return {
      ...this.state,
      scenes: scenesObj,
      roads: roadsObj,
      blockedConnections: blockedConnsObj,
      // Topology is fully derivable from scenes + roads; rebuilt on load.
      topology: null,
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

    // Reconstruct topology from scenes/roads (always derivable)
    let topology: TownTopology | null = null;
    if (scenes.size > 0 || roads.size > 0) {
      topology = buildTopology(scenes, roads);
    }

    return {
      moduleSetup: data.moduleSetup ?? null,
      gameDateTime:
        typeof data.gameDateTime === "string"
          ? data.gameDateTime
          : makeDateTime(data.moduleSetup?.startDate ?? "1900-01-01", "08:00"),
      npcCharacters: (data.npcCharacters ?? []).map(
        (npc: DynamicNPCProfile): DynamicNPCProfile => {
          // One-way migration for persisted rows written while hp/san lived in
          // the now-retired npcStats mirror. Runtime state keeps only status.
          const legacyStats = data.npcStats?.[npc.id];
          if (!legacyStats || typeof legacyStats !== "object") return npc;
          return {
            ...npc,
            status: {
              ...npc.status,
              ...(Number.isFinite(legacyStats.hp)
                ? { hp: legacyStats.hp }
                : {}),
              ...(Number.isFinite(legacyStats.san)
                ? { san: legacyStats.san }
                : {}),
            },
          };
        }
      ),
      scenes,
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
      npcInventories: data.npcInventories ?? {},
      npcRelationshipGraph: data.npcRelationshipGraph ?? {},
      vehicles: data.vehicles ?? [],
      transportEdges: data.transportEdges ?? [],
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
      // Absent on every runtime row written before spots existed; an empty
      // map is exactly right for those — nobody was standing anywhere in
      // particular. No legacy conversion: there is no old field to migrate.
      characterSpots:
        data.characterSpots && typeof data.characterSpots === "object"
          ? (data.characterSpots as Record<string, string>)
          : {},
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
  }

  /**
   * Set the in-game clock directly.
   * Used by simulation bootstrap paths such as real-time sync alignment.
   */
  setGameClock(params: { gameDateTime: string }): void {
    this.state.gameDateTime = params.gameDateTime;
  }

  getNpcInventory(npcId: string): Item[] {
    return this.state.npcInventories[npcId] ?? [];
  }

  /** Update an item's description in place. Searches all scenes then all NPC
   *  inventories for the matching id (item ids are globally unique). Name is
   *  the item's stable identity and is NOT changed by this method — true
   *  identity changes go through item.destroy + item.create.
   *  Returns true on success, false (with warning) when no item matches. */
  /** Change what an item is LIKE. Its description is its state, so `append`
   *  adds a sentence rather than replacing everything the object was — damage
   *  used to take the replacing path and overwrite the whole description with
   *  "damaged by fire: ...". The lighting pair is here too because it is the
   *  one part of an item a deterministic subsystem reads: a lamp that is
   *  smashed has to stop lighting the room in the same breath that says so. */
  setItem(
    itemId: string,
    patch: {
      description?: string;
      appendDescription?: string;
      hidden?: boolean;
      isLightSource?: boolean;
      lightLevel?: number;
    }
  ): boolean {
    const target = this.findItemById(itemId);
    if (!target) {
      console.warn(`[DGSM] setItem: item id="${itemId}" not found`);
      return false;
    }
    if (patch.description !== undefined) {
      target.description = patch.description;
    } else if (patch.appendDescription?.trim()) {
      const existing = target.description?.trim();
      target.description = existing
        ? `${existing} ${patch.appendDescription.trim()}`
        : patch.appendDescription.trim();
    }
    if (patch.hidden !== undefined) target.hidden = patch.hidden;
    if (patch.isLightSource !== undefined) {
      target.isLightSource = patch.isLightSource;
    }
    if (patch.lightLevel !== undefined) target.lightLevel = patch.lightLevel;
    return true;
  }

  /** Internal: resolve an item-holding container.
   *  `"scene:<id>"` resolves scene → road (same fallthrough as
   *  `getScene` — both kinds of place hold items); anything else is
   *  treated as an npcId. `createIfMissing` applies to the write direction:
   *  an NPC inventory is created on demand, a missing place never is. */
  private resolveItemContainer(
    location: string,
    createIfMissing = false
  ): Item[] | undefined {
    if (location.startsWith("scene:")) {
      const placeId = location.slice("scene:".length);
      const place =
        this.state.scenes.get(placeId) ?? this.state.roads.get(placeId);
      if (!place) return undefined;
      // Module JSON may omit the field on places that start with none.
      if (!place.items) place.items = [];
      return place.items;
    }
    // Everything past here is character territory. Two misspellings used to
    // fall through and silently mint a PHANTOM inventory (items vanish into
    // a container nothing ever reads): a bare place id ("SCN_x" — meant
    // "scene:SCN_x"), and a wrong prefix ("npc:x" — characters are bare).
    // Refuse both loudly instead.
    if (location.includes(":")) {
      console.warn(
        `[DGSM] holder "${location}": unknown prefix — places are "scene:<placeId>", characters are bare ids`
      );
      return undefined;
    }
    if (this.state.scenes.has(location) || this.state.roads.has(location)) {
      console.warn(
        `[DGSM] holder "${location}" names a place — did you mean "scene:${location}"?`
      );
      return undefined;
    }
    const inventory = this.state.npcInventories[location];
    if (inventory) return inventory;
    if (!createIfMissing) return undefined;
    this.state.npcInventories[location] = [];
    return this.state.npcInventories[location];
  }

  /** Internal: every item container in the world, in stable order —
   *  scenes, roads, then NPC inventories. `holder` is
   *  `"scene:<placeId>"` for places and the bare npcId for inventories. */
  private *allItemContainers(): Iterable<{ holder: string; items: Item[] }> {
    for (const scene of this.state.scenes.values()) {
      yield { holder: `scene:${scene.id}`, items: scene.items ?? [] };
    }
    for (const road of this.state.roads.values()) {
      yield { holder: `scene:${road.id}`, items: road.items ?? [] };
    }
    for (const [npcId, items] of Object.entries(this.state.npcInventories)) {
      yield { holder: npcId, items };
    }
  }

  /** Create a new Item at the given location.
   *  `location = "scene:<placeId>"` puts it in that scene/junction/road's items.
   *  `location = "<npcId>"` puts it in npcInventories[npcId].
   *  `id` (optional) is used verbatim when free; on conflict it warns and
   *  falls back to the generated id. Returns the created Item, or
   *  undefined + warns when the location can't be resolved. */
  createItem(
    name: string,
    location: string,
    description?: string,
    id?: string
  ): Item | undefined {
    const container = this.resolveItemContainer(location, true);
    if (!container) {
      console.warn(`[DGSM] createItem: location "${location}" not found`);
      return undefined;
    }
    let itemId: string;
    if (id !== undefined && this.itemIdExists(id)) {
      console.warn(
        `[DGSM] createItem: id "${id}" already exists — falling back to a generated id`
      );
      itemId = this.makeItemId(name);
    } else {
      itemId = id ?? this.makeItemId(name);
    }
    const item: Item = { id: itemId, name };
    if (description?.trim()) item.description = description;
    container.push(item);
    return item;
  }

  /** Move an item between locations. `from` and `to` accept the same
   *  `"scene:<id>"` / `"<npcId>"` syntax as createItem. The moved Item keeps
   *  its object identity. Returns true on success. */
  moveItem(itemId: string, from: string, to: string): boolean {
    // Resolve the destination BEFORE pulling the item out, so a bad `to`
    // cannot vanish the item.
    const destination = this.resolveItemContainer(to, true);
    if (!destination) {
      console.warn(`[DGSM] moveItem: destination "${to}" not found`);
      return false;
    }
    const removed = this.removeItemFrom(itemId, from);
    if (!removed) {
      console.warn(`[DGSM] moveItem: item id="${itemId}" not found at ${from}`);
      return false;
    }
    destination.push(removed);
    return true;
  }

  /** Destroy an item, removing it from the world wherever it is held.
   *  Returns true on removal. */
  destroyItem(itemId: string): boolean {
    for (const { items } of this.allItemContainers()) {
      const idx = items.findIndex((i) => i.id === itemId);
      if (idx !== -1) {
        items.splice(idx, 1);
        return true;
      }
    }
    console.warn(`[DGSM] destroyItem: item id="${itemId}" not found`);
    return false;
  }

  /** Internal: pull an item out of a single location. */
  private removeItemFrom(itemId: string, location: string): Item | undefined {
    const container = this.resolveItemContainer(location);
    if (!container) return undefined;
    const idx = container.findIndex((i) => i.id === itemId);
    if (idx === -1) return undefined;
    return container.splice(idx, 1)[0];
  }

  /** Internal: deterministic item-id generator from a display name. */
  private makeItemId(name: string): string {
    const base =
      "item_" +
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 32);
    if (!this.itemIdExists(base)) return base;
    // Disambiguate via numeric suffix.
    let i = 2;
    while (this.itemIdExists(`${base}_${i}`)) i += 1;
    return `${base}_${i}`;
  }

  private itemIdExists(itemId: string): boolean {
    return this.getItemHolder(itemId) !== undefined;
  }

  /** Does this id name a real item anywhere in the world — on the ground of
   *  any scene/junction/road, or in anyone's hands? Hidden items count. */
  hasItem(itemId: string): boolean {
    return this.getItemHolder(itemId) !== undefined;
  }

  /** Where an item is held: `"scene:<placeId>"` or the holder's npcId.
   *  Undefined when no container holds the id. */
  getItemHolder(itemId: string): string | undefined {
    for (const { holder, items } of this.allItemContainers()) {
      if (items.some((i) => i.id === itemId)) return holder;
    }
    return undefined;
  }

  /** Internal: find first Item matching id across every container. */
  private findItemById(itemId: string): Item | undefined {
    for (const { items } of this.allItemContainers()) {
      const found = items.find((i) => i.id === itemId);
      if (found) return found;
    }
    return undefined;
  }

  getRelationship(
    npcId: string,
    targetId: string
  ): { score: number; note: string; knownAs?: string } | undefined {
    return this.state.npcRelationshipGraph[npcId]?.[targetId];
  }

  updateRelationship(
    npcId: string,
    targetId: string,
    scoreDelta: number,
    note: string,
    /** What the holder now calls this person. Sticky: learning a name is not
     *  undone by later revising the opinion. */
    knownAs?: string
  ): void {
    if (!this.state.npcRelationshipGraph[npcId])
      this.state.npcRelationshipGraph[npcId] = {};
    const current: { score: number; note: string; knownAs?: string } = this
      .state.npcRelationshipGraph[npcId][targetId] ?? {
      score: 0,
      note: "",
    };
    const newScore = Math.max(-100, Math.min(100, current.score + scoreDelta));
    this.state.npcRelationshipGraph[npcId][targetId] = {
      score: newScore,
      note,
      ...((knownAs ?? current.knownAs)
        ? { knownAs: knownAs ?? current.knownAs }
        : {}),
    };
    // Deliberately one-directional. This used to mirror the write onto the
    // target's row with the same score and the SAME NOTE, which fabricated one
    // character's opinion out of another's: "Nancy grew wary of Philip" became
    // Philip's stated view of Nancy, in her words. A relationship is a private
    // reading, and B forms no view of A merely because A formed one of B.
  }

  /**
   * Conditions live on the place itself — `conditions` on the scene, junction
   * or road object, reached through `getScene`, which resolves all three
   * kinds. One home, mutated in place, the way `scene.items` has always
   * worked.
   *
   * They used to be mirrored into a `scenarioConditions` side-table seeded
   * from the module at load, with the perception path merging both lists.
   * One fact, two homes, and only one of them known to these mutators: a
   * `scene.removeCondition` emptied the side-table while the copy on the
   * place survived the merge. Observed live — a door the Engine had already
   * smashed open went on being rendered as nailed shut for the rest of the
   * run, and the character kept re-attacking it. The merge also deduped by
   * object identity, which held only until something serialized the state,
   * after which every module-authored condition rendered twice.
   */
  getSceneConditions(
    scenarioId: string
  ): import("../engine/core/types.js").SceneCondition[] {
    return this.getScene(scenarioId)?.conditions ?? [];
  }

  appendSceneCondition(
    scenarioId: string,
    condition: import("../engine/core/types.js").SceneCondition
  ): void {
    const place = this.getScene(scenarioId);
    if (!place) {
      console.warn(
        `[DynamicGameState] appendSceneCondition: no scene/road "${scenarioId}" — condition dropped`
      );
      return;
    }
    // Module JSON omits the field entirely on places that start with none.
    if (!place.conditions) place.conditions = [];
    let toAppend = condition;
    if (toAppend.id === undefined) {
      // Single choke point for condition ids: subsystems (fire/weather/sun)
      // omit them, so mint `cond_<featureId ?? "engine">_<n>` here, unique
      // within the place.
      const prefix = `cond_${toAppend.featureId ?? "engine"}_`;
      let n =
        place.conditions.filter((c) => c.id?.startsWith(prefix)).length + 1;
      while (place.conditions.some((c) => c.id === `${prefix}${n}`)) n += 1;
      toAppend = { ...condition, id: `${prefix}${n}` };
    } else if (place.conditions.some((c) => c.id === toAppend.id)) {
      console.warn(
        `[DynamicGameState] appendSceneCondition: duplicate condition id "${toAppend.id}" at "${scenarioId}" — condition dropped`
      );
      return;
    }
    place.conditions.push(toAppend);
  }

  /**
   * Remove a single condition by its id. Returns true when one was removed.
   */
  removeSceneConditionById(placeId: string, conditionId: string): boolean {
    const place = this.getScene(placeId);
    if (!place?.conditions) return false;
    const idx = place.conditions.findIndex((c) => c.id === conditionId);
    if (idx === -1) return false;
    place.conditions.splice(idx, 1);
    return true;
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
    const place = this.getScene(scenarioId);
    if (!place?.conditions) return;
    place.conditions = place.conditions.filter(
      (c) => c.featureId !== featureId
    );
  }

  /**
   * Rewrite a place's prose wholesale (scene or road — the same
   * fallthrough `getScene` uses). Returns false + warn when the id names no
   * place.
   */
  setPlaceDescription(placeId: string, description: string): boolean {
    const place = this.getScene(placeId);
    if (!place) {
      console.warn(
        `[DynamicGameState] setPlaceDescription: no scene/road "${placeId}" — ignored`
      );
      return false;
    }
    place.description = description;
    return true;
  }

  replaceSceneConditions(
    scenarioId: string,
    conditions: import("../engine/core/types.js").SceneCondition[]
  ): void {
    const place = this.getScene(scenarioId);
    if (!place) {
      console.warn(
        `[DynamicGameState] replaceSceneConditions: no scene/road "${scenarioId}" — ignored`
      );
      return;
    }
    place.conditions = conditions;
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
  }

  // === Scripted Event State (Phase C) ===

  getScriptedEventState(eventId: string): ScriptedEventState | undefined {
    return this.state.scriptedEventStates[eventId];
  }

  setScriptedEventState(eventId: string, state: ScriptedEventState): void {
    this.state.scriptedEventStates[eventId] = state;
  }

  // === Environment Readings (Phase D) ===

  getEnvironmentReading(locationId: string): EnvironmentReading {
    return (
      this.state.environmentReadings[locationId] ?? DEFAULT_ENVIRONMENT_READING
    );
  }

  setEnvironmentReading(locationId: string, reading: EnvironmentReading): void {
    this.state.environmentReadings[locationId] = reading;
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
  }

  // === Connection Registry ===

  /**
   * Id-addressed index over every authored connection (scenes,
   * roads). Built once on first use — runtime never adds or removes
   * connections, it only flips flags on them.
   */
  private getConnectionRegistry(): ConnectionRegistry {
    if (!this.connectionRegistry) {
      this.connectionRegistry = buildConnectionRegistry({
        scenes: this.state.scenes,
        roads: this.state.roads,
      });
    }
    return this.connectionRegistry;
  }

  /**
   * Resolve a connection id to its canonical symmetric edge (the same key
   * scheme `state.blockedConnections` uses). Null for unknown ids.
   */
  resolveConnectionEdgeById(connectionId: string): ConnectionEdge | null {
    return resolveConnectionEdge(connectionId, this.getConnectionRegistry());
  }

  /**
   * Reveal/hide a connection by its id, mutating the owning place's
   * SceneConnection in place (serializes with state). False + warn when the
   * id resolves to nothing.
   */
  /** Record that this character has found a concealed connection. Kept on the
   *  connection itself, beside `hidden`, so a passage carries its own answer
   *  to "who knows about me" and nothing has to be kept in step with it.
   *  Idempotent — finding the same door twice is one discovery. */
  recordConnectionDiscovery(
    characterId: string,
    connectionId: string
  ): boolean {
    const connection = this.findConnectionById(connectionId);
    if (!connection) {
      console.warn(
        `[DynamicGameState] recordConnectionDiscovery: unknown connection id "${connectionId}"`
      );
      return false;
    }
    const found = connection.discoveredBy ?? [];
    if (!found.includes(characterId)) {
      connection.discoveredBy = [...found, characterId];
    }
    return true;
  }

  hasDiscoveredConnection(characterId: string, connectionId: string): boolean {
    return (
      this.findConnectionById(connectionId)?.discoveredBy?.includes(
        characterId
      ) ?? false
    );
  }

  private findConnectionById(
    connectionId: string
  ): SceneConnection | undefined {
    const entry = this.getConnectionRegistry().get(connectionId);
    if (!entry) return undefined;
    const owner =
      entry.ownerKind === "scene"
        ? this.state.scenes.get(entry.ownerId)
        : this.state.roads.get(entry.ownerId);
    return owner?.connections?.find((c) => c.id === connectionId);
  }

  setConnectionHiddenById(connectionId: string, hidden: boolean): boolean {
    const entry = this.getConnectionRegistry().get(connectionId);
    const owner = entry
      ? entry.ownerKind === "scene"
        ? this.state.scenes.get(entry.ownerId)
        : this.state.roads.get(entry.ownerId)
      : undefined;
    const connection = owner?.connections?.find((c) => c.id === connectionId);
    if (!connection) {
      console.warn(
        `[DynamicGameState] setConnectionHiddenById: unknown connection id "${connectionId}"`
      );
      return false;
    }
    connection.hidden = hidden;
    return true;
  }

  // === Blocked Connections ===

  isConnectionBlocked(fromId: string, toId: string): boolean {
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
  ): void {
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
  }

  // === Topology ===

  getRoad(roadId: string): RoadNode | null {
    return this.state.topology?.roads.get(roadId) ?? null;
  }

  getTopology(): TownTopology {
    return this.state.topology;
  }

  // ── Vehicles ──────────────────────────────────────────────────

  getVehicles(): VehicleState[] {
    return this.state.vehicles;
  }

  getVehicle(vehicleId: string): VehicleState | null {
    return this.state.vehicles.find((v) => v.id === vehicleId) ?? null;
  }

  /** The vehicle whose interior scene this is, if any. */
  getVehicleByInterior(sceneId: string): VehicleState | null {
    return (
      this.state.vehicles.find((v) => v.interiorSceneId === sceneId) ?? null
    );
  }

  setVehiclePosition(vehicleId: string, position: CharacterPosition): void {
    const vehicle = this.getVehicle(vehicleId);
    if (!vehicle) return;
    vehicle.position = position;
  }

  setTopology(topology: TownTopology): void {
    this.state.topology = topology;
  }

  // === Character Position ===

  getCharacterPosition(characterId: string): CharacterPosition | null {
    return this.state.characterPositions[characterId] ?? null;
  }

  setCharacterPosition(characterId: string, position: CharacterPosition): void {
    // A spot describes a place inside ONE location, so it cannot survive
    // leaving it: without this, someone who walks to the next room is still
    // "at the workbench, back to the door" — in a room that has no workbench.
    // Cleared here rather than in the movement runtime because the runtime is
    // not the only writer: the Engine's `position` delta repositions people
    // too, and one of the two paths would always be the one that forgot.
    //
    // Walking ALONG a road keeps roadId constant, so a spot set on a road
    // survives the leg; scene->road and road->scene both clear. A reposition
    // into the location you are already in keeps the spot — that delta said
    // nothing about where in the room.
    const previous = this.state.characterPositions[characterId];
    if (
      previous &&
      this.resolveLocationId(previous) !== this.resolveLocationId(position)
    ) {
      delete this.state.characterSpots[characterId];
    }
    this.state.characterPositions[characterId] = position;
  }

  // === Character Spot (where inside the location) ===

  /**
   * Where they are WITHIN their location, as prose. `null` = nothing worth
   * saying.
   */
  getCharacterSpot(characterId: string): string | null {
    return this.state.characterSpots[characterId] ?? null;
  }

  /**
   * Empty (or whitespace-only, or bracket-only) clears it. Normalized here so
   * every reader — three prompts and one Engine snapshot — sees the same
   * bounded one-line string.
   */
  setCharacterSpot(characterId: string, spot: string): void {
    const normalized = normalizeSpot(spot);
    if (normalized) {
      this.state.characterSpots[characterId] = normalized;
    } else {
      delete this.state.characterSpots[characterId];
    }
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
   * Returns the scene/road ID the character is at.
   */
  resolveLocationId(position: CharacterPosition): string {
    switch (position.type) {
      case "road":
        return position.roadId;
      case "scene":
        return position.sceneId;
    }
  }
}
