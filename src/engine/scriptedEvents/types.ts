import type { FeatureReadContext } from "../core/featureReadContext.js";
import type {
  CharacterAction,
  SceneCondition,
  StateChange,
} from "../core/types.js";

export interface ScriptedEvent {
  id: string;
  label: string;
  enabled: boolean;
  conductorNpcId?: string;
  siteSceneId?: string;
  conditions: ScriptedEventCondition[];
  onComplete: ScriptedEventEffect[];
  onFail?: ScriptedEventEffect[];
}

export type ScriptedEventCondition =
  | { type: "daily"; triggerDefinitionId: string; failAfterMissed: number }
  | { type: "cumulative"; triggerDefinitionId: string; requiredCount: number }
  | {
      type: "prerequisite";
      locationId?: string;
      itemId?: string;
      mode: "manual" | "passive";
    };

export type ScriptedEventEffect =
  | {
      kind: "scene.addCondition";
      sceneId?: string;
      condition: SceneCondition;
    }
  | {
      kind: "character.san";
      predicate: "witnesses" | "global" | { characterIds: string[] };
      delta: number;
    }
  | {
      kind: "character.hp";
      predicate: "witnesses" | "global" | { characterIds: string[] };
      delta: number;
    }
  | { kind: "trigger"; otherEventId: string };

export type ScriptedEventProgress =
  | {
      type: "daily";
      fulfilledToday: boolean;
      lastFulfilledDay: number;
      consecutiveMissed: number;
    }
  | { type: "cumulative"; currentCount: number }
  | { type: "prerequisite"; fulfilled: boolean };

export interface ScriptedEventReadContext extends FeatureReadContext {
  getCommittedActionsThisTick(): ReadonlyArray<CharacterAction>;
  getCommittedActionsByCharacter(
    characterId: string,
  ): ReadonlyArray<CharacterAction>;
  getAccumulatedStateChanges(): ReadonlyArray<StateChange>;
  getEventProgress(eventId: string): ScriptedEventProgress | undefined;
}
