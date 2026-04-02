import type { PlanNode } from "../../planning/types.js";
import { GameEngineRegistry } from "../registry.js";
import type { ActionTool, ToolPreCheckResult } from "../types.js";

function makeMockTool(
  id: string,
  preCheckResult: ToolPreCheckResult = { passed: true }
): ActionTool {
  return {
    id,
    description: `Mock ${id} tool`,
    argsSchema: {
      requiredArgs: [
        { name: "targetId", type: "string", description: "target" },
      ],
    },
    exampleCall: { name: id, args: { targetId: "x" } },
    planningPrompt: `Use ${id} tool when needed.`,
    preCheck: () => preCheckResult,
    resolve: async () => ({ delta: {}, outcomeDescription: "done" }),
    apply: () => {},
  };
}

function makeNode(
  tools?: Array<{ name: string; args: Record<string, unknown> }>
): PlanNode {
  return {
    nodeId: "n1",
    characterId: "npc_a",
    characterName: "A",
    startTime: "10:00",
    endTime: "10:05",
    action: "do something",
    type: "action",
    impact: 0,
    status: "pending",
    executionMeta: { remainingMinutes: 5 },
    tools,
  } as PlanNode;
}

describe("GameEngineRegistry — tool management", () => {
  it("registerTool + getTool", () => {
    const registry = new GameEngineRegistry();
    const tool = makeMockTool("item");
    registry.registerTool(tool);
    expect(registry.getTool("item")).toBe(tool);
    expect(registry.getTool("unknown")).toBeUndefined();
  });

  it("getActiveTools returns matching tools with args", () => {
    const registry = new GameEngineRegistry();
    registry.registerTool(makeMockTool("item"));
    registry.registerTool(makeMockTool("craft"));

    const node = makeNode([{ name: "item", args: { targetId: "knife" } }]);
    const active = registry.getActiveTools(node);
    expect(active).toHaveLength(1);
    expect(active[0].tool.id).toBe("item");
    expect(active[0].args).toEqual({ targetId: "knife" });
  });

  it("getActiveTools returns empty when node has no tools", () => {
    const registry = new GameEngineRegistry();
    registry.registerTool(makeMockTool("item"));
    expect(registry.getActiveTools(makeNode())).toHaveLength(0);
    expect(registry.getActiveTools(makeNode([]))).toHaveLength(0);
  });

  it("getActiveTools ignores unregistered tool names", () => {
    const registry = new GameEngineRegistry();
    const node = makeNode([{ name: "unknown_tool", args: {} }]);
    expect(registry.getActiveTools(node)).toHaveLength(0);
  });

  it("runToolPreChecks returns null when all pass", () => {
    const registry = new GameEngineRegistry();
    registry.registerTool(makeMockTool("item", { passed: true }));
    const node = makeNode([{ name: "item", args: { targetId: "x" } }]);
    // biome-ignore lint/suspicious/noExplicitAny: test stub — no real DGSM needed
    expect(registry.runToolPreChecks(node, {} as any)).toBeNull();
  });

  it("runToolPreChecks returns first failure", () => {
    const registry = new GameEngineRegistry();
    registry.registerTool(
      makeMockTool("item", {
        passed: false,
        failureReason: "object_not_found",
        failureDetail: "knife not found",
      })
    );
    const node = makeNode([{ name: "item", args: { targetId: "knife" } }]);
    // biome-ignore lint/suspicious/noExplicitAny: test stub — no real DGSM needed
    const result = registry.runToolPreChecks(node, {} as any);
    expect(result).not.toBeNull();
    expect(result?.passed).toBe(false);
    expect(result?.failureReason).toBe("object_not_found");
  });

  it("runToolPreChecks returns null when no tools on node", () => {
    const registry = new GameEngineRegistry();
    registry.registerTool(makeMockTool("item"));
    // biome-ignore lint/suspicious/noExplicitAny: test stub — no real DGSM needed
    expect(registry.runToolPreChecks(makeNode(), {} as any)).toBeNull();
  });

  it("buildToolPrompt generates Available Tools section", () => {
    const registry = new GameEngineRegistry();
    registry.registerTool(makeMockTool("item"));
    const prompt = registry.buildToolPrompt();
    expect(prompt).toContain("Available Tools");
    expect(prompt).toContain("item");
    expect(prompt).toContain("targetId");
  });

  it("buildToolPrompt returns empty when no tools", () => {
    const registry = new GameEngineRegistry();
    expect(registry.buildToolPrompt()).toBe("");
  });
});
