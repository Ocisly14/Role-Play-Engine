/**
 * Type definitions for DynamicWorld runtime/module data.
 * All types used by DynamicGameState, TickProcessor, and engine components.
 */

import type {
  CharacterCondition,
  SceneCondition,
} from "../engine/core/types.js";

// ─── Character-related types ───────────────────────────────────────

export type Difficulty = "regular" | "hard" | "extreme";

export interface CharacterAttributes {
  STR: number;
  CON: number;
  DEX: number;
  APP: number;
  POW: number;
  SIZ: number;
  INT: number;
  EDU: number;
  [key: string]: number;
}

export interface CharacterStatus {
  hp: number;
  maxHp: number;
  san: number;
  maxSan: number;
  fatigue: number;
  maxFatigue: number;
  luck: number;
  mp?: number;
  conditions: CharacterCondition[];
  notes?: string;
  damageBonus?: string;
  build?: number;
  mov?: number;
  [key: string]: number | CharacterCondition[] | string | undefined;
}

export interface InventoryItem {
  id: string;
  name: string;
  quantity?: number;
  properties?: Record<string, any>;
}

/**
 * Memory categories a module may author for an NPC at session start.
 *
 * Geographic knowledge is authored here as `map` memories like everything
 * else — nothing is generated at bootstrap. Relationships and long-term
 * intentions have dedicated profile fields, but remain accepted here for an
 * explicitly authored memory.
 */
export type NpcProfileMemoryType =
  | "general"
  | "plan"
  | "secret"
  | "relationship"
  | "map"
  | "long_term_intent";

/** Memory entry defined in NPC profile JSON, bootstrapped into NpcMemory at session init. */
export interface NpcProfileMemoryEntry {
  type: NpcProfileMemoryType;
  content: string;
  metadata?: Record<string, any>;
}

/** The stances a module may author. One list, so the compile-time union and
 *  every runtime check are the same thing: this used to be a bare union with
 *  no runtime counterpart, and module JSON carrying `partner`, `acquaintance`
 *  and `colleague` sailed past a cast into the prompt — `relationship_stance_
 *  partner` has no translation, so the i18n key itself was rendered into
 *  characters' memories as if it were prose. */
