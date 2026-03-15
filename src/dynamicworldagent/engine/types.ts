import type {
  CharacterAction,
  PlanNode,
  RevisePlansContext,
} from "../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";

// ===== Node Handler: executes a specific PlanNode type =====

export interface NodeHandler {
  /** The PlanNodeType this handler processes (e.g. "movement", "fire_spread") */
  type: string;

  /** Execute a single node, return the resulting action */
  execute(
    node: PlanNode,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext
  ): CharacterAction;

  // --- LLM prompt metadata (auto-injected into plan agent prompts) ---

  /** Human-readable description of what this type does */
  description: string;

  /** Fields the LLM must provide on the PlanNode */
  requiredFields: string[];

  /** Fields the LLM may optionally provide */
  optionalFields?: string[];

  /** Example PlanNode for the LLM prompt */
  exampleNode: Partial<PlanNode>;
}

// ===== World Feature: self-running world system =====

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
  /** How many ticks between each propagation step (e.g. 2 = every 10 min) */
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
    },
    bucketTime: string,
    language: string
  ): Promise<{
    shouldRevise: boolean;
    shouldReviseSchedule: boolean;
    witnessEntry: string;
  }>;
  revisePlans(
    dgsm: DynamicGameStateManager,
    sessionId: string,
    npcId: string,
    context: RevisePlansContext,
    language: string,
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
  /** Duration of this tick in minutes (usually 5, can be less for final tick) */
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
   * Called once when the tick engine detects this feature's overlay fields on an executed node.
   * Reads overlay field values from the node and writes initial feature state into dgsm
   * (e.g. adding scene conditions, penalties, etc.).
   * Only called if `planNodeSchema` is defined.
   */
  activate?(node: PlanNode, dgsm: DynamicGameStateManager): void;

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

// ===== Execution Context: shared utilities passed to handlers =====

export interface ExecutionContext {
  /** Resolve a skill roll for the node */
  resolveSkillRoll(
    node: PlanNode,
    adjustedSkills: Record<string, number>,
    dgsm: DynamicGameStateManager
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

  /** Get difficulty for a node (player explicit or NPC relationship-derived) */
  getNodeDifficulty(
    node: PlanNode,
    dgsm: DynamicGameStateManager
  ): "regular" | "hard" | "extreme" | "luck_only";

  /** Luck-based failure rate */
  luckFailureRate(luck: number): number;

  /** Set by SimulationRunner to enable npc_moved event emission from handlers */
  simulationEmitter?: import(
    "../simulation/SimulationEventEmitter.js"
  ).SimulationEventEmitter;
}

export interface SkillRollResult {
  failed: boolean;
  reason?: string;
  detail?: string;
  successLevel: import(
    "../dynamicBasicAgent/npcPlanning/types.js"
  ).SuccessLevel;
}
