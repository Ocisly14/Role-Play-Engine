import { GameEngineRegistry } from "../registry.js";
import type { EngineTool } from "../types.js";

function makeMockEngineTool(id: string): EngineTool {
  return {
    id,
    description: `Mock ${id} tool`,
    schema: {
      requiredParams: [
        { name: "target", type: "string", description: "target" },
      ],
      example: { target: "x" },
    },
    execute: async () => ({
      delta: {},
      narrative: { outcome: "done" },
    }),
    applyDelta: () => {},
  };
}

describe("GameEngineRegistry — EngineTool registration", () => {
  it("registerEngineTool + getEngineTool", () => {
    const registry = new GameEngineRegistry();
    const tool = makeMockEngineTool("move");
    registry.registerEngineTool(tool);
    expect(registry.getEngineTool("move")).toBe(tool);
    expect(registry.getEngineTool("unknown")).toBeUndefined();
  });

  it("getAllEngineTools returns all registered tools", () => {
    const registry = new GameEngineRegistry();
    registry.registerEngineTool(makeMockEngineTool("move"));
    registry.registerEngineTool(makeMockEngineTool("action"));
    const all = registry.getAllEngineTools();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.id).sort()).toEqual(["action", "move"]);
  });

  it("warns on overwrite", () => {
    const registry = new GameEngineRegistry();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.registerEngineTool(makeMockEngineTool("move"));
    registry.registerEngineTool(makeMockEngineTool("move"));
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Overwriting engine tool: move")
    );
    spy.mockRestore();
  });
});

describe("GameEngineRegistry — EngineTool execution", () => {
  it("executeToolCall invokes tool.execute with params", async () => {
    const registry = new GameEngineRegistry();
    const executeSpy = vi.fn().mockResolvedValue({
      delta: { moveTo: "scene_01" },
      narrative: { outcome: "Moved" },
    });
    const tool = {
      ...makeMockEngineTool("move"),
      execute: executeSpy,
    };
    registry.registerEngineTool(tool);

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = {} as any;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const ctx = {} as any;
    const result = await registry.executeToolCall(
      { toolId: "move", params: { destination: "scene_01" } },
      dgsm,
      ctx
    );

    expect(executeSpy).toHaveBeenCalledWith(
      { destination: "scene_01" },
      dgsm,
      ctx
    );
    expect(result.delta).toEqual({ moveTo: "scene_01" });
    expect(result.narrative.outcome).toBe("Moved");
  });

  it("executeToolCall throws on unknown toolId", async () => {
    const registry = new GameEngineRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = {} as any;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const ctx = {} as any;
    await expect(
      registry.executeToolCall({ toolId: "nonexistent", params: {} }, dgsm, ctx)
    ).rejects.toThrow("Unknown engine tool: nonexistent");
  });

  it("executeToolCalls runs multiple calls sequentially", async () => {
    const registry = new GameEngineRegistry();
    const order: string[] = [];

    const moveTool: EngineTool = {
      ...makeMockEngineTool("move"),
      execute: async () => {
        order.push("move");
        return { delta: { moveTo: "s1" }, narrative: { outcome: "Moved" } };
      },
    };
    const actionTool: EngineTool = {
      ...makeMockEngineTool("action"),
      execute: async () => {
        order.push("action");
        return {
          delta: { searched: true },
          narrative: { outcome: "Searched" },
        };
      },
    };
    registry.registerEngineTool(moveTool);
    registry.registerEngineTool(actionTool);

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = {} as any;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const ctx = {} as any;
    const results = await registry.executeToolCalls(
      [
        { toolId: "move", params: { destination: "s1" } },
        { toolId: "action", params: { action: "search" } },
      ],
      dgsm,
      ctx
    );

    expect(results).toHaveLength(2);
    expect(order).toEqual(["move", "action"]);
    expect(results[0].toolId).toBe("move");
    expect(results[1].toolId).toBe("action");
  });

  it("applyToolResult calls tool.applyDelta", () => {
    const registry = new GameEngineRegistry();
    const applySpy = vi.fn();
    const tool = { ...makeMockEngineTool("move"), applyDelta: applySpy };
    registry.registerEngineTool(tool);

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = {} as any;
    registry.applyToolResult("move", dgsm, { moveTo: "scene_01" });
    expect(applySpy).toHaveBeenCalledWith(dgsm, { moveTo: "scene_01" });
  });

  it("applyToolResult throws on unknown toolId", () => {
    const registry = new GameEngineRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    expect(() => registry.applyToolResult("nope", {} as any, {})).toThrow(
      "Unknown engine tool: nope"
    );
  });
});
