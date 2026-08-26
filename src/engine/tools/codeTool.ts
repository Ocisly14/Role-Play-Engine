// src/engine/tools/codeTool.ts
//
// Engine-internal deterministic code tools (plan §4.4 / Phase 5). These are
// trusted capabilities the unified World Action Engine calls while resolving
// `act` commands — pathfinding, movement cost, inventory validation, opposed
// rolls, damage dice. They are NOT agent-facing tools and are never routed by
// an action kind: the Engine decides from `description + objectRefs` which
// capability it needs.
//
// Contract:
// - read-only over world state: a code tool never calls a DGSM mutator;
// - deterministic given its inputs (dice tools take an injectable rng so
//   replays can pin outcomes);
// - JSON-safe inputs and outputs, recorded per invocation with the calling
//   actionId for persistence/replay/audit;
// - no character-perspective text — objective facts and numbers only.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";

export interface CodeToolContext {
  /** Read-only by contract — tools must not call mutators. Final changes are
   *  always emitted by the Engine and committed through the Applier. */
  dgsm: DynamicGameStateManager;
  /** The action whose resolution triggered this call (for the audit trail). */
  actionId?: string;
}

export interface EngineCodeTool<I = unknown, O = unknown> {
  readonly name: string;
  readonly description: string;
  execute(input: I, ctx: CodeToolContext): O | Promise<O>;
}

/** Persistable record of one code-tool call. */
export interface CodeToolInvocation {
  toolName: string;
  actionId?: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

export class CodeToolRegistry {
  private tools = new Map<string, EngineCodeTool>();
  private invocations: CodeToolInvocation[] = [];

  register<I, O>(tool: EngineCodeTool<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`code tool "${tool.name}" is already registered`);
    }
    // One internal widening cast; `run` re-narrows via its type parameter.
    this.tools.set(tool.name, tool as unknown as EngineCodeTool);
  }

  get(name: string): EngineCodeTool | undefined {
    return this.tools.get(name);
  }

  list(): string[] {
    return [...this.tools.keys()];
  }

  /** Execute a tool and record the invocation (input, output/error and the
   *  calling actionId). Unknown tool names throw — the Engine's tool set is
   *  fixed code, not model-extensible. */
  async run<O = unknown>(
    name: string,
    input: unknown,
    ctx: CodeToolContext
  ): Promise<O> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`unknown code tool "${name}"`);
    const record: CodeToolInvocation = {
      toolName: name,
      ...(ctx.actionId !== undefined ? { actionId: ctx.actionId } : {}),
      input,
    };
    try {
      const output = await tool.execute(input, ctx);
      record.output = output;
      this.invocations.push(record);
      return output as O;
    } catch (err) {
      record.error = err instanceof Error ? err.message : String(err);
      this.invocations.push(record);
      throw err;
    }
  }

  /** Return and clear the invocation log (drained per tick into the trace). */
  drainInvocations(): CodeToolInvocation[] {
    const drained = this.invocations;
    this.invocations = [];
    return drained;
  }
}
