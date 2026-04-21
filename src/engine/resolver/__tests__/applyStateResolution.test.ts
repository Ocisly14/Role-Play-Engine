import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { OutputSchemaConfig } from "../../types.js";
import { applyStateResolution } from "../applyStateResolution.js";

// ─── Minimal mock of DynamicGameStateManager ──────────────────────────────────

function makeMockDgsm(
  overrides: Partial<DynamicGameStateManager> = {}
): DynamicGameStateManager {
  // Shared mutable state
  const npcCharacters: any[] = [
    {
      id: "npc_1",
      name: "Alice",
      status: {
        hp: 10,
        san: 60,
        conditions: [] as Array<{ id: string; description: string }>,
      },
    },
  ];
  const npcStats: Record<string, { hp: number; san: number }> = {
    npc_1: { hp: 10, san: 60 },
  };
  const npcInventories: Record<string, any[]> = {
    npc_1: [{ id: "lantern", name: "Lantern", type: "other" }],
  };
  const scenes: Map<string, any> = new Map([
    [
      "scene_study",
      {
        id: "scene_study",
        name: "Study",
        items: [{ id: "book", name: "Old Book", type: "other" }],
      },
    ],
  ]);
  const scenarioConditions: Record<string, any[]> = {};
  const characterPositions: Record<string, any> = {};

  const state: any = {
    npcCharacters,
    npcStats,
    npcInventories,
    scenes,
    scenarioConditions,
    characterPositions,
  };

  const dgsm: Partial<DynamicGameStateManager> = {
    getState: () => state,

    updateNpcHp: vi.fn((npcId: string, delta: number) => {
      if (npcStats[npcId]) {
        npcStats[npcId].hp = Math.max(0, npcStats[npcId].hp + delta);
        const npc = npcCharacters.find((n) => n.id === npcId);
        if (npc) npc.status.hp = npcStats[npcId].hp;
      }
    }),

    updateNpcSan: vi.fn((npcId: string, delta: number) => {
      if (npcStats[npcId]) {
        npcStats[npcId].san = Math.max(0, npcStats[npcId].san + delta);
        const npc = npcCharacters.find((n) => n.id === npcId);
        if (npc) npc.status.san = npcStats[npcId].san;
      }
    }),

    setCharacterPosition: vi.fn((characterId: string, position: any) => {
      characterPositions[characterId] = position;
    }),

    getSceneConditions: vi.fn((scenarioId: string) => {
      return scenarioConditions[scenarioId] ?? [];
    }),

    replaceSceneConditions: vi.fn((scenarioId: string, conditions: any[]) => {
      scenarioConditions[scenarioId] = conditions;
    }),

    appendSceneCondition: vi.fn((scenarioId: string, condition: any) => {
      if (!scenarioConditions[scenarioId]) scenarioConditions[scenarioId] = [];
      scenarioConditions[scenarioId].push(condition);
    }),

    getNpcInventory: vi.fn((npcId: string) => {
      return npcInventories[npcId] ?? [];
    }),

    addItemToNpc: vi.fn((npcId: string, item: any) => {
      if (!npcInventories[npcId]) npcInventories[npcId] = [];
      npcInventories[npcId].push(item);
    }),

    removeItemFromNpc: vi.fn((npcId: string, itemId: string) => {
      if (!npcInventories[npcId]) return undefined;
      const idx = npcInventories[npcId].findIndex((i: any) => i.id === itemId);
      if (idx === -1) return undefined;
      return npcInventories[npcId].splice(idx, 1)[0];
    }),

    getScene: vi.fn((sceneId: string) => {
      return scenes.get(sceneId) ?? null;
    }),

    ...overrides,
  };

  return dgsm as DynamicGameStateManager;
}

// ─── Tests: applyStateResolution ─────────────────────────────────────────────

