/**
 * Type definitions for World Builder agents
 * Supports truth-first world generation following instruction.md specification
 */

import type {
  ActionLogEntry,
  CharacterAttributes,
  CharacterStatus,
  InventoryItem,
  NPCClue,
  NPCRelationship,
} from "../../shared/agents/models/gameTypes.js";
import type {
  ScenarioClue,
  ScenarioCondition,
} from "../../shared/agents/models/scenarioTypes.js";

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
  clues: NPCClue[];
  relationships: NPCRelationship[];
  isNPC: true; // flag to distinguish from player characters

  // DynamicWorld specific fields
  instantiatedFrom?: string; // Knowledge holder ID that this NPC represents
  inheritsKnowledge?: string[]; // Truth event IDs from knowledge holder
  residence?: string; // macroLocationId -- derived from ScenarioOutline.residents
}

export interface DynamicScene {
  id: string;
  name: string;
  description: string;
  parentLocationId: string;
  items: Item[];
  clues: ScenarioClue[];
  conditions: ScenarioCondition[];
  connections: string[];
  sceneImage?: SceneImage;
  events: string[];
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
 * Setting types for CoC scenarios
 */
export type MacroSceneSettingType =
  | "small_town" // 小镇/乡村
  | "city" // 城市
  | "academic" // 学术/研究场所
  | "isolated" // 偏远据点/封闭环境
  | "single_structure" // 单一建筑
  | "route"; // 路径/旅程型

/**
 * Macro Scene Structure - Setting skeleton (not limited to towns)
 */
export interface MacroSceneStructure {
  moduleName: string; // CoC-style module title (e.g., "The Shadow Over Innsmouth")
  locationName: string; // Location name (e.g., "Innsmouth", "Arkham University")
  settingType?: MacroSceneSettingType; // Type of setting
  geographicLayout: {
    naturalFeatures: string[];
    artificialStructures: string[];
    keyLocations: string[];
  };
  economicCore: string;
  powerStructure: {
    formalAuthorities: Array<{ role: string; controlArea: string }>;
    informalPowers: Array<{ entity: string; influence: string }>;
  };
  informationAsymmetry: Array<{
    who: string;
    knows: string;
    hiddenFrom: string[];
  }>;
}

/**
 * Truth Event - Objective events that happened, NO names
 * Pure cause-effect chains independent of observers
 */
export interface TruthEvent {
  id: string; // e.g., "T1", "T2"
  time: string; // e.g., "2 months ago", "Day 3 evening"
  event: string; // Objective description, NO names
  cause?: string; // What caused this event
  consequence?: string; // What this event caused
  mythosInvolved: boolean; // Whether this involves mythos
}

/**
 * Knowledge Holder - Abstract entities that possess information
 * NOT NPCs - these are roles, organizations, places, or objects
 */
export interface KnowledgeHolder {
  id: string; // e.g., "KH_ROLE_1", "KH_PLACE_1"
  holderType: "ROLE" | "ORGANIZATION" | "PLACE" | "OBJECT";
  holderName: string; // e.g., "Ritual Participant", "Local Historical Society"
  knows: string[]; // Truth event IDs this holder knows
  distortion?:
    | "none"
    | "partial_amnesia"
    | "deliberate_suppression"
    | "misinterpretation";
  containsEvidence?: string[]; // For PLACE/OBJECT types
  reliability?: "high" | "medium" | "low";
}

/**
 * Red Herring - False but plausible explanations
 * Must have a physical or psychological source
 */
export interface RedHerring {
  id: string; // e.g., "RH1", "RH2"
  falseBelief: string; // The false but plausible explanation
  sourceType:
    | "MEDIA_RUMOR"
    | "MEDICAL_RECORD"
    | "OFFICIAL_REPORT"
    | "WITNESS_MISIDENTIFICATION"
    | "COINCIDENCE";
  origin: string; // Where this false belief comes from
  whyPlausible: string; // Why people would believe it
  contradictsEvents?: string[]; // Truth event IDs this contradicts
}

/**
 * Mythos Event - Historical mythos intrusion
 */
export interface MythosEvent {
  period: string;
  eventDescription: string;
  mythosEntityInvolved: string;
  immediateConsequences: string[];
  longTermResidue: string[];
  affectedNPCs: string[];
  affectedInstitutions: string[];
}

/**
 * End State Definition - Inevitable outcome if no intervention
 */
export interface EndStateDefinition {
  summary: string; // 1-3 paragraphs
  catastropheNature: string;
  victoryConditions: string[]; // What investigators must achieve to prevent the catastrophe
  pointOfNoReturn: {
    type: "time" | "condition";
    trigger: string; // e.g., "Day 8 0:00" or "All seals broken"
  };
}

/**
 * Scenario connection definition (name-based)
 */
export type ScenarioConnectionType =
  | "leads_to"
  | "concurrent"
  | "prerequisite"
  | "alternate";

export interface ScenarioConnection {
  scenarioName: string; // Human-readable scenario name
  scenarioId?: string; // Scenario ID for precise lookup
  relationshipType: ScenarioConnectionType;
  description?: string;
  blocked?: boolean; // 连接是否被物理阻挡或锁定
  blockReason?: string; // 阻挡原因说明（当 blocked 为 true 时建议提供）
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

export interface ScenarioClueSeed {
  clueText: string;
  evidenceRef?: string;
  notes?: string;
}

export interface ScenarioNpcAssignment {
  id: string;
  name: string;
  activity: string;
}

export interface ScenarioNpcAssignments {
  scenarioId: string;
  scenarioName: string;
  npcs: ScenarioNpcAssignment[];
}

export interface StartingSceneSelection {
  scenarioId: string;
  scenarioName: string;
  selectionReason?: string;
  scene: DynamicScene;
}

/**
 * NPC Basic Info (Step 1 only) - Name, occupation, age, gender, instantiatedFrom, inheritsKnowledge, background
 */
export interface NPCBasicInfoStep1 {
  name: string;
  occupation: string;
  age: number;
  gender: string;
  instantiatedFrom?: string;
  inheritsKnowledge?: string[];
  background: string;
}

/**
 * NPC Basic Info - Output of Step 1 + Step 2 of NPC Builder
 * NPCs instantiated from knowledge holders, with goals, secrets, relationships, mythosAwareness
 */
export interface NPCBasicInfo {
  name: string;
  occupation: string;
  age: number;
  gender: string;
  background: string;
  goals: string[];
  secrets: string[];
  relationships: Array<{
    targetName: string;
    relationshipType: string;
    attitude: number;
    description: string;
  }>;
  mythosAwareness: "none" | "partial" | "distorted" | "knowing";
  // NEW: Link to knowledge holders
  instantiatedFrom?: string; // Knowledge holder ID that this NPC represents
  inheritsKnowledge?: string[]; // Truth event IDs from knowledge holder
}

/**
 * World Generation Result - Complete output
 */
export interface WorldGenerationResult {
  macroScene: MacroSceneStructure;
  storyPremise: string;
  mythosEvents: MythosEvent[];
  endState: EndStateDefinition;
  scenarios: ScenarioOutline[];
  scenes: Map<string, DynamicScene>;
  transportEdges: TransportEdge[];
  truthTimeline: TruthEvent[];
  knowledgeMatrix: KnowledgeHolder[];
  redHerrings: RedHerring[];
  startingScene: StartingSceneSelection | null;
  npcs: DynamicNPCProfile[];
  generatedFiles: {
    macroSceneFile: string;
    scenariosFile: string;
    scenesDir: string;
    transportFile: string;
    truthTimelineFile: string;
    knowledgeMatrixFile: string;
    startingSceneFile: string | null;
    npcsDir: string;
    moduleDigestFile?: string | null;
  };
}

export interface ModuleDigest {
  moduleNotes: string;
  keeperGuidance: string;
  moduleLimitations: string;
  introduction: string;
  macroMapPath?: string; // Module-relative path to macro map image (e.g. "Map/[Module Name].png")
  globalTrigger?: {
    timeRestriction?: string;
    timeReason?: string;
    events?: string[];
    eventReasons?: string[];
    keeperNotes?: string;
  };
  victoryTrigger?: {
    conditions: string[]; // Independent observable win checks; satisfying any one condition means victory
    conditionReasons: string[]; // Why each single condition alone is sufficient to confirm victory
  };
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
