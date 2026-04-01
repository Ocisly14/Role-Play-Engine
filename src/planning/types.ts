import type { CharacterPosition } from "../state/topologyTypes.js";

export type BuiltinNodeType =
  | "action"
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
  learnedLocationNames?: string[];
  memory: string;
}

export interface InteractionStateDelta {
  actorChanges: CharacterStateDelta;
  targetChanges: Record<string, CharacterStateDelta>;
}

// ===== LLM State Resolver types (object_interaction) =====

/** LLM outputs the final state of each affected item. */
export interface ItemResult {
  itemId: string;
  /** Final location: "scene" | "inventory" | "inventory:<npcId>" | "container:<containerId>" | "destroyed" */
  location: string;
  /** Changed Item fields to deep-merge. Omit if unchanged. */
  updates?: Record<string, unknown>;
}

export interface NewItemEntry {
  id: string;
  name: string;
  /** Where the new item appears: "scene" | "inventory" | "container:<containerId>" */
  location: string;
  /** Original item ID this was produced from. The source item is automatically removed. */
  sourceItemId?: string;
  /** Any additional Item fields (type, description, category, containerStats, weaponStats, etc.) */
  [key: string]: unknown;
}

export interface ObjectStateDelta {
  /** Final state of each affected item. Only include items that changed. */
  items: ItemResult[];
  /** New items created by disassembly, crafting, or transformation. */
  newItems?: NewItemEntry[];
  /** Scene condition descriptions to add. */
  addSceneConditions?: string[];
  /** First-person memory for the actor. */
  memory: string;
}

// ===== LLM State Resolver types (scene_interaction) =====

export interface SceneConnectionEffectResult {
  targetId: string;
  action: "block" | "unblock" | "reveal" | "hide";
}

export interface SceneStateDelta {
  /** Scene conditions to add (with optional mechanical effects). */
  addSceneConditions?: SceneCondition[];
  /** Exact existing condition descriptions to remove. */
  removeSceneConditions?: string[];
  /** Connection effects: block/unblock/reveal/hide passages. */
  connectionEffects?: SceneConnectionEffectResult[];
  /** Item state changes (tool damage, consumption, movement). */
  items?: ItemResult[];
  /** First-person memory for the actor. */
  memory: string;
}

export interface ObjectInteractionPayload {
  /** Primary item this interaction targets. Used for existence pre-check. */
  itemId?: string;
}

export interface ScheduleEntry {
  location: string; // scene ID
  activity: string; // natural language description
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
  /** Movement-only target location ID. */
  destination?: string;
  type: PlanNodeType;
  /** Skill name for dice roll. Omit = auto-success. */
  skill?: string;
  impact: 0 | 1 | 2 | 3 | 4 | 5;
  difficulty?: "regular" | "hard" | "extreme";
  targetCharacterIds?: string[];
  objectInteractionPayload?: ObjectInteractionPayload;
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
  interruptionReason?: "revise_replan" | "character_dead";
  targetCharacterIds?: string[];
  discoveries?: DiscoveryEntry[];
  damagedEvidence?: { itemId: string; sourceName: string };
  /** Per-character memory text from LLM state resolver. When present, tickProcessor writes these instead of auto-generating. */
  stateMemories?: Record<string, string>;
  /** Per-target opposed roll outcomes (multi-target character_interaction) */
  perTargetResults?: Record<
    string,
    {
      successLevel: SuccessLevel;
      actorWon: boolean;
      detail: string;
      /** Pre-computed combat damage (only when actorWon in combat) */
      damage?: number;
    }
  >;
}

export type FailureReason =
  | "location_mismatch"
  | "location_blocked"
  | "target_absent"
  | "object_not_found"
  | "skill_roll_failed"
  | "bad_luck"
  | "prerequisite_not_met"
  | "unknown";

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

export type WorldEventType = "scene_updated" | "feature_triggered";

export interface WorldEventDescriptor {
  type: WorldEventType;
  location: string;
  gameTime: string;
  description: string;
  data: Record<string, unknown>;
}

export interface SimulationTickResult {
  actions: CharacterAction[];
  worldEvents: WorldEventDescriptor[];
  encounterSignatures: string[];
  dayChanged: boolean;
}
