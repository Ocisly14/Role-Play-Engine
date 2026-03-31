import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ObjectStateDelta,
  PlanNode,
} from "../../../planning/types.js";
import type { DynamicScene, Item } from "../../../state/types.js";
import {
  applyObjectDelta,
  resolveObjectInteractionState,
} from "../objectInteractionStateResolver.js";

vi.mock("../../../models/index.js", () => ({
  ModelClass: { SMALL: "small", MEDIUM: "medium", LARGE: "large" },
  generateText: vi.fn(),
}));

// ─── Mock DGSM ──────────────────────────────────────────────────────

function createMockDgsm() {
  const scenes = new Map<string, DynamicScene>();
  const npcInventories: Record<string, Item[]> = {};
  const npcCharacters: Array<{ id: string; name: string }> = [];
  const characterPositions: Record<string, any> = {};
  const scenarioConditions: Record<string, Array<{ description: string }>> = {};

  return {
    getState() {
      return { npcCharacters, npcInventories, scenarioConditions };
    },
    getScene(sceneId: string): DynamicScene | null {
      return scenes.get(sceneId) ?? null;
    },
    getNpcInventory(npcId: string): Item[] {
      return npcInventories[npcId] ?? [];
    },
    findNpcItem(npcId: string, itemId: string): Item | undefined {
      return npcInventories[npcId]?.find((i) => i.id === itemId);
    },
    addItemToNpc(npcId: string, item: Item): void {
      if (!npcInventories[npcId]) npcInventories[npcId] = [];
      npcInventories[npcId].push(item);
    },
    removeItemFromNpc(npcId: string, itemId: string): Item | undefined {
      if (!npcInventories[npcId]) return undefined;
      const idx = npcInventories[npcId].findIndex((i) => i.id === itemId);
      if (idx === -1) return undefined;
      return npcInventories[npcId].splice(idx, 1)[0];
    },
    appendSceneCondition(
      scenarioId: string,
      condition: { description: string }
    ): void {
      if (!scenarioConditions[scenarioId]) scenarioConditions[scenarioId] = [];
      scenarioConditions[scenarioId].push(condition);
    },
    getCharacterPosition(characterId: string) {
      return characterPositions[characterId] ?? null;
    },
    resolveLocationId(position: any): string {
      if (position.type === "scene") return position.sceneId;
      if (position.type === "junction") return position.junctionId;
      return position.roadId;
    },

    // ── Test helpers ──
    _addScene(id: string, name: string, items: Item[]): void {
      scenes.set(id, {
        id,
        name,
        description: "",
        parentLocationId: "PARENT",
        items,
        conditions: [],
        connections: [],
      });
    },
    _addInventory(npcId: string, items: Item[]): void {
      npcInventories[npcId] = items;
    },
    _addNpc(id: string, name: string): void {
      npcCharacters.push({ id, name });
    },
    _getConditions(sceneId: string): Array<{ description: string }> {
      return scenarioConditions[sceneId] ?? [];
    },
  };
}

// ─── Item factory ────────────────────────────────────────────────────

function makeItem(
  overrides: Partial<Item> & { id: string; name: string }
): Item {
  return { ...overrides };
}

// ─── Tests ───────────────────────────────────────────────────────────

