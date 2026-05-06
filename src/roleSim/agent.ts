// src/roleSim/agent.ts
//
// RoleSimAgent — the per-NPC behavior layer interface. Phase F implementation
// is `LLMRoleSimAgent` (llmAgent.ts), which runs an agent-loop using
// generateText + parseJsonResponse. Engine handles never appear in
// agent-facing types: the engine is the source of truth for in-flight state;
// controller queries it on demand instead of mirroring it.

import type {
  CharacterAction,
  FeatureEvent,
  GameTime,
} from "../engine/core/types.js";
import type { NpcMemoryType } from "../memory/types.js";
import type { DynamicNPCProfile } from "../state/types.js";

export type RoleSimDecision =
  | {
      tool: "act";
      input: { actionText: string; targetCharacterIds?: string[] };
    }
  | { tool: "continue"; reason?: string }
  | {
      tool: "writeMemory";
      type: NpcMemoryType;
      content?: string;
      mapAdd?: {
        sceneNames?: string[];
        junctionNames?: string[];
        roadNames?: string[];
        revealHiddenConnection?: string;
      };
    }
  | {
      tool: "recallMemory";
      query?: string;
      types?: NpcMemoryType[];
      gameDate?: string;
      limit?: number;
    }
  | { tool: "getMapSnapshot" };

export interface RoleSimContext {
  npcId: string;
  currentTime: GameTime;
  npcProfile: DynamicNPCProfile;
  currentScene: string;
  /** In-flight action, if any. NO handle field — handle is engine-internal.
   *  When agent decides `act` while currentAction is defined, the controller
   *  queries the engine for the active handle and cancels it (Decision 14). */
  currentAction?: { actionText: string };
  recentMemory: ReadonlyArray<{
    type: string;
    content: string;
    gameDateTime: string;
  }>;
  longTermIntent?: string;
  /** Present iff this tick produced revise-relevant events affecting this NPC
   *  (per impactPropagation). All triggers from one tick are batched here so
   *  the agent makes a single combined-context decision rather than reacting
   *  to each event in isolation. Absent when the tick had no revise events
   *  for this NPC. Decision 16 (revised 2026-04-24). */
  reviseTriggers?: ReadonlyArray<{
    description: string;
    sourceEvent?: FeatureEvent | CharacterAction;
  }>;
  /** Renderer-layer perception output (Decision 10). Empty during Phase F
   *  (Decision 11 — renderer deferred). */
  perception?: {
    narrative: string;
    perceivedFacts?: unknown[];
  };
}

export interface RoleSimAgent {
  decideNext(ctx: RoleSimContext): Promise<RoleSimDecision>;
}
