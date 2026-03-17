import { describe, expect, it, vi } from "vitest";
import type { PlanNode } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { DynamicScene } from "../../../state/types.js";
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
  const scenes = new Map<string, { id: string; connections: string[] }>();
  const junctions = new Map<string, unknown>();
  const roads = new Map<string, unknown>();
  const blockedCalls: Array<{
    fromId: string;
    toId: string;
    blocked: boolean;
    reason: string;
  }> = [];
  const appendedConditions: Array<{ locationId: string; description: string }> =
    [];

  return {
    getState() {
      return {
        npcCharacters,
        topology: {
          junctions,
          roads,
          junctionToRoads: new Map(),
          sceneToParent: new Map(),
        },
      };
    },
    getTopology() {
      return {
        junctions,
        roads,
        junctionToRoads: new Map(),
        sceneToParent: new Map(),
      };
    },
    getScene(sceneId: string) {
      const scene = scenes.get(sceneId);
      return scene
        ? ({
            ...scene,
            name: scene.id,
            description: scene.id,
            parentLocationId: "OUTDOOR",
            items: [],
            conditions: [],
          } as DynamicScene)
        : null;
    },
    getJunction(junctionId: string) {
      return junctions.get(junctionId) ?? null;
    },
    getRoad(roadId: string) {
      return roads.get(roadId) ?? null;
    },
    getCharacterPosition(characterId: string) {
      return characterPositions[characterId] ?? null;
    },
    resolveLocationId(position: { type: "scene"; sceneId: string }) {
      return position.sceneId;
    },
    appendSceneCondition(
      locationId: string,
      condition: { description: string }
    ) {
      appendedConditions.push({
        locationId,
        description: condition.description,
      });
    },
    setConnectionBlocked(
      fromId: string,
      toId: string,
      blocked: boolean,
      reason: string
    ) {
      blockedCalls.push({ fromId, toId, blocked, reason });
    },
    _addNpc(npcId: string, sceneId: string) {
      characterPositions[npcId] = { type: "scene", sceneId };
      npcCharacters.push({ id: npcId, skills: {}, status: { luck: 50 } });
    },
    _addScene(id: string, connections: string[]) {
      scenes.set(id, { id, connections });
    },
    _blockedCalls: blockedCalls,
    _appendedConditions: appendedConditions,
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
  const ctx = createMockCtx();

  it("blocks a real connected location", () => {
    const dgsm = createMockDgsm();
    dgsm._addNpc("npc_a", "SCN_3_SUB_1");
    dgsm._addScene("SCN_3_SUB_1", ["SCN_3_SUB_2"]);
    dgsm._addScene("SCN_3_SUB_2", ["SCN_3_SUB_1"]);

    const result = sceneInteractionHandler.execute(
      makeNode({
        sceneConnectionEffect: {
          targetScenarioId: "SCN_3_SUB_2",
          action: "block",
        },
      }),
      dgsm as unknown as DynamicGameStateManager,
      ctx
    );

    expect(result.status).toBe("completed");
    expect(dgsm._blockedCalls).toHaveLength(1);
    expect(dgsm._blockedCalls[0]).toMatchObject({
      fromId: "SCN_3_SUB_1",
      toId: "SCN_3_SUB_2",
      blocked: true,
    });
  });

  it("ignores a fabricated connection target", () => {
    const dgsm = createMockDgsm();
    dgsm._addNpc("npc_a", "SCN_3_SUB_1");
    dgsm._addScene("SCN_3_SUB_1", ["SCN_3_SUB_2"]);
    dgsm._addScene("SCN_3_SUB_2", ["SCN_3_SUB_1"]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = sceneInteractionHandler.execute(
      makeNode({
        sceneConnectionEffect: {
          targetScenarioId: "private_office_partition",
          action: "block",
        },
      }),
      dgsm as unknown as DynamicGameStateManager,
      ctx
    );

    expect(result.status).toBe("completed");
    expect(dgsm._blockedCalls).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      "[sceneInteractionHandler] Ignoring invalid sceneConnectionEffect from SCN_3_SUB_1 to private_office_partition"
    );

    warnSpy.mockRestore();
  });
});
