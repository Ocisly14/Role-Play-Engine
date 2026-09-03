// src/roleSim/agent.ts
//
// RoleSimAgent — the per-NPC behavior layer interface. Phase F implementation
// is `LLMRoleSimAgent` (llmAgent.ts), which runs an agent-loop using
// generateText + parseJsonResponse. Engine handles never appear in
// agent-facing types: the engine is the source of truth for in-flight state;
// controller queries it on demand instead of mirroring it.

import type { ActionObjectRef } from "../engine/actions/types.js";
import type { GameTime } from "../engine/core/types.js";
import type { NpcMemoryType } from "../memory/types.js";
import type { DynamicNPCProfile } from "../state/types.js";

export type RoleSimDecision =
  | {
      tool: "act";
      /** Structured intent (plan 2026-08-26 D2). Untrusted model output —
       *  the controller's commandBuilder validates and wraps it into a
       *  trusted ActionCommand. */
      description: string;
      objectRefs: ActionObjectRef[];
      proposedDurationTicks: number;
      skillId?: string;
      language?: string;
      utterance?: string;
    }
  | { tool: "continue"; reason?: string }
  | {
      tool: "writeMemory";
      type: NpcMemoryType;
      content?: string;
      targetId?: string;
    };

export interface RoleSimContext {
  npcId: string;
  currentTime: GameTime;
  npcProfile: DynamicNPCProfile;
  currentScene: string;
  /** In-flight action, if any. Intent + progress + timing only — NO engine
   *  ids or runtime internals. When the agent decides `act` while
   *  currentAction is defined, the controller submits a replacement command
   *  (old action is interrupted at resolution time, never pre-cancelled). */
  currentAction?: {
    description: string;
    startedAt?: GameTime;
    progressMinutes?: number;
    /** Engine-decided total duration in ticks (1 tick = 1 minute). */
    resolvedDurationTicks?: number;
  };
  /** Everything this character remembers, injected whole — there is no
   *  recall tool, so a memory absent from the prompt does not exist for
   *  them. Chronological order is applied by the formatter. */
  memories: ReadonlyArray<{
    /** Store row id — what the revise/retract path addresses. */
    id: string;
    /** The short name the character cites, minted when the memory was
     *  written and stored on the row. */
    handle: string;
    type: string;
    content: string;
    gameDateTime: string;
    /** Human-readable location name (resolved from sceneId), if known.
     *  Surfaced inline in the memory section to give spatial context. */
    location?: string;
  }>;
  /** Renderer-layer perception output (G1 / G6). One first-person citation-
   *  annotated paragraph that subsumes the prior `reviseTriggers` god-eye
   *  list — the agent reads what just happened from the rendered narrative,
   *  not from a parallel structured trigger list. */
  perception?: {
    narrative: string;
    /** Scene id it reached the character in. */
    location?: string;
  };
  /** Everything this NPC has perceived before this tick, in chronological
   *  order (oldest first) and uncapped — the current tick is in
   *  `perception.narrative`. Controller maintains the per-NPC log; only
   *  successful renders enter it. */
  recentPerceptions?: ReadonlyArray<{
    gameDateTime: GameTime;
    /** Scene id the character was in when it reached them. */
    location?: string;
    narrative: string;
  }>;
  /** Set on a retry pass: the intake rejected the agent's previous `act`
   *  command with this structured reason (invalid ref, bad duration, unknown
   *  skill, …). Rendered as factual feedback so the agent can re-decide. */
  rejectionFeedback?: string;
  /** Met Social / Investigation checks that were aimed at this character
   *  and ended this tick, already worded for them by `landedChecks.ts`: the
   *  other person's words could not be turned aside and an answer is owed.
   *  Which answer is not in here — that is the decision this prompt asks
   *  for. Absent when nothing landed. */
  landedChecks?: ReadonlyArray<string>;
}

export interface RoleSimAgent {
  decideNext(ctx: RoleSimContext): Promise<RoleSimDecision>;
}
