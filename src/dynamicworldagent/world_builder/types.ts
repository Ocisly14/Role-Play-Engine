/**
 * Type definitions for World Builder agents
 * Supports truth-first world generation following instruction.md specification
 */

import type { NPCProfile } from "../../coc_multiagents_system/agents/models/gameTypes.js";
import type { ScenarioSnapshot } from "../../coc_multiagents_system/agents/models/scenarioTypes.js";

/**
 * Setting types for CoC scenarios
 */
export type MacroSceneSettingType =
  | "small_town"      // 小镇/乡村
  | "city"            // 城市
  | "academic"        // 学术/研究场所
  | "isolated"        // 偏远据点/封闭环境
  | "single_structure" // 单一建筑
  | "route";          // 路径/旅程型

/**
 * Macro Scene Structure - Setting skeleton (not limited to towns)
 */
export interface MacroSceneStructure {
  moduleName: string;                     // CoC-style module title (e.g., "The Shadow Over Innsmouth")
  locationName: string;                   // Location name (e.g., "Innsmouth", "Arkham University")
  settingType?: MacroSceneSettingType;    // Type of setting
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
  id: string;                    // e.g., "T1", "T2"
  time: string;                  // e.g., "2 months ago", "Day 3 evening"
  event: string;                 // Objective description, NO names
  cause?: string;                // What caused this event
  consequence?: string;          // What this event caused
  mythosInvolved: boolean;       // Whether this involves mythos
}

/**
 * Knowledge Holder - Abstract entities that possess information
 * NOT NPCs - these are roles, organizations, places, or objects
 */
export interface KnowledgeHolder {
  id: string;                    // e.g., "KH_ROLE_1", "KH_PLACE_1"
  holderType: "ROLE" | "ORGANIZATION" | "PLACE" | "OBJECT";
  holderName: string;            // e.g., "Ritual Participant", "Local Historical Society"
  knows: string[];               // Truth event IDs this holder knows
  distortion?: "none" | "partial_amnesia" | "deliberate_suppression" | "misinterpretation";
  containsEvidence?: string[];   // For PLACE/OBJECT types
  reliability?: "high" | "medium" | "low";
}

/**
 * Red Herring - False but plausible explanations
 * Must have a physical or psychological source
 */
export interface RedHerring {
  id: string;                    // e.g., "RH1", "RH2"
  falseBelief: string;           // The false but plausible explanation
  sourceType: "MEDIA_RUMOR" | "MEDICAL_RECORD" | "OFFICIAL_REPORT" | "WITNESS_MISIDENTIFICATION" | "COINCIDENCE";
  origin: string;                // Where this false belief comes from
  whyPlausible: string;          // Why people would believe it
  contradictsEvents?: string[];  // Truth event IDs this contradicts
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
  summary: string;               // 1-3 paragraphs
  catastropheNature: string;
  winnersAndSurvivors: string[];
  pointOfNoReturn: {
    type: "time" | "condition";
    trigger: string;             // e.g., "Day 8 0:00" or "All seals broken"
  };
}

/**
 * Scenario connection definition (name-based, no snapshots yet)
 */
export type ScenarioConnectionType = "leads_to" | "concurrent" | "prerequisite" | "alternate";

export interface ScenarioConnection {
  scenarioName: string;
  relationshipType: ScenarioConnectionType;
  description?: string;
}

/**
 * Scenario Outline - generated from place holders, no snapshot yet
 */
export interface ScenarioOutline {
  id: string;
  name: string;
  description: string;
  sourcePlaceId?: string;
  sourcePlaceName?: string;
  tags?: string[];
  evidence?: string[];
  clues?: ScenarioClueSeed[];
  connections: ScenarioConnection[];
}

export interface ScenarioClueSeed {
  clueText: string;
  evidenceRef?: string;
  notes?: string;
}

export interface ScenarioNpcAssignment {
  id: string;
  name: string;
  occupation?: string;
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
  selectionReason: string;
  snapshot: ScenarioSnapshot;
}

/**
 * NPC Basic Info - Output of Step 1 of NPC Builder
 * NPCs instantiated from knowledge holders
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
  instantiatedFrom?: string;     // Knowledge holder ID that this NPC represents
  inheritsKnowledge?: string[];  // Truth event IDs from knowledge holder
}

/**
 * World Generation Result - Complete output
 */
export interface WorldGenerationResult {
  macroScene: MacroSceneStructure;
  truthTimeline: TruthEvent[];
  knowledgeMatrix: KnowledgeHolder[];
  redHerrings: RedHerring[];
  mythosEvents: MythosEvent[];
  endState: EndStateDefinition;
  scenarios: ScenarioOutline[];
  startingScene: StartingSceneSelection | null;
  otherScenarioNpcAssignments: ScenarioNpcAssignments[];
  npcs: NPCProfile[];
  generatedFiles: {
    truthTimelineFile: string;
    knowledgeMatrixFile: string;
    macroSceneFile: string;
    scenariosFile: string;
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
}

/**
 * Progress Callback - For reporting generation progress
 */
export type ProgressCallback = (message: string) => void;
