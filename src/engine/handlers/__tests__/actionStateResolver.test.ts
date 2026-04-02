import { describe, expect, it } from "vitest";
import type { SceneStateDelta } from "../../../planning/types.js";
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { TownTopology } from "../../../state/topologyTypes.js";
import type { DynamicScene, Item } from "../../../state/types.js";
import {
  applyActionSceneDelta,
  collectActionMoveCandidates,
} from "../actionStateResolver.js";

// ─── Mock DGSM (aligned with objectInteractionStateResolver tests) ───

function createMockDgsm() {
  const scenes = new Map<string, DynamicScene>();
  const npcInventories: Record<string, Item[]> = {};
  const npcCharacters: Array<{ id: string; name: string }> = [];
  const scenarioConditions: Record<string, Array<{ description: string }>> = {};
  const topology: TownTopology = {
    junctions: new Map(),
    roads: new Map(),
    junctionToRoads: new Map(),
    sceneToParent: new Map(),
  };
  const setConnectionHiddenCalls: Array<{
    sceneId: string;
    targetId: string;
    hidden: boolean;
  }> = [];

  return {
    getState() {
      return {
        npcCharacters,
        npcInventories,
        scenarioConditions,
        scenes,
        scenarioOutlines: [],
      };
    },
    getScene(sceneId: string): DynamicScene | null {
      return scenes.get(sceneId) ?? null;
    },
    getTopology(): TownTopology {
      return topology;
    },
    getJunction(junctionId: string) {
      return topology.junctions.get(junctionId) ?? null;
    },
    getRoad(roadId: string) {
      return topology.roads.get(roadId) ?? null;
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
    setConnectionHiddenCalls,
    setConnectionHidden(
      sceneId: string,
      targetId: string,
      hidden: boolean
    ): void {
      setConnectionHiddenCalls.push({ sceneId, targetId, hidden });
    },

    _addScene(
      id: string,
      name: string,
      items: Item[],
      parentLocationId = "PARENT"
    ): void {
      scenes.set(id, {
        id,
        name,
        description: "",
        parentLocationId,
        items,
        conditions: [],
        connections: [],
      });
    },
    _connectSceneToJunction(
      sceneId: string,
      junctionId: string,
      junctionName = junctionId
    ): void {
      topology.sceneToParent.set(sceneId, {
        type: "junction",
        junctionId,
      });
      if (!topology.junctions.has(junctionId)) {
        topology.junctions.set(junctionId, {
          id: junctionId,
          name: junctionName,
          description: "",
          parentLocationId: "OUTDOOR",
          items: [],
          conditions: [],
          connectedSceneIds: [sceneId],
        });
        topology.junctionToRoads.set(junctionId, []);
      } else {
        const junction = topology.junctions.get(junctionId)!;
        if (!junction.connectedSceneIds.includes(sceneId)) {
          junction.connectedSceneIds.push(sceneId);
        }
      }
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

describe("applyActionSceneDelta", () => {
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

    applyActionSceneDelta(
      dgsm as unknown as DynamicGameStateManager,
      delta,
      "room1",
      "actor1"
    );

    expect(dgsm.getNpcInventory("actor1")).toHaveLength(1);
    expect(dgsm.getNpcInventory("actor1")[0].damaged).toBe(true);
  });

  it("removes consumable destroyed by a current-location action", () => {
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

    applyActionSceneDelta(
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

    applyActionSceneDelta(
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

  it("tracks hidden connection reveals without mutating global hidden state", () => {
    const dgsm = createMockDgsm();
    dgsm._addScene("room1", "Hall", []);

    const delta: SceneStateDelta = {
      memory: "I found a hidden latch behind the shelf.",
      connectionEffects: [{ targetId: "secret_stairs", action: "reveal" }],
    };

    const result = applyActionSceneDelta(
      dgsm as unknown as DynamicGameStateManager,
      delta,
      "room1",
      "actor1"
    );

    expect(result.revealedHiddenConnections).toEqual([
      { sceneId: "room1", targetId: "secret_stairs" },
    ]);
    expect(dgsm.setConnectionHiddenCalls).toEqual([]);
  });
});

describe("collectActionMoveCandidates", () => {
  it("includes sibling scenes and topology locations reachable within 2 minutes", () => {
    const dgsm = createMockDgsm();
    dgsm._addScene("study", "Study", [], "MANOR");
    dgsm._addScene("bedroom", "Bedroom", [], "MANOR");
    dgsm._addScene("courtyard", "Courtyard", [], "OUTDOOR");
    dgsm._connectSceneToJunction("study", "JUNC_1", "Front Junction");
    dgsm._connectSceneToJunction("courtyard", "JUNC_1", "Front Junction");

    const candidates = collectActionMoveCandidates(
      "study",
      dgsm as unknown as DynamicGameStateManager
    );
    const candidateIds = candidates.map((candidate) => candidate.id);

    expect(candidateIds).toContain("bedroom");
    expect(candidateIds).toContain("JUNC_1");
    expect(candidateIds).toContain("courtyard");
  });
});
