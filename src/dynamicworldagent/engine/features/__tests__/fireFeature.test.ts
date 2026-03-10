import { describe, it, expect, beforeEach } from "vitest";
import { fireFeature } from "../fireFeature.js";
import type { TickRuntimeContext } from "../../types.js";
import type { PlanNode } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { SceneCondition } from "../../../dynamicBasicAgent/npcPlanning/types.js";

// ===== Minimal mock of DynamicGameStateManager =====

interface MockScene {
  id: string;
  name: string;
  connections: string[];
  events: string[];
}

function createMockDgsm() {
  const featureState: Record<string, Record<string, unknown>> = {};
  const scenarioConditions: Record<string, SceneCondition[]> = {};
  const blockedConnections = new Map<string, string>();
  const scenes = new Map<string, MockScene>();

  return {
    // Feature state
    getFeatureSceneState(featureId: string, sceneId: string): unknown | undefined {
      return featureState[featureId]?.[sceneId];
    },
    setFeatureSceneState(featureId: string, sceneId: string, data: unknown): void {
      if (!featureState[featureId]) featureState[featureId] = {};
      featureState[featureId][sceneId] = data;
    },
    removeFeatureSceneState(featureId: string, sceneId: string): void {
      if (featureState[featureId]) {
        delete featureState[featureId][sceneId];
      }
    },
    getFeatureState(featureId: string): Record<string, unknown> {
      return featureState[featureId] ?? {};
    },

    // Scene conditions
    getSceneConditions(scenarioId: string): SceneCondition[] {
      return scenarioConditions[scenarioId] ?? [];
    },
    appendSceneCondition(scenarioId: string, condition: SceneCondition): void {
      if (!scenarioConditions[scenarioId]) scenarioConditions[scenarioId] = [];
      scenarioConditions[scenarioId].push(condition);
    },

    // Scene lookup
    getScene(sceneId: string): MockScene | undefined {
      return scenes.get(sceneId);
    },
    _addScene(scene: MockScene): void {
      scenes.set(scene.id, scene);
    },

    // State (for clearing fire conditions and blocked connections)
    getState() {
      return { scenarioConditions, blockedConnections };
    },

    // Connection blocking
    isConnectionBlocked(fromId: string, toId: string): boolean {
      const key1 = `${fromId}::${toId}`;
      const key2 = `${toId}::${fromId}`;
      return blockedConnections.has(key1) || blockedConnections.has(key2);
    },
    setConnectionBlocked(fromId: string, toId: string, blocked: boolean, reason: string): void {
      const key = `${fromId}::${toId}`;
      if (blocked) {
        blockedConnections.set(key, reason);
      } else {
        blockedConnections.delete(key);
        blockedConnections.delete(`${toId}::${fromId}`);
      }
    },

    // Expose internals for assertions
    _featureState: featureState,
    _scenarioConditions: scenarioConditions,
    _blockedConnections: blockedConnections,
  };
}

type MockDgsm = ReturnType<typeof createMockDgsm>;

// ===== Helper: minimal TickRuntimeContext =====

function createMockRuntime(overrides?: Partial<TickRuntimeContext>): TickRuntimeContext {
  return {
    sessionId: "test-session",
    gameDay: 1,
    language: "en",
    tickTime: "08:00",
    tickDurationMinutes: 5,
    npcPlanning: {
      getLongTermIntent: async () => "",
      getPendingNodes: async () => [],
      runImpactGateForNpc: async () => ({ shouldRevise: false, witnessEntry: "" }),
      appendMemoryLog: async () => {},
      getMemoryLog: async () => [],
      revisePlans: async () => {},
    },
    ...overrides,
  };
}

// ===== Helper: create a PlanNode with fire overlay =====

function makeFireNode(location: string, overrides?: Record<string, unknown>): PlanNode {
  return {
    nodeId: "test-node-1",
    characterId: "npc-arsonist",
    characterName: "Arsonist",
    gameTime: "08:00",
    action: "Set fire",
    location,
    type: "scene_interaction",
    impact: 3,
    timeAdvanceMinutes: 5,
    status: "pending",
    fireIntensity: 1,
    ...overrides,
  } as PlanNode;
}

// ===== Helpers for running ticks =====

function runTicks(dgsm: MockDgsm, runtime: TickRuntimeContext, count: number): void {
  for (let i = 0; i < count; i++) {
    fireFeature.tick!(dgsm as any, runtime);
  }
}

// ===== Tests =====

