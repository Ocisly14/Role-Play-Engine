// StateResolution currently lives at src/engine/types.ts (marked @deprecated there).
// Cleaning up resolver output types is out of scope for this refactor; we use
// the type as-is for now.
import type { StateResolution } from "../types.js";

export type FeatureStateScope = "scene" | "region" | "character" | "global";

export interface GameTime {
  day: number;
  tickTime: string; // "HH:MM"
}

export type Unsubscribe = () => void;

/**
 * Structured character-level condition. Symmetric with SceneCondition.
 * Replaces the old `status.conditions: string[]` representation.
 */
export interface CharacterCondition {
  id: string; // unique per character; targeted by character.removeCondition
  featureId?: string; // owner feature (for observability / cleanup by featureId)
  description: string; // human/LLM-readable
  data?: Record<string, unknown>; // feature-private metadata
  mechanicalEffect?: {
    skillPenalty?: Record<string, number>;
    attackPenalty?: number;
  };
  expiresAt?: GameTime; // optional auto-expiry (not enforced by Applier — features check)
}

export interface ActionInput {
  characterId: string;
  actionText: string;
  targetCharacterIds?: string[];
  sceneId: string;
  overlayFields?: Record<string, unknown>;
}

export interface ActionHandle {
  readonly id: string;
  readonly characterId: string;
  readonly submittedAt: GameTime;
}

export type ActionStatus =
  | "queued"
  | "active"
  | "completed"
  | "interrupted"
  | "cancelled";

export interface ActionStep {
  id: string;
  handle: ActionHandle;
  stepGroupId: string;
  stepIndex: number;

  characterId: string;
  targetCharacterIds: string[];
  actionText: string;
  definitionId: string;
  executionSceneId: string;
  overlayFields?: Record<string, unknown>;

  submittedAt: GameTime;

  activatedAt?: GameTime;
  plannedDuration?: number;
  plannedOutcome?: StateResolution;
  completionTime?: GameTime;

  status: ActionStatus;
}

export interface InterruptReason {
  triggerKind: "encounter" | "featureEvent" | "stateChange" | "other";
  description: string;
}

export interface CancelResult {
  applied: boolean;
  remainingChainCancelled: number;
}

export interface InterruptResult {
  applied: boolean;
  remainingChainCancelled: number;
  partialOutcome?: StateResolution;
}

export interface SceneCondition {
  featureId?: string;
  data?: Record<string, unknown>;
  mechanicalEffect?: {
    skillPenalty?: Record<string, number>;
    blockConnections?: boolean;
  };
  description: string;
}

export type ConditionPredicate = { featureId: string };

export interface FeatureEvent {
  type: string;
  characterId?: string;
  sceneId?: string;
  data?: Record<string, unknown>;
}

export type StateChange =
  | { kind: "scene.addCondition"; sceneId: string; condition: SceneCondition }
  | {
      kind: "scene.removeCondition";
      sceneId: string;
      predicate: ConditionPredicate;
    }
  | {
      kind: "character.hp";
      characterId: string;
      delta: number;
      sourceFeatureId: string;
      reason: string;
    }
  | {
      kind: "character.san";
      characterId: string;
      delta: number;
      sourceFeatureId: string;
      reason: string;
    }
  | {
      kind: "character.fatigue";
      characterId: string;
      delta: number;
      sourceFeatureId: string;
      reason: string;
    }
  | {
      kind: "character.addCondition";
      characterId: string;
      condition: CharacterCondition;
    }
  | {
      kind: "character.removeCondition";
      characterId: string;
      conditionId: string;
    }
  | {
      kind: "connection.setBlock";
      connectionId: string;
      blocked: boolean;
      sourceFeatureId: string;
      reason: string;
    }
  | {
      kind: "feature.setState";
      featureId: string;
      key: string;
      state: unknown;
    }
  | { kind: "feature.removeState"; featureId: string; key: string }
  | { kind: "event.emit"; event: FeatureEvent };

export interface CharacterAction {
  characterId: string;
  handleId: string;
  stepGroupId: string;
  stepIndex: number;
  definitionId: string;
  actionText: string;
  sceneId: string;
  targetCharacterIds: string[];
  activatedAt: GameTime;
  completedAt: GameTime;
  outcome?: StateResolution;
}

export interface DamageReport {
  characterId: string;
  field: "hp" | "san" | "fatigue";
  contributors: Array<{ featureId: string; delta: number; reason: string }>;
  finalValueAfter: number;
  died: boolean;
}

// No standalone EncounterDetection type: encounters are emitted as
// FeatureEvents with type "encounter.detected", so role sim consumes a single
// unified event channel. See B4 EmergentEventEmitter.

export interface TickReport {
  tickTime: GameTime;
  commits: CharacterAction[];
  interruptions: Array<{ action: CharacterAction; reason: InterruptReason }>;
  cancellations: CharacterAction[];
  featureEvents: FeatureEvent[];
  stateChanges: StateChange[];
  damageReports: DamageReport[];
}
