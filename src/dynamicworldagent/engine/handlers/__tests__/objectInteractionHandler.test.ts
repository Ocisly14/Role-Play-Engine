import { beforeEach, describe, expect, it } from "vitest";
import type { PlanNode } from "../../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicScene, Item } from "../../../state/types.js";
import type { ExecutionContext } from "../../types.js";
import { objectInteractionHandler } from "../objectInteractionHandler.js";

// ===== Mock DGSM =====

function createMockDgsm() {
  const scenes: Record<string, DynamicScene> = {};
  const npcInventories: Record<string, Item[]> = {};
  const characterPositions: Record<string, any> = {};
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
    getCharacterPosition(characterId: string) {
      return characterPositions[characterId] ?? null;
    },
    resolveLocationId(position: any) {
      if (position.type === "scene") return position.sceneId;
      if (position.type === "junction") return position.junctionId;
      return position.roadId;
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
      characterPositions[npcId] = { type: "scene", sceneId: location };
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
    startTime: "10:00",
    endTime: "10:05",
    action: "interact with object",
    location: "study",
    type: "object_interaction",
    impact: 1 as const,
    status: "pending" as const,
    executionMeta: { remainingMinutes: 5 },
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

  // ── Basic validation ──

  describe("basic validation", () => {
    it("has correct type and required fields", () => {
      expect(objectInteractionHandler.type).toBe("object_interaction");
      expect(objectInteractionHandler.requiredFields).toContain("action");
    });

    it("succeeds when item is in scene", () => {
      const torch: Item = { id: "torch", name: "Torch" };
      dgsm._addScene("study", [torch]);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { itemId: "torch" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
    });

    it("succeeds when item is in NPC inventory", () => {
      const key: Item = { id: "room_key", name: "Room Key", type: "key" };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", key);

      const node = makeNode({
        objectInteractionPayload: { itemId: "room_key" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
    });

    it("succeeds when item is inside a scene container", () => {
      const coin: Item = { id: "gold_coin", name: "Gold Coin" };
      const box: Item = {
        id: "box",
        name: "Box",
        type: "container",
        containerStats: {
          capacity: 5,
          locked: false,
          contents: ["gold_coin"],
          storedItems: [coin],
        },
      };
      dgsm._addScene("study", [box]);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { itemId: "gold_coin" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
    });

    it("succeeds when item is inside an inventory container", () => {
      const coin: Item = { id: "gold_coin", name: "Gold Coin" };
      const pouch: Item = {
        id: "pouch",
        name: "Pouch",
        type: "container",
        containerStats: {
          capacity: 5,
          locked: false,
          contents: ["gold_coin"],
          storedItems: [coin],
        },
      };
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");
      dgsm.addItemToNpc("player-1", pouch);

      const node = makeNode({
        objectInteractionPayload: { itemId: "gold_coin" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
    });

    it("succeeds without payload (no item pre-check)", () => {
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");

      const node = makeNode();

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
    });

    it("uses node.action as outcome", () => {
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({ action: "Search the desk drawers" });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.outcome).toBe("Search the desk drawers");
    });
  });

  // ── Item not found ──

  describe("item not found", () => {
    it("fails when itemId not found in scene or inventory", () => {
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { itemId: "missing_item" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("object_not_found");
    });

    it("includes item name in failure outcome", () => {
      dgsm._addScene("study", []);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { itemId: "ghost_item" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("failed");
      expect(result.outcome).toContain("ghost_item");
    });
  });

  // ── Skill roll ──

  describe("skill roll", () => {
    it("succeeds when skill roll passes", () => {
      const safe: Item = {
        id: "safe",
        name: "Safe",
        type: "container",
        containerStats: { capacity: 10, locked: true, contents: [] },
      };
      dgsm._addScene("study", [safe]);
      dgsm._addNpc("player-1", "study", { Locksmith: 60 });

      const node = makeNode({
        skill: "Locksmith",
        objectInteractionPayload: { itemId: "safe" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(result.successLevel).toBe("regular");
    });

    it("fails when skill roll fails", () => {
      const failCtx = {
        ...ctx,
        resolveSkillRoll: () => ({
          failed: true,
          reason: "Fumble",
          successLevel: "fumble" as const,
        }),
      } as unknown as ExecutionContext;

      const safe: Item = {
        id: "safe",
        name: "Safe",
        type: "container",
        containerStats: { capacity: 10, locked: true, contents: [] },
      };
      dgsm._addScene("study", [safe]);
      dgsm._addNpc("player-1", "study", { Locksmith: 20 });

      const node = makeNode({
        skill: "Locksmith",
        objectInteractionPayload: { itemId: "safe" },
      });

      const result = objectInteractionHandler.execute(
        node,
        dgsm as any,
        failCtx
      );
      expect(result.status).toBe("failed");
      expect(result.failureReason).toBe("skill_roll_failed");
      expect(result.successLevel).toBe("fumble");
    });

    it("does not require skill — auto-succeeds without one", () => {
      const book: Item = { id: "book", name: "Book" };
      dgsm._addScene("study", [book]);
      dgsm._addNpc("player-1", "study");

      const node = makeNode({
        objectInteractionPayload: { itemId: "book" },
      });

      const result = objectInteractionHandler.execute(node, dgsm as any, ctx);
      expect(result.status).toBe("completed");
      expect(result.successLevel).toBeUndefined();
    });
  });

  // ── rollDetail ──

  describe("rollDetail", () => {
    it("includes rollDetail on success with skill", () => {
      const book: Item = { id: "book", name: "Book" };
      dgsm._addScene("study", [book]);
      dgsm._addNpc("player-1", "study", { Perception: 60 });

      const customCtx = {
        ...ctx,
        resolveSkillRoll: () => ({
          failed: false,
          detail: "Hard success (roll 22 vs 30)",
          successLevel: "hard" as const,
        }),
      } as unknown as ExecutionContext;

      const node = makeNode({
        skill: "Perception",
        objectInteractionPayload: { itemId: "book" },
      });

      const result = objectInteractionHandler.execute(
        node,
        dgsm as any,
        customCtx
      );
      expect(result.status).toBe("completed");
      expect((result as any).rollDetail).toBe("Hard success (roll 22 vs 30)");
    });
  });
});
