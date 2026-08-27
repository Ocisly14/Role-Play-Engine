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

/** Memory entry defined in NPC profile JSON, bootstrapped into NpcMemory at session init. */
export interface NpcProfileMemoryEntry {
  type: "information" | "secret" | "event" | "belief";
  content: string;
  metadata?: Record<string, any>;
}

export interface KnownMapSeed {
  sceneIds?: string[];
  junctionIds?: string[];
  roadIds?: string[];
  scenarioOutlineIds?: string[];
}

export interface NPCRelationship {
  targetId: string;
  targetName: string;
  relationshipType:
    | "ally"
    | "enemy"
    | "neutral"
    | "family"
    | "friend"
    | "rival"
    | "employer"
    | "employee"
    | "stranger";
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

  // Simulation data
  longTermIntent: string;
  relationships: NPCRelationship[];
  memory?: NpcProfileMemoryEntry[];
  knownMapSeed?: KnownMapSeed;

  isPlayerInjected?: boolean;
}

// ─── Scene types ───────────────────────────────────────────────────

export interface SceneConnection {
  targetId: string;
  description?: string;
  /** When true, this connection is not visible to NPCs until revealed */
  hidden?: boolean;
}

export interface DynamicScene {
  id: string;
  name: string;
  description: string;
  parentLocationId: string;
  items: Item[];
  itemContexts?: Record<string, string>;
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

export interface ConsumableStats {
  uses?: number;
  effect?: string;
  duration?: number;
}

export interface ContainerStats {
  capacity?: number;
  locked?: boolean;
  lockDifficulty?: "easy" | "regular" | "hard" | "extreme";
  contents?: string[];
  storedItems?: Item[];
}

export interface Item {
  id: string;
  name: string;
  description?: string;
  type?:
    | "weapon"
    | "consumable"
    | "tool"
    | "lighting"
    | "container"
    | "key"
    | "document"
    | "other";
  category?: "evidence" | "mundane";
  reveals?: string[];
  discoveryMethod?: string;
  era?: string;
  damaged?: boolean;
  damageDetails?: {
    damagedBy: string;
    damagedAt: string;
    reason: string;
  };
  isLightSource?: boolean;
  lightLevel?: number;
  weaponStats?: WeaponStats;
  consumableStats?: ConsumableStats;
  containerStats?: ContainerStats;
}

export interface SceneImage {
  path: string;
  mimeType?: string;
  generatedAt?: string;
}

// ─── World structure types ─────────────────────────────────────────

/**
 * Scenario Outline - Macro location container for sub-scenes
 */
export interface ScenarioOutline {
  id: string;
  name: string;
  description: string;
  sourcePlaceId?: string;
  sourcePlaceName?: string;
  residents?: string[];
  subSceneCount: number;
  entrySceneId?: string;
}

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
