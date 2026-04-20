import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { OutputSchemaConfig } from "../../types.js";
import {
  STATE_CHANGE_APPLIERS,
  applyByTypeId,
} from "../stateChangeAppliers.js";

// ─── Standard type IDs ────────────────────────────────────────────────────────

const STANDARD_TYPE_IDS = [
  "character.hp",
  "character.san",
  "character.fatigue",
  "character.condition",
  "character.position",
  "item.move",
  "item.destroy",
  "item.create",
  "item.modify",
  "scene.condition",
  "memory.event",
  "memory.witness",
  "relationship.change",
] as const;

// ─── Mock DGSM factory ────────────────────────────────────────────────────────

function makeMockDgsm(
  overrides: Partial<DynamicGameStateManager> = {}
): DynamicGameStateManager {
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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("STATE_CHANGE_APPLIERS", () => {
  it("has an applier for every standard type (13 types)", () => {
    expect(STANDARD_TYPE_IDS).toHaveLength(13);
    for (const typeId of STANDARD_TYPE_IDS) {
      expect(STATE_CHANGE_APPLIERS).toHaveProperty(typeId);
      expect(typeof STATE_CHANGE_APPLIERS[typeId]).toBe("function");
    }
  });
});

describe("applyByTypeId", () => {
  it("applies character.hp changes", () => {
    const dgsm = makeMockDgsm();
    const resolution = {
      "character.hp": [{ characterId: "npc_1", delta: -3 }],
    };
    const config: OutputSchemaConfig = { use: ["character.hp"] };

    applyByTypeId(dgsm, resolution, config);

    expect(dgsm.updateNpcHp).toHaveBeenCalledWith("npc_1", -3);
    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n: any) => n.id === "npc_1");
    expect(npc?.status.hp).toBe(7);
  });

  it("applies character.condition add", () => {
    const dgsm = makeMockDgsm();
    const resolution = {
      "character.condition": [
        { characterId: "npc_1", add: ["bleeding"], remove: [] },
      ],
    };
    const config: OutputSchemaConfig = { use: ["character.condition"] };

    applyByTypeId(dgsm, resolution, config);

    const state = dgsm.getState();
    const npc = state.npcCharacters.find((n: any) => n.id === "npc_1");
    expect(npc?.status.conditions).toContain("bleeding");
  });

  it("applies scene.condition add", () => {
    const dgsm = makeMockDgsm();
    const resolution = {
      "scene.condition": [
        { sceneId: "scene_study", add: ["door is barricaded"], remove: [] },
      ],
    };
    const config: OutputSchemaConfig = { use: ["scene.condition"] };

    applyByTypeId(dgsm, resolution, config);

    expect(dgsm.appendSceneCondition).toHaveBeenCalledWith("scene_study", {
      description: "door is barricaded",
    });
  });

  it("skips types not in use list", () => {
    const dgsm = makeMockDgsm();
    const resolution = {
      "character.hp": [{ characterId: "npc_1", delta: -5 }],
      "character.san": [{ characterId: "npc_1", delta: -10 }],
    };
    // Only character.san in use list
    const config: OutputSchemaConfig = { use: ["character.san"] };

    applyByTypeId(dgsm, resolution, config);

    expect(dgsm.updateNpcHp).not.toHaveBeenCalled();
    expect(dgsm.updateNpcSan).toHaveBeenCalledWith("npc_1", -10);
  });

  it("skips empty arrays", () => {
    const dgsm = makeMockDgsm();
    const resolution = {
      "character.hp": [],
      "character.san": [{ characterId: "npc_1", delta: -2 }],
    };
    const config: OutputSchemaConfig = {
      use: ["character.hp", "character.san"],
    };

    applyByTypeId(dgsm, resolution, config);

    expect(dgsm.updateNpcHp).not.toHaveBeenCalled();
    expect(dgsm.updateNpcSan).toHaveBeenCalledWith("npc_1", -2);
  });

  it("ignores custom fields not in STATE_CHANGE_APPLIERS", () => {
    const dgsm = makeMockDgsm();
    const resolution = {
      "custom.mysteryField": [{ something: "value" }],
      "character.hp": [{ characterId: "npc_1", delta: -1 }],
    };
    const config: OutputSchemaConfig = {
      use: ["custom.mysteryField", "character.hp"],
    };

    // Should not throw — custom field has no applier, is silently ignored
    expect(() => applyByTypeId(dgsm, resolution, config)).not.toThrow();
    // HP should still be applied
    expect(dgsm.updateNpcHp).toHaveBeenCalledWith("npc_1", -1);
  });

  it("dispatches preset-derived types", () => {
    const dgsm = makeMockDgsm();
    const originalApplier = STATE_CHANGE_APPLIERS["memory.event"];
    const spy = vi.fn();
    STATE_CHANGE_APPLIERS["memory.event"] = spy;

    try {
      applyByTypeId(
        dgsm,
        {
          "memory.event": [{ characterId: "npc_1", content: "Noted." }],
        },
        { presets: ["default"] }
      );

      expect(spy).toHaveBeenCalledWith(dgsm, [
        { characterId: "npc_1", content: "Noted." },
      ]);
    } finally {
      STATE_CHANGE_APPLIERS["memory.event"] = originalApplier;
    }
  });
});
