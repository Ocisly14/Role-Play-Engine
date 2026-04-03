import { TickOrchestrator } from "../tickOrchestrator.js";
import type { TickOrchestratorDeps } from "../tickOrchestrator.js";

function makeDeps(
  overrides?: Partial<TickOrchestratorDeps>
): TickOrchestratorDeps {
  return {
    registry: {
      executeToolCalls: vi.fn().mockResolvedValue([]),
      applyToolResult: vi.fn(),
      getAllFeatures: () => [],
    },
    translatePlanNode: vi.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as TickOrchestratorDeps;
}

describe("TickOrchestrator", () => {
  it("constructs with dependencies", () => {
    const deps = makeDeps();
    const orchestrator = new TickOrchestrator(deps);
    expect(orchestrator).toBeTruthy();
  });

  it("executeTick translates nodes and executes tool calls", async () => {
    const executeToolCalls = vi.fn().mockResolvedValue([
      {
        toolId: "action",
        delta: { status: "completed" },
        narrative: { outcome: "Searched" },
      },
    ]);
    const applyToolResult = vi.fn();
    const translatePlanNode = vi
      .fn()
      .mockReturnValue([
        { toolId: "action", params: { actorId: "npc_a", action: "Search" } },
      ]);

    const deps = makeDeps({
      registry: {
        executeToolCalls,
        applyToolResult,
        getAllFeatures: () => [],
      } as any,
      translatePlanNode,
    });

    const orchestrator = new TickOrchestrator(deps);
    const result = await orchestrator.executeTick({
      nodes: [
        {
          nodeId: "n1",
          characterId: "npc_a",
          type: "action",
          action: "Search",
        },
      ] as any[],
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      dgsm: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      ctx: {} as any,
    });

    expect(translatePlanNode).toHaveBeenCalledTimes(1);
    expect(executeToolCalls).toHaveBeenCalledTimes(1);
    expect(applyToolResult).toHaveBeenCalledWith(
      "action",
      {},
      { status: "completed" }
    );
    expect(result.results).toHaveLength(1);
    expect(result.narratives).toHaveLength(1);
  });

  it("executeTick handles multiple nodes", async () => {
    const executeToolCalls = vi.fn().mockResolvedValue([
      {
        toolId: "movement",
        delta: { status: "completed" },
        narrative: { outcome: "Moved" },
      },
    ]);
    const translatePlanNode = vi
      .fn()
      .mockReturnValue([
        { toolId: "movement", params: { actorId: "npc_a", destination: "s2" } },
      ]);

    const deps = makeDeps({
      registry: {
        executeToolCalls,
        applyToolResult: vi.fn(),
        getAllFeatures: () => [],
      } as any,
      translatePlanNode,
    });

    const orchestrator = new TickOrchestrator(deps);
    const result = await orchestrator.executeTick({
      nodes: [
        { nodeId: "n1", type: "movement" },
        { nodeId: "n2", type: "movement" },
      ] as any[],
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      dgsm: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      ctx: {} as any,
    });

    expect(translatePlanNode).toHaveBeenCalledTimes(2);
    // executeToolCalls called once per node
    expect(executeToolCalls).toHaveBeenCalledTimes(2);
    expect(result.results).toHaveLength(2);
  });

  it("executeTick returns empty results for no nodes", async () => {
    const deps = makeDeps();
    const orchestrator = new TickOrchestrator(deps);
    const result = await orchestrator.executeTick({
      nodes: [],
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      dgsm: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: test stub
      ctx: {} as any,
    });

    expect(result.results).toHaveLength(0);
    expect(result.narratives).toHaveLength(0);
  });

  it("runSimulationTick delegates to tickProcessor", async () => {
    const deps = makeDeps();
    const orchestrator = new TickOrchestrator(deps);

    // runSimulationTick requires full simulation params — verify it exists and is callable
    expect(typeof orchestrator.runSimulationTick).toBe("function");
  });
});
