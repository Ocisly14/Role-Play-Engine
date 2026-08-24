// src/roleSim/renderer/types.ts
//
// Phase G renderer types. The renderer turns a tick's events + DGSM state
// into a per-NPC, first-person, citation-annotated narrative consumed by
// `agent.decideNext`. See plan §G-decisions for the full contract.

import type {
  CharacterAction,
  CharacterCondition,
  FeatureEvent,
  SceneCondition,
} from "../../engine/core/types.js";

/** Posture of the viewpoint NPC's own action this tick (G10). */
export type OwnActionState =
  | { kind: "ongoing"; actionText: string }
  | {
      kind: "ended";
      actionText: string;
      status: "committed" | "cancelled";
    }
  | { kind: "idle" };

/** Per-NPC perception input handed to the renderer (G7 + G10). */
export interface PerceivedBundle {
  /** Always present — scene the NPC currently inhabits. */
  scene: {
    id: string;
    name: string;
    description: string;
    activeConditions: SceneCondition[];
  };
  /** Viewpoint NPC's own active conditions (proprioceptive — fully visible to self). */
  ownConditions: CharacterCondition[];
  /** Action posture this tick (G10). */
  ownAction: OwnActionState;
  /** Subset of TickReport.featureEvents that propagated to this NPC. May be empty. */
  events: FeatureEvent[];
  /** Subset of TickReport.commits whose impact reached this NPC. May be empty.
   *  Excludes the viewpoint NPC's own action (already in `ownAction`). */
  perceivedActions: CharacterAction[];
  /** Every other alive character standing in the viewpoint's scene right now,
   *  whether or not they did anything this tick. Default perception: presence,
   *  appearance, externally-visible conditions, and the actionText of their
   *  currently-active step (if any). Excludes self. */
  charactersInScene: ScenePresentCharacter[];
}

export interface ScenePresentCharacter {
  id: string;
  name: string;
  appearance?: string;
  /** Conditions on this character. Renderer downstream still filters to
   *  externally-perceivable ones per the system-prompt rule. */
  conditions: CharacterCondition[];
  /** Current in-flight action text (from engine queue), if the character is
   *  mid-action. Undefined = the character is idle / between actions. */
  currentActionText?: string;
}

export interface RenderedPerception {
  /** Final narrative + reference text fed into the agent prompt. */
  narrative: string;
}
