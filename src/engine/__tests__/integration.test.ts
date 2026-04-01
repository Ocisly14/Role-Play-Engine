/**
 * Integration test — Blackwood Manor
 *
 * Tests the full engine pipeline (handlers + features + memory) with
 * 3 realistic NPCs, a connected scene graph, and all feature systems.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { ModelClass, generateText } from "../../models/index.js";
import { buildSummarizeDayMemoryPrompt } from "../../planning/npcSummaryTemplates.js";
import type { PlanNode } from "../../planning/types.js";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../../state/DynamicGameState.js";
import { buildTopology } from "../../state/topologyTypes.js";
import type { JunctionNode, RoadNode } from "../../state/topologyTypes.js";
import type {
  DynamicNPCProfile,
  DynamicScene,
  Item,
} from "../../state/types.js";
import {
  applyCharacterDelta,
  resolveInteractionState,
  resolveTargets,
} from "../handlers/interactionStateResolver.js";
import {
  applyObjectDelta,
  resolveObjectInteractionState,
} from "../handlers/objectInteractionStateResolver.js";
import { createDefaultRegistry } from "../registerDefaults.js";
import type { GameEngineRegistry } from "../registry.js";
import type { ExecutionContext, TickRuntimeContext } from "../types.js";

// ===== World Fixtures =====

function buildWorld() {
  const state = initialDynamicGameState({
    sessionId: "integration-test",
    moduleName: "Blackwood Manor",
    gameDay: 1,
    timeOfDay: "21:00",
  });

  // --- Junctions ---
  const junc_gate: JunctionNode = {
    id: "JUNC_manor_gate",
    name: "Manor Gate",
    description: "The wrought-iron gate of Blackwood Manor.",
    parentLocationId: "OUTDOOR",
    items: [],
    conditions: [],
    connectedSceneIds: ["manor_foyer"],
  };
  const junc_town: JunctionNode = {
    id: "JUNC_town_square",
    name: "Town Square",
    description: "A quiet New England town square.",
    parentLocationId: "OUTDOOR",
    items: [],
    conditions: [],
    connectedSceneIds: [],
  };
  state.junctions.set(junc_gate.id, junc_gate);
  state.junctions.set(junc_town.id, junc_town);

  // --- Roads ---
  const road: RoadNode = {
    id: "ROAD_manor_path",
    name: "Manor Path",
    description: "A gravel path leading from the manor to town.",
    parentLocationId: "OUTDOOR",
    endpointA: "JUNC_manor_gate",
    endpointB: "JUNC_town_square",
    travelTimeMinutes: 15,
    alongConnections: [],
    items: [],
    conditions: [],
  };
  state.roads.set(road.id, road);

  // --- Topology ---
  state.topology = buildTopology(state.junctions, state.roads);

  // --- Scenes ---
  const foyer: DynamicScene = {
    id: "manor_foyer",
    name: "Manor Foyer",
    description: "A dimly lit entrance hall with a grand staircase.",
    parentLocationId: "SCN_MANOR",
    items: [],
    conditions: [],
    connections: [{ targetId: "manor_library" }, { targetId: "manor_cellar" }],
    indoor: true,
  };
  const library: DynamicScene = {
    id: "manor_library",
    name: "Manor Library",
    description:
      "Floor-to-ceiling bookshelves line the walls. A reading desk sits by the window.",
    parentLocationId: "SCN_MANOR",
    items: [
      {
        id: "necronomicon",
        name: "Necronomicon Fragment",
        type: "document",
        category: "evidence",
        description: "A yellowed page covered in eldritch script.",
      },
      {
        id: "oil_lamp",
        name: "Oil Lamp",
        type: "lighting",
        isLightSource: true,
        lightLevel: 3,
      },
    ] as Item[],
    conditions: [],
    connections: [{ targetId: "manor_foyer" }],
    indoor: true,
  };
  const cellar: DynamicScene = {
    id: "manor_cellar",
    name: "Manor Cellar",
    description: "A damp stone cellar with strange markings on the walls.",
    parentLocationId: "SCN_MANOR",
    items: [
      { id: "ritual_altar", name: "Stone Altar", type: "other" },
      { id: "ceremonial_dagger", name: "Ceremonial Dagger", type: "weapon" },
    ] as Item[],
    conditions: [],
    connections: [{ targetId: "manor_foyer" }],
    indoor: true,
  };
  state.scenes.set(foyer.id, foyer);
  state.scenes.set(library.id, library);
  state.scenes.set(cellar.id, cellar);

  // --- NPCs ---
  const webb: DynamicNPCProfile = {
    id: "npc_webb",
    name: "Dr. Marcus Webb",
    occupation: "Scholar",
    age: 45,
    gender: "male",
    appearance:
      "A bespectacled man with silver-streaked hair and ink-stained fingers.",
    personality: "Curious and methodical, driven by academic obsession.",
    longTermIntent:
      "Uncover the truth behind the Blackwood family's occult history.",
    attributes: {
      STR: 40,
      CON: 55,
      DEX: 50,
      APP: 60,
      POW: 65,
      SIZ: 60,
      INT: 80,
      EDU: 85,
    },
    status: {
      hp: 11,
      maxHp: 11,
      sanity: 60,
      maxSanity: 70,
      luck: 55,
      conditions: [],
    },
    skills: {
      "Library Use": 75,
      Occult: 65,
      History: 70,
      Research: 60,
      "Spot Hidden": 45,
      Persuade: 50,
      Psychology: 40,
    },
    inventory: [{ name: "Magnifying Glass" }, { name: "Journal" }],
    relationships: [],
  };
  const isabella: DynamicNPCProfile = {
    id: "npc_isabella",
    name: "Isabella Rossi",
    occupation: "Cultist",
    age: 32,
    gender: "female",
    appearance: "A striking woman with dark eyes and a silver pendant.",
    personality: "Secretive and devout, hiding fanaticism beneath charm.",
    longTermIntent: "Complete the Binding Ritual to summon her patron.",
    attributes: {
      STR: 45,
      CON: 50,
      DEX: 60,
      APP: 70,
      POW: 75,
      SIZ: 50,
      INT: 65,
      EDU: 55,
    },
    status: {
      hp: 10,
      maxHp: 10,
      sanity: 45,
      maxSanity: 55,
      luck: 60,
      conditions: [],
    },
    skills: {
      Occult: 80,
      Stealth: 65,
      "Fast Talk": 55,
      Dodge: 50,
      Listen: 45,
      "Cthulhu Mythos": 30,
    },
    inventory: [{ name: "Ceremonial Robe" }],
    relationships: [],
  };
  const harlow: DynamicNPCProfile = {
    id: "npc_harlow",
    name: "Officer James Harlow",
    occupation: "Police Officer",
    age: 38,
    gender: "male",
    appearance:
      "A broad-shouldered man in a rumpled uniform, badge slightly askew.",
    personality: "Gruff but well-meaning. Trusts his gut over evidence.",
    longTermIntent: "Investigate the disappearances linked to the manor.",
    attributes: {
      STR: 70,
      CON: 65,
      DEX: 55,
      APP: 50,
      POW: 50,
      SIZ: 75,
      INT: 55,
      EDU: 50,
    },
    status: {
      hp: 13,
      maxHp: 13,
      sanity: 55,
      maxSanity: 60,
      luck: 45,
      conditions: [],
    },
    skills: {
      Intimidate: 65,
      "Spot Hidden": 55,
      "Fighting (Brawl)": 60,
      "Firearms (Handgun)": 55,
      "Drive Auto": 45,
      Law: 40,
      Persuade: 35,
      Dodge: 40,
    },
    inventory: [{ name: "Service Revolver" }],
    relationships: [],
  };
  state.npcCharacters = [webb, isabella, harlow];

  // --- NPC Positions ---
  state.characterPositions = {
    npc_webb: { type: "scene", sceneId: "manor_library" },
    npc_isabella: { type: "scene", sceneId: "manor_cellar" },
    npc_harlow: { type: "scene", sceneId: "manor_foyer" },
  };

  // --- NPC Stats ---
  state.npcStats = {
    npc_webb: { hp: 11, san: 60 },
    npc_isabella: { hp: 10, san: 45 },
    npc_harlow: { hp: 13, san: 55 },
  };

  // --- NPC Inventories ---
  state.npcInventories = {
    npc_webb: [
      { id: "magnifying_glass", name: "Magnifying Glass", type: "tool" },
    ] as Item[],
    npc_isabella: [
      { id: "ceremonial_robe", name: "Ceremonial Robe", type: "other" },
    ] as Item[],
    npc_harlow: [
      { id: "service_revolver", name: "Service Revolver", type: "weapon" },
    ] as Item[],
  };

  // --- Module Setup ---
  state.moduleSetup = {
    title: "Blackwood Manor",
    weatherPresets: [{ regionId: "OUTDOOR", weatherType: "fog", intensity: 2 }],
    eventTriggerPresets: [
      {
        eventTriggerId: "ritual_of_binding",
        label: "The Binding Ritual",
        conductorNpcId: "npc_isabella",
        siteSceneId: "manor_cellar",
        invokeType: "invoke",
        autoInvoke: false,
        conditions: [
          {
            conditionId: "altar_maintenance",
            label: "Daily altar maintenance",
            type: "daily",
            triggerType: "maintain",
            failAfterMissed: 3,
          },
          {
            conditionId: "ritual_components",
            label: "Gather ritual components",
            type: "cumulative",
            triggerType: "gather",
            requiredCount: 3,
          },
        ],
        completionEffect: {
          sceneConditions: [
            {
              sceneId: "manor_cellar",
              description: "The altar glows with otherworldly light",
            },
          ],
          witnessSanLoss: 3,
          globalSanLoss: 1,
        },
        failureEffect: {
          sceneConditions: [
            {
              sceneId: "manor_cellar",
              description: "The altar cracks and crumbles",
            },
          ],
        },
      },
    ],
  } as any;

  return new DynamicGameStateManager(state);
}

// ===== Helpers =====

function makeNode(overrides: Partial<PlanNode>): PlanNode {
  return {
    nodeId: `node_${Math.random().toString(36).slice(2, 8)}`,
    characterId: "npc_webb",
    characterName: "Dr. Marcus Webb",
    startTime: "21:00",
    endTime: "21:05",
    action: "Do something",
    location: "manor_library",
    type: "action",
    impact: 0 as const,
    status: "pending" as const,
    executionMeta: { remainingMinutes: 5 },
    ...overrides,
  } as PlanNode;
}

function makeCtx(rollOverride?: () => any): ExecutionContext {
  return {
    getNodeDifficulty: () => "regular" as const,
    getScenePenalties: () => new Map<string, number>(),
    getCharacterPenalties: () => new Map<string, number>(),
    applyPenalties: (skills: Record<string, number>) => skills,
    resolveSkillRoll:
      rollOverride ??
      (() => ({
        failed: false,
        detail: "Regular success",
        successLevel: "regular" as const,
      })),
  } as unknown as ExecutionContext;
}

function makeRuntime(
  overrides?: Partial<TickRuntimeContext>
): TickRuntimeContext {
  return {
    sessionId: "integration-test",
    gameDay: 1,
    language: "en",
    tickTime: "21:00",
    tickDurationMinutes: 5,
    npcPlanning: {} as any,
    ...overrides,
  };
}

interface MemoryEntry {
  npcId: string;
  type: string;
  content: string;
  location?: string;
}

// ===== Tests =====

describe("Engine Integration — Blackwood Manor", () => {
  let dgsm: DynamicGameStateManager;
  let registry: GameEngineRegistry;
  const memoryWrites: MemoryEntry[] = [];

  function recordMemory(action: {
    characterId: string;
    outcome: string;
    location: string;
  }) {
    memoryWrites.push({
      npcId: action.characterId,
      type: "event",
      content: action.outcome,
      location: action.location,
    });
  }

  beforeAll(() => {
    dgsm = buildWorld();
    registry = createDefaultRegistry();
  });

  // ── 1. World Setup ──

  describe("1. world setup", () => {
    it("should have 3 NPCs with correct positions", () => {
      const state = dgsm.getState();
      expect(state.npcCharacters).toHaveLength(3);
      expect(dgsm.getCharacterPosition("npc_webb")).toEqual({
        type: "scene",
        sceneId: "manor_library",
      });
      expect(dgsm.getCharacterPosition("npc_isabella")).toEqual({
        type: "scene",
        sceneId: "manor_cellar",
      });
      expect(dgsm.getCharacterPosition("npc_harlow")).toEqual({
        type: "scene",
        sceneId: "manor_foyer",
      });
    });

    it("should have scenes with items", () => {
      const library = dgsm.getScene("manor_library");
      expect(library).toBeDefined();
      expect(library!.items).toHaveLength(2);
      expect(library!.items.find((i) => i.id === "necronomicon")).toBeDefined();
      expect(library!.items.find((i) => i.id === "oil_lamp")).toBeDefined();
    });

    it("should have topology with junctions and roads", () => {
      const topo = dgsm.getTopology();
      expect(topo.junctions.size).toBe(2);
      expect(topo.roads.size).toBe(1);
      expect(topo.sceneToParent.has("manor_foyer")).toBe(true);
    });

    it("should have registry with 5 handlers and 6 features", () => {
      expect(registry.getAllHandlers()).toHaveLength(5);
      expect(registry.getAllFeatures()).toHaveLength(6);
    });
  });

  // ── 2. Routine Handler + Stamina ──

  describe("2. routine handler + stamina", () => {
    it("should complete Webb's research with hard success", () => {
      const ctx = makeCtx(() => ({
        failed: false,
        detail: "Library Use 15/75 (hard success)",
        successLevel: "hard" as const,
      }));
      const handler = registry.getHandler("action")!;

      const action = handler.execute(
        makeNode({
          characterId: "npc_webb",
          characterName: "Dr. Marcus Webb",
          action: "Research the Blackwood family history in the library",
          location: "manor_library",
          skill: "Library Use",
        }),
        dgsm,
        ctx
      );

      expect(action.status).toBe("completed");
      expect(action.successLevel).toBe("hard");
      recordMemory(action as any);
    });

    it("should accumulate stamina and reach tired at 480 min", () => {
      const feature = registry.getFeature("stamina")!;

      // 96 ticks * 5 min = 480 min → tired
      for (let i = 0; i < 96; i++) {
        feature.tick!(dgsm, makeRuntime());
      }

      const webbStamina = dgsm.getFeatureSceneState(
        "stamina",
        "npc_webb"
      ) as any;
      expect(webbStamina).toBeDefined();
      expect(webbStamina.fatigueLevel).toBe(1); // tired
      expect(webbStamina.minutesSinceLastRest).toBe(480);
    });
  });

  // ── 3. Movement Handler ──

  describe("3. movement handler", () => {
    it("should move Harlow from foyer to town square via topology", () => {
      const handler = registry.getHandler("movement")!;
      const ctx = makeCtx();

      // foyer → JUNC_manor_gate (connected scene) → ROAD → JUNC_town_square
      const action = handler.execute(
        makeNode({
          characterId: "npc_harlow",
          characterName: "Officer James Harlow",
          action: "Walk to the town square",
          destination: "JUNC_town_square",
          type: "movement",
        }),
        dgsm,
        ctx
      );

      expect(action.status).toBe("completed");
      expect(dgsm.getCharacterPosition("npc_harlow")).toEqual({
        type: "junction",
        junctionId: "JUNC_town_square",
      });
      recordMemory(action as any);
    });

    it("should move Isabella to foyer via direct position set (interior movement)", () => {
      // Interior scene-to-scene movement bypasses topology
      dgsm.setCharacterPosition("npc_isabella", {
        type: "scene",
        sceneId: "manor_foyer",
      });
      expect(dgsm.getCharacterPosition("npc_isabella")).toEqual({
        type: "scene",
        sceneId: "manor_foyer",
      });
    });
  });

  // ── 4. Object Interaction Handler ──

  describe("4. object_interaction handler", () => {
    it("should succeed when Webb picks up the Necronomicon", () => {
      const handler = registry.getHandler("object_interaction")!;
      const ctx = makeCtx();

      const action = handler.execute(
        makeNode({
          characterId: "npc_webb",
          characterName: "Dr. Marcus Webb",
          action: "Pick up the Necronomicon Fragment from the reading desk",
          location: "manor_library",
          type: "object_interaction",
          objectInteractionPayload: { itemId: "necronomicon" },
        }),
        dgsm,
        ctx
      );

      expect(action.status).toBe("completed");
      recordMemory(action as any);
    });

    it("should fail for nonexistent item", () => {
      const handler = registry.getHandler("object_interaction")!;
      const ctx = makeCtx();

      const action = handler.execute(
        makeNode({
          characterId: "npc_webb",
          action: "Pick up the golden chalice",
          location: "manor_library",
          type: "object_interaction",
          objectInteractionPayload: { itemId: "golden_chalice" },
        }),
        dgsm,
        ctx
      );

      expect(action.status).toBe("failed");
      expect(action.failureReason).toBe("object_not_found");
    });
  });

  // ── 5. Character Interaction Handler ──

  describe("5. character_interaction handler", () => {
    it("should complete Harlow interrogating Webb", async () => {
      // Move Harlow back from town square to library
      dgsm.setCharacterPosition("npc_harlow", {
        type: "scene",
        sceneId: "manor_library",
      });

      const handler = registry.getHandler("character_interaction")!;
      const ctx = makeCtx(() => ({
        failed: false,
        detail: "Intimidate 25/65 (regular success)",
        successLevel: "regular" as const,
      }));

      const action = await handler.execute(
        makeNode({
          characterId: "npc_harlow",
          characterName: "Officer James Harlow",
          action: "Interrogate Dr. Webb about his presence in the manor",
          location: "manor_library",
          type: "character_interaction",
          skill: "Intimidate",
          targetCharacterIds: ["npc_webb"],
          impact: 2 as any,
        }),
        dgsm,
        ctx
      );

      expect(action.status).toBe("completed");
      recordMemory(action as any);
    });
  });

  // ── 6. Scene Interaction Handler ──

  describe("6. scene_interaction handler", () => {
    it("should barricade the cellar door", () => {
      // Move Harlow back to foyer
      dgsm.setCharacterPosition("npc_harlow", {
        type: "scene",
        sceneId: "manor_foyer",
      });

      const handler = registry.getHandler("scene_interaction")!;
      const ctx = makeCtx();

      const action = handler.execute(
        makeNode({
          characterId: "npc_harlow",
          characterName: "Officer James Harlow",
          action: "Barricade the cellar door with furniture",
          location: "manor_foyer",
          type: "scene_interaction",
          skill: "STR",
          impact: 2 as any,
        }),
        dgsm,
        ctx
      );

      expect(action.status).toBe("completed");
      recordMemory(action as any);
    });
  });

  // ── 7. EventTrigger — Daily Maintenance ──

  describe("7. eventTrigger — daily maintenance", () => {
    it("should initialize event trigger state on first tick", () => {
      const feature = registry.getFeature("event_trigger")!;
      feature.tick!(dgsm, makeRuntime());

      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "ritual_of_binding"
      ) as any;
      expect(state).toBeDefined();
      expect(state.status).toBe("active");
      expect(state.conditionStates.altar_maintenance.fulfilledToday).toBe(
        false
      );
    });

    it("should fulfill daily maintenance via activate", () => {
      const node = makeNode({
        characterId: "npc_isabella",
        characterName: "Isabella Rossi",
        action: "Perform the nightly altar maintenance ritual",
        location: "manor_cellar",
        type: "action",
        eventTriggerId: "ritual_of_binding",
        eventTriggerType: "maintain",
        eventTriggerConditionId: "altar_maintenance",
      });

      const results = registry.activateNodeFeatures(node, dgsm);
      // No outcomeNote for successful maintenance
      expect(results.filter((r) => r.outcomeNote)).toHaveLength(0);

      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "ritual_of_binding"
      ) as any;
      expect(state.conditionStates.altar_maintenance.fulfilledToday).toBe(true);
      expect(state.conditionStates.altar_maintenance.lastFulfilledDay).toBe(1);
    });
  });

  // ── 8. EventTrigger — Invoke Failure ──

  describe("8. eventTrigger — invoke failure", () => {
    it("should return 'nothing happened' when conditions are not met", () => {
      const node = makeNode({
        characterId: "npc_isabella",
        characterName: "Isabella Rossi",
        action: "Attempt to complete the Binding Ritual",
        location: "manor_cellar",
        type: "action",
        eventTriggerId: "ritual_of_binding",
        eventTriggerType: "invoke",
      });

      const results = registry.activateNodeFeatures(node, dgsm);
      const notes = results.filter((r) => r.outcomeNote);
      expect(notes).toHaveLength(1);
      expect(notes[0].outcomeNote).toContain("nothing happened");

      // Status should still be active
      const state = dgsm.getFeatureSceneState(
        "event_trigger",
        "ritual_of_binding"
      ) as any;
      expect(state.status).toBe("active");
    });
  });

  // ── 9. Weather + Lighting Tick ──

  describe("9. weather + lighting tick", () => {
    it("should initialize weather with fog preset", () => {
      const feature = registry.getFeature("weather")!;
      feature.tick!(dgsm, makeRuntime({ tickTime: "23:00" }));

      const outdoorState = dgsm.getFeatureSceneState(
        "weather",
        "OUTDOOR"
      ) as any;
      expect(outdoorState).toBeDefined();
      expect(outdoorState.weatherType).toBe("fog");
      expect(outdoorState.intensity).toBe(2);
    });

    it("should produce lighting conditions at night", () => {
      const feature = registry.getFeature("lighting")!;
      feature.tick!(dgsm, makeRuntime({ tickTime: "23:00" }));

      // Indoor library with oil lamp (level 3) → should be lit
      const libraryLight = dgsm.getFeatureSceneState(
        "lighting",
        "manor_library"
      ) as any;
      expect(libraryLight).toBeDefined();
      expect(libraryLight.lightLevel).toBeGreaterThanOrEqual(3);

      // Indoor cellar with no light source → dark or pitch black
      const cellarLight = dgsm.getFeatureSceneState(
        "lighting",
        "manor_cellar"
      ) as any;
      expect(cellarLight).toBeDefined();
      expect(cellarLight.lightLevel).toBeLessThanOrEqual(2);
    });
  });

  // ── 10. Fire Activate + Tick ──

  describe("10. fire activate + tick", () => {
    it("should start fire in cellar at intensity 2", () => {
      const node = makeNode({
        characterId: "npc_isabella",
        characterName: "Isabella Rossi",
        action: "Knock over the oil lantern onto the altar cloth",
        location: "manor_cellar",
        type: "scene_interaction",
        fireIntensity: 2,
      });

      registry.activateNodeFeatures(node, dgsm);

      const fireState = dgsm.getFeatureSceneState(
        "fire",
        "manor_cellar"
      ) as any;
      expect(fireState).toBeDefined();
      expect(fireState.intensity).toBe(2);
      expect(fireState.phase).toBe("growing");
    });

    it("should grow fire and block connections after tick", () => {
      const feature = registry.getFeature("fire")!;

      // Tick enough for intensity 2 → 3 (one growth step = 10 min)
      for (let i = 0; i < 2; i++) {
        feature.tick!(dgsm, makeRuntime());
      }

      const fireState = dgsm.getFeatureSceneState(
        "fire",
        "manor_cellar"
      ) as any;
      expect(fireState.intensity).toBe(3);

      // Fire scene condition should exist
      const conditions =
        dgsm.getState().scenarioConditions["manor_cellar"] ?? [];
      const fireCond = conditions.find((c: any) =>
        c.description.startsWith("[Fire]")
      );
      expect(fireCond).toBeDefined();
    });
  });

  // ── 11. Memory Writes ──

  describe("11. memory writes", () => {
    it("should have recorded memories for executed actions", () => {
      expect(memoryWrites.length).toBeGreaterThanOrEqual(4);

      // Webb's research
      const webbMemory = memoryWrites.find(
        (m) => m.npcId === "npc_webb" && m.content.includes("Research")
      );
      expect(webbMemory).toBeDefined();
      expect(webbMemory!.location).toBe("manor_library");

      // Harlow's movement to town
      const harlowMovement = memoryWrites.find(
        (m) =>
          m.npcId === "npc_harlow" && m.content.includes("Walk to the town")
      );
      expect(harlowMovement).toBeDefined();

      // Harlow's interrogation
      const harlowInterrogation = memoryWrites.find(
        (m) => m.npcId === "npc_harlow" && m.content.includes("Interrogate")
      );
      expect(harlowInterrogation).toBeDefined();

      // Harlow's barricade
      const harlowBarricade = memoryWrites.find(
        (m) => m.npcId === "npc_harlow" && m.content.includes("Barricade")
      );
      expect(harlowBarricade).toBeDefined();
    });
  });

  // ── 12. State Descriptions ──

  describe("12. stateDescription", () => {
    it("stamina: should mention tired NPC", () => {
      const desc = registry.getFeature("stamina")!.stateDescription(dgsm);
      expect(desc).toContain("tired");
      expect(desc).toContain("npc_webb");
    });

    it("weather: should describe fog", () => {
      const desc = registry.getFeature("weather")!.stateDescription(dgsm);
      expect(desc).toContain("fog");
    });

    it("lighting: should list scenes with abnormal lighting", () => {
      const desc = registry.getFeature("lighting")!.stateDescription(dgsm);
      // Cellar is dark, library is lit — at least cellar should appear
      expect(desc.length).toBeGreaterThan(0);
    });

    it("fire: should mention the cellar fire", () => {
      const desc = registry.getFeature("fire")!.stateDescription(dgsm);
      expect(desc).toContain("manor_cellar");
    });

    it("sanity: should be empty (no insanity active)", () => {
      const desc = registry.getFeature("sanity")!.stateDescription(dgsm);
      expect(desc).toBe("");
    });

    it("eventTrigger: should describe ritual conditions", () => {
      const desc = registry.getFeature("event_trigger")!.stateDescription(dgsm);
      expect(desc).toContain("ritual_of_binding");
      expect(desc).toContain("altar_maintenance");
    });

    it("buildWorldStatePrompt: should combine all non-empty descriptions", () => {
      const prompt = registry.buildWorldStatePrompt(dgsm);
      expect(prompt).toContain("fog");
      expect(prompt).toContain("manor_cellar");
      expect(prompt).toContain("tired");
    });
  });

  // ── 13. Real LLM — Object Interaction Resolver ──

  describe("13. real LLM — object_interaction resolver", () => {
    it("should call LLM to resolve Webb picking up the Necronomicon", async () => {
      const node = makeNode({
        characterId: "npc_webb",
        characterName: "Dr. Marcus Webb",
        action:
          "Pick up the Necronomicon Fragment and examine its eldritch script",
        location: "manor_library",
        type: "object_interaction",
        objectInteractionPayload: { itemId: "necronomicon" },
      });

      const runtime = { modelProvider: "openai" };

      const delta = await resolveObjectInteractionState(
        node,
        dgsm,
        runtime,
        null, // no skill roll — auto success
        "zh"
      );

      // LLM should return items array and a memory
      console.log("[LLM Object Delta]", JSON.stringify(delta, null, 2));
      expect(delta.items).toBeDefined();
      expect(delta.memory).toBeDefined();
      expect(delta.memory.length).toBeGreaterThan(0);

      // Apply the delta
      applyObjectDelta(dgsm, "npc_webb", delta, "manor_library");

      // If LLM moved item to inventory, verify it
      const movedToInventory = delta.items.find(
        (i) => i.itemId === "necronomicon" && i.location === "inventory"
      );
      if (movedToInventory) {
        const inv = dgsm.getNpcInventory("npc_webb");
        expect(inv.find((i) => i.id === "necronomicon")).toBeDefined();
      }

      // Record memory
      memoryWrites.push({
        npcId: "npc_webb",
        type: "event",
        content: delta.memory,
        location: "manor_library",
      });
    }, 30000);
  });

  // ── 14. Real LLM — Character Interaction Resolver ──

  describe("14. real LLM — character_interaction resolver", () => {
    it("should call LLM to resolve Harlow interrogating Webb", async () => {
      // Ensure both are in the library
      dgsm.setCharacterPosition("npc_harlow", {
        type: "scene",
        sceneId: "manor_library",
      });
      dgsm.setCharacterPosition("npc_webb", {
        type: "scene",
        sceneId: "manor_library",
      });

      const node = makeNode({
        characterId: "npc_harlow",
        characterName: "Officer James Harlow",
        action:
          "Interrogate Dr. Webb about what he found in the Necronomicon and why he is in the manor at night",
        location: "manor_library",
        type: "character_interaction",
        skill: "Intimidate",
        targetCharacterIds: ["npc_webb"],
        impact: 2 as any,
      });

      const runtime = { modelProvider: "openai" };

      const delta = await resolveInteractionState(
        node,
        dgsm,
        runtime,
        {
          successLevel: "hard",
          detail: "Intimidate 18/65 (hard success)",
          perTargetResults: {
            npc_webb: {
              successLevel: "regular",
              actorWon: true,
              detail:
                "Actor wins opposed roll (Intimidate 18 vs Psychology 72)",
            },
          },
        },
        [], // no knowledge entries
        "zh",
        registry
      );

      console.log("[LLM Interaction Delta]", JSON.stringify(delta, null, 2));

      // Both sides should have memory
      expect(delta.actorChanges).toBeDefined();
      expect(delta.actorChanges.memory).toBeDefined();
      expect(delta.actorChanges.memory.length).toBeGreaterThan(0);

      expect(delta.targetChanges).toBeDefined();
      expect(delta.targetChanges["npc_webb"]).toBeDefined();
      expect(delta.targetChanges["npc_webb"].memory).toBeDefined();
      expect(delta.targetChanges["npc_webb"].memory.length).toBeGreaterThan(0);

      // Apply deltas
      const targets = resolveTargets(node);
      await applyCharacterDelta(
        dgsm,
        "npc_harlow",
        delta.actorChanges,
        targets
      );
      await applyCharacterDelta(
        dgsm,
        "npc_webb",
        delta.targetChanges["npc_webb"],
        ["npc_harlow"]
      );

      // Record memories
      memoryWrites.push({
        npcId: "npc_harlow",
        type: "event",
        content: delta.actorChanges.memory,
        location: "manor_library",
      });
      memoryWrites.push({
        npcId: "npc_webb",
        type: "event",
        content: delta.targetChanges["npc_webb"].memory,
        location: "manor_library",
      });

      // Verify memories are in Chinese (language = "zh")
      const harlowMem = delta.actorChanges.memory;
      const webbMem = delta.targetChanges["npc_webb"].memory;
      // At least one should contain Chinese characters
      const hasChinese =
        /[\u4e00-\u9fff]/.test(harlowMem) || /[\u4e00-\u9fff]/.test(webbMem);
      expect(hasChinese).toBe(true);
    }, 30000);
  });

  // ── 15. Memory Summary ──

  describe("15. memory summary", () => {
    it("should have accumulated meaningful memories from all actions", () => {
      console.log("\n=== Memory Writes Summary ===");
      for (const m of memoryWrites) {
        console.log(
          `[${m.npcId}] @ ${m.location}: ${m.content.slice(0, 80)}...`
        );
      }
      console.log(`Total: ${memoryWrites.length} memories\n`);

      // Should have memories from: research, movement, handler interactions, LLM interactions
      expect(memoryWrites.length).toBeGreaterThanOrEqual(6);

      // Verify we have memories from different NPCs
      const npcIds = new Set(memoryWrites.map((m) => m.npcId));
      expect(npcIds.size).toBeGreaterThanOrEqual(2);

      // Verify LLM-generated memories are substantially longer than handler outcomes
      const llmMemories = memoryWrites.filter((m) => m.content.length > 50);
      expect(llmMemories.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── 16. Real LLM — Daily Summary ──

  describe("16. real LLM — daily summary", () => {
    it("should generate daily summary for Dr. Webb from accumulated memories", async () => {
      const webbMemories = memoryWrites.filter((m) => m.npcId === "npc_webb");
      const eventLog = webbMemories
        .map((m) => `[21:00] ${m.content}`)
        .join("\n");

      const { systemPrompt, userPrompt } = buildSummarizeDayMemoryPrompt({
        npcName: "Dr. Marcus Webb",
        npcProfile:
          "Dr. Marcus Webb, 45, Scholar. " +
          "A bespectacled man with silver-streaked hair and ink-stained fingers. " +
          "Curious and methodical, driven by academic obsession. " +
          "Skills: Library Use 75, Occult 65, History 70.",
        gameDay: 1,
        eventLog,
        existingKnowledge: "(none)",
        language: "zh",
      });

      const response = await generateText({
        runtime: { modelProvider: "openai" },
        context: userPrompt,
        customSystemPrompt: systemPrompt,
        modelClass: ModelClass.MEDIUM,
      });

      console.log("[LLM Daily Summary — Webb raw]", response);

      // Parse JSON response
      let parsed: {
        memories: Array<{ content: string; importance: number }>;
        newKnowledge?: Array<{
          id?: string;
          text: string;
          category?: string;
          difficulty?: string;
        }>;
      };
      try {
        const fenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonStr = fenceMatch ? fenceMatch[1].trim() : response.trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        // Attempt repair
        parsed = JSON.parse(response.replace(/,\s*([}\]])/g, "$1"));
      }

      console.log(
        "[LLM Daily Summary — Webb parsed]",
        JSON.stringify(parsed, null, 2)
      );

      // Should have at least 1 summary memory
      expect(parsed.memories).toBeDefined();
      expect(parsed.memories.length).toBeGreaterThanOrEqual(1);

      // Each memory should have content and importance
      for (const m of parsed.memories) {
        expect(m.content).toBeDefined();
        expect(m.content.length).toBeGreaterThan(0);
        expect(m.importance).toBeGreaterThanOrEqual(1);
        expect(m.importance).toBeLessThanOrEqual(5);
      }

      // Memories should be in Chinese
      const hasChinese = parsed.memories.some((m) =>
        /[\u4e00-\u9fff]/.test(m.content)
      );
      expect(hasChinese).toBe(true);

      // Should reference the Necronomicon or the interrogation
      const allContent = parsed.memories.map((m) => m.content).join(" ");
      const mentionsKey =
        allContent.includes("死灵") ||
        allContent.includes("Necronomicon") ||
        allContent.includes("Harlow") ||
        allContent.includes("审问") ||
        allContent.includes("逼问") ||
        allContent.includes("警察");
      expect(mentionsKey).toBe(true);
    }, 30000);

    it("should generate daily summary for Officer Harlow", async () => {
      const harlowMemories = memoryWrites.filter(
        (m) => m.npcId === "npc_harlow"
      );
      const eventLog = harlowMemories
        .map((m) => `[21:00] ${m.content}`)
        .join("\n");

      const { systemPrompt, userPrompt } = buildSummarizeDayMemoryPrompt({
        npcName: "Officer James Harlow",
        npcProfile:
          "Officer James Harlow, 38, Police Officer. " +
          "A broad-shouldered man in a rumpled uniform. " +
          "Gruff but well-meaning. Trusts his gut over evidence. " +
          "Skills: Intimidate 65, Fighting (Brawl) 60, Firearms (Handgun) 55.",
        gameDay: 1,
        eventLog,
        existingKnowledge: "(none)",
        language: "zh",
      });

      const response = await generateText({
        runtime: { modelProvider: "openai" },
        context: userPrompt,
        customSystemPrompt: systemPrompt,
        modelClass: ModelClass.MEDIUM,
      });

      console.log("[LLM Daily Summary — Harlow raw]", response);

      let parsed: {
        memories: Array<{ content: string; importance: number }>;
        newKnowledge?: Array<{
          id?: string;
          text: string;
          category?: string;
          difficulty?: string;
        }>;
      };
      try {
        const fenceMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonStr = fenceMatch ? fenceMatch[1].trim() : response.trim();
        parsed = JSON.parse(jsonStr);
      } catch {
        parsed = JSON.parse(response.replace(/,\s*([}\]])/g, "$1"));
      }

      console.log(
        "[LLM Daily Summary — Harlow parsed]",
        JSON.stringify(parsed, null, 2)
      );

      expect(parsed.memories.length).toBeGreaterThanOrEqual(1);

      // Harlow interrogated Webb — should have learned something as newKnowledge
      if (parsed.newKnowledge && parsed.newKnowledge.length > 0) {
        console.log("[Harlow newKnowledge]", parsed.newKnowledge);
        for (const k of parsed.newKnowledge) {
          expect(k.text).toBeDefined();
          expect(k.text.length).toBeGreaterThan(0);
        }
      }
    }, 30000);
  });
});
