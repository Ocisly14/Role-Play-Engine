import { describe, expect, it, vi } from "vitest";
import type { PlanNode } from "../../../dynamicworldagent/dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../../dynamicworldagent/state/DynamicGameState.js";
import type { TickRuntimeContext } from "../../types.js";
import { eventTriggerFeature } from "../eventTriggerFeature.js";

// ===== Minimal mock DGSM =====

function createMockDgsm(options: {
  eventTriggerPresets?: any[];
  npcInventory?: Record<string, any[]>;
  npcPositions?: Record<string, string>;
  sceneItems?: Record<string, any[]>;
  npcCharacters?: Array<{ id: string; status: { hp: number } }>;
  gameDay?: number;
  timeOfDay?: string;
}) {
  const featureState: Record<string, Record<string, unknown>> = {};
  const scenarioConditions: Record<string, any[]> = {};
  const {
    eventTriggerPresets = [],
    npcInventory = {},
    npcPositions = {},
    sceneItems = {},
    npcCharacters = [],
    gameDay = 1,
    timeOfDay = "21:00",
  } = options;

  const state = {
    moduleSetup: { eventTriggerPresets },
    featureState,
    characterPositions: Object.fromEntries(
      Object.entries(npcPositions).map(([id, loc]) => [
        id,
        { sceneId: loc, junctionId: null, roadId: null },
      ])
    ),
    npcCharacters,
    gameDay,
    timeOfDay,
    scenarioConditions,
  };

  const dgsm: Partial<DynamicGameStateManager> = {
    getState: () => state as any,

    getFeatureSceneState(featureId: string, key: string) {
      return featureState[featureId]?.[key];
    },

    setFeatureSceneState(featureId: string, key: string, data: unknown) {
      if (!featureState[featureId]) featureState[featureId] = {};
      featureState[featureId][key] = data;
    },

    getFeatureState(featureId: string) {
      return featureState[featureId] ?? {};
    },

    getNpcInventory(npcId: string) {
      return (npcInventory[npcId] ?? []) as any[];
    },

    getCharacterPosition(charId: string) {
      const pos = npcPositions[charId];
      if (!pos) return null;
      return { sceneId: pos, junctionId: null, roadId: null } as any;
    },

    resolveLocationId(position: any) {
      return position?.sceneId ?? "";
    },

    getScene(sceneId: string) {
      return {
        id: sceneId,
        items: sceneItems[sceneId] ?? [],
      } as any;
    },

    isNpcAlive(npcId: string) {
      const npc = npcCharacters.find((n) => n.id === npcId);
      return npc ? npc.status.hp > 0 : false;
    },

    getCharactersInScene(sceneId: string) {
      return Object.entries(npcPositions)
        .filter(([, loc]) => loc === sceneId)
        .map(([id]) => id);
    },

    appendSceneCondition(sceneId: string, cond: any) {
      if (!scenarioConditions[sceneId]) scenarioConditions[sceneId] = [];
      scenarioConditions[sceneId].push(cond);
    },

    updateNpcSan(_npcId: string, _delta: number) {
      // no-op in tests
    },

    pushWorldEvent(_event: any) {
      // no-op in tests
    },
  };

  return {
    dgsm: dgsm as DynamicGameStateManager,
    featureState,
    scenarioConditions,
    state,
  };
}

function makeRuntime(
  overrides: Partial<TickRuntimeContext> = {}
): TickRuntimeContext {
  return {
    sessionId: "test",
    gameDay: 1,
    language: "zh",
    tickTime: "21:00",
    tickDurationMinutes: 30,
    npcPlanning: {} as any,
    ...overrides,
  };
}

function makeNode(fields: Record<string, unknown>): PlanNode {
  return {
    type: "action",
    action: "test action",
    location: "SCN_2_SUB_3",
    characterId: "Patrizio von Samsa",
    ...fields,
  } as unknown as PlanNode;
}

// ===== Presets =====

