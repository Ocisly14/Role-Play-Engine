/**
 * Tick Orchestration Pattern
 *
 * Defines the tick execution flow independently of SimulationRunner.
 * Different consumers can use this pattern:
 * - SimulationRunner: continuous tick-by-tick simulation
 * - Future: single-action executor, replay, test harness
 *
 * Two execution modes:
 * - executeTick(): clean operations-based path (translate → execute → apply)
 * - runSimulationTick(): full simulation path (delegates to tickProcessor)
 */

import type { GameEngineRegistry } from "../engine/registry.js";
import { runSimulationTick as tickProcessorRun } from "../engine/runtime/tickProcessor.js";
import type {
  EngineNarrative,
  EngineToolCall,
  ExecutionContext,
} from "../engine/types.js";
import type { NpcMemoryManager } from "../memory/NpcMemoryManager.js";
import type { NPCPlanningAgent } from "../npc/planning/NPCPlanningAgent.js";
import type { SimulationTickResult } from "../npc/planning/types.js";
import type { PlanNode } from "../npc/planning/types.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";

export interface TickOrchestratorDeps {
  registry: GameEngineRegistry;
  translatePlanNode: (node: PlanNode) => EngineToolCall[];
}

export interface TickExecutionResult {
  /** All tool call results from this tick */
  results: Array<{
    toolId: string;
    delta: unknown;
    narrative: EngineNarrative;
  }>;
  /** All narratives collected from this tick */
  narratives: EngineNarrative[];
}

/**
 * Orchestrates a single tick's execution flow.
 * Decoupled from SimulationRunner — can be used by any consumer.
 */
export class TickOrchestrator {
  private deps: TickOrchestratorDeps;

  constructor(deps: TickOrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * Execute a tick using the clean operations-based path:
   * translate nodes → execute tool calls → apply deltas.
   *
   * Use this for single-action execution, testing, or replay scenarios.
   */
  async executeTick(params: {
    nodes: PlanNode[];
    dgsm: DynamicGameStateManager;
    ctx: ExecutionContext;
  }): Promise<TickExecutionResult> {
    const { nodes, dgsm, ctx } = params;
    const allResults: Array<{
      toolId: string;
      delta: unknown;
      narrative: EngineNarrative;
    }> = [];
    const allNarratives: EngineNarrative[] = [];

    for (const node of nodes) {
      // Step 2: Translate
      const toolCalls = this.deps.translatePlanNode(node);
      if (toolCalls.length === 0) continue;

      // Step 3: Execute
      const results = await this.deps.registry.executeToolCalls(
        toolCalls,
        dgsm,
        ctx
      );

      // Step 4: Apply deltas
      for (const result of results) {
        this.deps.registry.applyToolResult(result.toolId, dgsm, result.delta);
      }

      allResults.push(...results);
      allNarratives.push(...results.map((r) => r.narrative));
    }

    return { results: allResults, narratives: allNarratives };
  }

  /**
   * Execute a full simulation tick with all game logic:
   * NPC planning, node execution, impact pipeline, feature ticks, propagation.
   *
   * Delegates to tickProcessor for the complete flow.
   * Use this for continuous simulation (SimulationRunner).
   */
  async runSimulationTick(params: {
    dgsm: DynamicGameStateManager;
    npcPlanningAgent: NPCPlanningAgent;
    sessionId: string;
    moduleId: string;
    language: string;
    ctx: ExecutionContext;
    memoryManager?: NpcMemoryManager;
    previousEncounterSignatures?: ReadonlySet<string>;
  }): Promise<SimulationTickResult> {
    return tickProcessorRun({
      ...params,
      registry: this.deps.registry,
    });
  }
}
