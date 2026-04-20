import type { CharacterAction, PlanNode } from "../planning/types.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";

// ===== World Feature: self-running world system =====

/** Result returned by WorldFeature.onNodeStart() when a precondition fails */
export interface NodeStartBlockedResult {
  blocked: true;
  reason: string;
}

/** Result returned by WorldFeature.activate() */
export interface ActivateResult {
  /**
   * Describes what happened (or didn't happen) during feature activation.
   * Injected into the LLM resolver prompt for resolver-based actions,
   * or appended to the action memory for non-resolver actions.
   */
  outcomeNote?: string;
}

/** Result from world feature processing (used internally by the tick engine) */
export interface WorldFeatureResult {
  /** New PlanNodes to inject into subsequent ticks */
  newNodes?: PlanNode[];
  /** Player witness events (for interrupt handling) */
  playerEvents?: Array<{ event: CharacterAction; impact: number }>;
}

// ===== Feature schema & propagation declarations =====

/** Schema declaration for fields a feature adds to PlanNode output */
export interface FeatureNodeSchema {
  /** Fields the LLM must provide when using this feature overlay */
  requiredFields: Array<{ field: string; type: string; description: string }>;
  /** Fields the LLM may optionally provide */
  optionalFields?: Array<{ field: string; type: string; description: string }>;
  /** Complete example node showing this feature's fields merged with a real node */
  exampleNode: Record<string, unknown>;
}

/** Propagation configuration for features that spread spatially */
export interface FeaturePropagationConfig {
  /** How many ticks between each propagation step (e.g. 10 = every 10 min) */
  tickInterval: number;
  /** Maximum number of propagation hops from the source scene */
  maxHops: number;
}

/** Result returned by WorldFeature.propagate() */
export interface PropagationResult {
  /** Scene IDs the feature spread to this step */
  spreadTo: string[];
  /** New PlanNodes to inject (e.g. NPC reaction to fire arrival) */
  newNodes?: PlanNode[];
  /** Player witness events from propagation */
  playerEvents?: Array<{ event: CharacterAction; impact: number }>;
}

/** Minimal interface for NPC planning capabilities needed by WorldFeatures */
export interface NpcPlanningCapability {
  getPendingNodes(
    sessionId: string,
    npcId: string,
    gameDay: number
  ): Promise<PlanNode[]>;
  runImpactGateForNpc(
    candidate: {
      npcId: string;
      npcName: string;
      currentLocation: string;
      longTermIntent: string;
      todayScheduleSummary: string;
      currentDetailedPlan: string;
      triggeringEvents: string;
      memoryContext?: string;
      shortTermIntent?: string;
    },
    bucketTime: string,
    language: string,
    moduleBackground?: string
  ): Promise<{
    shouldUpdateIntent: boolean;
    updatedIntent?: string;
    shouldInterruptCurrentNode: boolean;
    shouldReviseSchedule: boolean;
  }>;
  generateImpactObservationForNpc(
    candidate: {
      npcId: string;
      npcName: string;
      currentLocation: string;
      longTermIntent: string;
      todayScheduleSummary: string;
      currentDetailedPlan: string;
      triggeringEvents: string;
      memoryContext?: string;
      shortTermIntent?: string;
    },
    bucketTime: string,
    perspective: "targeted" | "witness" | "co_presence",
    language: string,
    moduleBackground?: string
  ): Promise<string>;
  getShortTermIntent(sessionId: string, npcId: string): Promise<string | null>;
  setShortTermIntent(
    sessionId: string,
    npcId: string,
    intent: string
  ): Promise<void>;
  getLongTermIntent(sessionId: string, npcId: string): Promise<string>;
  getDailyPlan(
    sessionId: string,
    npcId: string,
    gameDay: number
  ): Promise<{ nodes: unknown; schedule: unknown } | null>;
  updateNode(
    sessionId: string,
    npcId: string,
    gameDay: number,
    node: PlanNode
  ): Promise<void>;
  reviseSchedule(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    triggerDescription: string,
    language?: string,
    registry?: import("./registry.js").GameEngineRegistry
  ): Promise<void>;
}