describe("applyObjectDelta", () => {
  it("moves item from scene to actor inventory", () => {
    const dgsm = createMockDgsm();
    const pen = makeItem({ id: "pen", name: "Fountain Pen" });
    dgsm._addScene("room1", "Study", [pen]);
    dgsm._addInventory("actor1", []);

    const delta: ObjectStateDelta = {
      items: [{ itemId: "pen", location: "inventory" }],
      memory: "I picked up the pen.",
    };

    applyObjectDelta(dgsm as any, "actor1", delta, "room1");

    expect(dgsm.getScene("room1")!.items).toHaveLength(0);
    expect(dgsm.getNpcInventory("actor1")).toHaveLength(1);
    expect(dgsm.getNpcInventory("actor1")[0].id).toBe("pen");
  });

  it("moves item from actor inventory to scene", () => {
    const dgsm = createMockDgsm();
    const book = makeItem({ id: "book", name: "Necronomicon" });
    dgsm._addScene("room1", "Library", []);
    dgsm._addInventory("actor1", [book]);

    const delta: ObjectStateDelta = {
      items: [{ itemId: "book", location: "scene" }],
      memory: "I placed the book on the table.",
    };

    applyObjectDelta(dgsm as any, "actor1", delta, "room1");

    expect(dgsm.getNpcInventory("actor1")).toHaveLength(0);
    expect(dgsm.getScene("room1")!.items).toHaveLength(1);
    expect(dgsm.getScene("room1")!.items[0].id).toBe("book");
  });

  it("moves item from container to actor inventory", () => {
    const dgsm = createMockDgsm();
    const letter = makeItem({ id: "letter", name: "Sealed Letter" });
    const box = makeItem({
      id: "box",
      name: "Wooden Box",
      type: "container",
      containerStats: { storedItems: [letter] },
    });
    dgsm._addScene("room1", "Attic", [box]);
    dgsm._addInventory("actor1", []);

    const delta: ObjectStateDelta = {
      items: [{ itemId: "letter", location: "inventory" }],
      memory: "I took the letter from the box.",
    };

    applyObjectDelta(dgsm as any, "actor1", delta, "room1");

    expect(dgsm.getNpcInventory("actor1")).toHaveLength(1);
    expect(dgsm.getNpcInventory("actor1")[0].id).toBe("letter");
    expect(box.containerStats!.storedItems).toHaveLength(0);
  });

  it("moves item to container", () => {
    const dgsm = createMockDgsm();
    const coin = makeItem({ id: "coin", name: "Gold Coin" });
    const briefcase = makeItem({
      id: "briefcase",
      name: "Briefcase",
      type: "container",
      containerStats: { storedItems: [] },
    });
    dgsm._addScene("room1", "Office", [coin, briefcase]);
    dgsm._addInventory("actor1", []);

    const delta: ObjectStateDelta = {
      items: [{ itemId: "coin", location: "container:briefcase" }],
      memory: "I put the coin in the briefcase.",
    };

    applyObjectDelta(dgsm as any, "actor1", delta, "room1");

    // Coin removed from scene top-level items
    expect(
      dgsm.getScene("room1")!.items.find((i) => i.id === "coin")
    ).toBeUndefined();
    // Coin now inside briefcase
    expect(briefcase.containerStats!.storedItems).toHaveLength(1);
    expect(briefcase.containerStats!.storedItems![0].id).toBe("coin");
  });

  it("modifies item in-place via deep merge", () => {
    const dgsm = createMockDgsm();
    const safe = makeItem({
      id: "safe",
      name: "Wall Safe",
      type: "container",
      containerStats: {
        locked: true,
        lockDifficulty: "hard",
        capacity: 10,
        storedItems: [],
      },
    });
    dgsm._addScene("room1", "Study", [safe]);
    dgsm._addInventory("actor1", []);

    const delta: ObjectStateDelta = {
      items: [
        {
          itemId: "safe",
          location: "scene",
          updates: { containerStats: { locked: false } },
        },
      ],
      memory: "I unlocked the safe.",
    };

    applyObjectDelta(dgsm as any, "actor1", delta, "room1");

    const updatedSafe = dgsm
      .getScene("room1")!
      .items.find((i) => i.id === "safe")!;
    expect(updatedSafe.containerStats!.locked).toBe(false);
    // Deep merge preserves other fields
    expect(updatedSafe.containerStats!.lockDifficulty).toBe("hard");
    expect(updatedSafe.containerStats!.capacity).toBe(10);
  });

  it("destroys item from scene", () => {
    const dgsm = createMockDgsm();
    const vase = makeItem({ id: "vase", name: "Ming Vase" });
    dgsm._addScene("room1", "Gallery", [vase]);
    dgsm._addInventory("actor1", []);

    const delta: ObjectStateDelta = {
      items: [{ itemId: "vase", location: "destroyed" }],
      memory: "I smashed the vase.",
    };

    applyObjectDelta(dgsm as any, "actor1", delta, "room1");

    expect(dgsm.getScene("room1")!.items).toHaveLength(0);
  });

  it("destroys item from inventory", () => {
    const dgsm = createMockDgsm();
    const note = makeItem({ id: "note", name: "Torn Note" });
    dgsm._addScene("room1", "Hallway", []);
    dgsm._addInventory("actor1", [note]);

    const delta: ObjectStateDelta = {
      items: [{ itemId: "note", location: "destroyed" }],
      memory: "I burned the note.",
    };

    applyObjectDelta(dgsm as any, "actor1", delta, "room1");

    expect(dgsm.getNpcInventory("actor1")).toHaveLength(0);
  });

  it("adds scene conditions", () => {
    const dgsm = createMockDgsm();
    dgsm._addScene("room1", "Kitchen", []);
    dgsm._addInventory("actor1", []);

    const delta: ObjectStateDelta = {
      items: [],
      addSceneConditions: [
        "broken glass on the floor",
        "smell of spilled chemicals",
      ],
      memory: "I knocked over the beakers.",
    };

    applyObjectDelta(dgsm as any, "actor1", delta, "room1");

    const conditions = dgsm._getConditions("room1");
    expect(conditions).toHaveLength(2);
    expect(conditions[0].description).toBe("broken glass on the floor");
    expect(conditions[1].description).toBe("smell of spilled chemicals");
  });

  it("skips unknown items gracefully", () => {
    const dgsm = createMockDgsm();
    const lamp = makeItem({ id: "lamp", name: "Desk Lamp" });
    dgsm._addScene("room1", "Office", [lamp]);
    dgsm._addInventory("actor1", []);

    const delta: ObjectStateDelta = {
      items: [{ itemId: "nonexistent_item", location: "inventory" }],
      memory: "I tried to pick something up.",
    };

    // Should not throw
    expect(() =>
      applyObjectDelta(dgsm as any, "actor1", delta, "room1")
    ).not.toThrow();

    // Scene unchanged
    expect(dgsm.getScene("room1")!.items).toHaveLength(1);
    expect(dgsm.getNpcInventory("actor1")).toHaveLength(0);
  });

  it("handles multiple sequential operations (unlock then extract)", () => {
    const dgsm = createMockDgsm();
    const jewel = makeItem({ id: "jewel", name: "Ruby" });
    const chest = makeItem({
      id: "chest",
      name: "Treasure Chest",
      type: "container",
      containerStats: { locked: true, storedItems: [jewel] },
    });
    const key = makeItem({ id: "old_key", name: "Old Key", type: "key" });
    dgsm._addScene("room1", "Vault", [chest]);
    dgsm._addInventory("actor1", [key]);

    // Operation 1: unlock the chest
    const unlockDelta: ObjectStateDelta = {
      items: [
        {
          itemId: "chest",
          location: "scene",
          updates: { containerStats: { locked: false } },
        },
      ],
      memory: "I unlocked the chest with the old key.",
    };
    applyObjectDelta(dgsm as any, "actor1", unlockDelta, "room1");
    expect(chest.containerStats!.locked).toBe(false);

    // Operation 2: take jewel from (now-unlocked) chest
    const extractDelta: ObjectStateDelta = {
      items: [{ itemId: "jewel", location: "inventory" }],
      memory: "I took the ruby from the chest.",
    };
    applyObjectDelta(dgsm as any, "actor1", extractDelta, "room1");

    expect(chest.containerStats!.storedItems).toHaveLength(0);
    expect(
      dgsm.getNpcInventory("actor1").find((i) => i.id === "jewel")
    ).toBeTruthy();
  });

  it("applyObjectDelta trusts LLM decision and moves item from locked container", () => {
    const dgsm = createMockDgsm();
    const diary = makeItem({ id: "diary", name: "Secret Diary" });
    const locker = makeItem({
      id: "locker",
      name: "Metal Locker",
      type: "container",
      containerStats: { locked: true, storedItems: [diary] },
    });
    dgsm._addScene("room1", "Changing Room", [locker]);
    dgsm._addInventory("actor1", []);

    const delta: ObjectStateDelta = {
      items: [{ itemId: "diary", location: "inventory" }],
      memory: "I grabbed the diary from the locker.",
    };

    applyObjectDelta(dgsm as any, "actor1", delta, "room1");

    // Lock guard removed — applyObjectDelta trusts LLM output
    expect(locker.containerStats!.storedItems).toHaveLength(0);
    expect(dgsm.getNpcInventory("actor1")).toHaveLength(1);
    expect(dgsm.getNpcInventory("actor1")[0].id).toBe("diary");
  });

  it("container lock guard allows access when actor has key", () => {
    const dgsm = createMockDgsm();
    const diary = makeItem({ id: "diary", name: "Secret Diary" });
    const locker = makeItem({
      id: "locker",
      name: "Metal Locker",
      type: "container",
      containerStats: { locked: true, storedItems: [diary] },
    });
    const key = makeItem({ id: "master_key", name: "Master Key", type: "key" });
    dgsm._addScene("room1", "Changing Room", [locker]);
    dgsm._addInventory("actor1", [key]);

    const delta: ObjectStateDelta = {
      items: [{ itemId: "diary", location: "inventory" }],
      memory: "I unlocked the locker and took the diary.",
    };

    applyObjectDelta(dgsm as any, "actor1", delta, "room1");

    // Item moved out of the locked container
    expect(locker.containerStats!.storedItems).toHaveLength(0);
    expect(dgsm.getNpcInventory("actor1")).toHaveLength(2); // key + diary
    expect(
      dgsm.getNpcInventory("actor1").find((i) => i.id === "diary")
    ).toBeTruthy();
  });
});

