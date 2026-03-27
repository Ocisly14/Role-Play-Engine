import { describe, expect, it } from "vitest";
import type { PlanNode } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { ExecutionContext } from "../../types.js";
import { sceneInteractionHandler } from "../sceneInteractionHandler.js";

function createMockDgsm() {
  const characterPositions: Record<string, { type: "scene"; sceneId: string }> =
    {};
  const npcCharacters: Array<{
    id: string;
    skills: Record<string, number>;
    status: { luck: number };
  }> = [];
  const sceneItemsById: Record<string, Array<{ id: string }>> = {};
  const npcItemsById: Record<string, Array<{ id: string }>> = {};

  return {
    getState() {
      return { npcCharacters };
    },
    getCharacterPosition(characterId: string) {
      return characterPositions[characterId] ?? null;
    },
    resolveLocationId(position: { type: "scene"; sceneId: string }) {
      return position.sceneId;
    },
    getScene(sceneId: string) {
      const items = sceneItemsById[sceneId] ?? [];
      return { id: sceneId, items };
    },
    findNpcItem(npcId: string, itemId: string) {
      return npcItemsById[npcId]?.find((i) => i.id === itemId);
    },
    _addNpc(
      npcId: string,
      sceneId: string,
      skills: Record<string, number> = {}
    ) {
      characterPositions[npcId] = { type: "scene", sceneId };
      npcCharacters.push({ id: npcId, skills, status: { luck: 50 } });
    },
    _setSceneItems(sceneId: string, items: Array<{ id: string }>) {
      sceneItemsById[sceneId] = items;
    },
    _setNpcItems(npcId: string, items: Array<{ id: string }>) {
      npcItemsById[npcId] = items;
    },
  };
}

function createMockCtx(
  rollFailed = false,
  successLevel: "regular" | "hard" | "critical" = "regular"
): ExecutionContext {
  return {
    getNodeDifficulty: () => "regular" as const,
    getScenePenalties: () => new Map<string, number>(),
    getCharacterPenalties: () => new Map<string, number>(),
    applyPenalties: (
      skills: Record<string, number>,
      _penalties: Map<string, number>
    ) => skills,
    resolveSkillRoll: () => ({
      failed: rollFailed,
      detail: rollFailed ? "Failed" : `${successLevel} success`,
      reason: rollFailed ? "Rolled too high" : undefined,
      successLevel,
    }),
  } as unknown as ExecutionContext;
}

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "si1",
    characterId: "npc_a",
    characterName: "A",
    startTime: "10:00",
    endTime: "10:05",
    action: "Close the blinds",
    location: "SCN_3_SUB_1",
    type: "scene_interaction",
    impact: 1,
    status: "pending",
    executionMeta: { remainingMinutes: 5 },
    ...overrides,
  } as PlanNode;
}

describe("sceneInteractionHandler", () => {
  it("auto-succeeds without skill roll", () => {
    const dgsm = createMockDgsm();
    dgsm._addNpc("npc_a", "SCN_3_SUB_1");
    const ctx = createMockCtx();

    const result = sceneInteractionHandler.execute(
      makeNode(),
      dgsm as unknown as DynamicGameStateManager,
      ctx
    );

    expect(result).toHaveProperty("status", "completed");
  });

  it("succeeds with skill roll", () => {
    const dgsm = createMockDgsm();
    dgsm._addNpc("npc_a", "SCN_3_SUB_1", { "Spot Hidden": 60 });
    const ctx = createMockCtx(false, "hard");

    const result = sceneInteractionHandler.execute(
      makeNode({ skill: "Spot Hidden" }),
      dgsm as unknown as DynamicGameStateManager,
      ctx
    );

    expect(result).toHaveProperty("status", "completed");
    expect(result).toHaveProperty("successLevel", "hard");
  });

  it("fails on skill roll failure", () => {
    const dgsm = createMockDgsm();
    dgsm._addNpc("npc_a", "SCN_3_SUB_1", { "Spot Hidden": 30 });
    const ctx = createMockCtx(true);

    const result = sceneInteractionHandler.execute(
      makeNode({ skill: "Spot Hidden" }),
      dgsm as unknown as DynamicGameStateManager,
      ctx
    );

    expect(result).toHaveProperty("status", "failed");
  });

  it("fails object_not_found when objectInteractionPayload.itemId is absent from inventory and scene", () => {
    const dgsm = createMockDgsm();
    dgsm._addNpc("npc_a", "SCN_3_SUB_1", { STR: 50 });
    dgsm._setSceneItems("SCN_3_SUB_1", []);
    const ctx = createMockCtx();

    const result = sceneInteractionHandler.execute(
      makeNode({
        skill: "STR",
        objectInteractionPayload: { itemId: "crowbar" },
      }),
      dgsm as unknown as DynamicGameStateManager,
      ctx
    );

    expect(result).toHaveProperty("status", "failed");
    expect(result.failureReason).toBe("object_not_found");
  });

  it("succeeds when tool exists in NPC inventory", () => {
    const dgsm = createMockDgsm();
    dgsm._addNpc("npc_a", "SCN_3_SUB_1", { STR: 50 });
    dgsm._setSceneItems("SCN_3_SUB_1", []);
    dgsm._setNpcItems("npc_a", [{ id: "crowbar" }]);
    const ctx = createMockCtx();

    const result = sceneInteractionHandler.execute(
      makeNode({
        skill: "STR",
        objectInteractionPayload: { itemId: "crowbar" },
      }),
      dgsm as unknown as DynamicGameStateManager,
      ctx
    );

    expect(result).toHaveProperty("status", "completed");
  });
});