export const RELATIONSHIP_TYPES = [
  "ally",
  "enemy",
  "neutral",
  "family",
  "friend",
  "rival",
  "employer",
  "employee",
  "stranger",
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

export interface NPCRelationship {
  targetId: string;
  targetName: string;
  relationshipType: RelationshipType;
  attitude: number;
  description?: string;
  history?: string;
  /** The same relationship in the holder's own voice. `description` and
   *  `history` are authored as a dossier — third person, ABOUT the character
   *  rather than by them — which reads as somebody else's notes once it sits
   *  in a memory block among sentences the character wrote themselves. When
   *  this is present it is what they remember; the other two stay as the
   *  author's reference. */
  firstPerson?: string;
}

// ─── Inventory utilities ───────────────────────────────────────────

export class InventoryUtils {
  static normalizeInventory(
    inventory: InventoryItem[] | undefined | null
  ): InventoryItem[] {
    if (!inventory || !Array.isArray(inventory)) return [];
    return inventory.filter(
      (item) =>
        item &&
        typeof item === "object" &&
        "id" in item &&
        typeof item.id === "string" &&
        "name" in item &&
        typeof item.name === "string"
    );
  }

  static toSimpleList(inventory: InventoryItem[]): string[] {
    return inventory.map((item) => {
      if (item.quantity && item.quantity > 1) {
        return `${item.name} (x${item.quantity})`;
      }
      return item.name;
    });
  }

  static findItem(
    inventory: InventoryItem[],
    itemName: string
  ): InventoryItem | undefined {
    const normalizedName = itemName.toLowerCase().trim();
    return inventory.find(
      (item) => item.name.toLowerCase().trim() === normalizedName
    );
  }

  static addItems(
    inventory: InventoryItem[],
    items: InventoryItem[]
  ): InventoryItem[] {
    const newInventory = [...inventory];
    for (const itemToAdd of items) {
      const existingIndex = newInventory.findIndex(
        (invItem) =>
          invItem.name.toLowerCase().trim() ===
          itemToAdd.name.toLowerCase().trim()
      );
      if (existingIndex >= 0) {
        const existing = newInventory[existingIndex];
        newInventory[existingIndex] = {
          ...existing,
          quantity: (existing.quantity || 1) + (itemToAdd.quantity || 1),
          properties:
            existing.properties || itemToAdd.properties
              ? { ...existing.properties, ...itemToAdd.properties }
              : undefined,
        };
      } else {
        newInventory.push({
          id: itemToAdd.id,
          name: itemToAdd.name,
          quantity: itemToAdd.quantity || 1,
          properties: itemToAdd.properties,
        });
      }
    }
    return newInventory;
  }

  static removeItems(
    inventory: InventoryItem[],
    itemsToRemove: InventoryItem[]
  ): InventoryItem[] {
    const removeNames = itemsToRemove.map((item) =>
      item.name.toLowerCase().trim()
    );
    return inventory
      .map((item) => {
        const itemName = item.name.toLowerCase().trim();
        const index = removeNames.indexOf(itemName);
        if (index >= 0) {
          const removeItem = itemsToRemove[index];
          const removeQuantity = removeItem.quantity || 1;
          const currentQuantity = item.quantity || 1;
          if (currentQuantity > removeQuantity) {
            return { ...item, quantity: currentQuantity - removeQuantity };
          } else {
            return null;
          }
        }
        return item;
      })
      .filter((item): item is InventoryItem => item !== null);
  }
}

// ─── Character profile ─────────────────────────────────────────────

/**
 * DynamicWorld NPC Profile — flat character type for the simulation engine.
 * Location is tracked via characterPositions, not on the profile.
 */
export interface CharacterLanguages {
  /** Grew up in it. Never checked: a person does not roll to speak their own
   *  language, and treating it as a skill makes every ordinary sentence a
   *  gamble. */
  native: string[];
  /** Everything else, by fluency 1-99. A tongue absent from both lists is one
   *  the character simply does not have — a rejection at the boundary, not a
   *  harder check. */
  learned?: Record<string, number>;
}

export interface DynamicNPCProfile {
  id: string;
  name: string;
  attributes: CharacterAttributes;
  status: CharacterStatus;
  inventory: InventoryItem[];
  skills: Record<string, number>;
  /** Which tongues, not how good at "languages" in general. A single
   *  fluency number cannot say that a character reads Latin haltingly and
   *  speaks their own language perfectly, and the difference is the whole
   *  of what this domain adjudicates. */
  languages?: CharacterLanguages;

  // Character descriptors (used in LLM planning prompts)
  occupation?: string;
  age?: number;
  gender?: string;
  appearance?: string;
  personality?: string;
  background?: string;
  backstory?: string;
  residence?: string;
  currentLocation?: string;
  /**
   * Seed only, read once at load exactly like `currentLocation`: where in that
   * location they start — "在工作台旁，背对着门". The live value lives in
   * `characterSpots` on the state and is never written back here, so DO NOT
   * render this field in any prompt: it goes stale the first time they move.
   */
  spot?: string;

  // Simulation data
  longTermIntent: string;
  relationships: NPCRelationship[];
  memory?: NpcProfileMemoryEntry[];

  isPlayerInjected?: boolean;
}

// ─── Scene types ───────────────────────────────────────────────────

export interface SceneConnection {
  /** Stable module-unique connection id (authoring convention: `connection.<place>.<slug>`). */
  id: string;
  targetId: string;
  name?: string;
  description?: string;
  /**
   * The passage is physically obscured — a door behind a bookshelf, a hatch
   * under a rug. It is the same for everyone: what changes when someone finds
   * it is THEIR knowledge, not the passage, and exposing it for good (the
   * bookshelf pushed aside) is what flips this to false.
   *
   * There is deliberately no per-viewer "found by" list: a character who knows
   * about a concealed passage says how to get through it, and the start
   * judgement grants that one crossing (`viaConcealedConnectionId`).
   */
  concealed?: boolean;
}

/** A place's point in the world, in meters: `x` east, `y` north, `z` its
 *  floor's elevation above sea level. Straight-line distance between two
 *  places is computed from these (perception — sound and sight do not walk
 *  the roads). */
export interface PlaceCoordinates {
  x: number;
  y: number;
  z: number;
}

export interface DynamicScene {
  id: string;
  name: string;
  /** The place itself (schema v3): size, layout, materials, fixtures, ways
   *  out — true at 3 a.m., empty, in any weather. It cites only fixtures and
   *  the places it leads to. People, light, weather and loose things are not
   *  in it; they come from live state. */
  setting: string;
  /** Absent on a module that has not placed its map, and always on a
   *  vehicle's interior (it is wherever the vehicle is). */
  coordinates?: PlaceCoordinates;
  /** The containing macro location (outline id) or node scene. Absent on a
   *  TOP-LEVEL scene — a geography node: street stretch, crossroads, yard. */
  parentLocationId?: string;
  items: Item[];
  conditions: SceneCondition[];
  connections: SceneConnection[];
  sceneImage?: SceneImage;
  indoor?: boolean;
}

export interface WeaponStats {
  skill: string;
  damage: string;
  range: string;
  attacksPerRound: number;
  ammo?: number;
  malfunction?: number;
  era?: string;
}

/**
 * An object in the world. A name and a paragraph — nothing else, because
 * nothing else was ever read: `type`, `category`, `reveals`, `discoveryMethod`,
 * `era`, `weaponStats`, `consumableStats` and `containerStats` had no consumer
 * anywhere in src/ or client/, and `damaged` was a second way of saying what
 * every damaged item's description already said in words ("残破", "部分灯管已经
 * 不亮", "被砸毁"). The Engine reads the description and judges; a field that
 * repeats the prose is a field that can disagree with it.
 *
 * `isLightSource`/`lightLevel` stay because they are NOT judged by a model:
 * `subsystem/sun.ts` sums them in code to compute a scene's illumination. A
 * lamp that stops working stops being a light source — one flag, not two.
 */
export interface Item {
  id: string;
  name: string;
  description?: string;
  /** Contributes to scene illumination — read by subsystem/sun.ts. */
  isLightSource?: boolean;
  lightLevel?: number;
  /** ROAD items only: where along the road's length the item sits
   *  (0.0 = endpointA side, 1.0 = endpointB side). Perception applies
   *  ROAD_ITEM_REACH_MINUTES around the walker; a positionless road item
   *  is ambient — visible anywhere along the length. Invalid on scenes:
   *  a scene has no interior distance. */
  position?: number;
  /** Where the thing is within its place, as a short phrase ("收银机旁",
   *  "收银机抽屉里"). Every item at a place that its setting does not cite
   *  has one; a fixture has none; an item on a person has none. */
  placement?: string;
  /** The id of the item at the same place this one sits inside, under or
   *  behind, when that item can hide it (a drawer, a closed cabinet, a
   *  suitcase, a mattress). Whether it can be seen is the container's own
   *  description — open or shut, clear or solid — judged per viewer by the
   *  noticing step. Absent = loose, in plain view. */
  container?: string;
  /** How many identical things this one item stands for — a case of 18
   *  tarts, four newspapers. Absent = one. Code reads it (taking some is a
   *  count going down, not prose being rewritten), so it is a field. */
  quantity?: number;
}

/** Where an item lands at a place: its position, and the item it sits in. */
export interface ItemWhere {
  placement?: string;
  container?: string;
}

export interface SceneImage {
  path: string;
  mimeType?: string;
  generatedAt?: string;
}

// ─── World structure types ─────────────────────────────────────────

/**
 * Transport Edge - Connects two macro locations via a street/outdoor scene
 */
export interface TransportEdge {
  fromLocationId: string;
  toLocationId: string;
  streetSceneId: string;
  travelTimeMinutes: number;
}

export interface ModuleSetup {
  title?: string;
  background?: string;
  storyOutline?: string;
  introduction?: string;
  /** In-world calendar start date in ISO 8601 (YYYY-MM-DD). */
  startDate: string;
  /** The tongue everyone in this setting grew up speaking, unless their own
   *  profile says otherwise. Without it a character has no native language at
   *  all and every ordinary sentence would want a check — so the loader gives
   *  it to any NPC whose sheet is silent. */
  commonLanguage?: string;
  initialGameTime?: string;
  tags?: string[];
  weatherPresets?: Array<{
    regionId: string;
    weatherType:
      | "clear"
      | "rain"
      | "fog"
      | "storm"
      | "snow"
      | "extreme_heat"
      | "extreme_cold";
    intensity: number;
  }>;
  /**
   * Per-feature initialization configs, populated by the module loader.
   * Each feature reads its own config via ctx.getFeatureInitConfig(featureId).
   * Loader has zero knowledge of feature internals — pure passthrough blob.
   */
  featureInit?: Record<string /* featureId */, unknown>;
  [key: string]: unknown;
}

export interface NpcInjectionPolicyTiers {
  daily_sim?: string[];
  investigator_sim?: string[];
  limited_sim?: string[];
  scene_only?: string[];
  cosmic_not_sim?: string[];
  [key: string]: string[] | undefined;
}

export interface NpcInjectionPolicy {
  moduleId?: string;
  description?: string;
  tiers?: NpcInjectionPolicyTiers;
}

/**
 * Structured Story Elements - Extracted from user creative prompt
 */
export interface StructuredStoryElements {
  era: string;
  worldbuilding: string;
  genre: string[];
  tone: string;
  theme: string;
  refinedPrompt: string;
}

export type ProgressCallback = (message: string) => void;
