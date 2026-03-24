import { describe, expect, it } from "vitest";
import type { PlanNode } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { ExecutionContext } from "../../types.js";
import {
  movementHandler,
  resolveTargetPosition,
} from "../movementHandler.js";

// ===== Mock DGSM =====

function createMockDgsm() {
  const characterPositions: Record<string, any> = {};
  const npcCharacters: Array<{
    id: string;
    skills: Record<string, number>;
    status: { luck: number };
  }> = [];
  const scenes = new Map<string, any>();
  const scenarioOutlines: any[] = [];
  const blockedConnections = new Map<string, string>();

  const junctions = new Map<string, any>();
  const roads = new Map<string, any>();
  const sceneToParent = new Map<string, string>();
  const junctionToRoads = new Map<string, any[]>();

  const positionLog: Array<{ characterId: string; position: any }> = [];

  return {
    getState() {
      return {
        npcCharacters,
        scenes,
        scenarioOutlines,
        blockedConnections,
        junctions,
        roads,
      };
    },
    getCharacterPosition(characterId: string) {
      return characterPositions[characterId] ?? null;
    },
    resolveLocationId(position: any) {
      if (position.type === "scene") return position.sceneId;
      if (position.type === "junction") return position.junctionId;
      return position.roadId;
    },
    setCharacterPosition(characterId: string, position: any) {
      characterPositions[characterId] = position;
      positionLog.push({ characterId, position });
    },
    getScene(sceneId: string) {
      return scenes.get(sceneId) ?? null;
    },
    getTopology() {
      return {
        junctions,
        roads,
        sceneToParent,
        junctionToRoads,
      };
    },
    _addNpc(
      npcId: string,
      position: any,
      skills: Record<string, number> = {}
    ) {
      characterPositions[npcId] = position;
      npcCharacters.push({
        id: npcId,
        skills,
        status: { luck: 50 },
      });
    },
    _addJunction(id: string, connectedSceneIds: string[] = []) {
      junctions.set(id, {
        id,
        name: id,
        description: "",
        parentLocationId: "OUTDOOR",
        connectedSceneIds,
        items: [],
        conditions: [],
        events: [],
      });
    },
    _addRoad(
      id: string,
      endpointA: string,
      endpointB: string,
      travelTimeMinutes = 10,
      alongConnections: any[] = []
    ) {
      const road = {
        id,
        name: id,
        description: "",
        parentLocationId: "OUTDOOR",
        endpointA,
        endpointB,
        travelTimeMinutes,
        alongConnections,
        items: [],
        conditions: [],
        events: [],
      };
      roads.set(id, road);
      // Wire up junctionToRoads with full road objects
      const aRoads = junctionToRoads.get(endpointA) ?? [];
      aRoads.push(road);
      junctionToRoads.set(endpointA, aRoads);
      const bRoads = junctionToRoads.get(endpointB) ?? [];
      bRoads.push(road);
      junctionToRoads.set(endpointB, bRoads);
    },
    _addScene(
      id: string,
      parentJunctionId: string
    ) {
      scenes.set(id, {
        id,
        name: id,
        description: "",
        parentLocationId: parentJunctionId,
        connections: [],
        items: [],
        conditions: [],
        indoor: false,
      });
      sceneToParent.set(id, { type: "junction", junctionId: parentJunctionId });
    },
    _addScenarioOutline(id: string, entrySceneId: string) {
      scenarioOutlines.push({ id, entrySceneId });
    },
    _blockConnection(fromRef: any, toRef: any, reason: string) {
      // Use the same key format as the real makeBlockedConnectionKey
      const key = `${fromRef.type}:${fromRef.type === "scene" ? fromRef.sceneId : fromRef.type === "junction" ? fromRef.junctionId : fromRef.roadId}->${toRef.type}:${toRef.type === "scene" ? toRef.sceneId : toRef.type === "junction" ? toRef.junctionId : toRef.roadId}`;
      blockedConnections.set(key, reason);
    },
    _positionLog: positionLog,
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
    nodeId: "m1",
    characterId: "npc_a",
    characterName: "A",
    startTime: "09:00",
    endTime: "09:05",
    action: "Walk to the harbor",
    location: "JUNC_B",
    type: "movement",
    impact: 0,
    status: "pending",
    executionMeta: { remainingMinutes: 5 },
    ...overrides,
  } as PlanNode;
}

// ===== Tests =====