describe("fireFeature", () => {
  let dgsm: MockDgsm;
  let runtime: TickRuntimeContext;

  beforeEach(() => {
    dgsm = createMockDgsm();
    runtime = createMockRuntime();
    // Add a default scene
    dgsm._addScene({
      id: "warehouse",
      name: "Old Warehouse",
      connections: ["hallway"],
      events: [],
    });
    dgsm._addScene({
      id: "hallway",
      name: "Hallway",
      connections: ["warehouse", "office"],
      events: [],
    });
    dgsm._addScene({
      id: "office",
      name: "Office",
      connections: ["hallway"],
      events: [],
    });
  });

  // ===== activate -- ignite =====

  describe("activate -- ignite", () => {
    it("should create fire state at scene with default parameters", () => {
      const node = makeFireNode("warehouse");
      fireFeature.activate!(node, dgsm as any);

      const fs = dgsm.getFeatureSceneState("fire", "warehouse") as any;
      expect(fs).toBeDefined();
      expect(fs.intensity).toBe(1);
      expect(fs.maxIntensity).toBe(5);
      expect(fs.spreadThreshold).toBe(3);
      expect(fs.phase).toBe("growing");
      expect(fs.totalBurnTicks).toBe(0);
    });

    it("should write fire scene condition with skill penalties", () => {
      const node = makeFireNode("warehouse");
      fireFeature.activate!(node, dgsm as any);

      const conditions = dgsm.getSceneConditions("warehouse");
      expect(conditions.length).toBeGreaterThanOrEqual(1);

      const fireCond = conditions.find(c => c.description.startsWith("[Fire]"));
      expect(fireCond).toBeDefined();
      expect(fireCond!.description).toContain("[Fire]");

      // At intensity 1: Spot Hidden -10
      const penalties = fireCond!.mechanicalEffect?.skillPenalty;
      expect(penalties).toBeDefined();
      const spotHidden = penalties!.find(p => p.skill === "Spot Hidden");
      expect(spotHidden).toBeDefined();
      expect(spotHidden!.delta).toBe(-10);
    });

    it("should not create duplicate fire at same scene", () => {
      const node1 = makeFireNode("warehouse");
      const node2 = makeFireNode("warehouse");
      fireFeature.activate!(node1, dgsm as any);
      fireFeature.activate!(node2, dgsm as any);

      const fs = dgsm.getFeatureSceneState("fire", "warehouse") as any;
      expect(fs.intensity).toBe(1);
    });

    it("should boost intensity if new fire is stronger", () => {
      const node1 = makeFireNode("warehouse", { fireIntensity: 1 });
      const node2 = makeFireNode("warehouse", { fireIntensity: 3 });
      fireFeature.activate!(node1, dgsm as any);
      fireFeature.activate!(node2, dgsm as any);

      const fs = dgsm.getFeatureSceneState("fire", "warehouse") as any;
      expect(fs.intensity).toBe(3);
    });
  });

  // ===== activate -- extinguish =====

  describe("activate -- extinguish", () => {
    it("should reduce fire intensity by 2", () => {
      // Set up fire at intensity 4
      const igniteNode = makeFireNode("warehouse", { fireIntensity: 4 });
      fireFeature.activate!(igniteNode, dgsm as any);

      const extinguishNode = makeFireNode("warehouse", {
        fireExtinguish: true,
        fireIntensity: undefined,
      });
      fireFeature.activate!(extinguishNode, dgsm as any);

      const fs = dgsm.getFeatureSceneState("fire", "warehouse") as any;
      expect(fs).toBeDefined();
      expect(fs.intensity).toBe(2);
    });

    it("should fully extinguish and write aftermath if intensity drops to 0", () => {
      // Set up fire at intensity 1
      const igniteNode = makeFireNode("warehouse", { fireIntensity: 1 });
      fireFeature.activate!(igniteNode, dgsm as any);

      const extinguishNode = makeFireNode("warehouse", {
        fireExtinguish: true,
        fireIntensity: undefined,
      });
      fireFeature.activate!(extinguishNode, dgsm as any);

      // Fire state should be removed
      const fs = dgsm.getFeatureSceneState("fire", "warehouse");
      expect(fs).toBeUndefined();

      // Aftermath condition should exist
      const conditions = dgsm.getSceneConditions("warehouse");
      const aftermath = conditions.find(c => c.description.startsWith("[Fire Aftermath]"));
      expect(aftermath).toBeDefined();
    });
  });

  // ===== tick -- intensity curve =====

  describe("tick -- intensity curve", () => {
    it("should not change intensity on first tick", () => {
      const node = makeFireNode("warehouse");
      fireFeature.activate!(node, dgsm as any);

      runTicks(dgsm, runtime, 1);

      const fs = dgsm.getFeatureSceneState("fire", "warehouse") as any;
      expect(fs.intensity).toBe(1);
      expect(fs.totalBurnTicks).toBe(1);
      expect(fs.ticksInPhase).toBe(1);
    });

    it("should increase intensity after 2 ticks", () => {
      const node = makeFireNode("warehouse");
      fireFeature.activate!(node, dgsm as any);

      runTicks(dgsm, runtime, 2);

      const fs = dgsm.getFeatureSceneState("fire", "warehouse") as any;
      expect(fs.intensity).toBe(2);
    });

    it("should switch to decaying phase at max intensity", () => {
      const node = makeFireNode("warehouse");
      fireFeature.activate!(node, dgsm as any);

      // Grow from 1 to 5: each +1 takes 2 ticks, so 1->2 (2t), 2->3 (4t), 3->4 (6t), 4->5 (8t)
      runTicks(dgsm, runtime, 8);

      const fs = dgsm.getFeatureSceneState("fire", "warehouse") as any;
      expect(fs.intensity).toBe(5);
      expect(fs.phase).toBe("decaying");
    });

    it("should extinguish after full lifecycle", () => {
      const node = makeFireNode("warehouse");
      fireFeature.activate!(node, dgsm as any);

      // Growing: 1->5 in 8 ticks
      // Decaying: 5->4 (2t), 4->3 (2t), 3->2 (2t), 2->1 (2t), 1->0 (2t) = 10 ticks
      // Total = 18 ticks
      runTicks(dgsm, runtime, 18);

      const fs = dgsm.getFeatureSceneState("fire", "warehouse");
      expect(fs).toBeUndefined();

      // Aftermath should exist
      const conditions = dgsm.getSceneConditions("warehouse");
      const aftermath = conditions.find(c => c.description.startsWith("[Fire Aftermath]"));
      expect(aftermath).toBeDefined();
    });
  });

  // ===== tick -- blocking =====

  describe("tick -- blocking", () => {
    it("should block connections when intensity reaches threshold", () => {
      const node = makeFireNode("warehouse");
      fireFeature.activate!(node, dgsm as any);

      // Grow to intensity 3: 1->2 (2t), 2->3 (4t)
      runTicks(dgsm, runtime, 4);

      const fs = dgsm.getFeatureSceneState("fire", "warehouse") as any;
      expect(fs.intensity).toBe(3);

      // Connection from hallway to warehouse should be blocked
      expect(dgsm.isConnectionBlocked("hallway", "warehouse")).toBe(true);
    });

    it("should unblock when intensity drops below threshold", () => {
      const node = makeFireNode("warehouse");
      fireFeature.activate!(node, dgsm as any);

      // Grow to max (8 ticks), then decay:
      // 5->4 (10t), 4->3 (12t), 3->2 (14t) -- intensity 2 < threshold 3 -> unblocked
      runTicks(dgsm, runtime, 14);

      const fs = dgsm.getFeatureSceneState("fire", "warehouse") as any;
      expect(fs.intensity).toBe(2);
      expect(dgsm.isConnectionBlocked("hallway", "warehouse")).toBe(false);
    });
  });

  // ===== propagate -- spatial spread =====

  describe("propagate -- spatial spread", () => {
    it("should not spread when below threshold", async () => {
      const node = makeFireNode("warehouse");
      fireFeature.activate!(node, dgsm as any);

      // Intensity 1 < spreadThreshold 3
      const result = await fireFeature.propagate!("warehouse", 0, dgsm as any, runtime);
      expect(result.spreadTo).toEqual([]);
    });

    it("should spread to adjacent scene when at threshold", async () => {
      const node = makeFireNode("warehouse", { fireIntensity: 3 });
      fireFeature.activate!(node, dgsm as any);

      const result = await fireFeature.propagate!("warehouse", 0, dgsm as any, runtime);
      expect(result.spreadTo).toContain("hallway");

      // Hallway should now have fire at intensity 1
      const hallwayFire = dgsm.getFeatureSceneState("fire", "hallway") as any;
      expect(hallwayFire).toBeDefined();
      expect(hallwayFire.intensity).toBe(1);
    });

    it("should not spread to scene already on fire", async () => {
      // Both scenes on fire
      const node1 = makeFireNode("warehouse", { fireIntensity: 3 });
      const node2 = makeFireNode("hallway", { fireIntensity: 1 });
      fireFeature.activate!(node1, dgsm as any);
      fireFeature.activate!(node2, dgsm as any);

      const result = await fireFeature.propagate!("warehouse", 0, dgsm as any, runtime);
      expect(result.spreadTo).toEqual([]);
    });
  });

  // ===== stateDescription =====

  describe("stateDescription", () => {
    it("should return empty string when no fires", () => {
      const desc = fireFeature.stateDescription(dgsm as any);
      expect(desc).toBe("");
    });

    it("should list all burning scenes", () => {
      const node = makeFireNode("warehouse");
      fireFeature.activate!(node, dgsm as any);

      const desc = fireFeature.stateDescription(dgsm as any);
      expect(desc).toContain("warehouse");
      expect(desc).toContain("Light smoke");
    });
  });
});
