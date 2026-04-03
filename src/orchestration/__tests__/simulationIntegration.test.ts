import { createDefaultRegistry } from "../../engine/registerDefaults.js";
import { translatePlanNode } from "../../translation/actionTranslator.js";
import { TickOrchestrator } from "../tickOrchestrator.js";

describe("TickOrchestrator — registry integration", () => {
  it("default registry has all 4 EngineTools registered", () => {
    const registry = createDefaultRegistry();
    expect(registry.getEngineTool("action")).toBeDefined();
    expect(registry.getEngineTool("movement")).toBeDefined();
    expect(registry.getEngineTool("character_interaction")).toBeDefined();
    expect(registry.getEngineTool("item")).toBeDefined();
  });

  it("can construct TickOrchestrator with default registry + translator", () => {
    const registry = createDefaultRegistry();
    const orchestrator = new TickOrchestrator({
      registry,
      translatePlanNode,
    });
    expect(orchestrator).toBeTruthy();
  });

  it("translatePlanNode produces valid tool calls for action node", () => {
    const calls = translatePlanNode({
      nodeId: "n1",
      characterId: "npc_a",
      characterName: "Alice",
      startTime: "09:00",
      endTime: "09:05",
      action: "Search the room",
      type: "action",
      skill: "Spot Hidden",
      impact: 1,
      status: "pending",
      executionMeta: { remainingMinutes: 5 },
    } as any);

    expect(calls).toHaveLength(1);
    expect(calls[0].toolId).toBe("action");

    // Verify the registry can find the tool
    const registry = createDefaultRegistry();
    const tool = registry.getEngineTool(calls[0].toolId);
    expect(tool).toBeDefined();
    expect(tool!.id).toBe("action");
  });

  it("translatePlanNode produces valid tool calls for movement node", () => {
    const calls = translatePlanNode({
      nodeId: "m1",
      characterId: "npc_a",
      characterName: "Alice",
      startTime: "09:00",
      endTime: "09:05",
      action: "Walk to harbor",
      destination: "harbor_docks",
      type: "movement",
      impact: 0,
      status: "pending",
      executionMeta: { remainingMinutes: 5 },
    } as any);

    expect(calls).toHaveLength(1);
    expect(calls[0].toolId).toBe("movement");
    expect(calls[0].params.destination).toBe("harbor_docks");
  });
});
