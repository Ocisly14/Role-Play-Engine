import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CharacterStateDelta,
  PlanNode,
} from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { Item } from "../../../state/types.js";
import {
  applyCharacterDelta,
  resolveInteractionState,
  resolveTargets,
} from "../interactionStateResolver.js";

vi.mock("../../../../models/index.js", () => ({
  ModelClass: { SMALL: "small", MEDIUM: "medium", LARGE: "large" },
  generateText: vi.fn(),
}));

// ===== Mock DGSM =====

function createMockDgsm() {
  const characterPositions: Record<string, any> = {};
  const npcStats: Record<string, { hp: number; san: number }> = {};
  const npcInventories: Record<string, Item[]> = {};
  const npcCharacters: Array<{
    id: string;
    name: string;
    skills: Record<string, number>;
    status: { luck: number; conditions: string[] };
    appearance?: string;
  }> = [];
  const scenes = new Map<string, any>();
  const junctions = new Map<string, any>();
  const roads = new Map<string, any>();
  const sceneToParent = new Map<string, any>();
  const junctionToRoads = new Map<string, any[]>();
  const blockedConnections = new Map<string, string>();

  return {
    getState() {
      return {
        npcCharacters,
        blockedConnections,
        junctions,
        roads,
      };
    },
    getCharacterPosition(id: string) {
      return characterPositions[id] ?? null;
    },
    resolveLocationId(pos: any) {
      if (pos.type === "scene") return pos.sceneId;
      if (pos.type === "junction") return pos.junctionId;
      return pos.roadId;
    },
    setCharacterPosition(id: string, pos: any) {
      characterPositions[id] = pos;
    },
    getNpcStats(id: string) {
      return npcStats[id];
    },
    getNpcInventory(id: string): Item[] {
      return npcInventories[id] ?? [];
    },
    isNpcAlive(id: string) {
      return (npcStats[id]?.hp ?? 0) > 0;
    },
    updateNpcHp(id: string, delta: number) {
      if (!npcStats[id]) return;
      npcStats[id].hp = Math.max(0, npcStats[id].hp + delta);
    },
    updateNpcSan(id: string, delta: number) {
      if (!npcStats[id]) return;
      npcStats[id].san = Math.max(0, npcStats[id].san + delta);
    },
    addItemToNpc(id: string, item: Item) {
      if (!npcInventories[id]) npcInventories[id] = [];
      npcInventories[id].push(item);
    },
    removeItemFromNpc(id: string, itemId: string): Item | undefined {
      if (!npcInventories[id]) return undefined;
      const idx = npcInventories[id].findIndex((i) => i.id === itemId);
      if (idx === -1) return undefined;
      return npcInventories[id].splice(idx, 1)[0];
    },
    getScene(id: string) {
      return scenes.get(id) ?? null;
    },
    getTopology() {
      return { junctions, roads, sceneToParent, junctionToRoads };
    },
    getRelationship() {
      return null;
    },
    getSceneConditions() {
      return [];
    },
    getConnectionBlockReason() {
      return undefined;
    },
    findNpcItem(npcId: string, itemId: string) {
      return npcInventories[npcId]?.find((i) => i.id === itemId);
    },
    _addNpc(
      id: string,
      position: any,
      hp = 10,
      san = 50,
      opts: { conditions?: string[]; appearance?: string } = {}
    ) {
      characterPositions[id] = position;
      npcStats[id] = { hp, san };
      npcInventories[id] = [];
      npcCharacters.push({
        id,
        name: id,
        skills: {},
        status: { luck: 50, conditions: opts.conditions ?? [] },
        appearance: opts.appearance,
      });
    },
    _addScene(id: string, items: Item[] = []) {
      scenes.set(id, {
        id,
        name: id,
        description: "",
        items,
        connections: [],
        conditions: [],
      });
    },
    _addJunction(id: string) {
      junctions.set(id, {
        id,
        name: id,
        description: "",
        parentLocationId: "OUTDOOR",
        connectedSceneIds: [],
        items: [],
        conditions: [],
        events: [],
      });
    },
    _addRoad(
      id: string,
      endpointA: string,
      endpointB: string,
      travelTimeMinutes = 10
    ) {
      const road = {
        id,
        name: id,
        description: "",
        parentLocationId: "OUTDOOR",
        endpointA,
        endpointB,
        travelTimeMinutes,
        alongConnections: [],
        items: [],
        conditions: [],
        events: [],
      };
      roads.set(id, road);
      const aRoads = junctionToRoads.get(endpointA) ?? [];
      aRoads.push(road);
      junctionToRoads.set(endpointA, aRoads);
      const bRoads = junctionToRoads.get(endpointB) ?? [];
      bRoads.push(road);
      junctionToRoads.set(endpointB, bRoads);
    },
    _npcStats: npcStats,
    _npcInventories: npcInventories,
    _characterPositions: characterPositions,
  };
}

