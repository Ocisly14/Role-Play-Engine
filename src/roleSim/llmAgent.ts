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
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import {
  type DispatcherDeps,
  TERMINAL_TOOLS,
  TOOL_CAPS,
  VALID_TOOLS,
  dispatchInstantTool,
} from "./toolDispatcher.js";
import { buildUserPromptSegments } from "./userPromptBuilder.js";

const MAX_TOTAL_ITERATIONS = 14;

/** Observability event emitted once per agent-loop iteration before the
 *  iteration's effect runs (instant tool dispatch / terminal return).
 *  Lets tests capture the full chain of LLM reasoning for one decide(). */
export interface AgentIterationEvent {
  npcId: string;
  /** 0-based iteration index inside this decide() loop. */
  iteration: number;
  /** Raw text emitted by the LLM for this iteration. */
  responseText: string;
  /** Parsed JSON tool call. Undefined if `parseError` is set. */
  parsed?: { tool: string; [k: string]: unknown };
  /** Set if parseJsonResponse threw. The agent will return `continue`. */
  parseError?: string;
}

export interface LLMRoleSimAgentDeps {
  memory: NpcMemoryManager;
  dgsm: DynamicGameStateManager;
  sessionId: string;
  moduleId: string;
  language: string;
  /** Optional iteration-level trace hook. Called after parsing each LLM
   *  response, before dispatching the tool. Use it from tests/debuggers to
   *  capture full agent reasoning without coupling to the model wrapper. */
  onIteration?: (event: AgentIterationEvent) => void;
}

export class LLMRoleSimAgent implements RoleSimAgent {
  constructor(private deps: LLMRoleSimAgentDeps) {}

  async decideNext(ctx: RoleSimContext): Promise<RoleSimDecision> {
    const caps = { ...TOOL_CAPS };
    const dispatcherDeps = this.buildDispatcherDeps(ctx);
    const transcript: string[] = [];

    for (let i = 0; i < MAX_TOTAL_ITERATIONS; i++) {
      // Segmented so the tick-invariant prefix (system prompt + identity +
      // situation) carries a prompt-cache breakpoint: this loop re-sends it
      // unchanged on every iteration, and it is by far the largest part of
      // the prompt. Concatenating the segments reproduces the old single
      // string byte for byte, so non-Anthropic providers are unaffected.
      const promptSegments = buildUserPromptSegments(ctx, transcript, {
        language: this.deps.language,
        dgsm: this.deps.dgsm,
      });

      const responseText = await generateText({
        customSystemPrompt: SYSTEM_PROMPT,
        // SYSTEM_PROMPT is assembled once at module import from constant tool
        // docs — ~12k chars, byte-identical for every NPC on every tick, and
        // the largest single block in this call site's ~6.9k-token prompt.
        // Every agent call in the session reads this one cache entry.
        cacheSystemPrompt: true,
        context: "",
        contextSegments: promptSegments,
        modelClass: ModelClass.MEDIUM,
        operation: "role-sim-agent",
      });

      let parsed: { tool: string; [k: string]: unknown };
      try {
        parsed = parseJsonResponse<{ tool: string; [k: string]: unknown }>(
          responseText
        );
      } catch (err) {
        this.deps.onIteration?.({
          npcId: ctx.npcId,
          iteration: i,
          responseText,
          parseError: err instanceof Error ? err.message : String(err),
        });
        console.warn(
          `[LLMRoleSimAgent] ${ctx.npcId} returned non-JSON — falling back to continue`
        );
        return { tool: "continue", reason: "implicit (no JSON tool call)" };
      }

      this.deps.onIteration?.({
        npcId: ctx.npcId,
        iteration: i,
        responseText,
        parsed,
      });

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
      const actionText = String(parsed.actionText ?? "");
      return { tool: "act", actionText };
    }
    return {
      tool: "continue",
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
    };
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
      gameDateTime: ctx.currentTime,
    };
  }
}
