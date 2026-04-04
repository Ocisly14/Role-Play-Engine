import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { StateResolution } from "../../types.js";
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
      status: { hp: 10, sanity: 60, conditions: [] as string[] },
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
        if (npc) npc.status.sanity = npcStats[npcId].san;
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
  describe("character changes", () => {
    it("applies HP delta to a character", () => {
      const dgsm = makeMockDgsm();
      const resolution: StateResolution = {
        characterChanges: [{ characterId: "npc_1", hp: -3 }],
        narrative: "Alice was wounded.",
      };

      applyStateResolution(dgsm, resolution);

      expect(dgsm.updateNpcHp).toHaveBeenCalledWith("npc_1", -3);
    });

    it("applies SAN delta to a character", () => {
      const dgsm = makeMockDgsm();
      const resolution: StateResolution = {
        characterChanges: [{ characterId: "npc_1", san: -5 }],
        narrative: "Alice witnessed something terrible.",
      };

      applyStateResolution(dgsm, resolution);

      expect(dgsm.updateNpcSan).toHaveBeenCalledWith("npc_1", -5);
    });

    it("adds conditions to a character", () => {
      const dgsm = makeMockDgsm();
      const resolution: StateResolution = {
        characterChanges: [
          { characterId: "npc_1", addConditions: ["bleeding"] },
        ],
        narrative: "Alice started bleeding.",
      };

      applyStateResolution(dgsm, resolution);

      const state = dgsm.getState();
      const npc = state.npcCharacters.find((n: any) => n.id === "npc_1");
      expect(npc?.status.conditions).toContain("bleeding");
    });

    it("removes conditions from a character", () => {
      // Start with a condition
      const dgsm = makeMockDgsm();
      const state = dgsm.getState();
      const npc = state.npcCharacters.find((n: any) => n.id === "npc_1");
      npc?.status.conditions.push("frightened");

      const resolution: StateResolution = {
        characterChanges: [
          { characterId: "npc_1", removeConditions: ["frightened"] },
        ],
        narrative: "Alice calmed down.",
      };

      applyStateResolution(dgsm, resolution);

      expect(npc?.status.conditions).not.toContain("frightened");
    });

    it("sets character position", () => {
      const dgsm = makeMockDgsm();
      const newPos = { type: "scene" as const, sceneId: "scene_hall" };
      const resolution: StateResolution = {
        characterChanges: [{ characterId: "npc_1", position: newPos }],
        narrative: "Alice moved to the hall.",
      };

      applyStateResolution(dgsm, resolution);

      expect(dgsm.setCharacterPosition).toHaveBeenCalledWith("npc_1", newPos);
    });

    it("skips HP update when hp is 0 (no change)", () => {
      const dgsm = makeMockDgsm();
      const resolution: StateResolution = {
        characterChanges: [{ characterId: "npc_1", hp: 0 }],
        narrative: "No damage.",
      };

      applyStateResolution(dgsm, resolution);

      expect(dgsm.updateNpcHp).not.toHaveBeenCalled();
    });
  });

  describe("scene changes", () => {
    it("adds a condition to a scene", () => {
      const dgsm = makeMockDgsm();
      const resolution: StateResolution = {
        sceneChanges: [
          {
            sceneId: "scene_study",
            addConditions: ["door is barricaded"],
          },
        ],
        narrative: "The door was barricaded.",
      };

      applyStateResolution(dgsm, resolution);

      expect(dgsm.appendSceneCondition).toHaveBeenCalledWith("scene_study", {
        description: "door is barricaded",
      });
    });

    it("removes a condition from a scene", () => {
      const dgsm = makeMockDgsm();
      // Pre-seed a condition
      (dgsm.appendSceneCondition as ReturnType<typeof vi.fn>).mockClear();
      // Manually push a condition into the backing store
      const state = dgsm.getState();
      state.scenarioConditions.scene_study = [
        { description: "smoke fills the room" },
      ];
      // Override getSceneConditions to use backing store
      (dgsm.getSceneConditions as ReturnType<typeof vi.fn>).mockImplementation(
        // biome-ignore lint/suspicious/noExplicitAny: test mock uses dynamic key access
        (id: string) => (state.scenarioConditions as any)[id] ?? []
      );

      const resolution: StateResolution = {
        sceneChanges: [
          {
            sceneId: "scene_study",
            removeConditions: ["smoke fills the room"],
          },
        ],
        narrative: "Smoke cleared.",
      };

      applyStateResolution(dgsm, resolution);

      expect(dgsm.replaceSceneConditions).toHaveBeenCalledWith(
        "scene_study",
        []
      );
    });
  });

  describe("item changes", () => {
    it("moves an item from NPC inventory to a scene", () => {
      const dgsm = makeMockDgsm();
      const resolution: StateResolution = {
        itemChanges: [
          {
            itemId: "lantern",
            action: "move",
            from: "npc_1",
            to: "scene:scene_study",
          },
        ],
        narrative: "The lantern was placed in the study.",
      };

      applyStateResolution(dgsm, resolution);

      // Item was removed from NPC
      expect(dgsm.removeItemFromNpc).toHaveBeenCalledWith("npc_1", "lantern");
      // Item was added to scene (getScene called to find destination)
      expect(dgsm.getScene).toHaveBeenCalledWith("scene_study");
    });

    it("destroys an item from a scene", () => {
      const dgsm = makeMockDgsm();
      const resolution: StateResolution = {
        itemChanges: [
          {
            itemId: "book",
            action: "destroy",
            from: "scene_study",
          },
        ],
        narrative: "The book was destroyed.",
      };

      applyStateResolution(dgsm, resolution);

      // Verify scene was accessed for removal
      expect(dgsm.getScene).toHaveBeenCalledWith("scene_study");
      // The scene's item list should no longer contain the book
      const scene = dgsm.getScene("scene_study");
      expect(scene?.items?.find((i: any) => i.id === "book")).toBeUndefined();
    });

    it("modifies item properties", () => {
      const dgsm = makeMockDgsm();
      const resolution: StateResolution = {
        itemChanges: [
          {
            itemId: "lantern",
            action: "modify",
            properties: { damaged: true },
          },
        ],
        narrative: "The lantern was damaged.",
      };

      applyStateResolution(dgsm, resolution);

      // Check the item was mutated in the NPC's inventory
      const inv = dgsm.getNpcInventory("npc_1");
      const lantern = inv.find((i: any) => i.id === "lantern");
      expect(lantern?.damaged).toBe(true);
    });
  });

  describe("empty resolution", () => {
    it("does nothing when resolution has no changes", () => {
      const dgsm = makeMockDgsm();
      const resolution: StateResolution = {
        narrative: "Nothing happened.",
      };

      applyStateResolution(dgsm, resolution);

      expect(dgsm.updateNpcHp).not.toHaveBeenCalled();
      expect(dgsm.updateNpcSan).not.toHaveBeenCalled();
      expect(dgsm.appendSceneCondition).not.toHaveBeenCalled();
      expect(dgsm.setCharacterPosition).not.toHaveBeenCalled();
    });
  });
});
