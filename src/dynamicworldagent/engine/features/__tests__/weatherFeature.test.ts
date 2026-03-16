import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneCondition } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import {
  makeBlockedConnectionKey,
  resolveBlockedConnectionNodeRef,
} from "../../../state/blockedConnections.js";
import type { TickRuntimeContext } from "../../types.js";
import { weatherFeature } from "../weatherFeature.js";

// ===== Mock DGSM =====

interface MockScene {
  id: string;
  name: string;
  parentLocationId: string;
  connections: string[];
  events: string[];
  indoor?: boolean;
  items?: any[];
}

function createMockDgsm() {
  const featureState: Record<string, Record<string, unknown>> = {};
  const scenarioConditions: Record<string, SceneCondition[]> = {};
  const blockedConnections = new Map<string, string>();
  const scenes = new Map<string, MockScene>();
  const characterPositions: Record<string, any> = {};
  const npcStats: Record<string, { hp: number; san: number }> = {};

  let api: {
    getConnectionBlockReason(fromId: string, toId: string): string | undefined;
    [key: string]: unknown;
  };

  const getNodeRef = (id: string) => resolveBlockedConnectionNodeRef(id, { scenes });

  api = {
    getFeatureSceneState(featureId: string, sceneId: string) {
      return featureState[featureId]?.[sceneId];
    },
    setFeatureSceneState(featureId: string, sceneId: string, data: unknown) {
      if (!featureState[featureId]) featureState[featureId] = {};
      featureState[featureId][sceneId] = data;
    },
    removeFeatureSceneState(featureId: string, sceneId: string) {
      if (featureState[featureId]) delete featureState[featureId][sceneId];
    },
    getFeatureState(featureId: string) {
      return featureState[featureId] ?? {};
    },
    appendSceneCondition(scenarioId: string, condition: SceneCondition) {
      if (!scenarioConditions[scenarioId]) scenarioConditions[scenarioId] = [];
      scenarioConditions[scenarioId].push(condition);
    },
    getScene(sceneId: string) {
      return scenes.get(sceneId);
    },
    getState() {
      return {
        scenarioConditions,
        blockedConnections,
        scenes,
        junctions: new Map(),
        roads: new Map(),
        characterPositions,
        npcStats,
      };
    },
    getConnectionBlockReason(fromId: string, toId: string) {
      const fromRef = getNodeRef(fromId);
      const toRef = getNodeRef(toId);
      if (!fromRef || !toRef) return undefined;
      return blockedConnections.get(makeBlockedConnectionKey(fromRef, toRef));
    },
    setConnectionBlocked(
      fromId: string,
      toId: string,
      blocked: boolean,
      reason: string
    ) {
      const fromRef = getNodeRef(fromId);
      const toRef = getNodeRef(toId);
      if (!fromRef || !toRef) {
        throw new Error(
          `Unknown blocked connection endpoint in test mock: ${fromId}, ${toId}`
        );
      }
      const key = makeBlockedConnectionKey(fromRef, toRef);
      if (blocked) blockedConnections.set(key, reason);
      else blockedConnections.delete(key);
    },
    updateNpcHp(npcId: string, delta: number) {
      if (!npcStats[npcId]) return;
      npcStats[npcId].hp = Math.max(0, npcStats[npcId].hp + delta);
    },
    _addScene(scene: MockScene) {
      scenes.set(scene.id, scene);
    },
    _addNpc(npcId: string, location: string, hp: number) {
      characterPositions[npcId] = { type: "scene", sceneId: location };
      npcStats[npcId] = { hp, san: 50 };
    },
    _featureState: featureState,
    _scenarioConditions: scenarioConditions,
    _blockedConnections: blockedConnections,
  };
  return api;
}

type MockDgsm = ReturnType<typeof createMockDgsm>;

function createMockRuntime(): TickRuntimeContext {
  return {
    sessionId: "test",
    gameDay: 1,
    language: "en",
    tickTime: "08:00",
    tickDurationMinutes: 5,
    npcPlanning: {
      getPendingNodes: async () => [],
      runImpactGateForNpc: async () => ({
        shouldRevise: false,
        shouldReviseSchedule: false,
        witnessEntry: "",
      }),
      revisePlans: async () => {},
    },
  };
}