const gateOfStarsPreset = {
  eventTriggerId: "gate_of_stars",
  label: "群星之门仪式",
  conductorNpcId: "Patrizio von Samsa",
  siteSceneId: "SCN_2_SUB_3",
  invokeType: "invoke",
  autoInvoke: false,
  conditions: [
    {
      conditionId: "altar_maintenance",
      label: "祭坛维护",
      type: "daily",
      triggerType: "maintain",
    },
    {
      conditionId: "anchor_placement",
      label: "锚点布置",
      type: "cumulative",
      requiredCount: 3,
      triggerType: "sacrifice",
    },
    {
      conditionId: "at_ritual_site",
      label: "在仪式场地",
      type: "prerequisite",
      triggerType: "prerequisite",
      check: { location: "SCN_2_SUB_3", mode: "passive" },
    },
    {
      conditionId: "has_portrait",
      label: "持有诅咒画像",
      type: "prerequisite",
      triggerType: "prerequisite",
      check: { item: "加塔诺托亚的诅咒画像", mode: "passive" },
    },
  ],
  completionEffect: {
    sceneConditions: [
      {
        sceneId: "SCN_2_SUB_3",
        description: "[Ritual Complete] Gate opened",
      },
    ],
    witnessSanLoss: 8,
    globalSanLoss: 5,
  },
};

const webMaintenancePreset = {
  eventTriggerId: "atlach_nacha_web",
  label: "纳克亚蛛网仪式",
  conductorNpcId: "Constantine Frollo",
  siteSceneId: "SCN_17_SUB_3",
  invokeType: "invoke",
  autoInvoke: false,
  conditions: [
    {
      conditionId: "web_maintenance",
      label: "蛛网维护仪式",
      type: "daily",
      triggerType: "maintain",
      failAfterMissed: 3,
    },
  ],
  failureEffect: {
    sceneConditions: [
      {
        sceneId: "SCN_17_SUB_3",
        description: "[Ritual Failed] Web unstable",
      },
    ],
  },
};

// ===== Tests =====