// ===== Tests =====

describe("resolveTargets", () => {
  it("returns targetCharacterIds from node", () => {
    const node = { targetCharacterIds: ["npc_b", "npc_c"] } as PlanNode;
    expect(resolveTargets(node)).toEqual(["npc_b", "npc_c"]);
  });

  it("returns empty array when no targetCharacterIds", () => {
    const node = {} as PlanNode;
    expect(resolveTargets(node)).toEqual([]);
  });
});

describe("applyCharacterDelta", () => {
  describe("HP and SAN changes", () => {
    it("should apply hpDelta", async () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", { type: "scene", sceneId: "room" }, 10, 50);

      const delta: CharacterStateDelta = {
        hpDelta: -3,
        memory: "I got hurt.",
      };

      await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      expect(dgsm._npcStats["npc_a"].hp).toBe(7);
    });

    it("should apply sanDelta", async () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", { type: "scene", sceneId: "room" }, 10, 50);

      const delta: CharacterStateDelta = {
        sanDelta: -5,
        memory: "That was horrifying.",
      };

      await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      expect(dgsm._npcStats["npc_a"].san).toBe(45);
    });

    it("should not go below 0 HP", async () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", { type: "scene", sceneId: "room" }, 2, 50);

      const delta: CharacterStateDelta = {
        hpDelta: -10,
        memory: "Devastating blow.",
      };

      await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      expect(dgsm._npcStats["npc_a"].hp).toBe(0);
    });

    it("should apply both hpDelta and sanDelta together", async () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", { type: "scene", sceneId: "room" }, 10, 50);

      const delta: CharacterStateDelta = {
        hpDelta: -2,
        sanDelta: -3,
        memory: "Pain and terror.",
      };

      await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      expect(dgsm._npcStats["npc_a"].hp).toBe(8);
      expect(dgsm._npcStats["npc_a"].san).toBe(47);
    });
  });

  describe("item transfers", () => {
    it("should remove items from character", async () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", { type: "scene", sceneId: "room" });
      dgsm.addItemToNpc("npc_a", { id: "knife", name: "Knife" });
      dgsm.addItemToNpc("npc_a", { id: "torch", name: "Torch" });

      const delta: CharacterStateDelta = {
        removeItems: ["knife"],
        memory: "I dropped the knife.",
      };

      await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      expect(dgsm._npcInventories["npc_a"]).toHaveLength(1);
      expect(dgsm._npcInventories["npc_a"][0].id).toBe("torch");
    });

    it("should transfer item from counterpart to character", async () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", { type: "scene", sceneId: "room" });
      dgsm._addNpc("npc_b", { type: "scene", sceneId: "room" });
      dgsm.addItemToNpc("npc_b", { id: "letter", name: "Letter" });

      const delta: CharacterStateDelta = {
        addItems: ["letter"],
        memory: "B gave me the letter.",
      };

      await applyCharacterDelta(dgsm as any, "npc_a", delta, ["npc_b"]);

      expect(dgsm._npcInventories["npc_a"]).toHaveLength(1);
      expect(dgsm._npcInventories["npc_a"][0].id).toBe("letter");
      expect(dgsm._npcInventories["npc_b"]).toHaveLength(0);
    });

    it("should pick up item from scene when not in counterpart inventory", async () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", { type: "scene", sceneId: "room" });
      dgsm._addScene("room", [{ id: "coin", name: "Gold Coin" }]);

      const delta: CharacterStateDelta = {
        addItems: ["coin"],
        memory: "I picked up the coin from the floor.",
      };

      await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      expect(dgsm._npcInventories["npc_a"]).toHaveLength(1);
      expect(dgsm._npcInventories["npc_a"][0].id).toBe("coin");
      expect(dgsm.getScene("room").items).toHaveLength(0);
    });

    it("should silently skip items not found anywhere", async () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", { type: "scene", sceneId: "room" });
      dgsm._addScene("room", []);

      const delta: CharacterStateDelta = {
        addItems: ["nonexistent"],
        memory: "I tried to grab something.",
      };

      // Should not throw
      await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      expect(dgsm._npcInventories["npc_a"]).toHaveLength(0);
    });
  });

  describe("conditions", () => {
    it("should add conditions to character", async () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", { type: "scene", sceneId: "room" });

      const delta: CharacterStateDelta = {
        addConditions: ["bleeding", "frightened"],
        memory: "I was stabbed and terrified.",
      };

      await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      const npc = dgsm.getState().npcCharacters.find((n) => n.id === "npc_a");
      expect(npc!.status.conditions).toContain("bleeding");
      expect(npc!.status.conditions).toContain("frightened");
    });

    it("should remove conditions from character", async () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", { type: "scene", sceneId: "room" }, 10, 50, {
        conditions: ["bleeding", "frightened", "stunned"],
      });

      const delta: CharacterStateDelta = {
        removeConditions: ["frightened"],
        memory: "I calmed down.",
      };

      await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      const npc = dgsm.getState().npcCharacters.find((n) => n.id === "npc_a");
      expect(npc!.status.conditions).toContain("bleeding");
      expect(npc!.status.conditions).toContain("stunned");
      expect(npc!.status.conditions).not.toContain("frightened");
    });

    it("should not duplicate existing conditions", async () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", { type: "scene", sceneId: "room" }, 10, 50, {
        conditions: ["bleeding"],
      });

      const delta: CharacterStateDelta = {
        addConditions: ["bleeding"],
        memory: "Still bleeding.",
      };

      await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      const npc = dgsm.getState().npcCharacters.find((n) => n.id === "npc_a");
      expect(
        npc!.status.conditions.filter((c) => c === "bleeding")
      ).toHaveLength(1);
    });
  });

  describe("appearance change", () => {
    it("should update character appearance", async () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", { type: "scene", sceneId: "room" }, 10, 50, {
        appearance: "Clean-shaven man in a suit",
      });

      const delta: CharacterStateDelta = {
        appearanceChange: "Blood-splattered man with torn jacket",
        memory: "The fight left its mark.",
      };

      await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      const npc = dgsm.getState().npcCharacters.find((n) => n.id === "npc_a");
      expect(npc!.appearance).toBe("Blood-splattered man with torn jacket");
    });
  });

  describe("movement", () => {
    it("should move character via topology path", async () => {
      const dgsm = createMockDgsm();
      dgsm._addJunction("JUNC_A");
      dgsm._addJunction("JUNC_B");
      dgsm._addRoad("ROAD_1", "JUNC_A", "JUNC_B", 10);
      dgsm._addNpc("npc_a", { type: "junction", junctionId: "JUNC_A" });

      const delta: CharacterStateDelta = {
        moveTo: "JUNC_B",
        memory: "I fled to the other junction.",
      };

      const result = await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      expect(result.blocked).toBeUndefined();
      expect(dgsm._characterPositions["npc_a"]).toEqual({
        type: "junction",
        junctionId: "JUNC_B",
      });
    });

    it("should return blocked when no path exists", async () => {
      const dgsm = createMockDgsm();
      dgsm._addJunction("JUNC_A");
      dgsm._addJunction("JUNC_B");
      // No road between them
      dgsm._addNpc("npc_a", { type: "junction", junctionId: "JUNC_A" });

      const delta: CharacterStateDelta = {
        moveTo: "JUNC_B",
        memory: "I tried to flee.",
      };

      const result = await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      expect(result.blocked).toBe(true);
      // Position should not change
      expect(dgsm._characterPositions["npc_a"]).toEqual({
        type: "junction",
        junctionId: "JUNC_A",
      });
    });
  });

  describe("combined delta", () => {
    it("should apply all changes in a single delta", async () => {
      const dgsm = createMockDgsm();
      dgsm._addJunction("JUNC_A");
      dgsm._addJunction("JUNC_B");
      dgsm._addRoad("ROAD_1", "JUNC_A", "JUNC_B", 10);
      dgsm._addNpc(
        "npc_a",
        { type: "junction", junctionId: "JUNC_A" },
        10,
        50,
        {
          conditions: ["hidden"],
        }
      );
      dgsm._addNpc("npc_b", { type: "junction", junctionId: "JUNC_A" });
      dgsm.addItemToNpc("npc_a", { id: "gun", name: "Pistol" });
      dgsm.addItemToNpc("npc_b", { id: "map", name: "Map" });

      const delta: CharacterStateDelta = {
        hpDelta: -2,
        sanDelta: -1,
        removeItems: ["gun"],
        addItems: ["map"],
        removeConditions: ["hidden"],
        addConditions: ["bleeding"],
        moveTo: "JUNC_B",
        memory: "The confrontation went badly.",
      };

      await applyCharacterDelta(dgsm as any, "npc_a", delta, ["npc_b"]);

      expect(dgsm._npcStats["npc_a"].hp).toBe(8);
      expect(dgsm._npcStats["npc_a"].san).toBe(49);
      expect(dgsm._npcInventories["npc_a"].map((i) => i.id)).toEqual(["map"]);
      expect(dgsm._npcInventories["npc_b"]).toHaveLength(0);
      const npc = dgsm.getState().npcCharacters.find((n) => n.id === "npc_a");
      expect(npc!.status.conditions).toEqual(["bleeding"]);
      expect(dgsm._characterPositions["npc_a"]).toEqual({
        type: "junction",
        junctionId: "JUNC_B",
      });
    });
  });

  describe("no-op delta", () => {
    it("should not change anything with memory-only delta", async () => {
      const dgsm = createMockDgsm();
      dgsm._addNpc("npc_a", { type: "scene", sceneId: "room" }, 10, 50);

      const delta: CharacterStateDelta = {
        memory: "Nothing happened.",
      };

      await applyCharacterDelta(dgsm as any, "npc_a", delta, []);

      expect(dgsm._npcStats["npc_a"].hp).toBe(10);
      expect(dgsm._npcStats["npc_a"].san).toBe(50);
      expect(dgsm._npcInventories["npc_a"]).toHaveLength(0);
    });
  });
});

