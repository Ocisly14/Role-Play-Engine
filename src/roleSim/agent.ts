// src/roleSim/agent.ts
//
// RoleSimAgent — the per-NPC behavior layer interface. Phase F implementation
// is `LLMRoleSimAgent` (llmAgent.ts), which runs an agent-loop using
// generateText + parseJsonResponse. Engine handles never appear in
// agent-facing types: the engine is the source of truth for in-flight state;
// controller queries it on demand instead of mirroring it.

import type { GameTime } from "../engine/core/types.js";
import type { NpcMemoryType } from "../memory/types.js";
import type { DynamicNPCProfile } from "../state/types.js";

export type RoleSimDecision =
  | {
      tool: "act";
      actionText: string;
      // targetCharacterIds removed (Phase H D2) — agent emits citations [Name]
      // in actionText; GameInterpreter resolves to ActionStep.referencedEntities.
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
      gameDates?: string[];
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
    /** Human-readable location name (resolved from sceneId), if known.
     *  Surfaced inline in the memory section to give spatial context. */
    location?: string;
  }>;
  longTermIntent?: string;
  /** Renderer-layer perception output (G1 / G6). One first-person citation-
   *  annotated paragraph that subsumes the prior `reviseTriggers` god-eye
   *  list — the agent reads what just happened from the rendered narrative,
   *  not from a parallel structured trigger list. */
  perception?: {
    narrative: string;
  };
  /** Short-term working memory: prior renderer narratives this NPC has seen,
   *  in chronological order (oldest first). Excludes the current tick (which
   *  is in `perception.narrative`). Controller maintains a per-NPC ring
   *  buffer; only successful renders enter the buffer. */
  recentPerceptions?: ReadonlyArray<{
    gameDateTime: GameTime;
    narrative: string;
  }>;
}

export interface RoleSimAgent {
  decideNext(ctx: RoleSimContext): Promise<RoleSimDecision>;
}