describe("eventTriggerFeature", () => {
  describe("tick — initialization", () => {
    it("should init from presets on first tick", () => {
      const { dgsm, featureState } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
      });

      eventTriggerFeature.tick!(dgsm, makeRuntime());

      const state = featureState["event_trigger"]?.["gate_of_stars"] as any;
      expect(state).toBeDefined();
      expect(state.status).toBe("active");
      expect(state.conditionStates["altar_maintenance"]).toEqual({
        type: "daily",
        fulfilledToday: false,
        lastFulfilledDay: 0,
        consecutiveMissed: 0,
      });
      expect(state.conditionStates["anchor_placement"]).toEqual({
        type: "cumulative",
        currentCount: 0,
        requiredCount: 3,
      });
      expect(state.conditionStates["at_ritual_site"]).toEqual({
        type: "prerequisite",
        mode: "passive",
        fulfilled: false,
      });
    });
  });

  describe("activate — daily condition", () => {
    it("should set fulfilledToday when maintain action is triggered", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime());

      eventTriggerFeature.activate!(
        makeNode({
          eventTriggerId: "gate_of_stars",
          eventTriggerType: "maintain",
          eventTriggerConditionId: "altar_maintenance",
        }),
        dgsm
      );

      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "gate_of_stars"
      ) as any;
      expect(state.conditionStates["altar_maintenance"].fulfilledToday).toBe(
        true
      );
      expect(state.conditionStates["altar_maintenance"].lastFulfilledDay).toBe(
        1
      );
    });
  });

  describe("activate — cumulative condition", () => {
    it("should increment count on sacrifice action", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime());

      // 3 sacrifices
      for (let i = 0; i < 3; i++) {
        eventTriggerFeature.activate!(
          makeNode({
            eventTriggerId: "gate_of_stars",
            eventTriggerType: "sacrifice",
            eventTriggerConditionId: "anchor_placement",
          }),
          dgsm
        );
      }

      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "gate_of_stars"
      ) as any;
      expect(state.conditionStates["anchor_placement"].currentCount).toBe(3);
    });

    it("should not exceed requiredCount", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime());

      for (let i = 0; i < 5; i++) {
        eventTriggerFeature.activate!(
          makeNode({
            eventTriggerId: "gate_of_stars",
            eventTriggerType: "sacrifice",
            eventTriggerConditionId: "anchor_placement",
          }),
          dgsm
        );
      }

      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "gate_of_stars"
      ) as any;
      expect(state.conditionStates["anchor_placement"].currentCount).toBe(3);
    });
  });

  describe("activate — invoke", () => {
    it("should fail invoke when conditions are not met", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
        npcPositions: { "Patrizio von Samsa": "SCN_2_SUB_3" },
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime());

      const result = eventTriggerFeature.activate!(
        makeNode({
          eventTriggerId: "gate_of_stars",
          eventTriggerType: "invoke",
        }),
        dgsm
      );

      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "gate_of_stars"
      ) as any;
      expect(state.status).toBe("active"); // not completed

      // Should return outcomeNote with label
      expect(result).toBeDefined();
      expect(result!.outcomeNote).toBe('"群星之门仪式" — nothing happened.');
    });

    it("should return void (no outcomeNote) on successful invoke", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
        npcPositions: { "Patrizio von Samsa": "SCN_2_SUB_3" },
        npcInventory: {
          "Patrizio von Samsa": [{ name: "加塔诺托亚的诅咒画像" }],
        },
        npcCharacters: [{ id: "Patrizio von Samsa", status: { hp: 10 } }],
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime());

      // Fulfill all conditions
      eventTriggerFeature.activate!(
        makeNode({
          eventTriggerId: "gate_of_stars",
          eventTriggerType: "maintain",
          eventTriggerConditionId: "altar_maintenance",
        }),
        dgsm
      );
      for (let i = 0; i < 3; i++) {
        eventTriggerFeature.activate!(
          makeNode({
            eventTriggerId: "gate_of_stars",
            eventTriggerType: "sacrifice",
            eventTriggerConditionId: "anchor_placement",
          }),
          dgsm
        );
      }

      const result = eventTriggerFeature.activate!(
        makeNode({
          eventTriggerId: "gate_of_stars",
          eventTriggerType: "invoke",
        }),
        dgsm
      );

      expect(result).toBeUndefined();
      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "gate_of_stars"
      ) as any;
      expect(state.status).toBe("completed");
    });

    it("should complete when all conditions are met", () => {
      const { dgsm, scenarioConditions } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
        npcPositions: { "Patrizio von Samsa": "SCN_2_SUB_3" },
        npcInventory: {
          "Patrizio von Samsa": [{ name: "加塔诺托亚的诅咒画像" }],
        },
        sceneItems: {},
        npcCharacters: [{ id: "Patrizio von Samsa", status: { hp: 10 } }],
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime());

      // Fulfill daily
      eventTriggerFeature.activate!(
        makeNode({
          eventTriggerId: "gate_of_stars",
          eventTriggerType: "maintain",
          eventTriggerConditionId: "altar_maintenance",
        }),
        dgsm
      );

      // Fulfill cumulative (3 times)
      for (let i = 0; i < 3; i++) {
        eventTriggerFeature.activate!(
          makeNode({
            eventTriggerId: "gate_of_stars",
            eventTriggerType: "sacrifice",
            eventTriggerConditionId: "anchor_placement",
          }),
          dgsm
        );
      }

      // Invoke
      eventTriggerFeature.activate!(
        makeNode({
          eventTriggerId: "gate_of_stars",
          eventTriggerType: "invoke",
        }),
        dgsm
      );

      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "gate_of_stars"
      ) as any;
      // All conditions met: daily fulfilled, cumulative 3/3, at location, has portrait
      expect(state.status).toBe("completed");
    });
  });

  describe("activate — ignore invalid input", () => {
    it("should ignore unknown eventTriggerId", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime());

      // Should not throw
      eventTriggerFeature.activate!(
        makeNode({
          eventTriggerId: "nonexistent",
          eventTriggerType: "maintain",
          eventTriggerConditionId: "foo",
        }),
        dgsm
      );
    });

    it("should ignore unknown conditionId", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime());

      eventTriggerFeature.activate!(
        makeNode({
          eventTriggerId: "gate_of_stars",
          eventTriggerType: "maintain",
          eventTriggerConditionId: "nonexistent_condition",
        }),
        dgsm
      );

      // State should remain unchanged
      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "gate_of_stars"
      ) as any;
      expect(state.conditionStates["altar_maintenance"].fulfilledToday).toBe(
        false
      );
    });

    it("should ignore activate on completed trigger", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime());

      // Manually set to completed
      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "gate_of_stars"
      ) as any;
      state.status = "completed";
      dgsm.setFeatureSceneState("event_trigger", "gate_of_stars", state);

      eventTriggerFeature.activate!(
        makeNode({
          eventTriggerId: "gate_of_stars",
          eventTriggerType: "maintain",
          eventTriggerConditionId: "altar_maintenance",
        }),
        dgsm
      );

      const afterState = dgsm.getFeatureSceneState(
        "event_trigger",
        "gate_of_stars"
      ) as any;
      expect(
        afterState.conditionStates["altar_maintenance"].fulfilledToday
      ).toBe(false);
    });
  });

  describe("tick — daily reset on day change", () => {
    it("should reset fulfilledToday and track consecutiveMissed", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
      });
      // Init on day 1
      eventTriggerFeature.tick!(dgsm, makeRuntime({ gameDay: 1 }));

      // Fulfill daily on day 1
      eventTriggerFeature.activate!(
        makeNode({
          eventTriggerId: "gate_of_stars",
          eventTriggerType: "maintain",
          eventTriggerConditionId: "altar_maintenance",
        }),
        dgsm
      );

      let state = dgsm.getFeatureSceneState(
        "event_trigger",
        "gate_of_stars"
      ) as any;
      expect(state.conditionStates["altar_maintenance"].fulfilledToday).toBe(
        true
      );

      // Tick to day 2 — should reset
      eventTriggerFeature.tick!(dgsm, makeRuntime({ gameDay: 2 }));

      state = dgsm.getFeatureSceneState(
        "event_trigger",
        "gate_of_stars"
      ) as any;
      expect(state.conditionStates["altar_maintenance"].fulfilledToday).toBe(
        false
      );
      expect(state.conditionStates["altar_maintenance"].consecutiveMissed).toBe(
        0
      ); // was fulfilled on day 1

      // Tick to day 3 without fulfilling — consecutiveMissed should increment
      eventTriggerFeature.tick!(dgsm, makeRuntime({ gameDay: 3 }));

      state = dgsm.getFeatureSceneState(
        "event_trigger",
        "gate_of_stars"
      ) as any;
      expect(state.conditionStates["altar_maintenance"].consecutiveMissed).toBe(
        1
      );
    });

    it("should handle multi-day gap", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [webMaintenancePreset],
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime({ gameDay: 1 }));

      // Skip from day 1 to day 4 without fulfilling — 3 day gap
      eventTriggerFeature.tick!(dgsm, makeRuntime({ gameDay: 4 }));

      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "atlach_nacha_web"
      ) as any;
      expect(state.conditionStates["web_maintenance"].consecutiveMissed).toBe(
        3
      );
      // failAfterMissed is 3, so it should be failed
      expect(state.status).toBe("failed");
    });
  });

  describe("tick — failAfterMissed", () => {
    it("should fail event trigger when consecutiveMissed reaches threshold", () => {
      const { dgsm, scenarioConditions } = createMockDgsm({
        eventTriggerPresets: [webMaintenancePreset],
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime({ gameDay: 1 }));

      // Day 2: not fulfilled
      eventTriggerFeature.tick!(dgsm, makeRuntime({ gameDay: 2 }));
      // Day 3: not fulfilled
      eventTriggerFeature.tick!(dgsm, makeRuntime({ gameDay: 3 }));
      // Day 4: not fulfilled — consecutiveMissed = 3 = failAfterMissed
      eventTriggerFeature.tick!(dgsm, makeRuntime({ gameDay: 4 }));

      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "atlach_nacha_web"
      ) as any;
      expect(state.status).toBe("failed");
      expect(scenarioConditions["SCN_17_SUB_3"]).toBeDefined();
      expect(scenarioConditions["SCN_17_SUB_3"][0].description).toContain(
        "Ritual Failed"
      );
    });
  });

  describe("autoInvoke", () => {
    it("should auto-complete when all conditions met", () => {
      const autoPreset = {
        ...gateOfStarsPreset,
        autoInvoke: true,
        // Simplify: only daily condition + passive location
        conditions: [
          {
            conditionId: "maintenance",
            label: "维护",
            type: "daily",
            triggerType: "maintain",
          },
          {
            conditionId: "at_site",
            label: "在场",
            type: "prerequisite",
            triggerType: "prerequisite",
            check: { location: "SCN_2_SUB_3", mode: "passive" },
          },
        ],
      };

      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [autoPreset],
        npcPositions: { "Patrizio von Samsa": "SCN_2_SUB_3" },
        npcCharacters: [{ id: "Patrizio von Samsa", status: { hp: 10 } }],
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime());

      // Fulfill daily — should auto-complete since all conditions met
      eventTriggerFeature.activate!(
        makeNode({
          eventTriggerId: "gate_of_stars",
          eventTriggerType: "maintain",
          eventTriggerConditionId: "maintenance",
        }),
        dgsm
      );

      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "gate_of_stars"
      ) as any;
      expect(state.status).toBe("completed");
    });
  });

  describe("stateDescription", () => {
    it("should generate dynamic description with condition statuses", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime());

      const desc = eventTriggerFeature.stateDescription(dgsm);

      expect(desc).toContain("事件触发条件标记参考");
      expect(desc).toContain("gate_of_stars");
      expect(desc).toContain("altar_maintenance");
      expect(desc).toContain("anchor_placement");
      expect(desc).toContain("0/3");
      // Should NOT contain prerequisite conditions
      expect(desc).not.toContain("at_ritual_site");
      expect(desc).not.toContain("has_portrait");
    });

    it("should return empty string when no active triggers", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [],
      });

      const desc = eventTriggerFeature.stateDescription(dgsm);
      expect(desc).toBe("");
    });
  });

  describe("prerequisite — manual mode", () => {
    it("should check and record fulfilled on manual trigger", () => {
      const manualPreset = {
        eventTriggerId: "test_manual",
        label: "Test",
        conductorNpcId: "NPC_A",
        siteSceneId: "SCENE_1",
        invokeType: "invoke",
        autoInvoke: false,
        conditions: [
          {
            conditionId: "bring_item",
            label: "带物品",
            type: "prerequisite",
            triggerType: "prepare",
            check: { item: "Magic Key", mode: "manual" },
          },
        ],
      };

      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [manualPreset],
        npcInventory: { NPC_A: [{ name: "Magic Key" }] },
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime());

      // Trigger manual check at node start (prerequisite checked at action start time)
      const node = makeNode({
        characterId: "NPC_A",
        eventTriggerId: "test_manual",
        eventTriggerType: "prepare",
        eventTriggerConditionId: "bring_item",
      });
      eventTriggerFeature.onNodeStart!(node, dgsm);
      eventTriggerFeature.activate!(node, dgsm);

      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "test_manual"
      ) as any;
      expect(state.conditionStates["bring_item"].fulfilled).toBe(true);
    });

    it("should set fulfilled=false when item not present", () => {
      const manualPreset = {
        eventTriggerId: "test_manual",
        label: "Test",
        conductorNpcId: "NPC_A",
        siteSceneId: "SCENE_1",
        invokeType: "invoke",
        autoInvoke: false,
        conditions: [
          {
            conditionId: "bring_item",
            label: "带物品",
            type: "prerequisite",
            triggerType: "prepare",
            check: { item: "Magic Key", mode: "manual" },
          },
        ],
      };

      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [manualPreset],
        npcInventory: { NPC_A: [] }, // no item
      });
      eventTriggerFeature.tick!(dgsm, makeRuntime());

      const node = makeNode({
        characterId: "NPC_A",
        eventTriggerId: "test_manual",
        eventTriggerType: "prepare",
        eventTriggerConditionId: "bring_item",
      });
      eventTriggerFeature.onNodeStart!(node, dgsm);
      eventTriggerFeature.activate!(node, dgsm);

      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "test_manual"
      ) as any;
      expect(state.conditionStates["bring_item"].fulfilled).toBe(false);
    });
  });

  describe("completion effects", () => {
    function fulfillAllAndInvoke(dgsm: DynamicGameStateManager) {
      eventTriggerFeature.tick!(dgsm, makeRuntime());
      eventTriggerFeature.activate!(
        makeNode({
          eventTriggerId: "gate_of_stars",
          eventTriggerType: "maintain",
          eventTriggerConditionId: "altar_maintenance",
        }),
        dgsm
      );
      for (let i = 0; i < 3; i++) {
        eventTriggerFeature.activate!(
          makeNode({
            eventTriggerId: "gate_of_stars",
            eventTriggerType: "sacrifice",
            eventTriggerConditionId: "anchor_placement",
          }),
          dgsm
        );
      }
      eventTriggerFeature.activate!(
        makeNode({
          eventTriggerId: "gate_of_stars",
          eventTriggerType: "invoke",
        }),
        dgsm
      );
    }

    it("should write sceneConditions on successful invoke", () => {
      const { dgsm, scenarioConditions } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
        npcPositions: { "Patrizio von Samsa": "SCN_2_SUB_3" },
        npcInventory: {
          "Patrizio von Samsa": [{ name: "加塔诺托亚的诅咒画像" }],
        },
        npcCharacters: [{ id: "Patrizio von Samsa", status: { hp: 10 } }],
      });

      fulfillAllAndInvoke(dgsm);

      expect(scenarioConditions["SCN_2_SUB_3"]).toBeDefined();
      expect(scenarioConditions["SCN_2_SUB_3"][0].description).toContain(
        "Ritual Complete"
      );
    });

    it("should apply witnessSanLoss to characters at site except conductor", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
        npcPositions: {
          "Patrizio von Samsa": "SCN_2_SUB_3",
          Witness_A: "SCN_2_SUB_3",
          Witness_B: "SCN_2_SUB_3",
          Far_NPC: "SCN_OTHER",
        },
        npcInventory: {
          "Patrizio von Samsa": [{ name: "加塔诺托亚的诅咒画像" }],
        },
        npcCharacters: [
          { id: "Patrizio von Samsa", status: { hp: 10 } },
          { id: "Witness_A", status: { hp: 10 } },
          { id: "Witness_B", status: { hp: 10 } },
          { id: "Far_NPC", status: { hp: 10 } },
        ],
      });
      const spy = vi.fn();
      (dgsm as any).updateNpcSan = spy;

      fulfillAllAndInvoke(dgsm);

      // witnessSanLoss=8 → only witnesses at site, not conductor
      const witnessCalls = spy.mock.calls.filter(
        ([, d]: [string, number]) => d === -8
      );
      expect(witnessCalls.map(([id]: [string]) => id).sort()).toEqual([
        "Witness_A",
        "Witness_B",
      ]);
    });

    it("should apply globalSanLoss to all alive NPCs", () => {
      const { dgsm } = createMockDgsm({
        eventTriggerPresets: [gateOfStarsPreset],
        npcPositions: {
          "Patrizio von Samsa": "SCN_2_SUB_3",
          NPC_A: "SCN_2_SUB_3",
          NPC_B: "SCN_OTHER",
          NPC_Dead: "SCN_OTHER",
        },
        npcInventory: {
          "Patrizio von Samsa": [{ name: "加塔诺托亚的诅咒画像" }],
        },
        npcCharacters: [
          { id: "Patrizio von Samsa", status: { hp: 10 } },
          { id: "NPC_A", status: { hp: 10 } },
          { id: "NPC_B", status: { hp: 10 } },
          { id: "NPC_Dead", status: { hp: 0 } },
        ],
      });
      const spy = vi.fn();
      (dgsm as any).updateNpcSan = spy;

      fulfillAllAndInvoke(dgsm);

      // globalSanLoss=5 → all alive (3), not dead
      const globalCalls = spy.mock.calls.filter(
        ([, d]: [string, number]) => d === -5
      );
      expect(globalCalls.map(([id]: [string]) => id).sort()).toEqual([
        "NPC_A",
        "NPC_B",
        "Patrizio von Samsa",
      ]);
      expect(
        spy.mock.calls.filter(([id]: [string]) => id === "NPC_Dead")
      ).toHaveLength(0);
    });
  });

  describe("failure effects", () => {
    it("should apply failureEffect witnessSanLoss on failAfterMissed", () => {
      const presetWithSan = {
        ...webMaintenancePreset,
        failureEffect: {
          sceneConditions: [
            { sceneId: "SCN_17_SUB_3", description: "[Failed] Web collapsed" },
          ],
          witnessSanLoss: 6,
        },
      };
      const { dgsm, scenarioConditions } = createMockDgsm({
        eventTriggerPresets: [presetWithSan],
        npcPositions: {
          "Constantine Frollo": "SCN_17_SUB_3",
          Witness_X: "SCN_17_SUB_3",
          Elsewhere: "SCN_OTHER",
        },
        npcCharacters: [
          { id: "Constantine Frollo", status: { hp: 10 } },
          { id: "Witness_X", status: { hp: 10 } },
          { id: "Elsewhere", status: { hp: 10 } },
        ],
      });
      const spy = vi.fn();
      (dgsm as any).updateNpcSan = spy;

      eventTriggerFeature.tick!(dgsm, makeRuntime({ gameDay: 1 }));
      eventTriggerFeature.tick!(dgsm, makeRuntime({ gameDay: 4 })); // 3 days missed → fail

      expect(scenarioConditions["SCN_17_SUB_3"][0].description).toContain(
        "Failed"
      );
      // witnessSanLoss=6 → only Witness_X (not conductor, not elsewhere)
      const calls = spy.mock.calls.filter(
        ([, d]: [string, number]) => d === -6
      );
      expect(calls.map(([id]: [string]) => id)).toEqual(["Witness_X"]);
    });
  });
});
