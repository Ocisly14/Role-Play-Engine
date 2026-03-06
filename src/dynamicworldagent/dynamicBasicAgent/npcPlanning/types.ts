import type { ActionType } from "../../../shared/state/index.js";

export type PlanNodeType =
  | "routine"
  | "movement"
  | "character_interaction"
  | "object_interaction"
  | "scene_interaction";

export interface SceneCondition {
  description: string;
  mechanicalEffect?: {
    skillPenalty?: Array<{ skill: string; delta: number }>;
    blocked?: boolean;
  };
}

export interface CharacterInteractionPayload {
  transferType: "item" | "clue" | "information";
  itemId?: string;
  clueId?: string;
  informationContent?: string;
}

export interface ObjectInteractionPayload {
  action: "pickup" | "place" | "use" | "inspect" | "destroy";
  itemId?: string;
}

export interface SceneConnectionEffect {
  targetScenarioId: string;
  action: "block" | "unblock";
}

export interface PlanNode {
  nodeId: string;
  characterId: string;
  characterName: string;
  gameTime: string;
  action: string;
  location: string;
  type: PlanNodeType;
  actionType?: ActionType;
  impact: 0 | 1 | 2 | 3;
  difficulty?: "regular" | "hard" | "extreme";
  isPlayer?: boolean;
  timeAdvanceMinutes: number;
  targetCharacterId?: string;
  characterInteractionPayload?: CharacterInteractionPayload;
  objectInteractionPayload?: ObjectInteractionPayload;
  sceneConnectionEffect?: SceneConnectionEffect;
  status: "pending" | "completed" | "failed";
  outcome?: string;
}

export interface CharacterAction {
  characterId: string;
  characterName: string;
  gameTime: string;
  action: string;
  location: string;
  type: PlanNodeType;
  actionType?: ActionType;
  impact: 0 | 1 | 2 | 3;
  isPlayer?: boolean;
  difficulty?: "regular" | "hard" | "extreme" | "luck_only";
  status: "completed" | "failed";
  outcome: string;
  failureReason?: FailureReason;
  targetCharacterId?: string;
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
};

export type ImpactTrigger = {
  type: "impact";
  triggeringAction: CharacterAction;
};

export interface RevisePlansContext {
  longTermIntent: string;
  actionLog: string[];
  pendingNodes: PlanNode[];
  trigger: FailureTrigger | ImpactTrigger;
}

