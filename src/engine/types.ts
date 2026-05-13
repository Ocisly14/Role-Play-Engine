import type { SuccessLevel } from "../planning/types.js";

// ===== Action Definition: declarative game rules =====

export interface ActionDefinitionSkillCheck {
  /** Exact skill name for this definition. Omit when the definition delegates to step-level skill. */
  skill?: string;
  difficulty: "regular" | "hard" | "extreme";
  type: "single" | "opposed";
  opposedDefense?: string[];
  failBehavior: "abort" | "partial";
}

export interface StateDomainSpec {
  inject: string[];
  fields?: string[] | Record<string, string[]>;
  output: string[];
}

export interface CustomFieldDef {
  type: string;
  description?: string;
}

/**
 * Per-definition duration hint rendered into the resolver prompt so the LLM
 * can judge `elapsedMinutes` consistently with CoC-canon expectations.
 */
export interface DurationGuidance {
  default: number;
  range?: string;
  notes?: string;
}

export interface OutputSchemaConfig {
  presets?: string[];
  use?: string[];
  requireOnSuccess?: string[];
  requireOnFailure?: string[];
  durationGuidance?: DurationGuidance;
  custom?: Record<string, CustomFieldDef>;
}

export interface ActionDefinitionInterpreter {
  examples: string[];
}

export interface ActionDefinitionImpactHint {
  default: number;
  range?: string;
  examples?: string;
}

export interface ActionDefinition {
  id: string;
  title: string;
  description: string;
  content: string;
  guidanceBody: string;
  /**
   * Dispatch discriminator. `"llm"` definitions are resolved by the LLM
   * resolver pipeline; `"code"` definitions are dispatched to a
   * `CodeEngineSubsystem` keyed by `codeSubsystem` (e.g. `"movement"`).
   */
  engine: "code" | "llm";
  codeSubsystem?: string;
  skillCheck?: ActionDefinitionSkillCheck;
  stateDomains?: Record<string, StateDomainSpec>;
  outputSchema?: OutputSchemaConfig;
  interpreter?: ActionDefinitionInterpreter;
  featureOverlay?: Record<string, unknown>;
  impactHint?: ActionDefinitionImpactHint;
}

// ===== GameInterpreter: action → definition steps =====

export interface InterpretedStep {
  definitionId: string;
  impact: 0 | 1 | 2 | 3 | 4 | 5;
  engine: "code" | "llm";
  codeSubsystem?: string;
  overlayFields?: Record<string, unknown>;
  /** Resolved [Name] citations from actionText (Phase H). Empty array if no
   *  citations present. ActionIntake passes through to ActionStep. */
  referencedEntities?: import("./core/types.js").ReferencedEntity[];
}

export interface InterpretedResult {
  steps: InterpretedStep[];
}

// ===== StateResolution: structured state changes =====

/** @deprecated Use state change types from resolver/stateChangeTypes.ts instead */
export interface CharacterChange {
  characterId: string;
  hp?: number;
  san?: number;
  fatigue?: number;
  addConditions?: string[];
  removeConditions?: string[];
  position?: import("../state/topologyTypes.js").CharacterPosition;
}

/** @deprecated Use state change types from resolver/stateChangeTypes.ts instead */
export interface ItemChange {
  itemId: string;
  action: "move" | "destroy" | "create" | "modify";
  from?: string;
  to?: string;
  properties?: Record<string, unknown>;
}

/** @deprecated Use state change types from resolver/stateChangeTypes.ts instead */
export interface SceneChange {
  sceneId: string;
  addConditions?: string[];
  removeConditions?: string[];
}

/** @deprecated Use state change types from resolver/stateChangeTypes.ts instead */
export interface MemoryEntry {
  characterId: string;
  type: string;
  content: string;
}

/** @deprecated Use state change types from resolver/stateChangeTypes.ts instead */
export interface RelationshipChange {
  from: string;
  to: string;
  change: string;
}

/** @deprecated Use state change types from resolver/stateChangeTypes.ts instead */
export interface StateResolution {
  characterChanges?: CharacterChange[];
  itemChanges?: ItemChange[];
  sceneChanges?: SceneChange[];
  memories?: MemoryEntry[];
  relationships?: RelationshipChange[];
  featureOverlays?: Record<string, unknown>;
  narrative: string;
}

// ===== Movement tick state =====

export interface MovementTickState {
  remainingMinutes: number;
  destination: string;
  targetPosition: import("../state/topologyTypes.js").CharacterPosition;
}

// ===== ToolResult: code tool execution result =====

export interface ToolResult {
  done: boolean;
  status: "completed" | "failed" | "interrupted";
  outcomeDescription: string;
  remainingMinutes?: number;
  rollDetail?: string;
  successLevel?: SuccessLevel;
  perTargetResults?: Record<
    string,
    {
      successLevel: SuccessLevel;
      actorWon: boolean;
      detail: string;
      damage?: number;
    }
  >;
}

export interface SkillRollResult {
  failed: boolean;
  reason?: string;
  detail?: string;
  successLevel: SuccessLevel;
  perTargetResults?: Record<
    string,
    {
      successLevel: SuccessLevel;
      actorWon: boolean;
      detail: string;
      damage?: number;
    }
  >;
}