/** Runtime dependencies passed to WorldFeature hooks */
export interface TickRuntimeContext {
  sessionId: string;
  gameDay: number;
  language: string;
  /** Current tick's time label (HH:MM) */
  tickTime: string;
  /** Duration of this tick in minutes (usually 1, can be less for final tick) */
  tickDurationMinutes: number;
  npcPlanning: NpcPlanningCapability;
}

export interface WorldFeature {
  /** Unique identifier (e.g. "fire", "rain", "poison_gas") */
  id: string;

  /** Human-readable description */
  description: string;

  /**
   * Static prompt section describing this feature's rules and behavior.
   * Injected into the planning agent prompt. Return "" to omit.
   */
  planningPrompt: string;

  /**
   * Schema for fields this feature adds to PlanNode output.
   * Rendered as a "Feature Overlay" section — LLM can combine with ANY node type.
   * Undefined if this feature adds no output fields.
   */
  planNodeSchema?: FeatureNodeSchema;

  /**
   * Propagation configuration. If defined, the tick engine will:
   * 1. Detect this feature's overlay fields on executed nodes → register propagation sources
   * 2. Call propagate() on schedule to spread effects to adjacent scenes
   */
  propagation?: FeaturePropagationConfig;

  /** Generate current state description for LLM context. Return "" to omit. */
  stateDescription(dgsm: DynamicGameStateManager): string;

  /**
   * Called every tick to update temporal state.
   * Use this for time-driven changes (rain intensity curves, tidal cycles, etc.)
   * or state-driven changes (fire grows near flammable objects, gas disperses in ventilated rooms).
   * Feature reads/writes its own state via dgsm.getFeatureSceneState / setFeatureSceneState.
   */
  tick?(dgsm: DynamicGameStateManager, runtime: TickRuntimeContext): void;

  /**
   * Return skill modifiers for a specific character based on this feature's state.
   * Called during skill roll resolution to apply character-level penalties/bonuses.
   * Use skill name "*" to apply to ALL skills.
   */
  getCharacterSkillModifiers?(
    characterId: string,
    dgsm: DynamicGameStateManager
  ): Array<{ skill: string; delta: number }>;

  /**
   * Called when a PlanNode with this feature's overlay fields transitions
   * from pending to in_progress (action start time).
   * Use this for precondition checks that should be evaluated at the start
   * of the action (e.g., location prerequisites), not at the end.
   * Only called if `planNodeSchema` is defined.
   * Return `{ blocked: true, reason }` to abort the node before execution.
   */
  onNodeStart?(
    node: PlanNode,
    dgsm: DynamicGameStateManager
  ): NodeStartBlockedResult | void;

  /**
   * Called once when the tick engine detects this feature's overlay fields on an executed node.
   * Reads overlay field values from the node and writes initial feature state into dgsm
   * (e.g. adding scene conditions, penalties, etc.).
   * Only called if `planNodeSchema` is defined.
   *
   * May return an ActivateResult with an outcomeNote describing what happened
   * (or didn't happen). The tick processor injects this into the LLM resolver
   * prompt or appends it to the action memory for non-resolver paths.
   */
  activate?(
    node: PlanNode,
    dgsm: DynamicGameStateManager
  ): ActivateResult | void;

  /**
   * Called by the tick engine on a recurring schedule (every `propagation.tickInterval` ticks)
   * to spread feature effects to adjacent scenes.
   * Reads current state from dgsm, computes spread, writes updated state back.
   * Only called if `propagation` is defined.
   */
  propagate?(
    sourceSceneId: string,
    currentHop: number,
    dgsm: DynamicGameStateManager,
    runtime: TickRuntimeContext
  ): Promise<PropagationResult>;
}

// ===== Action Definition: declarative game rules =====

