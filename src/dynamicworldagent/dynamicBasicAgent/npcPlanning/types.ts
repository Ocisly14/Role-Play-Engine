import type { SimulationEvent } from "../../simulation/types.js";
import type { CharacterPosition } from "../../state/topologyTypes.js";
import type { Item } from "../../state/types.js";

export type BuiltinNodeType =
  | "routine"
  | "movement"
  | "character_interaction"
  | "object_interaction"
  | "scene_interaction";

/** Open to plugin extensions — accepts any string, with IDE hints for built-in types */
export type PlanNodeType = BuiltinNodeType | (string & {});

export interface SceneCondition {
  description: string;
  mechanicalEffect?: {
    skillPenalty?: Array<{ skill: string; delta: number }>;
    blocked?: boolean;
  };
}

// ===== LLM State Resolver types (character_interaction) =====

export interface CharacterStateDelta {
  hpDelta?: number;
  sanDelta?: number;
  moveTo?: string;
  addItems?: string[];
  removeItems?: string[];
  addConditions?: string[];
  removeConditions?: string[];
  appearanceChange?: string;
  memory: string;
}

export interface InteractionStateDelta {
  actorChanges: CharacterStateDelta;
  targetChanges: Record<string, CharacterStateDelta>;
}

export interface ItemLocationRef {
  type: "scene" | "inventory" | "container";
  /** Required when type === "container". */
  containerItemId?: string;
  /** Where to look for the container itself. Defaults to "scene". */
  scope?: "scene" | "inventory";
}

export interface ObjectInteractionPayload {
  action: "move" | "use" | "inspect" | "destroy";
  itemId?: string;
  targetItemId?: string;
  from?: ItemLocationRef;
  to?: ItemLocationRef;
  /** Non-normal use: LLM returns expected item state changes after success */
  itemUpdates?: Partial<Item>;
  targetItemUpdates?: Partial<Item>;
}

export interface ScheduleEntry {
  location: string; // scene ID
  activity: string; // natural language description
}

export interface SceneConnectionEffect {
  targetScenarioId: string;
  action: "block" | "unblock";
}

export interface MovementStep {
  kind: "to_junction" | "along_road" | "to_scene";
  from: CharacterPosition;
  to: CharacterPosition;
  durationMinutes: number;
  roadId?: string;
  blockCheck?: {
    fromId: string;
    toId: string;
  };
}

export interface MovementExecutionState {
  routeSnapshot: MovementStep[];
  currentStepIndex: number;
  minutesIntoStep: number;
  lastReachablePosition: CharacterPosition;
  targetPosition: CharacterPosition;
  blockedReason?: string;
}

export interface PlanNodeExecutionMeta {
  remainingMinutes: number;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  interruptedAt?: string;
  interruptionReason?: string;
  blockedReason?: string;
  movement?: MovementExecutionState;
}

export type PlanNodeStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "interrupted";

export interface PlanNode {
  nodeId: string;
  characterId: string;
  characterName: string;
  startTime: string;
  endTime: string;
  action: string;
  location: string;
  type: PlanNodeType;
  /** Skill name for dice roll. Omit = auto-success. */
  skill?: string;
  impact: 0 | 1 | 2 | 3 | 4 | 5;
  difficulty?: "regular" | "hard" | "extreme";
  targetCharacterIds?: string[];
  objectInteractionPayload?: ObjectInteractionPayload;
  sceneConnectionEffect?: SceneConnectionEffect;
  status: PlanNodeStatus;
  executionMeta: PlanNodeExecutionMeta;
  outcome?: string;
  /** Feature overlay fields — arbitrary keys added by WorldFeature schemas */
  [key: string]: unknown;
}

export interface DiscoveryEntry {
  id: string;
  text: string;
  source: "evidence" | "npc";
  sourceId: string; // sceneId or npcId
  sourceName: string; // scene name or NPC name
  difficulty: "automatic" | "regular" | "hard" | "extreme";
  similarity: number; // semantic match score
}

export type SuccessLevel = "critical" | "hard" | "regular" | "fail" | "fumble";

export interface CharacterAction {
  characterId: string;
  characterName: string;
  gameTime: string;
  action: string;
  location: string;
  type: PlanNodeType;
  skill?: string;
  impact: 0 | 1 | 2 | 3 | 4 | 5;
  difficulty?: "regular" | "hard" | "extreme";
  successLevel?: SuccessLevel;
  /** Dice roll detail string from the skill check (e.g. "rolled 45 vs. skill 60"). Used by tickProcessor to pass context to LLM state resolver. */
  rollDetail?: string;
  status: "completed" | "failed" | "interrupted";
  outcome: string;
  failureReason?: FailureReason;
  interruptionReason?: "revise_replan";
  targetCharacterIds?: string[];
  discoveries?: DiscoveryEntry[];
  damagedEvidence?: { itemId: string; sourceName: string };
  /** Per-character memory text from LLM state resolver. When present, tickProcessor writes these instead of auto-generating. */
  stateMemories?: Record<string, string>;
  /** Per-target opposed roll outcomes (multi-target character_interaction) */
  perTargetResults?: Record<string, {
    successLevel: SuccessLevel;
    actorWon: boolean;
    detail: string;
    /** Pre-computed combat damage (only when actorWon in combat) */
    damage?: number;
  }>;
}

export type FailureReason =
  | "location_mismatch"
  | "location_blocked"
  | "target_absent"
  | "object_not_found"
  | "skill_roll_failed"
  | "bad_luck";

export type FailureTrigger = {
  type: "failure";
  failureReason: FailureReason;
  action: string;
  gameTime: string;
  failureOutcome?: string;
  blockedReason?: string;
};

export type ImpactTrigger = {
  type: "impact";
  triggeringAction: CharacterAction;
};

export interface RevisePlansContext {
  longTermIntent: string;
  memoryLog: string[];
  pendingNodes: PlanNode[];
  trigger: FailureTrigger | ImpactTrigger;
}

export interface RevisePlansResult {
  interruptedAction?: CharacterAction;
}

export interface SimulationTickResult {
  actions: CharacterAction[];
  events: SimulationEvent[];
  dayChanged: boolean;
}