function runTicks(dgsm: MockDgsm, runtime: TickRuntimeContext, count: number) {
  for (let i = 0; i < count; i++) {
    weatherFeature.tick!(dgsm as any, runtime);
  }
}

function setupDefaultScenes(dgsm: MockDgsm) {
  dgsm._addScene({
    id: "town_square",
    name: "Town Square",
    parentLocationId: "town",
    connections: ["main_street"],
    events: [],
  });
  dgsm._addScene({
    id: "main_street",
    name: "Main Street",
    parentLocationId: "town",
    connections: ["town_square", "tavern"],
    events: [],
  });
  dgsm._addScene({
    id: "tavern",
    name: "Tavern",
    parentLocationId: "town",
    connections: ["main_street"],
    events: [],
    indoor: true,
  });
  dgsm._addScene({
    id: "forest_path",
    name: "Forest Path",
    parentLocationId: "forest",
    connections: ["forest_clearing"],
    events: [],
  });
  dgsm._addScene({
    id: "forest_clearing",
    name: "Forest Clearing",
    parentLocationId: "forest",
    connections: ["forest_path"],
    events: [],
  });
}

// ===== Tests =====

describe("weatherFeature", () => {
  let dgsm: MockDgsm;
  let runtime: TickRuntimeContext;

  beforeEach(() => {
    dgsm = createMockDgsm();
    runtime = createMockRuntime();
    setupDefaultScenes(dgsm);
  });

  describe("initialization", () => {
    it("should auto-initialize regions on first tick", () => {
      runTicks(dgsm, runtime, 1);

      const townState = dgsm.getFeatureSceneState("weather", "town") as any;
      const forestState = dgsm.getFeatureSceneState("weather", "forest") as any;
      expect(townState).toBeDefined();
      expect(forestState).toBeDefined();
      expect(townState.weatherType).toBe("clear");
      expect(forestState.weatherType).toBe("clear");
    });

    it("should only include outdoor scenes in affectedSceneIds", () => {
      runTicks(dgsm, runtime, 1);

      const townState = dgsm.getFeatureSceneState("weather", "town") as any;
      expect(townState.affectedSceneIds).toContain("town_square");
      expect(townState.affectedSceneIds).toContain("main_street");
      expect(townState.affectedSceneIds).not.toContain("tavern");
    });

    it("should skip regions with only indoor scenes", () => {
      // Clear scenes and add only indoor ones for a region
      const indoorDgsm = createMockDgsm();
      indoorDgsm._addScene({
        id: "room1",
        name: "Room 1",
        parentLocationId: "building",
        connections: [],
        events: [],
        indoor: true,
      });
      indoorDgsm._addScene({
        id: "room2",
        name: "Room 2",
        parentLocationId: "building",
        connections: [],
        events: [],
        indoor: true,
      });

      runTicks(indoorDgsm, runtime, 1);

      const buildingState = indoorDgsm.getFeatureSceneState(
        "weather",
        "building"
      );
      expect(buildingState).toBeUndefined();
    });
  });

  describe("stateDescription", () => {
    it("should show clear when all regions are clear", () => {
      runTicks(dgsm, runtime, 1);
      const desc = weatherFeature.stateDescription(dgsm as any);
      expect(desc).toContain("Clear");
    });

    it("should list active weather regions", () => {
      runTicks(dgsm, runtime, 1);

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "rain";
      ws.intensity = 3;
      dgsm.setFeatureSceneState("weather", "town", ws);

      const desc = weatherFeature.stateDescription(dgsm as any);
      expect(desc).toContain("town");
      expect(desc).toContain("rain");
      expect(desc).toContain("3/5");
    });
  });

  describe("tick — Markov transition", () => {
    it("should not change weather before transition check interval", () => {
      runTicks(dgsm, runtime, 1); // init

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "rain";
      ws.intensity = 3;
      ws.ticksInState = 0;
      dgsm.setFeatureSceneState("weather", "town", ws);

      runTicks(dgsm, runtime, 5);

      const updated = dgsm.getFeatureSceneState("weather", "town") as any;
      expect(updated.weatherType).toBe("rain");
      expect(updated.intensity).toBe(3);
      expect(updated.ticksInState).toBe(5);
    });

    it("should transition to clear when random hits clear range", () => {
      runTicks(dgsm, runtime, 1); // init

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "rain";
      ws.intensity = 3;
      ws.ticksInState = 5;
      dgsm.setFeatureSceneState("weather", "town", ws);

      const mockRandom = vi.spyOn(Math, "random");
      // rain row cumsum: [0.10, 0.55, 0.65, 0.85, 0.90, 0.90, 1.00]
      // random = 0.01 → clear
      mockRandom.mockReturnValueOnce(0.01);
      // forest region (clear) needs random too
      mockRandom.mockReturnValueOnce(0.5); // clear stays clear

      runTicks(dgsm, runtime, 1);

      const updated = dgsm.getFeatureSceneState("weather", "town") as any;
      expect(updated.weatherType).toBe("clear");
      expect(updated.intensity).toBe(0);

      mockRandom.mockRestore();
    });

    it("should evolve intensity when type stays the same", () => {
      runTicks(dgsm, runtime, 1); // init

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "rain";
      ws.intensity = 2;
      ws.ticksInState = 5;
      dgsm.setFeatureSceneState("weather", "town", ws);

      const mockRandom = vi.spyOn(Math, "random");
      // sampleTransition: rain stays (0.30 falls in rain range [0.10, 0.55))
      mockRandom.mockReturnValueOnce(0.3);
      // evolveIntensity: 0.75 → up (0.60 <= 0.75 < 0.80)
      mockRandom.mockReturnValueOnce(0.75);
      // forest clear stays
      mockRandom.mockReturnValueOnce(0.5);

      runTicks(dgsm, runtime, 1);

      const updated = dgsm.getFeatureSceneState("weather", "town") as any;
      expect(updated.weatherType).toBe("rain");
      expect(updated.intensity).toBe(3);

      mockRandom.mockRestore();
    });

    it("should revert to clear when intensity drops to 0", () => {
      runTicks(dgsm, runtime, 1); // init

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "rain";
      ws.intensity = 1;
      ws.ticksInState = 5;
      dgsm.setFeatureSceneState("weather", "town", ws);

      const mockRandom = vi.spyOn(Math, "random");
      // rain stays
      mockRandom.mockReturnValueOnce(0.3);
      // intensity down: 0.95 → down (>= 0.80), 1-1=0 → clear
      mockRandom.mockReturnValueOnce(0.95);
      // forest
      mockRandom.mockReturnValueOnce(0.5);

      runTicks(dgsm, runtime, 1);

      const updated = dgsm.getFeatureSceneState("weather", "town") as any;
      expect(updated.weatherType).toBe("clear");
      expect(updated.intensity).toBe(0);

      mockRandom.mockRestore();
    });

    it("should cap intensity at 5", () => {
      runTicks(dgsm, runtime, 1); // init

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "storm";
      ws.intensity = 5;
      ws.ticksInState = 5;
      dgsm.setFeatureSceneState("weather", "town", ws);

      const mockRandom = vi.spyOn(Math, "random");
      // storm stays
      mockRandom.mockReturnValueOnce(0.4);
      // intensity up: 0.75 → up, but capped at 5
      mockRandom.mockReturnValueOnce(0.75);
      // forest
      mockRandom.mockReturnValueOnce(0.5);

      runTicks(dgsm, runtime, 1);

      const updated = dgsm.getFeatureSceneState("weather", "town") as any;
      expect(updated.intensity).toBe(5);

      mockRandom.mockRestore();
    });
  });

  describe("skill penalties", () => {
    it("should write fog penalties to outdoor scenes only", () => {
      runTicks(dgsm, runtime, 1); // init

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "fog";
      ws.intensity = 3;
      ws.ticksInState = 5;
      dgsm.setFeatureSceneState("weather", "town", ws);

      const mockRandom = vi.spyOn(Math, "random");
      // fog stays (0.50 in fog range [0.40, 0.95))
      mockRandom.mockReturnValueOnce(0.5);
      // intensity no change
      mockRandom.mockReturnValueOnce(0.3);
      // forest clear stays
      mockRandom.mockReturnValueOnce(0.5);

      runTicks(dgsm, runtime, 1);

      // town_square should have weather condition
      const squareConditions = dgsm._scenarioConditions["town_square"] ?? [];
      const weatherCond = squareConditions.find((c) =>
        c.description.startsWith("[Weather]")
      );
      expect(weatherCond).toBeDefined();
      expect(weatherCond!.mechanicalEffect?.skillPenalty).toBeDefined();

      const perception = weatherCond!.mechanicalEffect!.skillPenalty!.find(
        (p) => p.skill === "Perception"
      );
      expect(perception).toBeDefined();
      expect(perception!.delta).toBe(-30); // -10 * 3

      // tavern (indoor) should have NO weather condition
      const tavernConditions = dgsm._scenarioConditions["tavern"] ?? [];
      const tavernWeather = tavernConditions.find((c) =>
        c.description.startsWith("[Weather]")
      );
      expect(tavernWeather).toBeUndefined();

      mockRandom.mockRestore();
    });

    it("should apply rain penalties with correct trigger thresholds", () => {
      runTicks(dgsm, runtime, 1); // init

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "rain";
      ws.intensity = 2;
      ws.ticksInState = 5;
      dgsm.setFeatureSceneState("weather", "town", ws);

      const mockRandom = vi.spyOn(Math, "random");
      mockRandom.mockReturnValueOnce(0.3); // rain stays
      mockRandom.mockReturnValueOnce(0.3); // intensity no change
      mockRandom.mockReturnValueOnce(0.5); // forest

      runTicks(dgsm, runtime, 1);

      const conditions = dgsm._scenarioConditions["town_square"] ?? [];
      const weatherCond = conditions.find((c) =>
        c.description.startsWith("[Weather]")
      );
      expect(weatherCond).toBeDefined();

      const penalties = weatherCond!.mechanicalEffect!.skillPenalty!;
      // At intensity 2: Perception (trigger 1), Track (trigger 1), Drive Auto (trigger 2), Listen (trigger 2), Climb (trigger 2)
      // NOT: Pistol etc (trigger 3)
      expect(penalties.find((p) => p.skill === "Perception")).toBeDefined();
      expect(penalties.find((p) => p.skill === "Track")).toBeDefined();
      expect(penalties.find((p) => p.skill === "Drive Auto")).toBeDefined();
      expect(penalties.find((p) => p.skill === "Listen")).toBeDefined();
      expect(penalties.find((p) => p.skill === "Climb")).toBeDefined();
      expect(penalties.find((p) => p.skill === "Pistol")).toBeUndefined(); // trigger 3, not active at intensity 2

      mockRandom.mockRestore();
    });
  });

  describe("connection blocking", () => {
    it("should block outdoor connections during severe storm", () => {
      runTicks(dgsm, runtime, 1); // init

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "storm";
      ws.intensity = 4;
      ws.ticksInState = 5;
      dgsm.setFeatureSceneState("weather", "town", ws);

      const mockRandom = vi.spyOn(Math, "random");
      mockRandom.mockReturnValueOnce(0.4); // storm stays
      mockRandom.mockReturnValueOnce(0.3); // intensity no change
      mockRandom.mockReturnValueOnce(0.5); // forest

      runTicks(dgsm, runtime, 1);

      // outdoor-to-outdoor should be blocked
      expect(dgsm.getConnectionBlockReason("town_square", "main_street")).toBe(
        "Blocked by storm (intensity 4)"
      );

      // outdoor-to-indoor should NOT be blocked
      expect(dgsm.getConnectionBlockReason("main_street", "tavern")).toBeUndefined();

      mockRandom.mockRestore();
    });

    it("should not block at intensity < 4", () => {
      runTicks(dgsm, runtime, 1); // init

      const ws = dgsm.getFeatureSceneState("weather", "town") as any;
      ws.weatherType = "storm";
      ws.intensity = 3;
      ws.ticksInState = 5;
      dgsm.setFeatureSceneState("weather", "town", ws);

      const mockRandom = vi.spyOn(Math, "random");
      mockRandom.mockReturnValueOnce(0.4);
      mockRandom.mockReturnValueOnce(0.3);
      mockRandom.mockReturnValueOnce(0.5);

      runTicks(dgsm, runtime, 1);

      expect(dgsm._blockedConnections.size).toBe(0);

      mockRandom.mockRestore();
    });
  });

  describe("planningPrompt", () => {
    it("should be read-only with no overlay fields", () => {
      expect(weatherFeature.planningPrompt).toContain("Weather");
      expect(weatherFeature.planningPrompt).toContain("automatically");
      expect((weatherFeature as any).planNodeSchema).toBeUndefined();
      expect((weatherFeature as any).propagation).toBeUndefined();
    });
  });
});
