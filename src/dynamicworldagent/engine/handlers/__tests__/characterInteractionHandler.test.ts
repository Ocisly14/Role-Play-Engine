import { describe, expect, it } from "vitest";
import type { PlanNode } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { ExecutionContext } from "../../types.js";
import { characterInteractionHandler } from "../characterInteractionHandler.js";

function createMockDgsm() {
  const characterPositions: Record<string, any> = {};
  const npcCharacters: Array<{
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
    removeItemFromNpc() {
      return undefined;
    },
    addItemToNpc() {},
    _addNpc(
      npcId: string,
      position: { type: "scene"; sceneId: string } | { type: "road"; roadId: string; position: number }
    ) {
      characterPositions[npcId] = position;
      npcCharacters.push({ id: npcId, skills: {}, status: { luck: 50 } });
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
});
