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

/** Result returned by WorldFeature.onBucketEnd */
export interface WorldFeatureResult {
  /** New PlanNodes to inject into subsequent buckets */
  newNodes?: PlanNode[];
  /** Player witness events (used by impact-gate-style features) */
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

/** Runtime dependencies passed to WorldFeature lifecycle hooks */
export interface TickRuntimeContext {
  sessionId: string;
  gameDay: number;
  language: string;
  npcPlanning: NpcPlanningCapability;
}

export interface WorldFeature {
  /** Unique identifier */
  id: string;

  /** Which SceneCondition types this feature manages */
  conditionTypes: string[];

  /** Human-readable description */
  description: string;

  /** Called after each 5-min bucket. May return new PlanNodes and/or player events. */
  onBucketEnd(
    bucketActions: CharacterAction[],
    dgsm: DynamicGameStateManager,
    bucketTime: string,
    runtime: TickRuntimeContext
  ): Promise<WorldFeatureResult>;

  /** Called once at tick start */
  onTickStart?(dgsm: DynamicGameStateManager, runtime: TickRuntimeContext): void;

  /** Called once at tick end with all actions from the entire tick */
  onTickEnd?(allActions: CharacterAction[], dgsm: DynamicGameStateManager, runtime: TickRuntimeContext): void;

  /** Generate current state description for LLM context. Return "" to omit from prompt. */
  stateDescription(dgsm: DynamicGameStateManager): string;

  /**
   * Static prompt section injected into the planning agent prompt.
   * Describes what PlanNode fields this feature requires and their semantics,
   * so the LLM knows to output them. Return "" to omit.
   */
  planningPrompt: string;
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
