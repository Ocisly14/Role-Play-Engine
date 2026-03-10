import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { staminaFeature } from "../staminaFeature.js";
import type { TickRuntimeContext } from "../../types.js";

// ===== Mock DGSM =====

function createMockDgsm() {
  const featureState: Record<string, Record<string, unknown>> = {};
  const npcLocations: Record<string, string> = {};
  const npcStats: Record<string, { hp: number; san: number }> = {};
  const npcCharacters: Array<{ id: string; name: string; status: { hp: number; conditions: string[] } }> = [];
  let currentSceneId = "tavern";
  const playerCharacter = {
    id: "player-1",
    name: "Investigator",
    status: { hp: 12, maxHp: 12, sanity: 60, maxSanity: 99, luck: 50, conditions: [] },
    attributes: { STR: 50, CON: 60, DEX: 50, APP: 50, POW: 50, SIZ: 50, INT: 60, EDU: 70 },
    skills: {} as Record<string, number>,
    inventory: [],
  };

  return {
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
    getState() {
      return {
        currentSceneId,
        playerCharacter,
        npcLocations,
        npcStats,
        npcCharacters,
      };
    },
    updateNpcHp(npcId: string, delta: number) {
      if (!npcStats[npcId]) return;
      npcStats[npcId].hp = Math.max(0, npcStats[npcId].hp + delta);
    },
    updateNpcSan(npcId: string, delta: number) {
      if (!npcStats[npcId]) return;
      npcStats[npcId].san = Math.max(0, npcStats[npcId].san + delta);
    },
    getNpcStats(npcId: string) {
      return npcStats[npcId] ?? undefined;
    },
    _addNpc(npcId: string, location: string, hp: number, san = 50) {
      npcLocations[npcId] = location;
      npcStats[npcId] = { hp, san };
      npcCharacters.push({ id: npcId, name: npcId, status: { hp, conditions: [] } });
    },
    _setCurrentScene(sceneId: string) {
      currentSceneId = sceneId;
    },
    // Topology support for resolveCharacterLocationId
    getCharacterPosition: (_id: string) => null as any,
    resolveLocationId: (pos: any) => pos?.junctionId ?? pos?.roadId ?? pos?.sceneId,
    getNpcLocation: (npcId: string) => npcLocations[npcId] ?? undefined,

    _featureState: featureState,
    _playerCharacter: playerCharacter,
    _npcStats: npcStats,
    _npcLocations: npcLocations,
  };
}

type MockDgsm = ReturnType<typeof createMockDgsm>;

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

function runTicks(dgsm: MockDgsm, runtime: TickRuntimeContext, count: number) {
  for (let i = 0; i < count; i++) {
    staminaFeature.tick!(dgsm as any, runtime);
  }
}

// ===== Tests =====

