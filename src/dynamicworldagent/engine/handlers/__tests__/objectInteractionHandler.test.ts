import { beforeEach, describe, expect, it } from "vitest";
import type { PlanNode } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicScene, Item } from "../../../state/types.js";
import type { ExecutionContext } from "../../types.js";
import { objectInteractionHandler } from "../objectInteractionHandler.js";

// ===== Mock DGSM =====

function createMockDgsm() {
  const scenes: Record<string, DynamicScene> = {};
  const npcInventories: Record<string, Item[]> = {};
  const npcLocations: Record<string, string> = {};
  const npcCharacters: Array<{
    id: string;
    skills: Record<string, number>;
    status: { luck: number };
  }> = [];

  return {
    getState() {
      return { npcCharacters, npcInventories };
    },
    getScene(sceneId: string) {
      return scenes[sceneId] ?? null;
    },
    getNpcLocation(npcId: string) {
      return npcLocations[npcId] ?? null;
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
    _addScene(
      id: string,
      items: Item[] = [],
      itemContexts: Record<string, string> = {}
    ) {
      scenes[id] = {
        id,
        name: id,
        items,
        itemContexts,
        connections: [],
      } as unknown as DynamicScene;
    },
    _addNpc(
      npcId: string,
      location: string,
      skills: Record<string, number> = {},
      luck = 50
    ) {
      npcLocations[npcId] = location;
      npcCharacters.push({ id: npcId, skills, status: { luck } });
    },
    _scenes: scenes,
    _npcInventories: npcInventories,
  };
}

function createMockCtx(): ExecutionContext {
  return {
    getNodeDifficulty: () => "regular" as const,
    getScenePenalties: () => new Map<string, number>(),
    getCharacterPenalties: () => new Map<string, number>(),
    applyPenalties: (
      skills: Record<string, number>,
      _penalties: Map<string, number>
    ) => skills,
    luckFailureRate: () => 0,
    resolveSkillRoll: () => ({
      failed: false,
      detail: "Regular success",
      successLevel: "regular" as const,
    }),
  } as unknown as ExecutionContext;
}

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "oi1",
    characterId: "player-1",
    characterName: "Investigator",
    gameTime: "10:00",
    action: "interact with object",
    location: "study",
    type: "object_interaction",
    impact: 1 as const,
    timeAdvanceMinutes: 5,
    status: "pending" as const,
    ...overrides,
  } as PlanNode;
}

