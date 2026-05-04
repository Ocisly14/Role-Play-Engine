// src/roleSim/agent.ts
//
// RoleSimAgent — the per-NPC behavior layer interface. Phase E ships only
// `NpcAgentAdapter` (wraps the existing NPCPlanningAgent and emits
// `act` / `wait`); Phase F ships the true tool-driven LLM agent that can also
// emit `plan` and `interrupt`.
//
// The discriminated `RoleSimDecision` union deliberately includes all four
// tools now so the type contract doesn't churn when Phase F + the renderer
// land. The Phase E adapter simply never returns `plan` or `interrupt`.

import type {
  ActionHandle,
  ActionInput,
  GameTime,
  InterruptReason,
} from "../engine/core/types.js";
import type { DynamicNPCProfile } from "../state/types.js";

export interface RoleSimContext {
  npcId: string;
  currentTime: GameTime;
  npcProfile: DynamicNPCProfile;
  currentScene: string;
  currentAction?: { handle: ActionHandle; actionText: string };
  recentMemory: ReadonlyArray<{
    type: string;
    content: string;
    gameDay: number;
    gameTime: string;
  }>;
  longTermIntent?: string;
  // perceivedFacts?: PerceivedFact[];  // ← added back when renderer ships
}

export type RoleSimDecision =
  | { tool: "act"; input: ActionInput }
  | { tool: "plan"; planText: string }
  | { tool: "interrupt"; handle: ActionHandle; reason: InterruptReason }
  | { tool: "wait"; untilTime?: GameTime; reason?: string };

export interface RoleSimAgent {
  decideNext(ctx: RoleSimContext): Promise<RoleSimDecision>;
}
