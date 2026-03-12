import type { ActionType } from "../../../shared/state/index.js";
import type { Item } from "../../state/types.js";
import type { SimulationEvent } from "../../simulation/types.js";

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

export interface CharacterInteractionPayload {
  transferType: "item" | "information";
  itemId?: string;
  informationContent?: string;
  targetCharacterIds?: string[];
  relatedKnowledgeIds?: string[];
}

export interface ObjectInteractionPayload {
  action: "pickup" | "place" | "use" | "inspect" | "destroy";
  itemId?: string;
  targetItemId?: string;
  /** Non-normal use: LLM returns expected item state changes after success */
  itemUpdates?: Partial<Item>;
  targetItemUpdates?: Partial<Item>;
}

export interface ScheduleEntry {
  location: string;   // scene ID
  activity: string;   // natural language description
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
  /** Feature overlay fields — arbitrary keys added by WorldFeature schemas */
  [key: string]: unknown;
}

export interface DiscoveryEntry {
  id: string;
  text: string;
  source: "evidence" | "npc";
  sourceId: string;       // sceneId or npcId
  sourceName: string;     // scene name or NPC name
  difficulty: "automatic" | "regular" | "hard" | "extreme";
  similarity: number;     // semantic match score
}

/**
 * @deprecated Use DiscoveryEntry instead
 */
export type DiscoveredClueEntry = DiscoveryEntry;

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
  discoveries?: DiscoveryEntry[];
  damagedEvidence?: { itemId: string; sourceName: string };
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

export type TickMode = "player_turn" | "simulation";

export type TickResult =
  | { type: "completed"; actions: CharacterAction[] }
  | {
      type: "player_interrupt";
      actions: CharacterAction[];
      witnessEvents: PlayerWitnessEvent[];
      /** Minutes remaining after this interrupt */
      remainingMinutes: number;
      /** Game-time minute offset to resume from */
      resumeFromMinutes: number;
      gameDay: number;
    };

export interface SimulationTickResult {
  actions: CharacterAction[];
  events: SimulationEvent[];
  dayChanged: boolean;
}

