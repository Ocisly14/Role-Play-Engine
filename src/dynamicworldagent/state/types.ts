/**
 * Type definitions for DynamicWorld runtime/module data.
 */

import type {
  ActionLogEntry,
  CharacterAttributes,
  CharacterStatus,
  InventoryItem,
  NPCKnowledge,
  NPCRelationship,
} from "../../shared/agents/models/gameTypes.js";
import type {
  SceneCondition,
} from "../dynamicBasicAgent/npcPlanning/types.js";
import type { ItemContexts } from "./sceneItemContextPayload.js";

/**
 * DynamicWorld Character Profile - Independent type definition for DynamicWorld system
 * Based on CharacterProfile but without currentLocation field
 * Location is determined from actionLog instead of currentLocation field
 */
export interface DynamicCharacterProfile {
  id: string;
  name: string;
  attributes: CharacterAttributes;
  status: CharacterStatus;
  inventory: InventoryItem[];
  skills: Record<string, number>;
  notes?: string;
  actionLog?: ActionLogEntry[];
  // Additional character information (mainly for player characters)
  occupation?: string;
  age?: number;
  gender?: string;
  appearance?: string;
  personality?: string;
  backstory?: string;
  residence?: string;
  birthplace?: string;
  era?: string;
  ideology?: string;
  significantPeople?: string;
  gear?: string;
  weapons?: Array<{
    name: string;
    skill: string;
    damage: string;
    range: string;
    attacks: string;
    ammo: string;
  }>;
  derivedAttributes?: {
    MOV?: number;
    BUILD?: string;
    DB?: string;
    ARMOR?: string;
  };
  // Note: currentLocation is intentionally omitted - location is tracked via actionLog
}

/**
 * DynamicWorld NPC Profile - Extended character profile with NPC-specific data
 * Location is determined from actionLog instead of currentLocation field
 */
export interface DynamicNPCProfile extends DynamicCharacterProfile {
  // NPC-specific fields (override some optional fields from CharacterProfile)
  background?: string; // NPC-specific background (may differ from backstory)
  goals?: string[];
  secrets?: string[];
  knowledge: NPCKnowledge[];
  relationships: NPCRelationship[];
  isNPC: true; // flag to distinguish from player characters

  // DynamicWorld specific fields
  instantiatedFrom?: string; // Knowledge holder ID that this NPC represents
  inheritsKnowledge?: string[]; // Truth event IDs from knowledge holder
  residence?: string; // macroLocationId -- derived from ScenarioOutline.residents
  isPlayerInjected?: boolean; // true = player-created character in simulation mode
}

export interface DynamicScene {
  id: string;
  name: string;
  description: string;
  parentLocationId: string;
  items: Item[];
  itemContexts?: ItemContexts;
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
}

export interface Item {
  id: string;
  name: string;
  description?: string;
  type?: "weapon" | "consumable" | "tool" | "lighting" | "container" | "key" | "document" | "other";
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

/**
 * Scenario Outline - Macro location container for sub-scenes
 * Pure container: no connections, no clues. Grouping framework for DynamicScene instances.
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
 * Carries travel time for tick processor pathfinding
 */
export interface TransportEdge {
  fromLocationId: string;
  toLocationId: string;
  streetSceneId: string;
  travelTimeMinutes: number;
}

export interface ModuleSetup {
  weatherPresets?: Array<{
    regionId: string;
    weatherType: "clear" | "rain" | "fog" | "storm" | "snow" | "extreme_heat" | "extreme_cold";
    intensity: number;
  }>;
}

/**
 * Structured Story Elements - Extracted from user creative prompt
 * Used as structured input for all downstream world generation agents
 */
export interface StructuredStoryElements {
  /** Time period / era, e.g. "1920s Prohibition-era New England" */
  era: string;
  /** World rules: magic/science systems, political structure, civilizations, religion */
  worldbuilding: string;
  /** Story genres, e.g. ["horror", "mystery", "adventure"] */
  genre: string[];
  /** Overall tone / atmosphere, e.g. "dark, oppressive, paranoid" */
  tone: string;
  /** Core thematic idea, e.g. "humanity's insignificance before cosmic entities" */
  theme: string;
  /** All elements synthesized into a precise English creative brief */
  refinedPrompt: string;
}

/**
 * Progress Callback - For reporting generation progress
 */
export type ProgressCallback = (message: string) => void;