// ===== resolveObjectInteractionState (LLM) =====

function createResolverDgsm() {
  const scenes = new Map<string, DynamicScene>();
  const npcInventories: Record<string, Item[]> = {};
  const npcCharacters: Array<{
    id: string;
    name: string;
    skills: Record<string, number>;
    status: { conditions: string[] };
  }> = [];
  const characterPositions: Record<string, any> = {};
  const npcStats: Record<string, { hp: number; san: number }> = {};
  const hiddenCharacterIds = new Set<string>();

  return {
    getState() {
      return {
        npcCharacters,
        npcInventories,
        scenarioConditions: {},
        gameDay: 1,
      };
    },
    getScene(sceneId: string) {
      return scenes.get(sceneId) ?? null;
    },
    getNpcInventory(npcId: string): Item[] {
      return npcInventories[npcId] ?? [];
    },
    findNpcItem(npcId: string, itemId: string): Item | undefined {
      return npcInventories[npcId]?.find((i) => i.id === itemId);
    },
    addItemToNpc(npcId: string, item: Item) {
      if (!npcInventories[npcId]) npcInventories[npcId] = [];
      npcInventories[npcId].push(item);
    },
    removeItemFromNpc(npcId: string, itemId: string): Item | undefined {
      if (!npcInventories[npcId]) return undefined;
      const idx = npcInventories[npcId].findIndex((i) => i.id === itemId);
      if (idx === -1) return undefined;
      return npcInventories[npcId].splice(idx, 1)[0];
    },
    getCharacterPosition(id: string) {
      return characterPositions[id] ?? null;
    },
    resolveLocationId(pos: any) {
      if (pos.type === "scene") return pos.sceneId;
      if (pos.type === "junction") return pos.junctionId;
      return pos.roadId;
    },
    isNpcAlive(id: string) {
      return (npcStats[id]?.hp ?? 0) > 0;
    },
    isCharacterHidden(id: string) {
      return hiddenCharacterIds.has(id);
    },
    appendSceneCondition() {},
    _addScene(id: string, name: string, items: Item[] = []) {
      scenes.set(id, {
        id,
        name,
        description: "A dusty room.",
        parentLocationId: "PARENT",
        items,
        conditions: [],
        connections: [],
      } as unknown as DynamicScene);
    },
    _addNpc(id: string, name: string, location: string) {
      characterPositions[id] = { type: "scene", sceneId: location };
      npcStats[id] = { hp: 10, san: 50 };
      npcInventories[id] = [];
      npcCharacters.push({ id, name, skills: {}, status: { conditions: [] } });
    },
    _setHidden(id: string, hidden: boolean) {
      if (hidden) hiddenCharacterIds.add(id);
      else hiddenCharacterIds.delete(id);
    },
  };
}

function makeObjNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "oi1",
    characterId: "actor1",
    characterName: "Investigator",
    startTime: "10:00",
    endTime: "10:05",
    action: "Pick up the pen",
    location: "study",
    type: "object_interaction",
    impact: 1,
    status: "pending",
    executionMeta: { remainingMinutes: 5 },
    objectInteractionPayload: { itemId: "pen" },
    ...overrides,
  } as PlanNode;
}

describe("resolveObjectInteractionState (LLM)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Basic: pick up item ──

  it("should parse simple pickup response", async () => {
    const { generateText } = await import("../../../models/index.js");
    (generateText as any).mockResolvedValueOnce(
      JSON.stringify({
        items: [{ itemId: "pen", location: "inventory" }],
        memory: "我从书桌上拿起了那支钢笔。笔身上刻着一个我不认识的徽章。",
      })
    );

    const dgsm = createResolverDgsm();
    dgsm._addScene("study", "Study", [
      makeItem({ id: "pen", name: "Fountain Pen" }),
    ]);
    dgsm._addNpc("actor1", "Investigator", "study");

    const result = await resolveObjectInteractionState(
      makeObjNode(),
      dgsm as any,
      {} as any,
      null,
      "zh"
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0].itemId).toBe("pen");
    expect(result.items[0].location).toBe("inventory");
    expect(result.memory).toContain("钢笔");
  });

  // ── Complex: disassemble with newItems + conditions + witness ──

  it("should parse disassemble response with newItems, scene conditions, and witnesses", async () => {
    const { generateText } = await import("../../../models/index.js");
    (generateText as any).mockResolvedValueOnce(
      JSON.stringify({
        items: [{ itemId: "grandfather_clock", location: "destroyed" }],
        newItems: [
          {
            id: "clock_gear_01",
            name: "精密黄铜齿轮",
            type: "other",
            description: "从老座钟内部拆下的精密黄铜齿轮，上面刻着奇怪的符文。",
            location: "inventory",
            sourceItemId: "grandfather_clock",
          },
          {
            id: "clock_pendulum",
            name: "水晶钟摆",
            type: "other",
            description: "座钟的钟摆，内部似乎封印着某种液体。",
            location: "scene",
            sourceItemId: "grandfather_clock",
          },
          {
            id: "hidden_note",
            name: "藏在钟内的纸条",
            type: "document",
            description: "一张泛黄的纸条，上面用拉丁文写着什么。",
            location: "inventory",
            sourceItemId: "grandfather_clock",
          },
        ],
        addSceneConditions: [
          "座钟的碎片散落一地，木屑和金属零件混在一起",
          "空气中弥漫着陈旧的机油味",
        ],
        memory:
          "我小心翼翼地拆解了那台老座钟。在钟的内部机构中，我发现了一个精密的黄铜齿轮，上面刻着我从未见过的符文。更令人惊讶的是，钟摆内部似乎封印着某种发光的液体。最意外的发现是藏在钟壳夹层里的一张泛黄纸条。",
      })
    );

    const dgsm = createResolverDgsm();
    const clock = makeItem({
      id: "grandfather_clock",
      name: "Grandfather Clock",
      description: "An ancient grandfather clock with intricate carvings.",
    });
    dgsm._addScene("study", "Study", [clock]);
    dgsm._addNpc("actor1", "Investigator", "study");
    dgsm._addNpc("npc_butler", "Butler", "study");
    dgsm._addNpc("npc_maid", "Maid", "study");

    const result = await resolveObjectInteractionState(
      makeObjNode({
        action: "Carefully disassemble the grandfather clock",
        skill: "Mechanical Repair",
        objectInteractionPayload: { itemId: "grandfather_clock" },
      }),
      dgsm as any,
      {} as any,
      { successLevel: "hard", detail: "Hard success (roll 8 vs 45)" },
      "zh"
    );

    // Original item destroyed
    expect(result.items).toHaveLength(1);
    expect(result.items[0].itemId).toBe("grandfather_clock");
    expect(result.items[0].location).toBe("destroyed");

    // 3 new items produced
    expect(result.newItems).toHaveLength(3);
    const gear = result.newItems!.find((i) => i.id === "clock_gear_01");
    expect(gear).toBeDefined();
    expect(gear!.location).toBe("inventory");
    expect(gear!.sourceItemId).toBe("grandfather_clock");
    expect(gear!.description).toContain("符文");

    const pendulum = result.newItems!.find((i) => i.id === "clock_pendulum");
    expect(pendulum!.location).toBe("scene");

    const note = result.newItems!.find((i) => i.id === "hidden_note");
    expect(note!.type).toBe("document");

    // Scene conditions
    expect(result.addSceneConditions).toHaveLength(2);
    expect(result.addSceneConditions![0]).toContain("碎片");
    expect(result.addSceneConditions![1]).toContain("机油");

    // Actor memory
    expect(result.memory).toContain("符文");
    expect(result.memory).toContain("纸条");
  });

  // ── Complex: unlock container + extract + update item ──

  it("should parse multi-item response with updates and container operations", async () => {
    const { generateText } = await import("../../../models/index.js");
    (generateText as any).mockResolvedValueOnce(
      JSON.stringify({
        items: [
          {
            itemId: "wall_safe",
            location: "scene",
            updates: {
              containerStats: { locked: false },
              description: "保险箱的锁已被撬开，锁芯有明显的工具痕迹。",
            },
          },
          {
            itemId: "cult_ledger",
            location: "inventory",
          },
          {
            itemId: "ritual_dagger",
            location: "inventory",
            updates: {
              description:
                "一把黑曜石匕首，刀刃上似乎残留着暗红色的痕迹。拿在手里时能感到一阵异样的寒意。",
            },
          },
          {
            itemId: "lockpick_set",
            location: "inventory",
            updates: {
              damaged: true,
              damageDetails: {
                damagedBy: "use",
                reason: "撬锁时其中一根撬针折断了",
              },
              consumableStats: { uses: 2 },
            },
          },
        ],
        addSceneConditions: ["保险箱门敞开着，里面空空如也"],
        memory:
          "我用撬锁工具花了好一番功夫才打开保险箱。里面有一本看起来像是邪教账本的东西，还有一把让人不安的黑曜石匕首。可惜撬锁的时候弄断了一根撬针。账本上记录着大量来路不明的资金流向，还有一些我看不懂的符号。",
      })
    );

    const dgsm = createResolverDgsm();
    const cultLedger = makeItem({
      id: "cult_ledger",
      name: "Leather-bound Ledger",
    });
    const ritualDagger = makeItem({
      id: "ritual_dagger",
      name: "Obsidian Dagger",
    });
    const safe = makeItem({
      id: "wall_safe",
      name: "Wall Safe",
      type: "container",
      containerStats: {
        locked: true,
        lockDifficulty: "hard",
        capacity: 10,
        storedItems: [cultLedger, ritualDagger],
      },
    });
    const lockpick = makeItem({
      id: "lockpick_set",
      name: "Lockpick Set",
      type: "tool",
      consumableStats: { uses: 3, effect: "pick locks" },
    });
    dgsm._addScene("study", "Study", [safe]);
    dgsm._addNpc("actor1", "Investigator", "study");
    dgsm.addItemToNpc("actor1", lockpick);

    const result = await resolveObjectInteractionState(
      makeObjNode({
        action: "Pick the lock on the wall safe with my lockpick set",
        skill: "Locksmith",
        objectInteractionPayload: { itemId: "wall_safe" },
      }),
      dgsm as any,
      {} as any,
      { successLevel: "regular", detail: "Regular success (roll 38 vs 45)" },
      "zh"
    );

    // 4 items affected
    expect(result.items).toHaveLength(4);

    // Safe unlocked and description updated
    const safeResult = result.items.find((i) => i.itemId === "wall_safe");
    expect(safeResult!.updates!.containerStats).toEqual({ locked: false });
    expect(safeResult!.updates!.description).toContain("撬开");

    // Ledger and dagger moved to inventory
    expect(result.items.find((i) => i.itemId === "cult_ledger")!.location).toBe(
      "inventory"
    );
    expect(
      result.items.find((i) => i.itemId === "ritual_dagger")!.location
    ).toBe("inventory");
    expect(
      result.items.find((i) => i.itemId === "ritual_dagger")!.updates!
        .description
    ).toContain("寒意");

    // Lockpick damaged
    const lockpickResult = result.items.find(
      (i) => i.itemId === "lockpick_set"
    );
    expect(lockpickResult!.updates!.damaged).toBe(true);
    expect(lockpickResult!.updates!.consumableStats).toEqual({ uses: 2 });

    // Scene condition
    expect(result.addSceneConditions![0]).toContain("保险箱");

    // Memory mentions key findings
    expect(result.memory).toContain("邪教");
    expect(result.memory).toContain("匕首");
    expect(result.memory).toContain("撬针");
  });

  // ── Move to container (location: "container:xxx") ──

  it("should parse item moves into containers and between NPCs", async () => {
    const { generateText } = await import("../../../models/index.js");
    (generateText as any).mockResolvedValueOnce(
      JSON.stringify({
        items: [
          { itemId: "evidence_photo", location: "container:briefcase" },
          { itemId: "poison_vial", location: "inventory:npc_butler" },
        ],
        memory:
          "我把证据照片放进了公文包里。那瓶毒药太危险了，我让管家帮忙保管。",
      })
    );

    const dgsm = createResolverDgsm();
    const photo = makeItem({
      id: "evidence_photo",
      name: "Crime Scene Photo",
      category: "evidence",
    });
    const vial = makeItem({
      id: "poison_vial",
      name: "Vial of Poison",
      type: "consumable",
    });
    const briefcase = makeItem({
      id: "briefcase",
      name: "Briefcase",
      type: "container",
      containerStats: { capacity: 5, locked: false, storedItems: [] },
    });
    dgsm._addScene("study", "Study", [photo, vial]);
    dgsm._addNpc("actor1", "Investigator", "study");
    dgsm._addNpc("npc_butler", "Butler", "study");
    dgsm.addItemToNpc("actor1", briefcase);

    const result = await resolveObjectInteractionState(
      makeObjNode({
        action: "Put the photo in my briefcase, give the vial to the butler",
        objectInteractionPayload: { itemId: "evidence_photo" },
      }),
      dgsm as any,
      {} as any,
      null,
      "zh"
    );

    expect(result.items).toHaveLength(2);
    expect(
      result.items.find((i) => i.itemId === "evidence_photo")!.location
    ).toBe("container:briefcase");
    expect(result.items.find((i) => i.itemId === "poison_vial")!.location).toBe(
      "inventory:npc_butler"
    );
  });

  // ── JSON edge cases ──

  it("should handle markdown-fenced JSON with trailing commas", async () => {
    const { generateText } = await import("../../../models/index.js");
    // Simulates imperfect LLM JSON with trailing comma
    (generateText as any).mockResolvedValueOnce(
      '```json\n{"items":[{"itemId":"pen","location":"inventory",}],"memory":"repaired",}\n```'
    );

    const dgsm = createResolverDgsm();
    dgsm._addScene("study", "Study", [makeItem({ id: "pen", name: "Pen" })]);
    dgsm._addNpc("actor1", "Investigator", "study");

    const result = await resolveObjectInteractionState(
      makeObjNode(),
      dgsm as any,
      {} as any,
      null,
      "zh"
    );

    expect(result.memory).toBe("repaired");
    expect(result.items[0].itemId).toBe("pen");
  });

  it("should fill default memory when LLM omits it", async () => {
    const { generateText } = await import("../../../models/index.js");
    (generateText as any).mockResolvedValueOnce(JSON.stringify({ items: [] }));

    const dgsm = createResolverDgsm();
    dgsm._addScene("study", "Study", []);
    dgsm._addNpc("actor1", "Investigator", "study");

    const result = await resolveObjectInteractionState(
      makeObjNode({ action: "Search the desk" }),
      dgsm as any,
      {} as any,
      null,
      "zh"
    );

    expect(result.memory).toBe("Search the desk");
  });

  // ── Error handling ──

  it("should return fallback on LLM failure", async () => {
    const { generateText } = await import("../../../models/index.js");
    (generateText as any).mockRejectedValueOnce(new Error("API error"));

    const dgsm = createResolverDgsm();
    dgsm._addScene("study", "Study", []);
    dgsm._addNpc("actor1", "Investigator", "study");

    const result = await resolveObjectInteractionState(
      makeObjNode({ action: "Pick up the pen" }),
      dgsm as any,
      {} as any,
      null,
      "zh"
    );

    expect(result.items).toEqual([]);
    expect(result.memory).toBe("Pick up the pen");
  });

  it("should return fallback on malformed JSON", async () => {
    const { generateText } = await import("../../../models/index.js");
    (generateText as any).mockResolvedValueOnce("not valid json {{{");

    const dgsm = createResolverDgsm();
    dgsm._addScene("study", "Study", []);
    dgsm._addNpc("actor1", "Investigator", "study");

    const result = await resolveObjectInteractionState(
      makeObjNode(),
      dgsm as any,
      {} as any,
      null,
      "zh"
    );

    expect(result.items).toEqual([]);
    expect(result.memory).toBeDefined();
  });

  // ── Prompt content verification ──

  it("should include scene items, inventory, skill roll and item context in prompt", async () => {
    const { generateText } = await import("../../../models/index.js");
    let capturedPrompt = "";
    let capturedSystem = "";
    (generateText as any).mockImplementationOnce(async (opts: any) => {
      capturedPrompt = opts.context;
      capturedSystem = opts.customSystemPrompt;
      return JSON.stringify({ items: [], memory: "ok" });
    });

    const dgsm = createResolverDgsm();
    const diary = makeItem({
      id: "diary",
      name: "Leather Diary",
      description: "A worn diary.",
    });
    const matchbox = makeItem({ id: "matchbox", name: "Matchbox" });
    dgsm._addScene("study", "Study", [diary]);
    (dgsm.getScene("study") as any).itemContexts = { diary: "摊开在书桌上" };
    dgsm._addNpc("actor1", "Investigator", "study");
    dgsm.addItemToNpc("actor1", matchbox);

    await resolveObjectInteractionState(
      makeObjNode({
        action: "Read the diary carefully",
        skill: "Library Use",
        objectInteractionPayload: { itemId: "diary" },
      }),
      dgsm as any,
      {} as any,
      { successLevel: "critical", detail: "Critical success (roll 01 vs 65)" },
      "zh"
    );

    // Scene item appears in prompt
    expect(capturedPrompt).toContain("Leather Diary");
    expect(capturedPrompt).toContain("worn diary");
    // Item context
    expect(capturedPrompt).toContain("摊开在书桌上");
    // Inventory item
    expect(capturedPrompt).toContain("Matchbox");
    // Skill roll
    expect(capturedPrompt).toContain("critical");
    expect(capturedPrompt).toContain("Critical success");
    // System prompt is in the correct language
    expect(capturedSystem).toContain("zh");
  });

  it("should no longer inject co-present NPCs into the resolver prompt", async () => {
    const { generateText } = await import("../../../models/index.js");
    let capturedPrompt = "";
    (generateText as any).mockImplementationOnce(async (opts: any) => {
      capturedPrompt = opts.context;
      return JSON.stringify({ items: [], memory: "ok" });
    });

    const dgsm = createResolverDgsm();
    dgsm._addScene("study", "Study", [makeItem({ id: "pen", name: "Pen" })]);
    dgsm._addNpc("actor1", "Investigator", "study");
    dgsm._addNpc("npc_visible", "Visible Witness", "study");
    dgsm._addNpc("npc_hidden", "Hidden Witness", "study");
    dgsm._setHidden("npc_hidden", true);

    await resolveObjectInteractionState(
      makeObjNode(),
      dgsm as any,
      {} as any,
      null,
      "en"
    );

    expect(capturedPrompt).not.toContain("Visible Witness");
    expect(capturedPrompt).not.toContain("Hidden Witness");
  });
});
