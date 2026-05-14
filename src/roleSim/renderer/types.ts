// src/roleSim/renderer/types.ts
//
// Phase G renderer types. The renderer turns a tick's events + DGSM state
// into a per-NPC, first-person, citation-annotated narrative consumed by
// `agent.decideNext`. See plan §G-decisions for the full contract.

import type {
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
      status: "committed" | "interrupted" | "cancelled";
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
}

export interface RenderedPerception {
  /** Final narrative + reference text fed into the agent prompt. */
  narrative: string;
}
