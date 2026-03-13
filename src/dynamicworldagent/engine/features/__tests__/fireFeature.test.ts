import { describe, it, expect, beforeEach } from "vitest";
import { fireFeature } from "../fireFeature.js";
import type { TickRuntimeContext } from "../../types.js";
import type { PlanNode } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { SceneCondition } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { Item } from "../../../state/types.js";

// ===== Minimal mock of DynamicGameStateManager =====

interface MockScene {
  id: string;
  name: string;
  connections: string[];
  events: string[];
  items?: Item[];
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

    // Topology (default: null — no outdoor topology)
    getTopology(): any {
      return null;
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
      getPendingNodes: async () => [],
      runImpactGateForNpc: async () => ({ shouldRevise: false, shouldReviseSchedule: false, witnessEntry: "" }),
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

// ===== Helper: create mock items =====

function makeEvidence(id: string, overrides?: Partial<Item>): Item {
  return {
    id,
    name: `Evidence ${id}`,
    category: "evidence",
    ...overrides,
  };
}

function makeItem(id: string, overrides?: Partial<Item>): Item {
  return {
    id,
    name: `Item ${id}`,
    ...overrides,
  };
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
      const spotHidden = penalties!.find(p => p.skill === "Perception");
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

  // ===== tick -- item damage =====

  describe("tick -- item damage", () => {
    it("should not damage items when intensity <= 2", () => {
      const items = Array.from({ length: 5 }, (_, i) => makeItem(`i${i}`));
      dgsm._addScene({ id: "lab", name: "Lab", connections: [], events: [], items });

      const node = makeFireNode("lab");
      fireFeature.activate!(node, dgsm as any);

      // 2 ticks: intensity 1→2 (still <= 2)
      runTicks(dgsm, runtime, 2);

      const damaged = items.filter(it => it.damaged);
      expect(damaged.length).toBe(0);
    });

    it("should damage 20% of undamaged items when intensity rises above 2", () => {
      const items = Array.from({ length: 10 }, (_, i) => makeItem(`i${i}`));
      dgsm._addScene({ id: "lab", name: "Lab", connections: [], events: [], items });

      const node = makeFireNode("lab");
      fireFeature.activate!(node, dgsm as any);

      // 4 ticks: intensity 1→2→3, triggers damage at intensity 3
      runTicks(dgsm, runtime, 4);

      const damaged = items.filter(it => it.damaged);
      expect(damaged.length).toBe(2); // round(10 * 0.2)
      for (const it of damaged) {
        expect(it.damageDetails?.damagedBy).toBe("fire");
        expect(it.damageDetails?.reason).toContain("intensity 3");
      }
    });

    it("should skip already damaged items", () => {
      const items = [
        makeItem("i1", { damaged: true }),
        makeItem("i2"),
        makeItem("i3"),
        makeItem("i4"),
        makeItem("i5"),
      ];
      dgsm._addScene({ id: "lab", name: "Lab", connections: [], events: [], items });

      const node = makeFireNode("lab");
      fireFeature.activate!(node, dgsm as any);

      // Intensity 3: round(4 undamaged * 0.2) = 1 newly damaged
      runTicks(dgsm, runtime, 4);

      expect(items.filter(it => it.damaged).length).toBe(2); // 1 pre-damaged + 1 new
    });

    it("should damage both evidence and mundane items together", () => {
      const items = [
        ...Array.from({ length: 5 }, (_, i) => makeEvidence(`e${i}`)),
        ...Array.from({ length: 5 }, (_, i) => makeItem(`i${i}`)),
      ];
      dgsm._addScene({ id: "lab", name: "Lab", connections: [], events: [], items });

      const node = makeFireNode("lab");
      fireFeature.activate!(node, dgsm as any);

      // Intensity 3: round(10 * 0.2) = 2 items damaged
      runTicks(dgsm, runtime, 4);

      expect(items.filter(it => it.damaged).length).toBe(2);
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

  // ===== road fire model =====

  describe("road fire model", () => {
    let roadDgsm: MockDgsm & { getTopology: () => any };

    beforeEach(() => {
      const base = createMockDgsm();

      const topology = {
        junctions: new Map([
          ["JUNC_1", {
            id: "JUNC_1",
            name: "Junction 1",
            description: "",
            parentLocationId: "OUTDOOR",
            items: [],
            conditions: [],
            events: [],
            connectedSceneIds: [],
          }],
          ["JUNC_2", {
            id: "JUNC_2",
            name: "Junction 2",
            description: "",
            parentLocationId: "OUTDOOR",
            items: [],
            conditions: [],
            events: [],
            connectedSceneIds: [],
          }],
        ]),
        roads: new Map([
          ["ROAD_1", {
            id: "ROAD_1",
            name: "Main Street",
            description: "",
            parentLocationId: "OUTDOOR",
            endpointA: "JUNC_1",
            endpointB: "JUNC_2",
            travelTimeMinutes: 20,
            alongConnections: [{ sceneId: "SCN_ALONG", position: 0.5 }],
            items: [],
            conditions: [],
            events: [],
          }],
        ]),
        junctionToRoads: new Map(),
        sceneToParent: new Map(),
      };

      roadDgsm = Object.assign(base, {
        getTopology: () => topology,
      });

      // Add SCN_ALONG as a scene so damageByFire can look it up
      roadDgsm._addScene({
        id: "SCN_ALONG",
        name: "Along Road Scene",
        connections: [],
        events: [],
      });
      // Add ROAD_1 as a "scene" for connections (needed by updateFireBlocking)
      roadDgsm._addScene({
        id: "ROAD_1",
        name: "Main Street",
        connections: ["JUNC_1", "JUNC_2"],
        events: [],
      });
    });

    it("road fire state has burnRange", () => {
      // Manually set a road fire state
      const roadFireState = {
        intensity: 2,
        maxIntensity: 5,
        growthRate: 1,
        decayRate: 1,
        spreadThreshold: 3,
        phase: "growing" as const,
        ticksInPhase: 0,
        totalBurnTicks: 0,
        burnRange: { start: 0.5, end: 0.5 },
      };
      roadDgsm.setFeatureSceneState("fire", "ROAD_1", roadFireState);

      const fs = roadDgsm.getFeatureSceneState("fire", "ROAD_1") as any;
      expect(fs).toBeDefined();
      expect(fs.burnRange).toBeDefined();
      expect(fs.burnRange.start).toBe(0.5);
      expect(fs.burnRange.end).toBe(0.5);
    });

    it("burn range expands each tick (delta = 2/20 = 0.1)", () => {
      const roadFireState = {
        intensity: 2,
        maxIntensity: 5,
        growthRate: 1,
        decayRate: 1,
        spreadThreshold: 3,
        phase: "growing" as const,
        ticksInPhase: 0,
        totalBurnTicks: 0,
        burnRange: { start: 0.5, end: 0.5 },
      };
      roadDgsm.setFeatureSceneState("fire", "ROAD_1", roadFireState);

      // Run 1 tick
      fireFeature.tick!(roadDgsm as any, runtime);

      const fs = roadDgsm.getFeatureSceneState("fire", "ROAD_1") as any;
      expect(fs.burnRange.start).toBeCloseTo(0.4, 5);
      expect(fs.burnRange.end).toBeCloseTo(0.6, 5);
    });

    it("burn range clamps to 0.0-1.0", () => {
      const roadFireState = {
        intensity: 2,
        maxIntensity: 5,
        growthRate: 1,
        decayRate: 1,
        spreadThreshold: 3,
        phase: "growing" as const,
        ticksInPhase: 0,
        totalBurnTicks: 0,
        burnRange: { start: 0.05, end: 0.95 },
      };
      roadDgsm.setFeatureSceneState("fire", "ROAD_1", roadFireState);

      // Run 1 tick: delta=0.1, start would be 0.05-0.1=-0.05 → clamped to 0, end would be 0.95+0.1=1.05 → clamped to 1
      fireFeature.tick!(roadDgsm as any, runtime);

      const fs = roadDgsm.getFeatureSceneState("fire", "ROAD_1") as any;
      expect(fs.burnRange.start).toBe(0);
      expect(fs.burnRange.end).toBe(1);
    });

    it("along-road scenes within burn range get fire condition", () => {
      // SCN_ALONG is at position 0.5. Set burn range to include it.
      const roadFireState = {
        intensity: 2,
        maxIntensity: 5,
        growthRate: 1,
        decayRate: 1,
        spreadThreshold: 3,
        phase: "growing" as const,
        ticksInPhase: 0,
        totalBurnTicks: 0,
        burnRange: { start: 0.45, end: 0.45 },
      };
      roadDgsm.setFeatureSceneState("fire", "ROAD_1", roadFireState);

      // After 1 tick: burn range expands by 0.1 each side → start=0.35, end=0.55
      // SCN_ALONG at 0.5 is within [0.35, 0.55]
      fireFeature.tick!(roadDgsm as any, runtime);

      const conditions = roadDgsm.getSceneConditions("SCN_ALONG");
      const fireCond = conditions.find(c => c.description.startsWith("[Fire]"));
      expect(fireCond).toBeDefined();
      // intensity=2, so along-road scene gets max(1, 2-1) = 1 → "Light smoke"
      expect(fireCond!.description).toContain("Light smoke");
    });

    it("along-road scenes outside burn range don't get fire condition", () => {
      // SCN_ALONG is at position 0.5. Set burn range far from it.
      const roadFireState = {
        intensity: 2,
        maxIntensity: 5,
        growthRate: 1,
        decayRate: 1,
        spreadThreshold: 3,
        phase: "growing" as const,
        ticksInPhase: 0,
        totalBurnTicks: 0,
        burnRange: { start: 0.1, end: 0.1 },
      };
      roadDgsm.setFeatureSceneState("fire", "ROAD_1", roadFireState);

      // After 1 tick: burn range expands by 0.1 → start=0.0, end=0.2
      // SCN_ALONG at 0.5 is NOT within [0.0, 0.2]
      fireFeature.tick!(roadDgsm as any, runtime);

      const conditions = roadDgsm.getSceneConditions("SCN_ALONG");
      const fireCond = conditions.find(c => c.description.startsWith("[Fire]"));
      expect(fireCond).toBeUndefined();
    });
  });

  // ===== weather interaction on outdoor fire =====

  describe("weather interaction on outdoor fire", () => {
    let roadDgsm: MockDgsm & { getTopology: () => any };

    beforeEach(() => {
      const base = createMockDgsm();

      const topology = {
        junctions: new Map([
          ["JUNC_1", {
            id: "JUNC_1",
            name: "Junction 1",
            description: "",
            parentLocationId: "OUTDOOR",
            items: [],
            conditions: [],
            events: [],
            connectedSceneIds: [],
          }],
          ["JUNC_2", {
            id: "JUNC_2",
            name: "Junction 2",
            description: "",
            parentLocationId: "OUTDOOR",
            items: [],
            conditions: [],
            events: [],
            connectedSceneIds: [],
          }],
        ]),
        roads: new Map([
          ["ROAD_1", {
            id: "ROAD_1",
            name: "Main Street",
            description: "",
            parentLocationId: "OUTDOOR",
            endpointA: "JUNC_1",
            endpointB: "JUNC_2",
            travelTimeMinutes: 20,
            alongConnections: [{ sceneId: "SCN_ALONG", position: 0.5 }],
            items: [],
            conditions: [],
            events: [],
          }],
        ]),
        junctionToRoads: new Map(),
        sceneToParent: new Map(),
      };

      roadDgsm = Object.assign(base, {
        getTopology: () => topology,
      });

      // Add scenes needed by tests
      roadDgsm._addScene({
        id: "SCN_ALONG",
        name: "Along Road Scene",
        connections: [],
        events: [],
      });
      roadDgsm._addScene({
        id: "ROAD_1",
        name: "Main Street",
        connections: ["JUNC_1", "JUNC_2"],
        events: [],
      });
      roadDgsm._addScene({
        id: "JUNC_1",
        name: "Junction 1",
        connections: [],
        events: [],
      });
    });

    it("heavy rain (intensity >= 4) extinguishes road fire", () => {
      // Set heavy rain weather on OUTDOOR
      roadDgsm.setFeatureSceneState("weather", "OUTDOOR", { weatherType: "rain", intensity: 4 });

      // Set road fire
      const roadFireState = {
        intensity: 2,
        maxIntensity: 5,
        growthRate: 1,
        decayRate: 1,
        spreadThreshold: 3,
        phase: "growing" as const,
        ticksInPhase: 0,
        totalBurnTicks: 3,
        burnRange: { start: 0.4, end: 0.6 },
      };
      roadDgsm.setFeatureSceneState("fire", "ROAD_1", roadFireState);

      // Run 1 tick
      fireFeature.tick!(roadDgsm as any, runtime);

      // Fire should be extinguished
      const fs = roadDgsm.getFeatureSceneState("fire", "ROAD_1");
      expect(fs).toBeUndefined();

      // Aftermath condition should exist
      const conditions = roadDgsm.getSceneConditions("ROAD_1");
      const aftermath = conditions.find(c => c.description.startsWith("[Fire Aftermath]"));
      expect(aftermath).toBeDefined();
    });

    it("light rain (intensity 2) slows road fire spread (0.5x)", () => {
      // Set light rain weather on OUTDOOR
      roadDgsm.setFeatureSceneState("weather", "OUTDOOR", { weatherType: "rain", intensity: 2 });

      // Set road fire
      const roadFireState = {
        intensity: 2,
        maxIntensity: 5,
        growthRate: 1,
        decayRate: 1,
        spreadThreshold: 3,
        phase: "growing" as const,
        ticksInPhase: 0,
        totalBurnTicks: 0,
        burnRange: { start: 0.5, end: 0.5 },
      };
      roadDgsm.setFeatureSceneState("fire", "ROAD_1", roadFireState);

      // Run 1 tick
      fireFeature.tick!(roadDgsm as any, runtime);

      // Spread should be halved: base delta = 2/20 = 0.1, * 0.5 = 0.05
      const fs = roadDgsm.getFeatureSceneState("fire", "ROAD_1") as any;
      expect(fs).toBeDefined();
      expect(fs.burnRange.start).toBeCloseTo(0.45, 5);
      expect(fs.burnRange.end).toBeCloseTo(0.55, 5);
    });

    it("heavy rain extinguishes junction fire", () => {
      // Set heavy rain weather on OUTDOOR
      roadDgsm.setFeatureSceneState("weather", "OUTDOOR", { weatherType: "rain", intensity: 4 });

      // Set junction fire (regular fire state, not road fire)
      const junctionFireState = {
        intensity: 2,
        maxIntensity: 5,
        growthRate: 1,
        decayRate: 1,
        spreadThreshold: 3,
        phase: "growing" as const,
        ticksInPhase: 0,
        totalBurnTicks: 5,
      };
      roadDgsm.setFeatureSceneState("fire", "JUNC_1", junctionFireState);

      // Run 1 tick
      fireFeature.tick!(roadDgsm as any, runtime);

      // Fire should be extinguished
      const fs = roadDgsm.getFeatureSceneState("fire", "JUNC_1");
      expect(fs).toBeUndefined();

      // Aftermath condition should exist
      const conditions = roadDgsm.getSceneConditions("JUNC_1");
      const aftermath = conditions.find(c => c.description.startsWith("[Fire Aftermath]"));
      expect(aftermath).toBeDefined();
    });

    it("scene (building) fire NOT affected by weather (no extinguish)", () => {
      // Set heavy rain weather on OUTDOOR
      roadDgsm.setFeatureSceneState("weather", "OUTDOOR", { weatherType: "rain", intensity: 4 });

      // SCN_ALONG is a building scene, not a road or junction in the topology
      // Set fire on it
      const sceneFireState = {
        intensity: 2,
        maxIntensity: 5,
        growthRate: 1,
        decayRate: 1,
        spreadThreshold: 3,
        phase: "growing" as const,
        ticksInPhase: 0,
        totalBurnTicks: 0,
      };
      roadDgsm.setFeatureSceneState("fire", "SCN_ALONG", sceneFireState);

      // Run 1 tick
      fireFeature.tick!(roadDgsm as any, runtime);

      // Fire should still exist (not extinguished by weather)
      const fs = roadDgsm.getFeatureSceneState("fire", "SCN_ALONG");
      expect(fs).toBeDefined();
    });
  });

  // ===== topology-aware propagation =====

  describe("topology-aware propagation", () => {
    let topoDgsm: MockDgsm & { getTopology: () => any };

    beforeEach(() => {
      const base = createMockDgsm();

      // Build topology with proper maps using buildTopology-style construction
      const junctions = new Map([
        ["JUNC_1", {
          id: "JUNC_1", name: "J1", description: "", parentLocationId: "OUTDOOR",
          connectedSceneIds: ["SCN_A"], items: [], conditions: [], events: [],
        }],
        ["JUNC_2", {
          id: "JUNC_2", name: "J2", description: "", parentLocationId: "OUTDOOR",
          connectedSceneIds: [], items: [], conditions: [], events: [],
        }],
      ]);
      const roads = new Map([
        ["ROAD_1", {
          id: "ROAD_1", name: "R1", description: "", parentLocationId: "OUTDOOR",
          endpointA: "JUNC_1", endpointB: "JUNC_2", travelTimeMinutes: 20,
          alongConnections: [{ sceneId: "SCN_B", position: 0.3 }],
          items: [], conditions: [], events: [],
        }],
      ]);

      // Manually build topology with all maps
      const junctionToRoads = new Map();
      junctionToRoads.set("JUNC_1", [roads.get("ROAD_1")!]);
      junctionToRoads.set("JUNC_2", [roads.get("ROAD_1")!]);

      const sceneToParent = new Map();
      sceneToParent.set("SCN_A", { type: "junction", junctionId: "JUNC_1" });
      sceneToParent.set("SCN_B", { type: "road", roadId: "ROAD_1", position: 0.3 });

      const topology = { junctions, roads, junctionToRoads, sceneToParent };

      topoDgsm = Object.assign(base, {
        getTopology: () => topology,
      });

      topoDgsm._addScene({ id: "SCN_A", name: "Scene A", connections: [], events: [] });
      topoDgsm._addScene({ id: "SCN_B", name: "Scene B", connections: [], events: [] });
    });

    it("should spread from scene to parent junction", async () => {
      // Fire at SCN_A intensity 3 (>= spreadThreshold)
      topoDgsm.setFeatureSceneState("fire", "SCN_A", {
        intensity: 3, maxIntensity: 5, growthRate: 1, decayRate: 1,
        spreadThreshold: 3, phase: "growing" as const, ticksInPhase: 0, totalBurnTicks: 0,
      });

      const result = await fireFeature.propagate!("SCN_A", 0, topoDgsm as any, runtime);
      expect(result.spreadTo).toContain("JUNC_1");
      expect(topoDgsm.getFeatureSceneState("fire", "JUNC_1")).toBeDefined();
    });

    it("should spread from junction to connected roads with correct position", async () => {
      topoDgsm.setFeatureSceneState("fire", "JUNC_1", {
        intensity: 3, maxIntensity: 5, growthRate: 1, decayRate: 1,
        spreadThreshold: 3, phase: "growing" as const, ticksInPhase: 0, totalBurnTicks: 0,
      });

      const result = await fireFeature.propagate!("JUNC_1", 0, topoDgsm as any, runtime);
      expect(result.spreadTo).toContain("ROAD_1");

      // Road fire should have burnRange starting at 0.0 (JUNC_1 is endpointA)
      const roadFire = topoDgsm.getFeatureSceneState("fire", "ROAD_1") as any;
      expect(roadFire).toBeDefined();
      expect(roadFire.burnRange).toBeDefined();
      expect(roadFire.burnRange.start).toBe(0);
      expect(roadFire.burnRange.end).toBe(0);
    });

    it("should spread from junction to connected scenes", async () => {
      topoDgsm.setFeatureSceneState("fire", "JUNC_1", {
        intensity: 3, maxIntensity: 5, growthRate: 1, decayRate: 1,
        spreadThreshold: 3, phase: "growing" as const, ticksInPhase: 0, totalBurnTicks: 0,
      });

      const result = await fireFeature.propagate!("JUNC_1", 0, topoDgsm as any, runtime);
      expect(result.spreadTo).toContain("SCN_A");
    });

    it("should spread from road to endpoint junction when burnRange reaches end", async () => {
      topoDgsm.setFeatureSceneState("fire", "ROAD_1", {
        intensity: 3, maxIntensity: 5, growthRate: 1, decayRate: 1,
        spreadThreshold: 3, phase: "growing" as const, ticksInPhase: 0, totalBurnTicks: 0,
        burnRange: { start: 0.0, end: 0.96 },
      });

      const result = await fireFeature.propagate!("ROAD_1", 0, topoDgsm as any, runtime);
      // burnRange.start <= 0.05 -> spread to endpointA (JUNC_1)
      expect(result.spreadTo).toContain("JUNC_1");
      // burnRange.end >= 0.95 -> spread to endpointB (JUNC_2)
      expect(result.spreadTo).toContain("JUNC_2");
    });

    it("should NOT spread from road when burnRange hasn't reached endpoints", async () => {
      topoDgsm.setFeatureSceneState("fire", "ROAD_1", {
        intensity: 3, maxIntensity: 5, growthRate: 1, decayRate: 1,
        spreadThreshold: 3, phase: "growing" as const, ticksInPhase: 0, totalBurnTicks: 0,
        burnRange: { start: 0.3, end: 0.7 },
      });

      const result = await fireFeature.propagate!("ROAD_1", 0, topoDgsm as any, runtime);
      expect(result.spreadTo).not.toContain("JUNC_1");
      expect(result.spreadTo).not.toContain("JUNC_2");
    });

    it("should spread from scene to parent road with position", async () => {
      // SCN_B is on ROAD_1 at position 0.3
      topoDgsm.setFeatureSceneState("fire", "SCN_B", {
        intensity: 3, maxIntensity: 5, growthRate: 1, decayRate: 1,
        spreadThreshold: 3, phase: "growing" as const, ticksInPhase: 0, totalBurnTicks: 0,
      });

      const result = await fireFeature.propagate!("SCN_B", 0, topoDgsm as any, runtime);
      expect(result.spreadTo).toContain("ROAD_1");

      const roadFire = topoDgsm.getFeatureSceneState("fire", "ROAD_1") as any;
      expect(roadFire.burnRange.start).toBe(0.3);
      expect(roadFire.burnRange.end).toBe(0.3);
    });

    it("should fall back to scene.connections when no topology", async () => {
      // Use a dgsm without topology
      const noTopoDgsm = createMockDgsm();
      noTopoDgsm._addScene({ id: "room1", name: "Room 1", connections: ["room2"], events: [] });
      noTopoDgsm._addScene({ id: "room2", name: "Room 2", connections: ["room1"], events: [] });

      noTopoDgsm.setFeatureSceneState("fire", "room1", {
        intensity: 3, maxIntensity: 5, growthRate: 1, decayRate: 1,
        spreadThreshold: 3, phase: "growing" as const, ticksInPhase: 0, totalBurnTicks: 0,
      });

      const result = await fireFeature.propagate!("room1", 0, noTopoDgsm as any, runtime);
      expect(result.spreadTo).toContain("room2");
    });
  });
});
