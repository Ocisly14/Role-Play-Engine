import type { ActionType } from "../../shared/state/index.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { PlanNode, CharacterAction, RevisePlansContext } from "../dynamicBasicAgent/npcPlanning/types.js";

// ===== Node Handler: executes a specific PlanNode type =====

export interface NodeHandler {
  /** The PlanNodeType this handler processes (e.g. "movement", "fire_spread") */
  type: string;

  /** Execute a single node, return the resulting action */
  execute(node: PlanNode, dgsm: DynamicGameStateManager, ctx: ExecutionContext): CharacterAction;

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

/** Result returned by WorldFeature.onTickEnd */
export interface WorldFeatureResult {
  /** New PlanNodes to inject into subsequent ticks */
  newNodes?: PlanNode[];
  /** Player witness events (for interrupt handling) */
  playerEvents?: Array<{ event: CharacterAction; impact: number }>;
}

/** Minimal interface for NPC planning capabilities needed by WorldFeatures */
export interface NpcPlanningCapability {
  getLongTermIntent(sessionId: string, npcId: string): Promise<string>;
  getPendingNodes(sessionId: string, npcId: string, gameDay: number): Promise<PlanNode[]>;
  runImpactGateForNpc(
    candidate: {
      npcId: string;
      npcName: string;
      currentLocation: string;
      longTermIntent: string;
      pendingNodesSummary: string;
      triggeringEvents: string;
    },
    bucketTime: string,
    language: string
  ): Promise<{ shouldRevise: boolean; witnessEntry: string }>;
  appendMemoryLog(
    sessionId: string, npcId: string, entry: string,
    gameDay: number, gameTime: string, location: string
  ): Promise<void>;
  getMemoryLog(sessionId: string, npcId: string, gameDay?: number): Promise<string[]>;
  revisePlans(
    dgsm: DynamicGameStateManager, sessionId: string, npcId: string,
    context: RevisePlansContext, language: string
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
  /** Unique identifier */
  id: string;

  /** Human-readable description */
  description: string;

  /** How many full ticks between settlements (1 = every tick, 2 = every 10 min) */
  tickInterval: number;

  /**
   * Spatial scope of this feature's effects.
   * A number (0-5) uses the impact level scale.
   * "dynamic" means scope follows each action's own impact level.
   */
  impactScope: number | "dynamic";

  /**
   * Static prompt section describing this feature's effects.
   * Injected into the planning agent prompt. Should NOT describe impact levels
   * (those are handled by the engine). Return "" to omit.
   */
  planningPrompt: string;

  /**
   * Optional fields this feature adds to every PlanNode output.
   * Used by the registry to build the output schema prompt.
   * Return undefined or [] if this feature adds no node fields.
   */
  planNodeFields?: Array<{ field: string; type: string; description: string }>;

  /** Generate current state description for LLM context. Return "" to omit. */
  stateDescription(dgsm: DynamicGameStateManager): string;

  /** Called at tick end. Receives all actions from this tick. */
  onTickEnd(
    tickActions: CharacterAction[],
    dgsm: DynamicGameStateManager,
    runtime: TickRuntimeContext
  ): Promise<WorldFeatureResult>;
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
  getScenePenalties(location: string, dgsm: DynamicGameStateManager): Map<string, number>;

  /** Apply penalties to a skills record */
  applyPenalties(skills: Record<string, number>, penalties: Map<string, number>): Record<string, number>;

  /** Get difficulty for a node (player explicit or NPC relationship-derived) */
  getNodeDifficulty(node: PlanNode, dgsm: DynamicGameStateManager): "regular" | "hard" | "extreme" | "luck_only";

  /** Luck-based failure rate */
  luckFailureRate(luck: number): number;

  /** Select best skill for an action description + action type */
  selectBestSkill(
    actionDesc: string,
    actionType: ActionType,
    npcSkills: Record<string, number>
  ): { skill: string; value: number } | null;
}

export interface SkillRollResult {
  failed: boolean;
  reason?: string;
  detail?: string;
  successLevel: import("../dynamicBasicAgent/npcPlanning/types.js").SuccessLevel;
}
