// src/roleSim/llmAgent.ts
//
// Phase F LLM-driven RoleSimAgent. One decide() opens a fresh agent loop:
// each iteration sends the full ctx + transcript-so-far as one user prompt,
// the LLM emits a single JSON tool call, instant tools loop back, terminal
// tools (act/continue) end the loop and return the decision to the
// controller. No native Anthropic tool_use API — same generateText +
// parseJsonResponse path as the rest of the project.

import { parseJsonResponse } from "../engine/shared/jsonParse.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import { ModelClass, generateText } from "../models/index.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { RoleSimAgent, RoleSimContext, RoleSimDecision } from "./agent.js";
import {
  type DispatcherDeps,
  TERMINAL_TOOLS,
  TOOL_CAPS,
  VALID_TOOLS,
  dispatchInstantTool,
} from "./toolDispatcher.js";

const MAX_TOTAL_ITERATIONS = 14;

const PHASE_F_PLACEHOLDER_SYSTEM_PROMPT = `
You are an NPC in a Call of Cthulhu tabletop RPG simulation. Each turn you receive your current
context (your profile, time of day, long-term intent, recent memories, current action if any,
and possibly a notification of something that just happened around you) and must choose what to
do next using the provided tools.

Tools that consume a tick (terminate this decision — you must end with exactly one):
- act(actionText, targetCharacterIds?): take a physical action in the world (move, examine, talk,
  attack, etc.). If you currently have an in-flight action, calling act will CANCEL it and start
  the new one — use this when something happens that makes you want to switch focus.
- continue(reason?): do nothing new; if you have an in-flight action let it keep running, otherwise
  let time pass.

Tools that don't consume a tick (loop continues, you can chain multiple before terminating):
- writeMemory(type, content | mapAdd): record a thought/plan/belief/secret/etc. to your memory.
  Memory types: event, witness, information, map, belief, plan, secret, summary, long_term_intent.
  For type="map", supply mapAdd: { sceneNames?, junctionNames?, roadNames?, revealHiddenConnection? }.
- recallMemory(query?, types?, gameDay?, limit?): query your past memories.
- getMapSnapshot(): view your known map of places.

You must end every decision by calling exactly one of: act, continue.

Respond with ONE JSON object per turn, e.g.:
{ "tool": "recallMemory", "query": "smith" }
or
{ "tool": "act", "input": { "actionText": "go to the library" } }
or
{ "tool": "continue", "reason": "still finishing the book" }
`.trim();

export interface LLMRoleSimAgentDeps {
  memory: NpcMemoryManager;
  dgsm: DynamicGameStateManager;
  sessionId: string;
  moduleId: string;
  language: string;
}

export class LLMRoleSimAgent implements RoleSimAgent {
  constructor(private deps: LLMRoleSimAgentDeps) {}

  async decideNext(ctx: RoleSimContext): Promise<RoleSimDecision> {
    const caps = { ...TOOL_CAPS };
    const dispatcherDeps = this.buildDispatcherDeps(ctx);
    const transcript: string[] = [];

    for (let i = 0; i < MAX_TOTAL_ITERATIONS; i++) {
      const userPrompt = this.buildUserPrompt(ctx, transcript);

      const responseText = await generateText({
        customSystemPrompt: PHASE_F_PLACEHOLDER_SYSTEM_PROMPT,
        context: userPrompt,
        modelClass: ModelClass.MEDIUM,
        operation: "role-sim-agent",
      });

      let parsed: { tool: string; [k: string]: unknown };
      try {
        parsed = parseJsonResponse<{ tool: string; [k: string]: unknown }>(
          responseText
        );
      } catch {
        console.warn(
          `[LLMRoleSimAgent] ${ctx.npcId} returned non-JSON — falling back to continue`
        );
        return { tool: "continue", reason: "implicit (no JSON tool call)" };
      }

      if (!parsed.tool || !VALID_TOOLS.has(parsed.tool)) {
        transcript.push(
          this.formatToolError(parsed.tool, "Unknown tool name.")
        );
        continue;
      }

      if (TERMINAL_TOOLS.has(parsed.tool)) {
        return this.buildTerminalDecision(parsed);
      }

      const dispatched = await dispatchInstantTool(
        parsed.tool,
        parsed,
        caps,
        dispatcherDeps
      );
      transcript.push(this.formatToolCall(parsed));
      transcript.push(this.formatToolResult(dispatched.result));
    }

    console.warn(
      `[LLMRoleSimAgent] ${ctx.npcId} hit MAX_TOTAL_ITERATIONS without terminating — forcing continue`
    );
    return { tool: "continue", reason: "iteration cap (forced)" };
  }

  private buildTerminalDecision(parsed: {
    tool: string;
    [k: string]: unknown;
  }): RoleSimDecision {
    if (parsed.tool === "act") {
      const inputBlob = (parsed.input ?? parsed) as Record<string, unknown>;
      const actionText = String(inputBlob.actionText ?? "");
      const targetCharacterIds = Array.isArray(inputBlob.targetCharacterIds)
        ? (inputBlob.targetCharacterIds as string[])
        : undefined;
      return { tool: "act", input: { actionText, targetCharacterIds } };
    }
    return {
      tool: "continue",
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
  }

  private buildUserPrompt(ctx: RoleSimContext, transcript: string[]): string {
    const lines: string[] = [];
    lines.push(`# You are ${ctx.npcProfile.name}`);
    lines.push(`Time: Day ${ctx.currentTime.day}, ${ctx.currentTime.tickTime}`);
    lines.push(`Current scene: ${ctx.currentScene}`);
    if (ctx.longTermIntent) {
      lines.push(`\n## Your long-term intent\n${ctx.longTermIntent}`);
    }
    if (ctx.currentAction) {
      lines.push(`\n## Currently doing\n"${ctx.currentAction.actionText}"`);
    }
    if (ctx.reviseTriggers && ctx.reviseTriggers.length > 0) {
      lines.push(`\n## Things that just happened around you (this tick)`);
      for (const t of ctx.reviseTriggers) {
        lines.push(`- ${t.description}`);
      }
    }
    if (ctx.perception?.narrative) {
      lines.push(`\n## What you perceive\n${ctx.perception.narrative}`);
    }
    if (ctx.recentMemory.length > 0) {
      lines.push(`\n## Recent memories`);
      for (const m of ctx.recentMemory) {
        lines.push(`- [${m.gameTime}] (${m.type}) ${m.content}`);
      }
    }
    if (transcript.length > 0) {
      lines.push(
        `\n## Tool calls so far this decision\n${transcript.join("\n")}`
      );
    }
    lines.push(
      `\nDecide your next action using the tools described in the system prompt. Output a single JSON object.`
    );
    return lines.join("\n");
  }

  private formatToolCall(parsed: {
    tool: string;
    [k: string]: unknown;
  }): string {
    return `→ Called: ${JSON.stringify(parsed)}`;
  }
  private formatToolResult(result: string): string {
    return `← Result: ${result}`;
  }
  private formatToolError(toolName: unknown, msg: string): string {
    return `← Error for "${String(toolName)}": ${msg}`;
  }

  private buildDispatcherDeps(ctx: RoleSimContext): DispatcherDeps {
    return {
      memory: this.deps.memory,
      dgsm: this.deps.dgsm,
      npcId: ctx.npcId,
      sessionId: this.deps.sessionId,
      moduleId: this.deps.moduleId,
      gameDay: ctx.currentTime.day,
      gameTime: ctx.currentTime.tickTime,
    };
  }
}