describe("staminaFeature", () => {
  let dgsm: MockDgsm;
  let runtime: TickRuntimeContext;

  beforeEach(() => {
    dgsm = createMockDgsm();
    runtime = createMockRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ===== Initialization =====

  describe("initialization", () => {
    it("should create player stamina state on first tick", () => {
      runTicks(dgsm, runtime, 1);

      const playerState = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      expect(playerState).toBeDefined();
      expect(playerState.minutesSinceLastRest).toBe(5);
      expect(playerState.fatigueLevel).toBe(0);
      expect(playerState.exhaustedDrainTicks).toBe(0);
    });

    it("should create NPC stamina state on first tick", () => {
      dgsm._addNpc("npc-guard", "tavern", 10);

      runTicks(dgsm, runtime, 1);

      const npcState = dgsm.getFeatureSceneState("stamina", "npc-guard") as any;
      expect(npcState).toBeDefined();
      expect(npcState.minutesSinceLastRest).toBe(5);
      expect(npcState.fatigueLevel).toBe(0);
    });
  });

  // ===== Fatigue levels =====

  describe("fatigue levels", () => {
    it("should be rested (level 0) below 480 minutes", () => {
      // 95 ticks * 5 min = 475 min (< 480)
      runTicks(dgsm, runtime, 95);

      const playerState = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      expect(playerState.minutesSinceLastRest).toBe(475);
      expect(playerState.fatigueLevel).toBe(0);
    });

    it("should be tired (level 1) at exactly 480 minutes", () => {
      // 96 ticks * 5 min = 480 min
      runTicks(dgsm, runtime, 96);

      const playerState = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      expect(playerState.minutesSinceLastRest).toBe(480);
      expect(playerState.fatigueLevel).toBe(1);
    });

    it("should be tired (level 1) between 480 and 960 minutes", () => {
      // 100 ticks * 5 min = 500 min
      runTicks(dgsm, runtime, 100);

      const playerState = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      expect(playerState.minutesSinceLastRest).toBe(500);
      expect(playerState.fatigueLevel).toBe(1);
    });

    it("should be exhausted (level 2) at exactly 960 minutes", () => {
      // 192 ticks * 5 min = 960 min
      const mockRandom = vi.spyOn(Math, "random");
      mockRandom.mockReturnValue(0.99); // always pass CON checks
      runTicks(dgsm, runtime, 192);

      const playerState = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      expect(playerState.minutesSinceLastRest).toBe(960);
      expect(playerState.fatigueLevel).toBe(2);
    });

    it("should remain exhausted (level 2) above 960 minutes", () => {
      const mockRandom = vi.spyOn(Math, "random");
      mockRandom.mockReturnValue(0.99); // always pass CON checks
      // 200 ticks * 5 min = 1000 min
      runTicks(dgsm, runtime, 200);

      const playerState = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      expect(playerState.minutesSinceLastRest).toBe(1000);
      expect(playerState.fatigueLevel).toBe(2);
    });
  });

  // ===== Environmental acceleration =====

  describe("environmental acceleration", () => {
    it("should accumulate at 2x with extreme weather (intensity >= 3)", () => {
      // Set up extreme_heat weather affecting tavern
      dgsm.setFeatureSceneState("weather", "region1", {
        weatherType: "extreme_heat",
        intensity: 3,
        affectedSceneIds: ["tavern"],
      });

      // 1 tick at 2x = 10 min effective
      runTicks(dgsm, runtime, 1);

      const playerState = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      expect(playerState.minutesSinceLastRest).toBe(10);
    });

    it("should accumulate at 2x with fire intensity >= 2", () => {
      // Set up fire at tavern with intensity 2
      dgsm.setFeatureSceneState("fire", "tavern", { intensity: 2 });

      // 1 tick at 2x = 10 min effective
      runTicks(dgsm, runtime, 1);

      const playerState = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      expect(playerState.minutesSinceLastRest).toBe(10);
    });

    it("should accumulate at 3x with both extreme weather and fire", () => {
      dgsm.setFeatureSceneState("weather", "region1", {
        weatherType: "extreme_cold",
        intensity: 4,
        affectedSceneIds: ["tavern"],
      });
      dgsm.setFeatureSceneState("fire", "tavern", { intensity: 3 });

      // 1 tick at 3x = 15 min effective
      runTicks(dgsm, runtime, 1);

      const playerState = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      expect(playerState.minutesSinceLastRest).toBe(15);
    });

    it("should NOT accelerate with weather intensity below 3", () => {
      dgsm.setFeatureSceneState("weather", "region1", {
        weatherType: "extreme_heat",
        intensity: 2,
        affectedSceneIds: ["tavern"],
      });

      runTicks(dgsm, runtime, 1);

      const playerState = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      expect(playerState.minutesSinceLastRest).toBe(5); // no acceleration
    });

    it("should NOT accelerate with fire intensity below 2", () => {
      dgsm.setFeatureSceneState("fire", "tavern", { intensity: 1 });

      runTicks(dgsm, runtime, 1);

      const playerState = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      expect(playerState.minutesSinceLastRest).toBe(5); // no acceleration
    });

    it("should NOT accelerate with non-extreme weather types", () => {
      dgsm.setFeatureSceneState("weather", "region1", {
        weatherType: "rain",
        intensity: 5,
        affectedSceneIds: ["tavern"],
      });

      runTicks(dgsm, runtime, 1);

      const playerState = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      expect(playerState.minutesSinceLastRest).toBe(5); // no acceleration
    });

    it("should apply NPC acceleration based on NPC scene", () => {
      dgsm._addNpc("npc-guard", "plaza", 10);
      dgsm.setFeatureSceneState("fire", "plaza", { intensity: 3 });

      runTicks(dgsm, runtime, 1);

      const npcState = dgsm.getFeatureSceneState("stamina", "npc-guard") as any;
      expect(npcState.minutesSinceLastRest).toBe(10); // 2x from fire

      // Player at tavern should have no acceleration
      const playerState = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      expect(playerState.minutesSinceLastRest).toBe(5);
    });
  });

  // ===== Exhausted drain =====

  describe("exhausted drain", () => {
    function fastForwardToExhausted(dgsm: MockDgsm, runtime: TickRuntimeContext) {
      // Directly inject exhausted state to avoid running 192 ticks
      dgsm.setFeatureSceneState("stamina", "player-1", {
        minutesSinceLastRest: 960,
        fatigueLevel: 2,
        exhaustedDrainTicks: 0,
      });
    }

    it("should drain HP and SAN on CON fail every 6 ticks at exhausted level", () => {
      fastForwardToExhausted(dgsm, runtime);

      const mockRandom = vi.spyOn(Math, "random");
      // At 960 min: failChance = min(0.6, 0.3 + (960-960)/960 * 0.3) = 0.3
      // Tick 1-5: no drain (not yet 6 ticks)
      // Tick 6: drain check — random = 0.1 < 0.3 → fail
      mockRandom.mockReturnValueOnce(0.1); // CON fail
      mockRandom.mockReturnValueOnce(0.5); // SAN d3 roll

      runTicks(dgsm, runtime, 6);

      expect(dgsm._playerCharacter.status.hp).toBe(11); // 12 - 1
      expect(dgsm._playerCharacter.status.sanity).toBeLessThan(60); // reduced by 1-3
    });

    it("should NOT drain on CON pass", () => {
      fastForwardToExhausted(dgsm, runtime);

      const mockRandom = vi.spyOn(Math, "random");
      // At 960 min: failChance = 0.3
      // random = 0.5 > 0.3 → pass
      mockRandom.mockReturnValue(0.99);

      runTicks(dgsm, runtime, 6);

      expect(dgsm._playerCharacter.status.hp).toBe(12); // unchanged
      expect(dgsm._playerCharacter.status.sanity).toBe(60); // unchanged
    });

    it("should drain NPC HP and SAN on CON fail", () => {
      dgsm._addNpc("npc-guard", "tavern", 10, 40);
      dgsm.setFeatureSceneState("stamina", "npc-guard", {
        minutesSinceLastRest: 960,
        fatigueLevel: 2,
        exhaustedDrainTicks: 0,
      });

      const mockRandom = vi.spyOn(Math, "random");
      // Player will also tick — set up player state to avoid drain
      dgsm.setFeatureSceneState("stamina", "player-1", {
        minutesSinceLastRest: 100,
        fatigueLevel: 0,
        exhaustedDrainTicks: 0,
      });

      // NPC check at tick 6: fail
      mockRandom.mockReturnValueOnce(0.1); // CON fail for NPC
      mockRandom.mockReturnValueOnce(0.5); // SAN d3 roll for NPC

      runTicks(dgsm, runtime, 6);

      expect(dgsm._npcStats["npc-guard"].hp).toBe(9); // 10 - 1
      expect(dgsm._npcStats["npc-guard"].san).toBeLessThan(40); // reduced by 1-3
    });

    it("should have scaling fail chance based on minutes active", () => {
      // At 1920 minutes: failChance = min(0.6, 0.3 + (1920-960)/960 * 0.3) = min(0.6, 0.6) = 0.6
      dgsm.setFeatureSceneState("stamina", "player-1", {
        minutesSinceLastRest: 1920,
        fatigueLevel: 2,
        exhaustedDrainTicks: 0,
      });

      const mockRandom = vi.spyOn(Math, "random");
      // failChance = 0.6, random = 0.55 < 0.6 → fail
      mockRandom.mockReturnValueOnce(0.55);
      mockRandom.mockReturnValueOnce(0.5); // SAN d3

      runTicks(dgsm, runtime, 6);

      expect(dgsm._playerCharacter.status.hp).toBe(11); // drained

      // At 960, failChance = 0.3, 0.55 > 0.3 → would pass
      // So the scaling actually matters
    });

    it("should cap fail chance at 0.6", () => {
      // At 3000 minutes: failChance = min(0.6, 0.3 + (3000-960)/960 * 0.3) = min(0.6, ~0.937) = 0.6
      dgsm.setFeatureSceneState("stamina", "player-1", {
        minutesSinceLastRest: 3000,
        fatigueLevel: 2,
        exhaustedDrainTicks: 0,
      });

      const mockRandom = vi.spyOn(Math, "random");
      // failChance = 0.6, random = 0.59 < 0.6 → fail
      mockRandom.mockReturnValueOnce(0.59);
      mockRandom.mockReturnValueOnce(0.0); // SAN d3 roll → 1

      runTicks(dgsm, runtime, 6);

      expect(dgsm._playerCharacter.status.hp).toBe(11);
    });

    it("should drain SAN by 1d3 (1-3) on fail", () => {
      fastForwardToExhausted(dgsm, runtime);

      const mockRandom = vi.spyOn(Math, "random");
      // fail check
      mockRandom.mockReturnValueOnce(0.0); // definite fail
      // d3 roll: Math.floor(random * 3) + 1
      // random = 0.99 → Math.floor(0.99*3)+1 = 2+1 = 3
      mockRandom.mockReturnValueOnce(0.99);

      runTicks(dgsm, runtime, 6);

      expect(dgsm._playerCharacter.status.sanity).toBe(57); // 60 - 3
    });
  });

  // ===== stateDescription =====

  describe("stateDescription", () => {
    it("should return empty string when no character is fatigued", () => {
      // All at rested state
      runTicks(dgsm, runtime, 1);

      const desc = staminaFeature.stateDescription(dgsm as any);
      expect(desc).toBe("");
    });

    it("should list tired characters with hours active", () => {
      dgsm.setFeatureSceneState("stamina", "player-1", {
        minutesSinceLastRest: 500,
        fatigueLevel: 1,
        exhaustedDrainTicks: 0,

      });

      const desc = staminaFeature.stateDescription(dgsm as any);
      expect(desc).not.toBe("");
      expect(desc).toContain("tired");
      expect(desc).toContain("player-1");
    });

    it("should list exhausted characters", () => {
      dgsm.setFeatureSceneState("stamina", "player-1", {
        minutesSinceLastRest: 1000,
        fatigueLevel: 2,
        exhaustedDrainTicks: 5,

      });

      const desc = staminaFeature.stateDescription(dgsm as any);
      expect(desc).not.toBe("");
      expect(desc).toContain("exhausted");
    });

    it("should not list rested characters", () => {
      dgsm.setFeatureSceneState("stamina", "player-1", {
        minutesSinceLastRest: 100,
        fatigueLevel: 0,
        exhaustedDrainTicks: 0,

      });

      const desc = staminaFeature.stateDescription(dgsm as any);
      expect(desc).toBe("");
    });
  });

  // ===== character condition injection =====

  describe("character condition injection", () => {
    it("should add Tired condition to player when reaching level 1", () => {
      // 96 ticks * 5 min = 480 min → tired
      runTicks(dgsm, runtime, 96);

      const conditions = dgsm._playerCharacter.status.conditions;
      expect(conditions.some((c: string) => c.includes("[Fatigue]") && c.includes("Tired"))).toBe(true);
    });

    it("should replace Tired with Exhausted when reaching level 2", () => {
      const mockRandom = vi.spyOn(Math, "random");
      mockRandom.mockReturnValue(0.99); // pass all CON checks

      // 192 ticks * 5 min = 960 min → exhausted
      runTicks(dgsm, runtime, 192);

      const conditions = dgsm._playerCharacter.status.conditions;
      expect(conditions.some((c: string) => c.includes("Tired"))).toBe(false);
      expect(conditions.some((c: string) => c.includes("[Fatigue]") && c.includes("Exhausted"))).toBe(true);
    });

    it("should add condition to NPC when fatigued", () => {
      dgsm._addNpc("npc-guard", "tavern", 10);

      runTicks(dgsm, runtime, 96); // 480 min → tired

      const npc = dgsm.getState().npcCharacters.find((n: any) => n.id === "npc-guard");
      expect(npc!.status.conditions.some((c: string) => c.includes("[Fatigue]"))).toBe(true);
    });

    it("should not have fatigue condition when rested", () => {
      runTicks(dgsm, runtime, 10); // 50 min → still rested

      const conditions = dgsm._playerCharacter.status.conditions;
      expect(conditions.some((c: string) => c.includes("[Fatigue]"))).toBe(false);
    });
  });

  // ===== CharacterPosition resolution =====

  describe("CharacterPosition resolution", () => {
    it("should use CharacterPosition for acceleration when available", () => {
      // Override getCharacterPosition to return a road position for npc1
      (dgsm as any).getCharacterPosition = (id: string) =>
        id === "npc1" ? { type: "road", roadId: "ROAD_1", position: 0.5 } : null;

      dgsm._addNpc("npc1", "tavern", 10);

      // Set fire on ROAD_1 (intensity 2 → acceleration)
      dgsm.setFeatureSceneState("fire", "ROAD_1", { intensity: 2 });

      runTicks(dgsm, runtime, 1);

      const stamina = dgsm.getFeatureSceneState("stamina", "npc1") as any;
      // With fire acceleration: 5 * 2 = 10 minutes
      expect(stamina.minutesSinceLastRest).toBe(10);
    });

    it("should fallback to npcLocations when no CharacterPosition", () => {
      // Default getCharacterPosition returns null
      dgsm._addNpc("npc2", "tavern", 10);

      // Set fire on tavern (intensity 2 → acceleration)
      dgsm.setFeatureSceneState("fire", "tavern", { intensity: 2 });

      runTicks(dgsm, runtime, 1);

      const stamina = dgsm.getFeatureSceneState("stamina", "npc2") as any;
      // npc2 is at "tavern" via npcLocations, fire at tavern → 2x
      expect(stamina.minutesSinceLastRest).toBe(10);
    });

    it("should use currentSceneId for player when no CharacterPosition", () => {
      // Player at tavern (currentSceneId), no CharacterPosition
      dgsm.setFeatureSceneState("fire", "tavern", { intensity: 3 });

      runTicks(dgsm, runtime, 1);

      const stamina = dgsm.getFeatureSceneState("stamina", "player-1") as any;
      // Player at tavern, fire at tavern → 2x
      expect(stamina.minutesSinceLastRest).toBe(10);
    });
  });

  // ===== planningPrompt =====

  describe("planningPrompt", () => {
    it("should contain 'fatigue' in planning prompt", () => {
      expect(staminaFeature.planningPrompt.toLowerCase()).toContain("fatigue");
    });
  });
});
