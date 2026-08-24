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
  /** Per-step narrative fragment produced by the interpreter — the slice of
   *  the cleaned narrative that belongs to *this step only*. Falls back to
   *  the full cleaned narrative if the LLM didn't emit a per-step fragment.
   *  ActionIntake stores this on ActionStep.actionText so each step's logs /
   *  memory / resolver-prompt show just its own beat, not the entire action. */
  actionText?: string;
  /** Resolved citations from the agent's [references] block. Empty array if
   *  no citations present. ActionIntake passes through to ActionStep. */
  referencedEntities?: import("./core/types.js").ReferencedEntity[];
}

export interface InterpretedResult {
  steps: InterpretedStep[];
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
