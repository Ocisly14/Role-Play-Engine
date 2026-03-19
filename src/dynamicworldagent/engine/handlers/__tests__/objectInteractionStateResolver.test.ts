import { describe, expect, it } from "vitest";
import { applyObjectDelta } from "../objectInteractionStateResolver.js";
import type { ObjectStateDelta } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { Item, DynamicScene } from "../../../state/types.js";

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
      condition: { description: string },
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

function makeItem(overrides: Partial<Item> & { id: string; name: string }): Item {
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
    expect(dgsm.getScene("room1")!.items.find((i) => i.id === "coin")).toBeUndefined();
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

    const updatedSafe = dgsm.getScene("room1")!.items.find((i) => i.id === "safe")!;
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
      applyObjectDelta(dgsm as any, "actor1", delta, "room1"),
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
    expect(dgsm.getNpcInventory("actor1").find((i) => i.id === "jewel")).toBeTruthy();
  });

  it("container lock guard blocks access when actor lacks key", () => {
    const dgsm = createMockDgsm();
    const diary = makeItem({ id: "diary", name: "Secret Diary" });
    const locker = makeItem({
      id: "locker",
      name: "Metal Locker",
      type: "container",
      containerStats: { locked: true, storedItems: [diary] },
    });
    dgsm._addScene("room1", "Changing Room", [locker]);
    dgsm._addInventory("actor1", []); // no key

    const delta: ObjectStateDelta = {
      items: [{ itemId: "diary", location: "inventory" }],
      memory: "I tried to grab the diary from the locker.",
    };

    applyObjectDelta(dgsm as any, "actor1", delta, "room1");

    // Item stays in the locked container
    expect(locker.containerStats!.storedItems).toHaveLength(1);
    expect(locker.containerStats!.storedItems![0].id).toBe("diary");
    expect(dgsm.getNpcInventory("actor1")).toHaveLength(0);
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
    expect(dgsm.getNpcInventory("actor1").find((i) => i.id === "diary")).toBeTruthy();
  });
});