describe("objectInteractionHandler", () => {
  let dgsm: ReturnType<typeof createMockDgsm>;
  let ctx: ExecutionContext;

  beforeEach(() => {
    dgsm = createMockDgsm();
    ctx = createMockCtx();
  });

  // ── Pickup ──

  describe("pickup", () => {
    it("transfers full Item from scene to NPC inventory", () => {
      const torch: Item = {
        id: "torch",
        name: "Torch",
        type: "lighting",
        isLightSource: true,
        lightLevel: 3,
      };
      dgsm._addScene("study", [torch]);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "pickup", itemId: "torch" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._scenes["study"].items).toHaveLength(0);
      expect(dgsm._npcInventories["player-1"]).toHaveLength(1);
      expect(dgsm._npcInventories["player-1"][0]).toEqual(torch);
    });

    it("fails when item not found in scene", () => {
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "pickup", itemId: "missing_item" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("object_not_found");
    });
  });

  // ── Place ──

  describe("place", () => {
    it("transfers full Item from NPC inventory to scene", () => {
      const key: Item = { id: "room_key", name: "Room Key", type: "key" };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", key);

      const node = makeNode({
        objectInteractionPayload: { action: "place", itemId: "room_key" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._npcInventories["player-1"]).toHaveLength(0);
      expect(dgsm._scenes["study"].items).toHaveLength(1);
      expect(dgsm._scenes["study"].items[0]).toEqual(key);
    });

    it("fails when item not in inventory", () => {
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "place", itemId: "missing_item" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("object_not_found");
    });
  });

  // ── Use (normal) ──

  describe("use — normal (no actionType)", () => {
    it("decrements consumable uses and removes when exhausted", () => {
      const medkit: Item = {
        id: "medkit",
        name: "First Aid Kit",
        type: "consumable",
        consumableStats: { uses: 1, effect: "heals minor wounds" },
      };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", medkit);

      const node = makeNode({
        objectInteractionPayload: { action: "use", itemId: "medkit" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._npcInventories["player-1"]).toHaveLength(0);
    });

    it("decrements consumable uses but keeps item when uses remain", () => {
      const bandage: Item = {
        id: "bandage",
        name: "Bandage Roll",
        type: "consumable",
        consumableStats: { uses: 3, effect: "stops bleeding" },
      };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", bandage);

      const node = makeNode({
        objectInteractionPayload: { action: "use", itemId: "bandage" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._npcInventories["player-1"]).toHaveLength(1);
      expect(dgsm._npcInventories["player-1"][0].consumableStats!.uses).toBe(2);
    });

    it("toggles lighting isLightSource", () => {
      const flashlight: Item = {
        id: "flashlight",
        name: "Flashlight",
        type: "lighting",
        isLightSource: false,
        lightLevel: 3,
      };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", flashlight);

      const node = makeNode({
        objectInteractionPayload: { action: "use", itemId: "flashlight" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._npcInventories["player-1"][0].isLightSource).toBe(true);
    });

    it("unlocks target container with key", () => {
      const key: Item = { id: "room_key", name: "Room Key", type: "key" };
      const safe: Item = {
        id: "safe",
        name: "Safe",
        type: "container",
        containerStats: {
          capacity: 10,
          locked: true,
          lockDifficulty: "hard",
          contents: [],
        },
      };
      dgsm._addScene("study", [safe]);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", key);

      const node = makeNode({
        objectInteractionPayload: {
          action: "use",
          itemId: "room_key",
          targetItemId: "safe",
        },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._scenes["study"].items[0].containerStats!.locked).toBe(false);
    });

    it("fails when key used without targetItemId", () => {
      const key: Item = { id: "room_key", name: "Room Key", type: "key" };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", key);

      const node = makeNode({
        objectInteractionPayload: { action: "use", itemId: "room_key" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("object_not_found");
    });

    it("opens unlocked container", () => {
      const box: Item = {
        id: "box",
        name: "Box",
        type: "container",
        containerStats: { capacity: 5, locked: false, contents: [] },
      };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", box);

      const node = makeNode({
        objectInteractionPayload: { action: "use", itemId: "box" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
    });

    it("document use is a no-op success", () => {
      const diary: Item = {
        id: "diary",
        name: "Diary",
        type: "document",
        description: "A worn diary.",
      };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", diary);

      const node = makeNode({
        objectInteractionPayload: { action: "use", itemId: "diary" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
    });
  });

  // ── Use (non-normal) ──

  describe("use — non-normal (has actionType)", () => {
    it("applies itemUpdates and targetItemUpdates on success", () => {
      const acid: Item = {
        id: "acid",
        name: "Acid",
        type: "consumable",
        consumableStats: { uses: 1, effect: "corrosive" },
      };
      const lock: Item = {
        id: "padlock",
        name: "Padlock",
        type: "container",
        containerStats: {
          capacity: 0,
          locked: true,
          lockDifficulty: "hard",
          contents: [],
        },
      };
      dgsm._addScene("study", [lock]);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", acid);

      const node = makeNode({
        actionType: "exploration",
        objectInteractionPayload: {
          action: "use",
          itemId: "acid",
          targetItemId: "padlock",
          itemUpdates: { consumableStats: { uses: 0, effect: "corrosive" } },
          targetItemUpdates: {
            containerStats: { locked: false },
            damaged: true,
          },
        },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._scenes["study"].items[0].containerStats!.locked).toBe(false);
      expect(dgsm._scenes["study"].items[0].damaged).toBe(true);
      expect(dgsm._npcInventories["player-1"]).toHaveLength(0);
    });

    it("does not apply updates on skill check failure", () => {
      const failCtx = {
        ...ctx,
        resolveSkillRoll: () => ({
          failed: true,
          reason: "Fumble",
          successLevel: "fumble" as const,
        }),
      } as unknown as ExecutionContext;

      const lockpick: Item = { id: "lockpick", name: "Lockpick", type: "tool" };
      const safe: Item = {
        id: "safe",
        name: "Safe",
        type: "container",
        containerStats: {
          capacity: 10,
          locked: true,
          lockDifficulty: "hard",
          contents: [],
        },
      };
      dgsm._addScene("study", [safe]);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", lockpick);

      const node = makeNode({
        actionType: "stealth",
        objectInteractionPayload: {
          action: "use",
          itemId: "lockpick",
          targetItemId: "safe",
          targetItemUpdates: { containerStats: { locked: false } },
        },
      });

      const result = objectInteractionHandler.execute(
        node,
        dgsm as any,
        failCtx
      );
      expect(result.status).toBe("failed");
      expect(dgsm._scenes["study"].items[0].containerStats!.locked).toBe(true);
    });
  });

  // ── Inspect ──

  describe("inspect", () => {
    it("returns item details in outcome string", () => {
      const diary: Item = {
        id: "diary",
        name: "Diary",
        type: "document",
        description: "A worn leather diary with cryptic entries.",
      };
      dgsm._addScene("study", [diary], {
        diary: "摊开在书桌上，页边压着一支掉漆的钢笔。",
      });
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "inspect", itemId: "diary" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(result.outcome).toContain("Diary");
      expect(result.outcome).toContain("A worn leather diary");
      expect(result.outcome).toContain("摊开在书桌上");
    });

    it("includes container contents when unlocked", () => {
      const box: Item = {
        id: "box",
        name: "Box",
        type: "container",
        containerStats: {
          capacity: 5,
          locked: false,
          contents: ["gold_coin", "silver_ring"],
        },
      };
      dgsm._addScene("study", [box]);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "inspect", itemId: "box" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(result.outcome).toContain("gold_coin");
      expect(result.outcome).toContain("silver_ring");
    });

    it("shows locked status for locked container", () => {
      const safe: Item = {
        id: "safe",
        name: "Safe",
        type: "container",
        containerStats: {
          capacity: 10,
          locked: true,
          lockDifficulty: "hard",
          contents: ["secret_doc"],
        },
      };
      dgsm._addScene("study", [safe]);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "inspect", itemId: "safe" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(result.outcome).toContain("locked");
      expect(result.outcome).not.toContain("secret_doc");
    });

    it("works for items in NPC inventory", () => {
      const compass: Item = {
        id: "compass",
        name: "Compass",
        type: "tool",
        description: "A brass compass.",
      };
      dgsm._addScene("study", [], {
        compass: "原本挂在墙上的木钉上。",
      });
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", compass);

      const node = makeNode({
        objectInteractionPayload: { action: "inspect", itemId: "compass" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(result.outcome).toContain("Compass");
      expect(result.outcome).toContain("A brass compass");
      expect(result.outcome).not.toContain("木钉");
    });
  });

  // ── Destroy ──

  describe("destroy", () => {
    it("removes item from scene and logs event with item name", () => {
      const vase: Item = { id: "vase", name: "Ming Vase", type: "other" };
      dgsm._addScene("study", [vase]);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "destroy", itemId: "vase" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._scenes["study"].items).toHaveLength(0);
    });

    it("removes item from inventory when not in scene", () => {
      const note: Item = { id: "note", name: "Note", type: "document" };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", note);

      const node = makeNode({
        objectInteractionPayload: { action: "destroy", itemId: "note" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(dgsm._npcInventories["player-1"]).toHaveLength(0);
    });

    it("fails when item not found anywhere", () => {
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { action: "destroy", itemId: "ghost_item" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("object_not_found");
    });
  });

  // ── Location check ──

  describe("location check", () => {
    it("fails when NPC is not at expected location", () => {
      dgsm._addScene("study", [{ id: "book", name: "Book" }]);
      dgsm._addNpc("player-1", "kitchen");

      const node = makeNode({
        location: "study",
        objectInteractionPayload: { action: "pickup", itemId: "book" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("location_mismatch");
    });
  });
});
