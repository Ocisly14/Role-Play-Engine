import type { PlanNode } from "../../npc/planning/types.js";
import { translatePlanNode } from "../actionTranslator.js";

function makeNode(overrides: Partial<PlanNode>): PlanNode {
  return {
    nodeId: "n1",
    characterId: "npc_a",
    characterName: "Alice",
    startTime: "09:00",
    endTime: "09:05",
    action: "Do something",
    type: "action",
    impact: 0,
    status: "pending",
    executionMeta: { remainingMinutes: 5 },
    ...overrides,
  } as PlanNode;
}

describe("translatePlanNode", () => {
  it("translates action node", () => {
    const node = makeNode({
      type: "action",
      action: "Search the room",
      skill: "Spot Hidden",
    });
    const calls = translatePlanNode(node);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolId).toBe("action");
    expect(calls[0].params.actorId).toBe("npc_a");
    expect(calls[0].params.action).toBe("Search the room");
    expect(calls[0].params.skill).toBe("Spot Hidden");
  });

  it("translates movement node", () => {
    const node = makeNode({
      type: "movement",
      action: "Walk to harbor",
      destination: "harbor_docks",
    });
    const calls = translatePlanNode(node);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolId).toBe("movement");
    expect(calls[0].params.destination).toBe("harbor_docks");
    expect(calls[0].params.actorId).toBe("npc_a");
  });

  it("translates character_interaction node", () => {
    const node = makeNode({
      type: "character_interaction",
      action: "Ask about the artifact",
      targetCharacterIds: ["npc_b", "npc_c"],
      skill: "Persuade",
    });
    const calls = translatePlanNode(node);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolId).toBe("character_interaction");
    expect(calls[0].params.targetCharacterIds).toEqual(["npc_b", "npc_c"]);
    expect(calls[0].params.skill).toBe("Persuade");
  });

  it("translates object_interaction node to item tool call", () => {
    const node = makeNode({
      type: "object_interaction",
      action: "Pick up the key",
      tools: [{ name: "item", args: { itemId: "old_key" } }],
    });
    const calls = translatePlanNode(node);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolId).toBe("item");
    expect(calls[0].params.itemId).toBe("old_key");
    expect(calls[0].params.actorId).toBe("npc_a");
  });

  it("translates action node with tool calls into multiple EngineToolCalls", () => {
    const node = makeNode({
      type: "action",
      action: "Search and pick up knife",
      tools: [{ name: "item", args: { itemId: "knife_01" } }],
    });
    const calls = translatePlanNode(node);
    expect(calls).toHaveLength(2);
    expect(calls[0].toolId).toBe("action");
    expect(calls[1].toolId).toBe("item");
    expect(calls[1].params.itemId).toBe("knife_01");
  });

  it("passes through unknown type as toolId", () => {
    const node = makeNode({ type: "custom_ritual" as any });
    const calls = translatePlanNode(node);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolId).toBe("custom_ritual");
  });

  it("includes impact and difficulty in params", () => {
    const node = makeNode({
      type: "action",
      impact: 3,
      difficulty: "hard",
    });
    const calls = translatePlanNode(node);
    expect(calls[0].params.impact).toBe(3);
    expect(calls[0].params.difficulty).toBe("hard");
  });
});
