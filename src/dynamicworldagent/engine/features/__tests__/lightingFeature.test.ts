import { describe, it, expect, beforeEach } from "vitest";
import { lightingFeature } from "../lightingFeature.js";
import type { TickRuntimeContext } from "../../types.js";
import type { SceneCondition } from "../../../dynamicBasicAgent/npcPlanning/types.js";

// ===== Mock DGSM =====

interface MockItem {
  id: string;
  name: string;
  isLightSource?: boolean;
  lightLevel?: number;
  damaged?: boolean;
}

interface MockScene {
  id: string;
  name: string;
  parentLocationId: string;
  connections: string[];
  events: string[];
  indoor?: boolean;
  items?: MockItem[];
  clues?: any[];
}

function createMockDgsm() {
  const featureState: Record<string, Record<string, unknown>> = {};
  const scenarioConditions: Record<string, SceneCondition[]> = {};
  const scenes = new Map<string, MockScene>();
  const blockedConnections = new Map<string, string>();

  return {
    getFeatureSceneState(featureId: string, sceneId: string) {
      return featureState[featureId]?.[sceneId];
    },
    setFeatureSceneState(featureId: string, sceneId: string, data: unknown) {
      if (!featureState[featureId]) featureState[featureId] = {};
      featureState[featureId][sceneId] = data;
    },
    getFeatureState(featureId: string) {
      return featureState[featureId] ?? {};
    },
    appendSceneCondition(scenarioId: string, condition: SceneCondition) {
      if (!scenarioConditions[scenarioId]) scenarioConditions[scenarioId] = [];
      scenarioConditions[scenarioId].push(condition);
    },
    getScene(sceneId: string) { return scenes.get(sceneId); },
    getState() {
      return { scenarioConditions, blockedConnections, scenes };
    },
    _addScene(scene: MockScene) { scenes.set(scene.id, scene); },
    _setFireState(sceneId: string, intensity: number) {
      if (!featureState["fire"]) featureState["fire"] = {};
      featureState["fire"][sceneId] = { intensity };
    },
    _setWeatherState(regionId: string, weatherType: string, intensity: number) {
      if (!featureState["weather"]) featureState["weather"] = {};
      featureState["weather"][regionId] = { weatherType, intensity, affectedSceneIds: [] };
    },
    // Topology (default: null — no outdoor topology)
    getTopology(): any {
      return null;
    },

    _featureState: featureState,
    _scenarioConditions: scenarioConditions,
  };
}

type MockDgsm = ReturnType<typeof createMockDgsm>;

function createRuntime(tickTime: string): TickRuntimeContext {
  return {
    sessionId: "test", gameDay: 1, language: "en",
    tickTime, tickDurationMinutes: 5,
    npcPlanning: {
      getLongTermIntent: async () => "",
      getPendingNodes: async () => [],
      runImpactGateForNpc: async () => ({ shouldRevise: false, witnessEntry: "" }),
      appendMemoryLog: async () => {},
      getMemoryLog: async () => [],
      revisePlans: async () => {},
    },
  };
}

function setupScenes(dgsm: MockDgsm) {
  dgsm._addScene({ id: "street", name: "Street", parentLocationId: "town", connections: ["alley", "shop"], events: [] });
  dgsm._addScene({ id: "alley", name: "Dark Alley", parentLocationId: "town", connections: ["street"], events: [] });
  dgsm._addScene({ id: "shop", name: "Shop", parentLocationId: "town", connections: ["street"], events: [], indoor: true });
}

// ===== Tests =====

