import { describe, expect, it } from "vitest";
import type { SceneStateDelta } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { DynamicScene, Item } from "../../../state/types.js";
import { applySceneDelta } from "../sceneInteractionStateResolver.js";

// ─── Mock DGSM (aligned with objectInteractionStateResolver tests) ───

function createMockDgsm() {
  const scenes = new Map<string, DynamicScene>();
  const npcInventories: Record<string, Item[]> = {};
  const npcCharacters: Array<{ id: string; name: string }> = [];
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
    getSceneConditions(sceneId: string): Array<{ description: string }> {
      return scenarioConditions[sceneId] ?? [];
    },
    setConnectionBlocked(): void {},
    setConnectionHidden(): void {},

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
  };
}

function makeItem(
  overrides: Partial<Item> & { id: string; name: string }
): Item {
  return { ...overrides };
}

describe("applySceneDelta", () => {
  it("applies damaged tool update while item stays in inventory", () => {
    const dgsm = createMockDgsm();
    const crowbar = makeItem({
      id: "crowbar",
      name: "Crowbar",
      type: "tool",
    } as Item);
    dgsm._addScene("room1", "Shed", []);
    dgsm._addInventory("actor1", [crowbar]);

    const delta: SceneStateDelta = {
      memory: "I pried the window; the bar bent.",
      items: [
        {
          itemId: "crowbar",
          location: "inventory",
          updates: { damaged: true },
        },
      ],
    };

    applySceneDelta(
      dgsm as unknown as DynamicGameStateManager,
      delta,
      "room1",
      "actor1"
    );

    expect(dgsm.getNpcInventory("actor1")).toHaveLength(1);
    expect(dgsm.getNpcInventory("actor1")[0].damaged).toBe(true);
  });

  it("removes consumable destroyed by scene interaction", () => {
    const dgsm = createMockDgsm();
    const matches = makeItem({
      id: "matches",
      name: "Matches",
      consumableStats: { uses: 1 },
    });
    dgsm._addScene("room1", "Kitchen", []);
    dgsm._addInventory("actor1", [matches]);

    const delta: SceneStateDelta = {
      memory: "I lit the fuse; the matches are gone.",
      items: [{ itemId: "matches", location: "destroyed" }],
    };

    applySceneDelta(
      dgsm as unknown as DynamicGameStateManager,
      delta,
      "room1",
      "actor1"
    );

    expect(dgsm.getNpcInventory("actor1")).toHaveLength(0);
  });

  it("moves item from inventory to scene", () => {
    const dgsm = createMockDgsm();
    const flashlight = makeItem({ id: "flashlight", name: "Flashlight" });
    dgsm._addScene("room1", "Hall", []);
    dgsm._addInventory("actor1", [flashlight]);

    const delta: SceneStateDelta = {
      memory: "I dropped the flashlight on the floor.",
      items: [{ itemId: "flashlight", location: "scene" }],
    };

    applySceneDelta(
      dgsm as unknown as DynamicGameStateManager,
      delta,
      "room1",
      "actor1"
    );

    expect(dgsm.getNpcInventory("actor1")).toHaveLength(0);
    const room = dgsm.getScene("room1");
    expect(room?.items).toHaveLength(1);
    expect(room?.items?.[0].id).toBe("flashlight");
  });
});
