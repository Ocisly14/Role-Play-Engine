// src/roleSim/llmAgent.ts
//
// Phase F LLM-driven RoleSimAgent. One decide() opens a fresh agent loop:
// each iteration sends the full ctx + transcript-so-far as one user prompt,
// the LLM emits a single JSON tool call, instant tools loop back, terminal
// tools (act/continue) end the loop and return the decision to the
// controller. No native Anthropic tool_use API — same generateText +
// parseJsonResponse path as the rest of the project.

import type { ActionObjectRef } from "../engine/actions/types.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import { ModelClass, generateToolCalls } from "../models/index.js";
import type {
  ModelMessage,
  ToolResultRecord,
} from "../models/providers/types.js";
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
import { AGENT_TOOLS } from "./tools/schemas.js";
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
  /** The tool call the model made. Always set on the native tool path. */
  parsed?: { tool: string; [k: string]: unknown };
  /** Set if parseJsonResponse threw. The agent will return `continue`. */
  /** Legacy text-JSON path only; never set now that the provider enforces
   *  the tool envelope. Kept so existing run records still typecheck. */
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

    // The opening user turn holds the whole situation. Instant-tool rounds
    // append an assistant turn plus its tool result, so the prefix only ever
    // grows — every earlier turn stays byte-identical and stays cacheable.
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: buildUserPromptSegments(ctx, [], {
          language: this.deps.language,
          dgsm: this.deps.dgsm,
        }).map((segment) => ({
          kind: "text" as const,
          text: segment.text,
          cacheControl: segment.cache,
        })),
      },
    ];

    for (let i = 0; i < MAX_TOTAL_ITERATIONS; i++) {
      const { toolCalls, assistantMessage } = await generateToolCalls({
        customSystemPrompt: SYSTEM_PROMPT,
        // SYSTEM_PROMPT is assembled once at module import from constant tool
        // docs — ~12k chars, byte-identical for every NPC on every tick. The
        // breakpoint here also covers the tool definitions, which render
        // ahead of the system prompt.
        cacheSystemPrompt: true,
        messages,
        tools: AGENT_TOOLS,
        // The model must call something: this is what removes the old failure
        // mode where it answered in prose and the decision was discarded.
        toolChoice: "any",
        // Instant-tool queries are independent of each other, so batching
        // them saves round trips. Every returned call is answered below.
        allowParallelCalls: true,
        modelClass: ModelClass.MEDIUM,
        operation: "role-sim-agent",
      });

      for (const call of toolCalls) {
        this.deps.onIteration?.({
          npcId: ctx.npcId,
          iteration: i,
          responseText: JSON.stringify(call.args),
          parsed: { tool: call.name, ...call.args },
        });
      }

      const terminal = toolCalls.filter((c) => TERMINAL_TOOLS.has(c.name));
      const instant = toolCalls.filter((c) => !TERMINAL_TOOLS.has(c.name));

      // A clean terminal turn ends the decision. Nothing further is sent, so
      // the tool call needs no result.
      if (terminal.length > 0 && instant.length === 0) {
        return this.buildTerminalDecision({
          tool: terminal[0].name,
          ...terminal[0].args,
        });
      }

      // Otherwise every call must be answered — including a terminal one the
      // model mixed in, which is reported as not executed rather than being
      // silently dropped, so it can correct itself on the next turn.
      messages.push(assistantMessage);
      const results: ToolResultRecord[] = [];

      for (const call of toolCalls) {
        if (TERMINAL_TOOLS.has(call.name)) {
          results.push({
            toolCallId: call.id,
            content: `Error: "${call.name}" was NOT executed. A turn may contain either informational tools or one terminal tool (act/continue), never both. Finish your lookups, then commit in a turn of its own.`,
          });
          continue;
        }

        if (!VALID_TOOLS.has(call.name)) {
          results.push({
            toolCallId: call.id,
            content: `Error: unknown tool "${call.name}".`,
          });
          continue;
        }

        const dispatched = await dispatchInstantTool(
          call.name,
          call.args,
          caps,
          dispatcherDeps
        );
        results.push({ toolCallId: call.id, content: dispatched.result });
      }

      messages.push({ role: "tool", results });
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
      // Pass the raw args through with only light shape coercion. Real
      // validation (ref scope, duration bounds, skill existence) is the
      // trust boundary's job in commandBuilder/commandValidator — errors
      // there come back to the agent as rejection feedback.
      const refs = Array.isArray(parsed.objectRefs) ? parsed.objectRefs : [];
      return {
        tool: "act",
        description: String(parsed.description ?? ""),
        objectRefs: refs as ActionObjectRef[],
        proposedDurationTicks: Number(parsed.proposedDurationTicks),
        skillId:
          typeof parsed.skillId === "string" && parsed.skillId.trim() !== ""
            ? parsed.skillId
            : undefined,
        utterance:
          typeof parsed.utterance === "string" && parsed.utterance !== ""
            ? parsed.utterance
            : undefined,
      };
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
