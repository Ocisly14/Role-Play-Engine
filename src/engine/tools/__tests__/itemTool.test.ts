import { describe, expect, it } from "vitest";
import type { PlanNode } from "../../../planning/types.js";
import { itemTool } from "../itemTool.js";

function createMockDgsm() {
  const scenes = new Map<string, any>();
  const npcInventories: Record<string, any[]> = {};
  const characterPositions: Record<string, any> = {};

  return {
    getCharacterPosition(id: string) {
      return characterPositions[id] ?? null;
    },
    resolveLocationId(pos: any) {
      return pos?.sceneId ?? "";
    },
    getScene(id: string) {
      return scenes.get(id) ?? null;
    },
    findNpcItem(npcId: string, itemId: string) {
      return npcInventories[npcId]?.find((i: any) => i.id === itemId);
    },
    getNpcInventory(npcId: string) {
      return npcInventories[npcId] ?? [];
    },
    _addScene(id: string, items: any[]) {
      scenes.set(id, { id, name: id, items });
    },
    _addInventory(npcId: string, items: any[]) {
      npcInventories[npcId] = items;
    },
    _setPosition(npcId: string, sceneId: string) {
      characterPositions[npcId] = { type: "scene", sceneId };
    },
  };
}

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "n1",
    characterId: "npc_a",
    characterName: "A",
    startTime: "10:00",
    endTime: "10:05",
    action: "Pick up the knife",
    type: "action",
    impact: 0,
    status: "pending",
    executionMeta: { remainingMinutes: 5 },
    ...overrides,
  } as PlanNode;
}

describe("itemTool.preCheck", () => {
  it("passes when itemId is found in scene", () => {
    const dgsm = createMockDgsm();
    dgsm._setPosition("npc_a", "room1");
    dgsm._addScene("room1", [{ id: "knife", name: "Knife" }]);
    expect(
      itemTool.preCheck(makeNode(), { itemId: "knife" }, dgsm as any).passed
    ).toBe(true);
  });

  it("passes when itemId is found in inventory", () => {
    const dgsm = createMockDgsm();
    dgsm._setPosition("npc_a", "room1");
    dgsm._addScene("room1", []);
    dgsm._addInventory("npc_a", [{ id: "knife", name: "Knife" }]);
    expect(
      itemTool.preCheck(makeNode(), { itemId: "knife" }, dgsm as any).passed
    ).toBe(true);
  });

  it("fails when itemId is not found anywhere", () => {
    const dgsm = createMockDgsm();
    dgsm._setPosition("npc_a", "room1");
    dgsm._addScene("room1", []);
    const result = itemTool.preCheck(
      makeNode(),
      { itemId: "knife" },
      dgsm as any
    );
    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe("object_not_found");
  });

  it("passes when no itemId in args", () => {
    const dgsm = createMockDgsm();
    expect(itemTool.preCheck(makeNode(), {}, dgsm as any).passed).toBe(true);
  });

  it("passes when itemId is in a scene container", () => {
    const dgsm = createMockDgsm();
    dgsm._setPosition("npc_a", "room1");
    dgsm._addScene("room1", [
      {
        id: "box",
        name: "Box",
        containerStats: { storedItems: [{ id: "key", name: "Key" }] },
      },
    ]);
    expect(
      itemTool.preCheck(makeNode(), { itemId: "key" }, dgsm as any).passed
    ).toBe(true);
  });
});
