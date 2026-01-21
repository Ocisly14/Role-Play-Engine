/**
 * Type definitions for World Builder agents
 * Supports truth-first world generation following instruction.md specification
 */

import type { NPCProfile } from "../models/gameTypes.js";

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
  npcs: NPCProfile[];
  generatedFiles: {
    truthTimelineFile: string;
    knowledgeMatrixFile: string;
    macroSceneFile: string;
    npcsDir: string;
  };
}

/**
 * Progress Callback - For reporting generation progress
 */
export type ProgressCallback = (message: string) => void;