describe("movementHandler", () => {
  it("has correct type and required fields", () => {
    expect(movementHandler.type).toBe("movement");
    expect(movementHandler.requiredFields).toContain("action");
    expect(movementHandler.requiredFields).toContain("location");
    expect(movementHandler.optionalFields).toContain("skill");
  });

  describe("topology-based movement", () => {
    it("should move character along topology path", () => {
      const dgsm = createMockDgsm();
      dgsm._addJunction("JUNC_A");
      dgsm._addJunction("JUNC_B");
      dgsm._addRoad("ROAD_1", "JUNC_A", "JUNC_B", 10);
      dgsm._addNpc("npc_a", { type: "junction", junctionId: "JUNC_A" });

      const ctx = createMockCtx();

      const result = movementHandler.execute(
        makeNode({ location: "JUNC_B" }),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      expect(result.status).toBe("completed");
      expect(dgsm._characterPositions["npc_a"]).toEqual({
        type: "junction",
        junctionId: "JUNC_B",
      });
    });

    it("should move character from scene to junction via topology", () => {
      const dgsm = createMockDgsm();
      dgsm._addJunction("JUNC_A", ["SCN_SHOP"]);
      dgsm._addJunction("JUNC_B");
      dgsm._addRoad("ROAD_1", "JUNC_A", "JUNC_B", 10);
      dgsm._addScene("SCN_SHOP", "JUNC_A");

      dgsm._addNpc("npc_a", { type: "scene", sceneId: "SCN_SHOP" });

      const ctx = createMockCtx();

      const result = movementHandler.execute(
        makeNode({ location: "JUNC_B" }),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      expect(result.status).toBe("completed");
      expect(dgsm._characterPositions["npc_a"]).toEqual({
        type: "junction",
        junctionId: "JUNC_B",
      });
    });

    it("should move to a scene target when topology resolves it", () => {
      const dgsm = createMockDgsm();
      dgsm._addJunction("JUNC_A");
      dgsm._addJunction("JUNC_B", ["SCN_DOCK"]);
      dgsm._addRoad("ROAD_1", "JUNC_A", "JUNC_B", 10);
      dgsm._addScene("SCN_DOCK", "JUNC_B");

      dgsm._addNpc("npc_a", { type: "junction", junctionId: "JUNC_A" });

      const ctx = createMockCtx();

      const result = movementHandler.execute(
        makeNode({ location: "SCN_DOCK" }),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      expect(result.status).toBe("completed");
      expect(dgsm._characterPositions["npc_a"]).toEqual({
        type: "scene",
        sceneId: "SCN_DOCK",
      });
    });

    it("should fail when character has no position", () => {
      const dgsm = createMockDgsm();
      dgsm._addJunction("JUNC_A");
      dgsm._addJunction("JUNC_B");
      dgsm._addRoad("ROAD_1", "JUNC_A", "JUNC_B", 10);
      // No NPC added — no position

      const ctx = createMockCtx();

      const result = movementHandler.execute(
        makeNode({ location: "JUNC_B" }),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("location_blocked");
    });

    it("should fail when target location cannot be resolved", () => {
      const dgsm = createMockDgsm();
      dgsm._addJunction("JUNC_A");
      dgsm._addNpc("npc_a", { type: "junction", junctionId: "JUNC_A" });

      const ctx = createMockCtx();

      const result = movementHandler.execute(
        makeNode({ location: "NONEXISTENT" }),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("location_blocked");
    });
  });

  describe("creative movement (with skill)", () => {
    it("should complete creative movement on successful skill roll", () => {
      const dgsm = createMockDgsm();
      dgsm._addJunction("JUNC_A");
      dgsm._addJunction("JUNC_B");
      dgsm._addRoad("ROAD_1", "JUNC_A", "JUNC_B", 10);
      dgsm._addNpc("npc_a", { type: "junction", junctionId: "JUNC_A" }, {
        Climb: 60,
      });

      const ctx = createMockCtx({
        resolveSkillRoll: () => ({
          failed: false,
          detail: "Regular success (roll 42 vs 60)",
          successLevel: "regular" as const,
        }),
      } as any);

      const result = movementHandler.execute(
        makeNode({ location: "JUNC_B", skill: "Climb" }),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      expect(result.status).toBe("completed");
      expect(result.outcome).toContain("Creative movement succeeded");
      expect(dgsm._characterPositions["npc_a"]).toEqual({
        type: "junction",
        junctionId: "JUNC_B",
      });
    });

    it("should fail creative movement on failed skill roll without moving", () => {
      const dgsm = createMockDgsm();
      dgsm._addJunction("JUNC_A");
      dgsm._addJunction("JUNC_B");
      dgsm._addRoad("ROAD_1", "JUNC_A", "JUNC_B", 10);
      dgsm._addNpc("npc_a", { type: "junction", junctionId: "JUNC_A" }, {
        Climb: 20,
      });

      const ctx = createMockCtx({
        resolveSkillRoll: () => ({
          failed: true,
          detail: "Fumble (roll 99)",
          reason: "Fumble",
          successLevel: "fumble" as const,
        }),
      } as any);

      const result = movementHandler.execute(
        makeNode({ location: "JUNC_B", skill: "Climb" }),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("skill_roll_failed");
      // Position should remain at JUNC_A
      expect(dgsm._characterPositions["npc_a"]).toEqual({
        type: "junction",
        junctionId: "JUNC_A",
      });
    });
  });

  describe("same-location movement", () => {
    it("should complete when already at target location", () => {
      const dgsm = createMockDgsm();
      dgsm._addJunction("JUNC_A");
      dgsm._addNpc("npc_a", { type: "junction", junctionId: "JUNC_A" });

      const ctx = createMockCtx();

      const result = movementHandler.execute(
        makeNode({ location: "JUNC_A" }),
        dgsm as unknown as DynamicGameStateManager,
        ctx
      );

      expect(result.status).toBe("completed");
    });
  });
});

// ===== resolveTargetPosition unit tests =====

describe("resolveTargetPosition", () => {
  it("should resolve a junction ID to junction position", () => {
    const junctions = new Map([["JUNC_A", { id: "JUNC_A" }]]);
    const topology = {
      junctions,
      roads: new Map(),
      sceneToParent: new Map(),
      junctionToRoads: new Map(),
    } as any;

    const pos = resolveTargetPosition("JUNC_A", topology);
    expect(pos).toEqual({ type: "junction", junctionId: "JUNC_A" });
  });

  it("should resolve a scene ID to scene position", () => {
    const sceneToParent = new Map([["SCN_1", "JUNC_A"]]);
    const topology = {
      junctions: new Map(),
      roads: new Map(),
      sceneToParent,
      junctionToRoads: new Map(),
    } as any;

    const pos = resolveTargetPosition("SCN_1", topology);
    expect(pos).toEqual({ type: "scene", sceneId: "SCN_1" });
  });

  it("should resolve a road ID to the far endpoint junction", () => {
    const roads = new Map([
      ["ROAD_1", { id: "ROAD_1", endpointA: "JUNC_A", endpointB: "JUNC_B" }],
    ]);
    const topology = {
      junctions: new Map(),
      roads,
      sceneToParent: new Map(),
      junctionToRoads: new Map(),
    } as any;

    const pos = resolveTargetPosition("ROAD_1", topology);
    expect(pos).toEqual({ type: "junction", junctionId: "JUNC_B" });
  });

  it("should return null for unknown location ID without dgsm", () => {
    const topology = {
      junctions: new Map(),
      roads: new Map(),
      sceneToParent: new Map(),
      junctionToRoads: new Map(),
    } as any;

    const pos = resolveTargetPosition("UNKNOWN", topology);
    expect(pos).toBeNull();
  });

  it("should resolve an outline ID to its entry scene via dgsm fallback", () => {
    const sceneToParent = new Map([["SCN_1_SUB_1", "JUNC_A"]]);
    const topology = {
      junctions: new Map(),
      roads: new Map(),
      sceneToParent,
      junctionToRoads: new Map(),
    } as any;

    const mockDgsm = {
      getState: () => ({
        scenarioOutlines: [{ id: "SCN_1", entrySceneId: "SCN_1_SUB_1" }],
        scenes: new Map(),
      }),
    } as unknown as DynamicGameStateManager;

    const pos = resolveTargetPosition("SCN_1", topology, mockDgsm);
    expect(pos).toEqual({ type: "scene", sceneId: "SCN_1_SUB_1" });
  });

  it("should resolve an interior sub-scene to its parent outline entry scene via dgsm fallback", () => {
    const sceneToParent = new Map([["SCN_1_SUB_1", "JUNC_A"]]);
    const topology = {
      junctions: new Map(),
      roads: new Map(),
      sceneToParent,
      junctionToRoads: new Map(),
    } as any;

    const mockDgsm = {
      getState: () => ({
        scenarioOutlines: [{ id: "BUILDING", entrySceneId: "SCN_1_SUB_1" }],
        scenes: new Map([
          [
            "INTERIOR_ROOM",
            {
              id: "INTERIOR_ROOM",
              parentLocationId: "BUILDING",
            },
          ],
        ]),
      }),
    } as unknown as DynamicGameStateManager;

    const pos = resolveTargetPosition("INTERIOR_ROOM", topology, mockDgsm);
    expect(pos).toEqual({ type: "scene", sceneId: "SCN_1_SUB_1" });
  });
});
