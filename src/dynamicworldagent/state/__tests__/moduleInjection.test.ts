/**
 * Integration test: verifies that all module data from Cassandra_zh
 * is correctly imported and injected into DynamicGameState via the
 * full pipeline: importModule → loadModule → initRuntime.
 *
 * Requires: Prisma DB accessible (uses getPrismaClient)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveModuleIdByName } from "../../../shared/agents/memory/database/moduleScope.js";
import { getPrismaClient } from "../../../shared/agents/memory/database/prismaClient.js";
import { importModule } from "../moduleImporter.js";
import { initRuntime, loadModule } from "../moduleLoader.js";

const MODULE_NAME = "Cassandra_zh";
const MODULE_DIR = path.join(process.cwd(), "data", "Mods", MODULE_NAME);

// Skip entire suite if module directory doesn't exist
const moduleExists = fs.existsSync(MODULE_DIR);

describe.skipIf(!moduleExists)("Module injection: Cassandra_zh", () => {
  let prisma: ReturnType<typeof getPrismaClient>;
  let moduleId: string;

  beforeAll(async () => {
    prisma = getPrismaClient();

    // Import module from filesystem → DB
    await importModule({
      prisma,
      moduleDir: MODULE_DIR,
      moduleName: MODULE_NAME,
    });

    const resolved = await resolveModuleIdByName(MODULE_NAME);
    if (!resolved) throw new Error("Module not found after import");
    moduleId = resolved;
  }, 30_000);

  describe("importModule → DB", () => {
    it("should create module record", async () => {
      const mod = await prisma.module.findFirst({
        where: { moduleName: MODULE_NAME },
      });
      expect(mod).not.toBeNull();
    });

    it("should store module_setup.json", async () => {
      const setup = await prisma.moduleSetup.findUnique({
        where: { moduleId },
      });
      expect(setup).not.toBeNull();
      expect(setup!.data).toBeDefined();
      const data = setup!.data as Record<string, any>;
      expect(data.introduction).toBeDefined();
      expect(data.weatherPresets).toBeDefined();
      expect(data.eventTriggerPresets).toBeDefined();
    });

    it("should store npc_injection_policy.json", async () => {
      const row = await prisma.moduleScene.findUnique({
        where: {
          moduleId_entryId: {
            moduleId,
            entryId: "__npc_injection_policy__",
          },
        },
      });
      expect(row).not.toBeNull();
    });

    it("should store scenarios_outline.json", async () => {
      const row = await prisma.moduleScene.findUnique({
        where: {
          moduleId_entryId: {
            moduleId,
            entryId: "__scenarios_outline__",
          },
        },
      });
      expect(row).not.toBeNull();
    });

    it("should store scene files", async () => {
      const scenes = await prisma.moduleScene.findMany({
        where: {
          moduleId,
          entryId: { startsWith: "SCN_" },
        },
      });
      expect(scenes.length).toBeGreaterThanOrEqual(10);
    });

    it("should store junction files", async () => {
      const junctions = await prisma.moduleScene.findMany({
        where: {
          moduleId,
          entryId: { startsWith: "JUNC_" },
        },
      });
      expect(junctions.length).toBeGreaterThanOrEqual(5);
    });

    it("should store NPC profiles", async () => {
      const npcs = await prisma.moduleNpc.findMany({
        where: { moduleId },
      });
      expect(npcs.length).toBeGreaterThanOrEqual(20);
    });
  });

  describe("loadModule → ModuleData", () => {
    it("should load complete ModuleData from DB", async () => {
      const data = await loadModule(prisma, moduleId);
      expect(data).not.toBeNull();

      // Setup
      expect(data!.setup).not.toBeNull();
      expect(data!.setup!.introduction).toBeDefined();
      expect(data!.setup!.weatherPresets).toBeDefined();
      expect((data!.setup as any).eventTriggerPresets).toBeDefined();

      // NPCs
      expect(data!.npcs.length).toBeGreaterThanOrEqual(20);

      // Scenes
      expect(data!.scenes.size).toBeGreaterThanOrEqual(10);

      // Topology
      expect(data!.junctions.size).toBeGreaterThanOrEqual(5);
      expect(data!.roads.size).toBeGreaterThanOrEqual(5);

      // Scenario outlines
      expect(data!.scenarioOutlines.length).toBeGreaterThanOrEqual(10);

      // Injection policy
      expect(data!.npcInjectionPolicy).not.toBeNull();
      expect(data!.npcInjectionPolicy!.tiers).toBeDefined();
      expect(data!.npcInjectionPolicy!.tiers.daily_sim).toBeDefined();
      expect(
        data!.npcInjectionPolicy!.tiers.daily_sim!.length
      ).toBeGreaterThanOrEqual(10);
    });
  });

  describe("initRuntime → DynamicGameState", () => {
    it("should build complete game state", async () => {
      const moduleData = await loadModule(prisma, moduleId);
      expect(moduleData).not.toBeNull();

      const state = initRuntime({
        sessionId: "test-session",
        moduleData: moduleData!,
        gameDay: 1,
        timeOfDay: "21:00",
      });

      // === Module metadata ===
      expect(state.moduleName).toBe(MODULE_NAME);
      expect(state.moduleSetup).not.toBeNull();
      expect(state.sessionId).toBe("test-session");
      expect(state.gameDay).toBe(1);
      expect(state.timeOfDay).toBe("21:00");

      // === Scenes ===
      expect(state.scenes.size).toBeGreaterThanOrEqual(10);
      // Spot check a known scene
      expect(state.scenes.has("SCN_2_SUB_3")).toBe(true); // 焚化厂地下仪式场
      expect(state.scenes.has("SCN_17_SUB_3")).toBe(true); // 教堂蛛网密室

      // === Topology ===
      expect(state.topology).toBeDefined();
      expect(state.junctions.size).toBeGreaterThanOrEqual(5);
      expect(state.roads.size).toBeGreaterThanOrEqual(5);

      // === NPC characters (filtered by injection policy) ===
      expect(state.npcCharacters.length).toBeGreaterThanOrEqual(10);
      const npcIds = state.npcCharacters.map((n) => n.id);
      // daily_sim NPCs should be included
      expect(npcIds).toContain("Patrizio von Samsa");
      expect(npcIds).toContain("Constantine Frollo");
      expect(npcIds).toContain("Lux Lynch");
      expect(npcIds).toContain("Ben Cleo");
      // investigator_sim should be included
      expect(npcIds).toContain("Bruno Galilei");
      // scene_only should NOT be included
      expect(npcIds).not.toContain("Cthulhu");
      expect(npcIds).not.toContain("Nyogtha");

      // === NPC stats ===
      expect(state.npcStats["Patrizio von Samsa"]).toBeDefined();
      expect(state.npcStats["Patrizio von Samsa"].hp).toBeGreaterThan(0);
      expect(state.npcStats["Patrizio von Samsa"].san).toBeGreaterThan(0);

      // === NPC inventories ===
      expect(state.npcInventories["Patrizio von Samsa"]).toBeDefined();
      expect(Array.isArray(state.npcInventories["Patrizio von Samsa"])).toBe(
        true
      );

      // === NPC positions ===
      expect(state.characterPositions["Patrizio von Samsa"]).toBeDefined();
      expect(state.characterPositions["Constantine Frollo"]).toBeDefined();

      // === NPC relationships ===
      expect(state.npcRelationshipGraph["Patrizio von Samsa"]).toBeDefined();

      // === Scenario outlines ===
      expect(state.scenarioOutlines.length).toBeGreaterThanOrEqual(10);

      // === Transport edges ===
      expect(state.transportEdges.length).toBeGreaterThanOrEqual(5);

      // === NPC injection policy ===
      expect(state.npcInjectionPolicy).not.toBeNull();

      // === Feature state (initially empty, features init on first tick) ===
      expect(state.featureState).toEqual({});

      // === Scene conditions (from scene/junction/road definitions) ===
      // SCN_2_SUB_3 should have conditions
      expect(state.scenarioConditions["SCN_2_SUB_3"]).toBeDefined();
      expect(state.scenarioConditions["SCN_2_SUB_3"].length).toBeGreaterThan(0);
    });

    it("should include Patrizio inventory items", async () => {
      const moduleData = await loadModule(prisma, moduleId);
      const state = initRuntime({
        sessionId: "test-inventory",
        moduleData: moduleData!,
        gameDay: 1,
        timeOfDay: "21:00",
      });

      const patrizioInventory = state.npcInventories["Patrizio von Samsa"];
      expect(patrizioInventory).toBeDefined();
      expect(patrizioInventory.length).toBeGreaterThan(0);
      const itemNames = patrizioInventory.map((i: any) => i.name);
      // Core items from NPC profile
      expect(itemNames).toContain("定制西装");
      expect(itemNames).toContain("镇长文件");
    });

    it("should correctly set moduleSetup with eventTriggerPresets", async () => {
      const moduleData = await loadModule(prisma, moduleId);
      const state = initRuntime({
        sessionId: "test-setup",
        moduleData: moduleData!,
        gameDay: 1,
        timeOfDay: "21:00",
      });

      const setup = state.moduleSetup as any;
      expect(setup).not.toBeNull();

      // weatherPresets
      expect(setup.weatherPresets).toBeDefined();
      expect(setup.weatherPresets[0].weatherType).toBe("snow");

      // eventTriggerPresets
      expect(setup.eventTriggerPresets).toBeDefined();
      expect(setup.eventTriggerPresets.length).toBe(2);

      const gos = setup.eventTriggerPresets.find(
        (p: any) => p.eventTriggerId === "gate_of_stars"
      );
      expect(gos).toBeDefined();
      expect(gos.conductorNpcId).toBe("Patrizio von Samsa");
      expect(gos.siteSceneId).toBe("SCN_2_SUB_3");
      expect(gos.invokeType).toBe("invoke");
      expect(gos.autoInvoke).toBe(false);
      expect(gos.conditions.length).toBeGreaterThanOrEqual(3);
      expect(gos.completionEffect).toBeDefined();

      const anw = setup.eventTriggerPresets.find(
        (p: any) => p.eventTriggerId === "atlach_nacha_web"
      );
      expect(anw).toBeDefined();
      expect(anw.conductorNpcId).toBe("Constantine Frollo");
      expect(anw.conditions[0].failAfterMissed).toBe(3);
    });
  });
});
