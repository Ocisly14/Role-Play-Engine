import { describe, expect, it } from "vitest";
import type { PlanNode } from "../../../planning/types.js";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { ExecutionContext } from "../../types.js";
import { actionHandler } from "../actionHandler.js";

// ===== Mock DGSM =====

function createMockDgsm() {
  const characterPositions: Record<string, any> = {};
  const npcCharacters: Array<{
    id: string;
    skills: Record<string, number>;
    status: { luck: number; conditions: string[] };
  }> = [];
  const featureState: Record<string, Record<string, unknown>> = {};

  return {
    getState() {
      return { npcCharacters };
    },
    getCharacterPosition(characterId: string) {
      return characterPositions[characterId] ?? null;
    },
    resolveLocationId(position: any) {
      if (position.type === "scene") return position.sceneId;
      if (position.type === "junction") return position.junctionId;
      return position.roadId;
    },
    // Feature state for stamina (restCharacter uses these)
    getFeatureSceneState(featureId: string, key: string) {
      return featureState[featureId]?.[key];
    },
    setFeatureSceneState(featureId: string, key: string, data: unknown) {
      if (!featureState[featureId]) featureState[featureId] = {};
      featureState[featureId][key] = data;
    },
    _addNpc(
      npcId: string,
      sceneId: string,
      skills: Record<string, number> = {}
    ) {
      characterPositions[npcId] = { type: "scene", sceneId };
      npcCharacters.push({
        id: npcId,
        skills,
        status: { luck: 50, conditions: [] },
      });
    },
    _featureState: featureState,
    _characterPositions: characterPositions,
  };
}

type MockDgsm = ReturnType<typeof createMockDgsm>;

function createMockCtx(
  overrides?: Partial<ExecutionContext>
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
      failed: false,
      detail: "Regular success",
      successLevel: "regular" as const,
    }),
    ...overrides,
  } as unknown as ExecutionContext;
}

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "r1",
    characterId: "npc_a",
    characterName: "A",
    startTime: "22:00",
    endTime: "22:05",
    action: "Sit and read a book",
    location: "library",
    type: "action",
    impact: 0,
    status: "pending",
    executionMeta: { remainingMinutes: 5 },
    ...overrides,
  } as PlanNode;
}

// ===== Tests =====

describe("actionHandler", () => {
  it("has correct type and required fields", () => {
    expect(actionHandler.type).toBe("action");
    expect(actionHandler.requiredFields).toContain("action");
    expect(actionHandler.optionalFields).toContain("skill");
    expect(actionHandler.optionalFields).toContain("routineSubtype");
  });

  describe("basic execution", () => {
    it("should complete a routine action without skill check", () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", "library");
      const ctx = createMockCtx();

      const result = actionHandler.execute(
        makeNode(),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      expect(result.status).toBe("completed");
      expect(result.characterId).toBe("npc_a");
      expect(result.action).toBe("Sit and read a book");
      expect(result.location).toBe("library");
    });
  });

  describe("skill roll", () => {
    it("should complete when skill roll succeeds", () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", "library", { "Library Use": 60 });
      const ctx = createMockCtx({
        resolveSkillRoll: () => ({
          failed: false,
          detail: "Hard success (roll 15 vs 30)",
          successLevel: "hard" as const,
        }),
      } as any);

      const result = actionHandler.execute(
        makeNode({ skill: "Library Use" }),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      expect(result.status).toBe("completed");
      expect(result.successLevel).toBe("hard");
    });

    it("should fail when skill roll fails", () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", "library", { "Library Use": 20 });
      const ctx = createMockCtx({
        resolveSkillRoll: () => ({
          failed: true,
          detail: "Fumble (roll 99)",
          reason: "Fumble",
          successLevel: "fumble" as const,
        }),
      } as any);

      const result = actionHandler.execute(
        makeNode({ skill: "Library Use" }),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      expect(result.status).toBe("failed");
      expect(result.successLevel).toBe("fumble");
      expect(result.failureReason).toBe("skill_roll_failed");
    });
  });

  describe("rest subtype", () => {
    it("should reset stamina when routineSubtype is rest", () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", "bedroom");

      // Set up exhausted stamina state
      dgsm.setFeatureSceneState("stamina", "npc_a", {
        minutesSinceLastRest: 960,
        fatigueLevel: 2,
        exhaustedDrainTicks: 5,
      });

      const ctx = createMockCtx();

      const result = actionHandler.execute(
        makeNode({
          location: "bedroom",
          routineSubtype: "rest",
          action: "Sleep for the night",
        }),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      expect(result.status).toBe("completed");

      const stamina = dgsm.getFeatureSceneState("stamina", "npc_a") as any;
      expect(stamina.minutesSinceLastRest).toBe(0);
      expect(stamina.fatigueLevel).toBe(0);
      expect(stamina.exhaustedDrainTicks).toBe(0);
    });

    it("should not reset stamina for non-rest routines", () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", "library");

      dgsm.setFeatureSceneState("stamina", "npc_a", {
        minutesSinceLastRest: 500,
        fatigueLevel: 1,
        exhaustedDrainTicks: 0,
      });

      const ctx = createMockCtx();

      actionHandler.execute(
        makeNode(),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      const stamina = dgsm.getFeatureSceneState("stamina", "npc_a") as any;
      expect(stamina.minutesSinceLastRest).toBe(500);
      expect(stamina.fatigueLevel).toBe(1);
    });
  });

  describe("penalties", () => {
    it("should pass scene and character penalties to skill roll", () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", "library", { "Library Use": 60 });

      let capturedSkills: Record<string, number> | undefined;
      const ctx = createMockCtx({
        getScenePenalties: () => new Map([["Library Use", -10]]),
        getCharacterPenalties: () => new Map([["Library Use", -5]]),
        applyPenalties: (
          skills: Record<string, number>,
          penalties: Map<string, number>
        ) => {
          const result = { ...skills };
          for (const [skill, delta] of penalties) {
            if (result[skill] !== undefined) {
              result[skill] += delta;
            }
          }
          return result;
        },
        resolveSkillRoll: (
          _node: any,
          adjustedSkills: Record<string, number>
        ) => {
          capturedSkills = adjustedSkills;
          return {
            failed: false,
            detail: "Regular success",
            successLevel: "regular" as const,
          };
        },
      } as any);

      actionHandler.execute(
        makeNode({ skill: "Library Use" }),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      expect(capturedSkills).toBeDefined();
      expect(capturedSkills!["Library Use"]).toBe(45); // 60 - 10 - 5
    });
  });
});