describe("lightingFeature", () => {
  let dgsm: MockDgsm;

  beforeEach(() => {
    dgsm = createMockDgsm();
    setupScenes(dgsm);
  });

  describe("sun curve — outdoor scenes", () => {
    it("should be bright at noon", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(5);
      expect(streetState.sources).toContain("sun");
    });

    it("should be dark at midnight (moon provides level 2)", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(2);
      expect(streetState.sources).toContain("moon");
    });

    it("should be normal at dawn (06:00)", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("06:00"));

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(3);
    });

    it("should be normal at dusk (18:00)", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("18:00"));

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(3);
    });
  });

  describe("indoor scenes", () => {
    it("should be pitch black without light sources", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const shopState = dgsm.getFeatureSceneState("lighting", "shop") as any;
      expect(shopState.lightLevel).toBe(1);
    });

    it("should use item light sources", () => {
      const shop = dgsm.getScene("shop")!;
      shop.items = [
        { id: "lamp", name: "Oil Lamp", isLightSource: true, lightLevel: 3 },
      ];

      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const shopState = dgsm.getFeatureSceneState("lighting", "shop") as any;
      expect(shopState.lightLevel).toBe(3);
      expect(shopState.sources).toContain("item:lamp");
    });

    it("should ignore damaged light sources", () => {
      const shop = dgsm.getScene("shop")!;
      shop.items = [
        { id: "lamp", name: "Oil Lamp", isLightSource: true, lightLevel: 3, damaged: true },
      ];

      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const shopState = dgsm.getFeatureSceneState("lighting", "shop") as any;
      expect(shopState.lightLevel).toBe(1);
    });
  });

  describe("fire light contribution", () => {
    it("should add fire light to burning scene", () => {
      dgsm._setFireState("shop", 2);

      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const shopState = dgsm.getFeatureSceneState("lighting", "shop") as any;
      expect(shopState.lightLevel).toBe(3);
      expect(shopState.sources).toContain("fire");
    });

    it("should not spread fire light to adjacent when intensity < 3", () => {
      dgsm._setFireState("alley", 2);

      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(2); // moon only
    });

    it("should spread fire light to adjacent when intensity >= 3", () => {
      dgsm._setFireState("alley", 3);

      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const alleyState = dgsm.getFeatureSceneState("lighting", "alley") as any;
      expect(alleyState.lightLevel).toBe(4);

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(3); // fire adjacent=3 > moon=2
    });

    it("should map fire intensity 5 to blinding (level 5)", () => {
      dgsm._setFireState("alley", 5);

      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const alleyState = dgsm.getFeatureSceneState("lighting", "alley") as any;
      expect(alleyState.lightLevel).toBe(5);
    });
  });

  describe("weather modifier", () => {
    it("should reduce sun level during heavy fog", () => {
      dgsm._setWeatherState("town", "fog", 5);

      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(3); // 5 - 2 = 3
    });

    it("should reduce sun level during storm", () => {
      dgsm._setWeatherState("town", "storm", 4);

      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(3); // 5 - 2 = 3
    });

    it("should not affect indoor scenes", () => {
      dgsm._setWeatherState("town", "fog", 5);
      const shop = dgsm.getScene("shop")!;
      shop.items = [{ id: "lamp", name: "Lamp", isLightSource: true, lightLevel: 4 }];

      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const shopState = dgsm.getFeatureSceneState("lighting", "shop") as any;
      expect(shopState.lightLevel).toBe(4);
    });
  });

  describe("skill penalties", () => {
    it("should write penalties for pitch black", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const conditions = dgsm._scenarioConditions["shop"] ?? [];
      const lightCond = conditions.find(c => c.description.startsWith("[Lighting]"));
      expect(lightCond).toBeDefined();
      expect(lightCond!.description).toContain("Pitch black");

      const perception = lightCond!.mechanicalEffect?.skillPenalty?.find(p => p.skill === "Perception");
      expect(perception?.delta).toBe(-40);
    });

    it("should write penalties for blinding", () => {
      dgsm._setFireState("street", 5);

      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const conditions = dgsm._scenarioConditions["street"] ?? [];
      const lightCond = conditions.find(c => c.description.startsWith("[Lighting]"));
      expect(lightCond).toBeDefined();
      expect(lightCond!.description).toContain("Blinding");

      const perception = lightCond!.mechanicalEffect?.skillPenalty?.find(p => p.skill === "Perception");
      expect(perception?.delta).toBe(-15);
    });

    it("should not write condition for normal light", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("06:00"));

      const conditions = dgsm._scenarioConditions["street"] ?? [];
      const lightCond = conditions.find(c => c.description.startsWith("[Lighting]"));
      expect(lightCond).toBeUndefined();
    });
  });

  describe("stateDescription", () => {
    it("should show abnormal lighting only", () => {
      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const desc = lightingFeature.stateDescription(dgsm as any);
      expect(desc).toContain("shop");
      expect(desc).toContain("Pitch black");
    });

    it("should say normal when all scenes have normal lighting", () => {
      const shop = dgsm.getScene("shop")!;
      shop.items = [{ id: "lamp", name: "Lamp", isLightSource: true, lightLevel: 4 }];

      lightingFeature.tick!(dgsm as any, createRuntime("18:00"));

      const desc = lightingFeature.stateDescription(dgsm as any);
      expect(desc).toContain("Normal");
    });
  });

  describe("max aggregation", () => {
    it("should take max of multiple light sources", () => {
      const shop = dgsm.getScene("shop")!;
      shop.items = [
        { id: "candle", name: "Candle", isLightSource: true, lightLevel: 2 },
        { id: "lamp", name: "Lamp", isLightSource: true, lightLevel: 4 },
      ];

      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      const shopState = dgsm.getFeatureSceneState("lighting", "shop") as any;
      expect(shopState.lightLevel).toBe(4);
      expect(shopState.sources).toContain("item:lamp");
    });
  });

  describe("topology fire light propagation", () => {
    it("should propagate fire light from scene to parent junction via topology", () => {
      // Build a simple topology: SCN_A is connected to JUNC_1
      const junctions = new Map([
        ["JUNC_1", { id: "JUNC_1", name: "J1", description: "", parentLocationId: "OUTDOOR",
          connectedSceneIds: ["SCN_A"], items: [], clues: [], conditions: [], events: [] }],
      ]);
      const roads = new Map();

      // Build topology maps manually
      const junctionToRoads = new Map();
      junctionToRoads.set("JUNC_1", []);
      const sceneToParent = new Map();
      sceneToParent.set("SCN_A", { type: "junction", junctionId: "JUNC_1" });

      const topology = { junctions, roads, junctionToRoads, sceneToParent };
      (dgsm as any).getTopology = () => topology;

      // Add SCN_A as a scene
      dgsm._addScene({ id: "SCN_A", name: "Scene A", parentLocationId: "OUTDOOR", connections: [], events: [] });

      // Set fire at SCN_A with intensity 3 (triggers fire light spread)
      dgsm._setFireState("SCN_A", 3);

      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      // JUNC_1 should have fire light contribution (as adjacent gets fireLightLevel-1 = 3)
      const juncLighting = dgsm.getFeatureSceneState("lighting", "JUNC_1") as any;
      expect(juncLighting).toBeDefined();
      expect(juncLighting.lightLevel).toBeGreaterThanOrEqual(3);
    });

    it("should compute lighting for roads and junctions", () => {
      const junctions = new Map([
        ["JUNC_1", { id: "JUNC_1", name: "J1", description: "", parentLocationId: "OUTDOOR",
          connectedSceneIds: [], items: [], clues: [], conditions: [], events: [] }],
      ]);
      const roads = new Map([
        ["ROAD_1", { id: "ROAD_1", name: "R1", description: "", parentLocationId: "OUTDOOR",
          endpointA: "JUNC_1", endpointB: "JUNC_1", travelTimeMinutes: 10,
          alongConnections: [], items: [], clues: [], conditions: [], events: [] }],
      ]);

      const junctionToRoads = new Map();
      junctionToRoads.set("JUNC_1", [roads.get("ROAD_1")!]);
      const sceneToParent = new Map();

      const topology = { junctions, roads, junctionToRoads, sceneToParent };
      (dgsm as any).getTopology = () => topology;

      // Daytime: road and junction should get sun
      lightingFeature.tick!(dgsm as any, createRuntime("12:00"));

      const roadLighting = dgsm.getFeatureSceneState("lighting", "ROAD_1") as any;
      expect(roadLighting).toBeDefined();
      expect(roadLighting.lightLevel).toBeGreaterThanOrEqual(4);

      const juncLighting = dgsm.getFeatureSceneState("lighting", "JUNC_1") as any;
      expect(juncLighting).toBeDefined();
      expect(juncLighting.lightLevel).toBeGreaterThanOrEqual(4);
    });

    it("should propagate fire light from road to junction via topology", () => {
      const junctions = new Map([
        ["JUNC_1", { id: "JUNC_1", name: "J1", description: "", parentLocationId: "OUTDOOR",
          connectedSceneIds: [], items: [], clues: [], conditions: [], events: [] }],
        ["JUNC_2", { id: "JUNC_2", name: "J2", description: "", parentLocationId: "OUTDOOR",
          connectedSceneIds: [], items: [], clues: [], conditions: [], events: [] }],
      ]);
      const roads = new Map([
        ["ROAD_1", { id: "ROAD_1", name: "R1", description: "", parentLocationId: "OUTDOOR",
          endpointA: "JUNC_1", endpointB: "JUNC_2", travelTimeMinutes: 10,
          alongConnections: [], items: [], clues: [], conditions: [], events: [] }],
      ]);

      const junctionToRoads = new Map();
      junctionToRoads.set("JUNC_1", [roads.get("ROAD_1")!]);
      junctionToRoads.set("JUNC_2", [roads.get("ROAD_1")!]);
      const sceneToParent = new Map();

      const topology = { junctions, roads, junctionToRoads, sceneToParent };
      (dgsm as any).getTopology = () => topology;

      // Set fire on ROAD_1 with intensity 4 (fire light spread triggers at >=3)
      dgsm.setFeatureSceneState("fire", "ROAD_1", { intensity: 4 });

      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      // Both junctions should have fire light from the road fire
      const junc1Lighting = dgsm.getFeatureSceneState("lighting", "JUNC_1") as any;
      expect(junc1Lighting).toBeDefined();
      expect(junc1Lighting.lightLevel).toBeGreaterThanOrEqual(3);

      const junc2Lighting = dgsm.getFeatureSceneState("lighting", "JUNC_2") as any;
      expect(junc2Lighting).toBeDefined();
      expect(junc2Lighting.lightLevel).toBeGreaterThanOrEqual(3);
    });

    it("should fall back to scene.connections when no topology", () => {
      // Default dgsm has getTopology() returning null
      dgsm._setFireState("alley", 3);

      lightingFeature.tick!(dgsm as any, createRuntime("00:00"));

      // Street is connected to alley — should get fire light via scene.connections fallback
      const streetState = dgsm.getFeatureSceneState("lighting", "street") as any;
      expect(streetState.lightLevel).toBe(3); // adjacent fire light level
    });
  });
});
