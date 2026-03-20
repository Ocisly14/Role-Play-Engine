/**
 * Type definitions for DynamicWorld runtime/module data.
 * All types used by DynamicGameState, TickProcessor, and engine components.
 */

import type { SceneCondition } from "../dynamicBasicAgent/npcPlanning/types.js";

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
  sanity: number;
  maxSanity: number;
  luck: number;
  mp?: number;
  conditions: string[];
  notes?: string;
  damageBonus?: string;
  build?: number;
  mov?: number;
  [key: string]: number | string[] | string | undefined;
}

export interface InventoryItem {
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
export interface DynamicNPCProfile {
  id: string;
  name: string;
  attributes: CharacterAttributes;
  status: CharacterStatus;
  inventory: InventoryItem[];
  skills: Record<string, number>;

  // Character descriptors (used in LLM planning prompts)
  occupation?: string;
  age?: number;
  gender?: string;
  appearance?: string;
  personality?: string;
  background?: string;
  backstory?: string;
  residence?: string;

  // Simulation data
  longTermIntent: string;
  relationships: NPCRelationship[];
  memory?: NpcProfileMemoryEntry[];

  isPlayerInjected?: boolean;
}

// ─── Scene types ───────────────────────────────────────────────────

export interface DynamicScene {
  id: string;
  name: string;
  description: string;
  parentLocationId: string;
  items: Item[];
  itemContexts?: Record<string, string>;
  conditions: SceneCondition[];
  connections: string[];
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
  moduleStartDate?: string;
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