// ===== resolveInteractionState (LLM) =====

function makeInteractionNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "ci1",
    characterId: "npc_a",
    characterName: "Alice",
    startTime: "10:00",
    endTime: "10:05",
    action: "Talk to Bob",
    location: "tavern",
    type: "character_interaction",
    impact: 1,
    status: "pending",
    targetCharacterIds: ["npc_b"],
    executionMeta: { remainingMinutes: 5 },
    ...overrides,
  } as PlanNode;
}

function createResolverDgsm() {
  const dgsm = createMockDgsm();
  dgsm._addNpc("npc_a", { type: "scene", sceneId: "tavern" }, 10, 50);
  dgsm._addNpc("npc_b", { type: "scene", sceneId: "tavern" }, 8, 40);
  dgsm._addScene("tavern", []);
  return dgsm;
}

describe("resolveInteractionState (LLM)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Basic parsing ──

  it("should parse simple conversation response", async () => {
    const { generateText } = await import("../../../../models/index.js");
    (generateText as any).mockResolvedValueOnce(
      JSON.stringify({
        actorChanges: { memory: "我和Bob聊了聊天气。" },
        targetChanges: { npc_b: { memory: "Alice跟我打了招呼，聊了天气。" } },
      })
    );

    const dgsm = createResolverDgsm();
    const result = await resolveInteractionState(
      makeInteractionNode(),
      dgsm as any,
      {} as any,
      null,
      [],
      "zh"
    );

    expect(result.actorChanges.memory).toBe("我和Bob聊了聊天气。");
    expect(result.targetChanges["npc_b"].memory).toBe(
      "Alice跟我打了招呼，聊了天气。"
    );
    expect(result.actorChanges.hpDelta).toBeUndefined();
    expect(result.actorChanges.sanDelta).toBeUndefined();
  });

  // ── Combat: full HP/SAN + conditions + appearance + movement ──

  it("should parse a full combat response with all delta fields", async () => {
    const { generateText } = await import("../../../../models/index.js");
    (generateText as any).mockResolvedValueOnce(
      JSON.stringify({
        actorChanges: {
          hpDelta: -1,
          sanDelta: 0,
          addConditions: ["adrenaline_rush"],
          removeConditions: [],
          appearanceChange: "Alice的拳头上沾着血迹，衬衫被撕破了左袖。",
          memory:
            "我一拳打中了Bob的下巴，但他的反击也擦伤了我的手臂。肾上腺素让我几乎感觉不到痛。",
        },
        targetChanges: {
          npc_b: {
            hpDelta: -4,
            sanDelta: -2,
            addConditions: ["bleeding", "stunned"],
            removeConditions: [],
            appearanceChange: "Bob的下巴肿了起来，嘴角流着血，眼神有些涣散。",
            moveTo: "JUNC_B",
            memory:
              "Alice突然出拳打中了我的下巴。剧痛让我一时无法思考，我本能地向后退去，嘴里尝到了血腥味。这个女人比看起来要危险得多。",
          },
        },
      })
    );

    const dgsm = createResolverDgsm();
    // Add topology so moveTo can work
    dgsm._addJunction("JUNC_A");
    dgsm._addJunction("JUNC_B");
    dgsm._addRoad("ROAD_1", "JUNC_A", "JUNC_B", 5);

    const result = await resolveInteractionState(
      makeInteractionNode({
        action: "Punch Bob in the jaw",
        skill: "Fighting (Brawl)",
        targetCharacterIds: ["npc_b"],
      }),
      dgsm as any,
      {} as any,
      {
        successLevel: "hard",
        detail: "Hard success (roll 18 vs 35)",
        perTargetResults: {
          npc_b: {
            successLevel: "hard",
            actorWon: true,
            detail: "Actor wins opposed roll",
            damage: 4,
          },
        },
      },
      [],
      "zh"
    );

    // Actor changes
    expect(result.actorChanges.hpDelta).toBe(-1);
    expect(result.actorChanges.addConditions).toContain("adrenaline_rush");
    expect(result.actorChanges.appearanceChange).toContain("血迹");
    expect(result.actorChanges.memory).toContain("一拳");

    // Target changes
    const bob = result.targetChanges["npc_b"];
    expect(bob.hpDelta).toBe(-4);
    expect(bob.sanDelta).toBe(-2);
    expect(bob.addConditions).toEqual(["bleeding", "stunned"]);
    expect(bob.appearanceChange).toContain("下巴肿");
    expect(bob.moveTo).toBe("JUNC_B");
    expect(bob.memory).toContain("剧痛");
  });

  // ── Multi-target: 1 actor vs 2 targets with different outcomes ──

  it("should handle multi-target interaction with mixed outcomes", async () => {
    const { generateText } = await import("../../../../models/index.js");
    (generateText as any).mockResolvedValueOnce(
      JSON.stringify({
        actorChanges: {
          sanDelta: -1,
          removeItems: ["bribe_money"],
          memory:
            "我试图说服Bob和Carol帮我。Bob被我说动了，但Carol完全不为所动，反而对我产生了敌意。我给了Bob一些钱作为酬劳。",
        },
        targetChanges: {
          npc_b: {
            addItems: ["bribe_money"],
            addConditions: ["cooperative"],
            memory:
              "Alice提出了一个有趣的交易。她给了我一笔钱，让我帮她调查码头的事情。我同意了——反正也不是什么难事。",
          },
          npc_c: {
            addConditions: ["hostile"],
            memory:
              "Alice企图拉拢我和Bob参与她的阴谋。我断然拒绝了。这个女人不值得信任。",
          },
        },
      })
    );

    const dgsm = createResolverDgsm();
    dgsm._addNpc("npc_c", { type: "scene", sceneId: "tavern" }, 12, 60);
    dgsm.addItemToNpc("npc_a", { id: "bribe_money", name: "一叠钞票" });

    const result = await resolveInteractionState(
      makeInteractionNode({
        action: "Persuade Bob and Carol to help investigate the docks",
        skill: "Persuade",
        targetCharacterIds: ["npc_b", "npc_c"],
      }),
      dgsm as any,
      {} as any,
      {
        successLevel: "regular",
        detail: "Regular success (roll 42 vs 55)",
        perTargetResults: {
          npc_b: {
            successLevel: "regular",
            actorWon: true,
            detail: "Actor wins",
          },
          npc_c: {
            successLevel: "hard",
            actorWon: false,
            detail: "Target resists",
          },
        },
      },
      [],
      "zh"
    );

    // Actor lost SAN and gave away money
    expect(result.actorChanges.sanDelta).toBe(-1);
    expect(result.actorChanges.removeItems).toContain("bribe_money");

    // Bob cooperated — got money and cooperative condition
    expect(result.targetChanges["npc_b"].addItems).toContain("bribe_money");
    expect(result.targetChanges["npc_b"].addConditions).toContain(
      "cooperative"
    );

    // Carol resisted — got hostile condition, no items
    expect(result.targetChanges["npc_c"].addConditions).toContain("hostile");
    expect(result.targetChanges["npc_c"].addItems).toBeUndefined();

    // All three have memory
    expect(result.actorChanges.memory).toContain("Carol");
    expect(result.targetChanges["npc_b"].memory).toContain("交易");
    expect(result.targetChanges["npc_c"].memory).toContain("拒绝");
  });

  // ── Intimidation: bidirectional item + condition + knowledge ──

  it("should parse intimidation with item handover and condition changes", async () => {
    const { generateText } = await import("../../../../models/index.js");
    (generateText as any).mockResolvedValueOnce(
      JSON.stringify({
        actorChanges: {
          addItems: ["warehouse_key"],
          removeConditions: ["anxious"],
          memory:
            "我用枪指着Bob，逼他交出了仓库的钥匙。他告诉我仓库在码头区第三个，里面藏着走私的古董。看他吓得发抖的样子，应该没有撒谎。",
        },
        targetChanges: {
          npc_b: {
            sanDelta: -5,
            removeItems: ["warehouse_key"],
            addConditions: ["terrified", "cooperative"],
            removeConditions: ["confident"],
            memory:
              "Alice居然拿枪指着我！我吓坏了，把仓库钥匙交给了她，还告诉了她仓库的位置。我不想死——那些古董不值得用命去换。",
          },
        },
      })
    );

    const dgsm = createResolverDgsm();

    const result = await resolveInteractionState(
      makeInteractionNode({
        action: "Point gun at Bob and demand the warehouse key",
        skill: "Intimidate",
      }),
      dgsm as any,
      {} as any,
      {
        successLevel: "critical",
        detail: "Critical success (roll 03 vs 65)",
        perTargetResults: {
          npc_b: {
            successLevel: "critical",
            actorWon: true,
            detail: "Actor wins — critical",
          },
        },
      },
      [
        {
          sourceId: "npc_b",
          text: "仓库在码头区第三个",
          difficulty: "hard" as any,
        },
        {
          sourceId: "npc_b",
          text: "仓库里藏着走私的古董",
          difficulty: "extreme" as any,
        },
      ],
      "zh"
    );

    // Actor gained key, lost anxious
    expect(result.actorChanges.addItems).toContain("warehouse_key");
    expect(result.actorChanges.removeConditions).toContain("anxious");
    expect(result.actorChanges.memory).toContain("钥匙");
    expect(result.actorChanges.memory).toContain("古董");

    // Bob lost key, gained terrified, lost confident, lost SAN
    const bob = result.targetChanges["npc_b"];
    expect(bob.sanDelta).toBe(-5);
    expect(bob.removeItems).toContain("warehouse_key");
    expect(bob.addConditions).toContain("terrified");
    expect(bob.addConditions).toContain("cooperative");
    expect(bob.removeConditions).toContain("confident");
  });

  // ── JSON edge cases ──

  it("should handle JSON wrapped in markdown fences", async () => {
    const { generateText } = await import("../../../../models/index.js");
    (generateText as any).mockResolvedValueOnce(
      '```json\n{"actorChanges":{"hpDelta":-1,"memory":"fenced response"},"targetChanges":{"npc_b":{"sanDelta":-2,"memory":"也fenced"}}}\n```'
    );

    const dgsm = createResolverDgsm();
    const result = await resolveInteractionState(
      makeInteractionNode(),
      dgsm as any,
      {} as any,
      null,
      [],
      "zh"
    );

    expect(result.actorChanges.hpDelta).toBe(-1);
    expect(result.actorChanges.memory).toBe("fenced response");
    expect(result.targetChanges["npc_b"].sanDelta).toBe(-2);
  });

  it("should fill default memory when LLM omits it", async () => {
    const { generateText } = await import("../../../../models/index.js");
    (generateText as any).mockResolvedValueOnce(
      JSON.stringify({ actorChanges: { hpDelta: -1 }, targetChanges: {} })
    );

    const dgsm = createResolverDgsm();
    const result = await resolveInteractionState(
      makeInteractionNode({ action: "Greet Bob" }),
      dgsm as any,
      {} as any,
      null,
      [],
      "zh"
    );

    expect(result.actorChanges.memory).toBe("Greet Bob");
    expect(result.targetChanges["npc_b"].memory).toBe(
      "Alice interacted with me."
    );
  });

  // ── Error handling ──

  it("should return fallback on LLM failure", async () => {
    const { generateText } = await import("../../../../models/index.js");
    (generateText as any).mockRejectedValueOnce(new Error("LLM timeout"));

    const dgsm = createResolverDgsm();
    const result = await resolveInteractionState(
      makeInteractionNode({ action: "Talk to Bob" }),
      dgsm as any,
      {} as any,
      null,
      [],
      "zh"
    );

    expect(result.actorChanges.memory).toBe("Talk to Bob");
    expect(result.targetChanges["npc_b"].memory).toBe(
      "Alice interacted with me."
    );
    expect(result.actorChanges.hpDelta).toBeUndefined();
  });

  it("should return fallback on malformed JSON", async () => {
    const { generateText } = await import("../../../../models/index.js");
    (generateText as any).mockResolvedValueOnce("this is not json at all }{}{");

    const dgsm = createResolverDgsm();
    const result = await resolveInteractionState(
      makeInteractionNode(),
      dgsm as any,
      {} as any,
      null,
      [],
      "zh"
    );

    expect(result.actorChanges.memory).toBeDefined();
    expect(result.targetChanges["npc_b"].memory).toBeDefined();
  });

  // ── Prompt verification ──

  it("should include skill roll, target data, and knowledge in prompt", async () => {
    const { generateText } = await import("../../../../models/index.js");
    let capturedPrompt = "";
    (generateText as any).mockImplementationOnce(async (opts: any) => {
      capturedPrompt = opts.context;
      return JSON.stringify({
        actorChanges: { memory: "ok" },
        targetChanges: { npc_b: { memory: "ok" } },
      });
    });

    const dgsm = createResolverDgsm();

    await resolveInteractionState(
      makeInteractionNode({
        action: "Ask Bob about the ritual",
        skill: "Persuade",
      }),
      dgsm as any,
      {} as any,
      {
        successLevel: "hard",
        detail: "Hard success (roll 15 vs 30)",
        perTargetResults: {
          npc_b: {
            successLevel: "regular",
            actorWon: true,
            detail: "Actor wins",
          },
        },
      },
      [
        {
          sourceId: "npc_b",
          text: "The ritual requires three sacrifices",
          difficulty: "hard" as any,
        },
        {
          sourceId: "npc_b",
          text: "It takes place at midnight",
          difficulty: "regular" as any,
        },
      ],
      "zh"
    );

    // Skill roll info
    expect(capturedPrompt).toContain("hard");
    expect(capturedPrompt).toContain("Actor wins");
    // Knowledge entries
    expect(capturedPrompt).toContain("three sacrifices");
    expect(capturedPrompt).toContain("midnight");
    // Character IDs
    expect(capturedPrompt).toContain("npc_a");
    expect(capturedPrompt).toContain("npc_b");
  });
});