export interface ActionDefinitionSkillCheck {
  /** Exact skill name for this definition. Omit when the definition delegates to PlanNode.skill. */
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
 * Semantic authority lives in the engine (definition + resolver); tick-layer
 * consumption of `elapsedMinutes` is a separate mechanical concern.
 */
export interface DurationGuidance {
  /** Typical minutes when no special factors apply. */
  default: number;
  /** Human-readable min-max range, e.g. "1-15". */
  range?: string;
  /** Short prose describing the factors that push elapsed up or down. */
  notes?: string;
}

export interface OutputSchemaConfig {
  presets?: string[];
  use?: string[];
  /**
   * Top-level fields that MUST appear (non-empty) when the skill check
   * succeeds. Expressed as "at least one of". Do NOT list `memory.event`
   * here — it is universally required (see resolver's Always Required block).
   */
  requireOnSuccess?: string[];
  /**
   * Top-level fields that MUST appear (non-empty) when the skill check
   * fails or fumbles. Expressed as "at least one of". Declare here for
   * skills whose failure has physical side effects (damaged tool, spilled
   * contents, wasted material). Do NOT list `memory.event` — it is
   * universally required regardless of outcome.
   */
  requireOnFailure?: string[];
  /**
   * Duration guidance rendered into the resolver prompt. The resolver is
   * always required to emit `elapsedMinutes`; this block tells it the
   * expected shape for this definition.
   */
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
  successLevel?: import("../planning/types.js").SuccessLevel;
  perTargetResults?: Record<
    string,
    {
      successLevel: import("../planning/types.js").SuccessLevel;
      actorWon: boolean;
      detail: string;
      damage?: number;
    }
  >;
}

// ===== Execution Context: shared utilities passed to handlers =====

export interface ExecutionContext {
  /** Resolve a skill roll for the node */
  resolveSkillRoll(
    node: PlanNode,
    adjustedSkills: Record<string, number>,
    dgsm: DynamicGameStateManager,
    adjustTargetSkills?: (
      targetId: string,
      rawSkills: Record<string, number>
    ) => Record<string, number>
  ): SkillRollResult;

  /** Get scene penalties for a location */
  getScenePenalties(
    location: string,
    dgsm: DynamicGameStateManager
  ): Map<string, number>;

  /** Apply penalties to a skills record */
  applyPenalties(
    skills: Record<string, number>,
    penalties: Map<string, number>
  ): Record<string, number>;

  /** Get character-level skill penalties from all active features */
  getCharacterPenalties(
    characterId: string,
    dgsm: DynamicGameStateManager
  ): Map<string, number>;

  /** Get difficulty for a node */
  getNodeDifficulty(
    node: PlanNode,
    dgsm: DynamicGameStateManager
  ): "regular" | "hard" | "extreme";

  /** Current tick time label (HH:MM) */
  currentTime?: string;

  /** Set by SimulationRunner to enable npc_moved event emission from handlers */
  simulationEmitter?: import(
    "../simulation/SimulationEventEmitter.js"
  ).SimulationEventEmitter;

  /** LLM runtime (model provider context) — needed by handlers that call LLM resolvers */
  runtime?: any;

  /** Language code (e.g. "en", "zh") — used by LLM-based handlers */
  language?: string;

  /** NPC memory manager — used by handlers that write character memories */
  memoryManager?: import("../memory/NpcMemoryManager.js").NpcMemoryManager;
}

export interface SkillRollResult {
  failed: boolean;
  reason?: string;
  detail?: string;
  successLevel: import("../planning/types.js").SuccessLevel;
  /** Per-target opposed roll outcomes (multi-target character_interaction) */
  perTargetResults?: Record<
    string,
    {
      successLevel: import("../planning/types.js").SuccessLevel;
      actorWon: boolean;
      detail: string;
      /** Pre-computed combat damage (only when actorWon in combat) */
      damage?: number;
    }
  >;
}
