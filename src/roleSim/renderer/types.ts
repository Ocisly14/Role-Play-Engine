// src/roleSim/renderer/types.ts
//
// Renderer contracts (plan Phase 9). The Engine emits objective Occurrences
// with perceiver character ids; the controller groups them per character; the
// renderer turns one character's occurrences + their own state into a
// first-person sensory narrative. The renderer decides WHAT of
// each occurrence this character actually perceives (per signals, location,
// senses) — the Engine never provides per-character fact subsets.

import type { Occurrence } from "../../engine/actions/types.js";
import type {
  CharacterCondition,
  GameTime,
  SceneCondition,
} from "../../engine/core/types.js";

/** Posture of the viewpoint NPC's own action this tick. Read from the
 *  EngineAction lifecycle — intent, progress and timing only, never engine
 *  runtime internals. */
export type OwnActionState =
  | {
      kind: "ongoing";
      description: string;
      startedAt?: GameTime;
      progressMinutes: number;
      resolvedDurationTicks?: number;
    }
  | {
      kind: "ended";
      description: string;
      status: "completed" | "failed" | "interrupted" | "cancelled";
      /** Engine judgement surface: objective outcome + reason, when known. */
      outcome?: { outcome: string; reason?: string };
    }
  | { kind: "idle" };

/** Per-NPC perception input handed to the renderer. */
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
  /** Action posture this tick. */
  ownAction: OwnActionState;
  /** The tick's objective occurrences this character was listed as able to
   *  perceive (plus subsystem/scripted events adapted into occurrence form).
   *  The renderer decides what of each is actually perceived. May be empty. */
  occurrences: Occurrence[];
  /** Every other alive character standing in the viewpoint's scene right now,
   *  whether or not they did anything this tick. Default perception: presence,
   *  appearance, externally-visible conditions, and their in-flight action's
   *  intent description (if any). Excludes self. */
  charactersInScene: ScenePresentCharacter[];
}

export interface ScenePresentCharacter {
  id: string;
  name: string;
  appearance?: string;
  /** Conditions on this character. Renderer downstream still filters to
   *  externally-perceivable ones per the system-prompt rule. */
  conditions: CharacterCondition[];
  /** Current in-flight action intent (EngineAction.command.description), if
   *  the character is mid-action. Undefined = idle. */
  currentActionText?: string;
}

export interface RenderedPerception {
  /** Narrative fed into the agent prompt. Prose with the citation tags
   *  written into it (`the tall pale man [stranger_a]`): what the actor may
   *  point at is whatever the paragraph tagged, and nothing else. */
  narrative: string;
}
