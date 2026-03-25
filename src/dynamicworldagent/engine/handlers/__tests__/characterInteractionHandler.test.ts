import { describe, expect, it } from "vitest";
import type { PlanNode } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { ExecutionContext } from "../../types.js";
import { characterInteractionHandler } from "../characterInteractionHandler.js";

function createMockDgsm() {
  const characterPositions: Record<string, any> = {};
  const npcStats: Record<string, { hp: number; san: number }> = {};
  const npcCharacters: Array<{
    name?: string;
    id: string;
    skills: Record<string, number>;
    status: { luck: number };
  }> = [];
  const roads = new Map([
    [
      "ROAD_1",
      {
        id: "ROAD_1",
        name: "Harbor Road",
        parentLocationId: "OUTDOOR",
        endpointA: "JUNC_A",
        endpointB: "JUNC_B",
        travelTimeMinutes: 10,
        alongConnections: [],
        items: [],
        conditions: [],
      },
    ],
  ]);
  const hiddenCharacterIds = new Set<string>();

  return {
    getState() {
      return { npcCharacters, roads };
    },
    getCharacterPosition(characterId: string) {
      return characterPositions[characterId] ?? null;
    },
    resolveLocationId(position: any) {
      if (position.type === "scene") return position.sceneId;
      if (position.type === "junction") return position.junctionId;
      return position.roadId;
    },
    isNpcAlive(npcId: string) {
      return (npcStats[npcId]?.hp ?? 0) > 0;
    },
    isCharacterHidden(npcId: string) {
      return hiddenCharacterIds.has(npcId);
    },
    removeItemFromNpc() {
      return undefined;
    },
    addItemToNpc() {},
    _addNpc(
      npcId: string,
      position: { type: "scene"; sceneId: string } | { type: "road"; roadId: string; position: number },
      hp = 10
    ) {
      characterPositions[npcId] = position;
      npcStats[npcId] = { hp, san: 50 };
      npcCharacters.push({
        id: npcId,
        name: npcId,
        skills: {},
        status: { luck: 50 },
      });
    },
    _setHidden(npcId: string, hidden: boolean) {
      if (hidden) hiddenCharacterIds.add(npcId);
      else hiddenCharacterIds.delete(npcId);
    },
  };
}

function createMockCtx(): ExecutionContext {
  return {
    getNodeDifficulty: () => "regular" as const,
    getScenePenalties: () => new Map<string, number>(),
    getCharacterPenalties: () => new Map<string, number>(),
    applyPenalties: (
      skills: Record<string, number>,
      _penalties: Map<string, number>
    ) => skills,
    resolveSkillRoll: () => ({
      failed: false,
      detail: "Regular success",
      successLevel: "regular" as const,
    }),
  } as unknown as ExecutionContext;
}

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "ci1",
    characterId: "npc_a",
    characterName: "A",
    startTime: "10:00",
    endTime: "10:05",
    action: "Talk to B",
    location: "ROAD_1",
    type: "character_interaction",
    impact: 1,
    status: "pending",
    targetCharacterIds: ["npc_b"],
    executionMeta: { remainingMinutes: 5 },
    ...overrides,
  } as PlanNode;
}

describe("characterInteractionHandler", () => {
  const ctx = createMockCtx();

  it("allows interaction on the same road when characters are within the proximity threshold", async () => {
    const dgsm = createMockDgsm();
    dgsm._addNpc("npc_a", { type: "road", roadId: "ROAD_1", position: 0.1 });
    dgsm._addNpc("npc_b", { type: "road", roadId: "ROAD_1", position: 0.25 });

    const result = await characterInteractionHandler.execute(makeNode(), dgsm as any, ctx);
    expect(result.status).toBe("completed");
  });

  it("fails when characters are too far apart on the same road", async () => {
    const dgsm = createMockDgsm();
    dgsm._addNpc("npc_a", { type: "road", roadId: "ROAD_1", position: 0.1 });
    dgsm._addNpc("npc_b", { type: "road", roadId: "ROAD_1", position: 0.8 });

    const result = await characterInteractionHandler.execute(makeNode(), dgsm as any, ctx);
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("target_absent");
  });

  it("treats dead targets like normal interaction targets at handler level", async () => {
    const dgsm = createMockDgsm();
    dgsm._addNpc("npc_a", { type: "road", roadId: "ROAD_1", position: 0.1 });
    dgsm._addNpc("npc_b", { type: "road", roadId: "ROAD_1", position: 0.12 }, 0);

    const result = await characterInteractionHandler.execute(makeNode(), dgsm as any, ctx);
    expect(result.status).toBe("completed");
    expect(result.failureReason).toBeUndefined();
    expect(result.outcome).toBe("Talk to B");
  });

  it("fails when the target is hidden at the same location", async () => {
    const dgsm = createMockDgsm();
    dgsm._addNpc("npc_a", { type: "road", roadId: "ROAD_1", position: 0.1 });
    dgsm._addNpc("npc_b", { type: "road", roadId: "ROAD_1", position: 0.12 });
    dgsm._setHidden("npc_b", true);

    const result = await characterInteractionHandler.execute(makeNode(), dgsm as any, ctx);
    expect(result.status).toBe("failed");
    expect(result.failureReason).toBe("target_absent");
  });
});