describe("applyStateResolution", () => {
  describe("character.hp", () => {
    it("applies character.hp delta to a character", () => {
      const dgsm = makeMockDgsm();

      applyStateResolution(
        dgsm,
        { "character.hp": [{ characterId: "npc_1", delta: -3 }] },
        { use: ["character.hp"] }
      );

      expect(dgsm.updateNpcHp).toHaveBeenCalledWith("npc_1", -3);
    });

    it("skips hp update when delta is 0", () => {
      const dgsm = makeMockDgsm();

      applyStateResolution(
        dgsm,
        { "character.hp": [{ characterId: "npc_1", delta: 0 }] },
        { use: ["character.hp"] }
      );

      expect(dgsm.updateNpcHp).not.toHaveBeenCalled();
    });
  });

  describe("character.san", () => {
    it("applies character.san delta to a character", () => {
      const dgsm = makeMockDgsm();

      applyStateResolution(
        dgsm,
        { "character.san": [{ characterId: "npc_1", delta: -5 }] },
        { use: ["character.san"] }
      );

      expect(dgsm.updateNpcSan).toHaveBeenCalledWith("npc_1", -5);
    });
  });

  describe("character.condition", () => {
    it("adds conditions to a character", () => {
      const dgsm = makeMockDgsm();

      applyStateResolution(
        dgsm,
        {
          "character.condition": [
            { characterId: "npc_1", add: ["bleeding"], remove: [] },
          ],
        },
        { use: ["character.condition"] }
      );

      const state = dgsm.getState();
      const npc = state.npcCharacters.find((n: any) => n.id === "npc_1");
      expect(
        npc?.status.conditions.some(
          (c: { description: string }) => c.description === "bleeding"
        )
      ).toBe(true);
    });

    it("removes conditions from a character", () => {
      const dgsm = makeMockDgsm();
      // Pre-seed a condition
      const state = dgsm.getState();
      const npc = state.npcCharacters.find((n: any) => n.id === "npc_1");
      npc?.status.conditions.push({
        id: "cond-frightened",
        description: "frightened",
      });

      applyStateResolution(
        dgsm,
        {
          "character.condition": [
            { characterId: "npc_1", add: [], remove: ["frightened"] },
          ],
        },
        { use: ["character.condition"] }
      );

      expect(
        npc?.status.conditions.some(
          (c: { description: string }) => c.description === "frightened"
        )
      ).toBe(false);
    });
  });

  describe("character.position", () => {
    it("sets character position", () => {
      const dgsm = makeMockDgsm();

      applyStateResolution(
        dgsm,
        {
          "character.position": [
            { characterId: "npc_1", sceneId: "scene_hall" },
          ],
        },
        { use: ["character.position"] }
      );

      expect(dgsm.setCharacterPosition).toHaveBeenCalledWith("npc_1", {
        type: "scene",
        sceneId: "scene_hall",
      });
    });
  });

  describe("scene.condition", () => {
    it("adds a condition to a scene", () => {
      const dgsm = makeMockDgsm();

      applyStateResolution(
        dgsm,
        {
          "scene.condition": [
            { sceneId: "scene_study", add: ["door is barricaded"], remove: [] },
          ],
        },
        { use: ["scene.condition"] }
      );

      expect(dgsm.appendSceneCondition).toHaveBeenCalledWith("scene_study", {
        description: "door is barricaded",
      });
    });
  });

  describe("item.move", () => {
    it("moves an item from NPC inventory to a scene", () => {
      const dgsm = makeMockDgsm();

      applyStateResolution(
        dgsm,
        {
          "item.move": [
            {
              itemId: "lantern",
              from: "npc_1",
              to: "scene:scene_study",
            },
          ],
        },
        { use: ["item.move"] }
      );

      expect(dgsm.removeItemFromNpc).toHaveBeenCalledWith("npc_1", "lantern");
      expect(dgsm.getScene).toHaveBeenCalledWith("scene_study");
    });
  });

  describe("item.destroy", () => {
    it("destroys an item from a scene", () => {
      const dgsm = makeMockDgsm();

      applyStateResolution(
        dgsm,
        {
          "item.destroy": [{ itemId: "book", from: "scene_study" }],
        },
        { use: ["item.destroy"] }
      );

      expect(dgsm.getScene).toHaveBeenCalledWith("scene_study");
      const scene = dgsm.getScene("scene_study");
      expect(scene?.items?.find((i: any) => i.id === "book")).toBeUndefined();
    });
  });

  describe("item.modify", () => {
    it("modifies item properties", () => {
      const dgsm = makeMockDgsm();

      applyStateResolution(
        dgsm,
        {
          "item.modify": [{ itemId: "lantern", properties: { damaged: true } }],
        },
        { use: ["item.modify"] }
      );

      const inv = dgsm.getNpcInventory("npc_1");
      const lantern = inv.find((i: any) => i.id === "lantern");
      expect((lantern as any)?.damaged).toBe(true);
    });
  });

  describe("empty resolution", () => {
    it("does nothing when resolution has no changes", () => {
      const dgsm = makeMockDgsm();
      const config: OutputSchemaConfig = {
        use: [
          "character.hp",
          "character.san",
          "scene.condition",
          "character.position",
        ],
      };

      applyStateResolution(dgsm, {}, config);

      expect(dgsm.updateNpcHp).not.toHaveBeenCalled();
      expect(dgsm.updateNpcSan).not.toHaveBeenCalled();
      expect(dgsm.appendSceneCondition).not.toHaveBeenCalled();
      expect(dgsm.setCharacterPosition).not.toHaveBeenCalled();
    });
  });
});
