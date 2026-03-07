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
  impact: 0 | 1 | 2 | 3 | 4 | 5;
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

export interface DiscoveredClueEntry {
  clueId: string;
  clueText: string;
  source: "scene" | "npc";
  sourceId: string;       // scenarioId or npcId
  sourceName: string;     // scenario name or NPC name
  difficulty: "automatic" | "regular" | "hard" | "extreme";
  similarity: number;     // semantic match score
}

export type SuccessLevel = "critical" | "hard" | "regular" | "fail" | "fumble";

export interface CharacterAction {
  characterId: string;
  characterName: string;
  gameTime: string;
  action: string;
  location: string;
  type: PlanNodeType;
  actionType?: ActionType;
  impact: 0 | 1 | 2 | 3 | 4 | 5;
  isPlayer?: boolean;
  difficulty?: "regular" | "hard" | "extreme" | "luck_only";
  successLevel?: SuccessLevel;
  status: "completed" | "failed";
  outcome: string;
  failureReason?: FailureReason;
  targetCharacterId?: string;
  discoveredClues?: DiscoveredClueEntry[];
  damagedClue?: { clueId: string; sourceName: string };
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
  memoryLog: string[];
  pendingNodes: PlanNode[];
  trigger: FailureTrigger | ImpactTrigger;
}

export interface PlayerWitnessEvent {
  characterName: string;
  action: string;
  outcome: string;
  location: string;
  gameTime: string;
  impact: number;
}

export type TickResult =
  | { type: "completed"; actions: CharacterAction[] }
  | {
      type: "player_interrupt";
      actions: CharacterAction[];
      witnessEvents: PlayerWitnessEvent[];
      /** Remaining bucket keys + nodes to resume if player chooses continue */
      remainingBuckets: Array<{ bucketKey: number; nodes: PlanNode[] }>;
      /** Game day at time of interrupt */
      gameDay: number;
    };

