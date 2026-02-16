import type { CoCDatabase, CoCDatabaseAdapter } from "../../../src/shared/agents/memory/database/index.js";
import { ScenarioLoader } from "../../../src/shared/agents/memory/scenarioloader/index.js";
import { NPCLoader } from "../../../src/shared/agents/character/npcloader/index.js";
import { ModuleLoader } from "../../../src/shared/agents/memory/moduleloader/index.js";
import { WorldModuleLoader } from "../../../src/dynamicworldagent/world_builder/worldModuleLoader.js";
import { registerModuleForUser } from "./library.js";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import { resolveModuleIdByName } from "../../../src/shared/agents/memory/database/moduleScope.js";
import path from "path";
import fs from "fs";

type ProgressCallback = (
  stage: string,
  progress: number,
  message: string
) => void;

async function purgeMissingModFromDatabase(
  modName: string,
  emailId?: string
): Promise<void> {
  if (!emailId) return;

  const prisma = getPrismaClient();
  const normalized = modName.trim().toLowerCase();

  await prisma.$transaction(async (tx) => {
    const ownedModules = await tx.module.findMany({
      where: {
        ownerEmailId: emailId,
        moduleNameNormalized: normalized,
      },
      select: { moduleId: true },
    });

    if (ownedModules.length > 0) {
      const moduleIds = ownedModules.map((module) => module.moduleId);
      await tx.userModuleDeleted.deleteMany({
        where: { moduleId: { in: moduleIds } },
      });
      await tx.userModuleLibrary.deleteMany({
        where: { moduleId: { in: moduleIds } },
      });
      await tx.modulePermission.deleteMany({
        where: { moduleId: { in: moduleIds } },
      });
      await tx.module.deleteMany({
        where: { moduleId: { in: moduleIds } },
      });
      await tx.modGeneration.deleteMany({
        where: {
          emailId,
          moduleName: modName,
        },
      });
      return;
    }

    const accessibleModuleRows = await tx.modulePermission.findMany({
      where: {
        emailId,
        module: {
          moduleNameNormalized: normalized,
        },
      },
      select: { moduleId: true },
    });

    if (accessibleModuleRows.length === 0) {
      return;
    }

    const moduleIds = accessibleModuleRows.map((row) => row.moduleId);
    await tx.userModuleDeleted.deleteMany({
      where: {
        emailId,
        moduleId: { in: moduleIds },
      },
    });
    await tx.userModuleLibrary.deleteMany({
      where: {
        emailId,
        moduleId: { in: moduleIds },
      },
    });
    await tx.modulePermission.deleteMany({
      where: {
        emailId,
        moduleId: { in: moduleIds },
      },
    });
  });
}

/**
 * Check if a module is a world-builder generated module
 */
function isWorldBuilderModule(modPath: string): boolean {
  const worldBuilderFiles = [
    "truth_timeline.json",
    "knowledge_matrix.json",
    "macro_scene.json",
  ];

  return worldBuilderFiles.every((file) =>
    fs.existsSync(path.join(modPath, file))
  );
}

/**
 * Load mod data from directory
 * @param db - Database instance
 * @param modName - Name of the mod to load
 * @param onProgress - Optional progress callback for SSE
 */
export async function loadMod(
  db: CoCDatabase | CoCDatabaseAdapter,
  modName: string,
  emailId?: string,
  onProgress?: ProgressCallback
): Promise<any> {
  const modsDir = path.join(process.cwd(), "data", "Mods");
  const modPath = path.join(modsDir, modName);

  if (!fs.existsSync(modPath)) {
    await purgeMissingModFromDatabase(modName, emailId);
    throw new Error(`Mod "${modName}" not found`);
  }

  if (emailId) {
    await registerModuleForUser(emailId, modName);
  }
  await clearExistingModData(emailId, modName);

  onProgress?.("Initializing", 10, "Initializing loaders...");

  // Check if this is a world-builder generated module
  if (isWorldBuilderModule(modPath)) {
    console.log(`Detected world-builder module: ${modName}`);
    onProgress?.("Loading", 20, "Loading world-builder module...");

    const worldModuleLoader = new WorldModuleLoader(db, { emailId: emailId });
    const loadedModule = await worldModuleLoader.loadAndSaveWorldModule(
      modPath,
      true
    );

    if (!loadedModule) {
      throw new Error("Failed to load world-builder module");
    }

    const scenariosLoaded = loadedModule.scenarios.length;
    const npcsLoaded = loadedModule.npcs.length;
    const modulesLoaded = 1;

    onProgress?.(
      "Complete",
      100,
      `Loaded ${scenariosLoaded} scenarios, ${npcsLoaded} NPCs, ${modulesLoaded} modules`
    );

    return {
      success: true,
      message: `World-builder mod loaded: ${scenariosLoaded} scenarios, ${npcsLoaded} NPCs, ${modulesLoaded} modules`,
      scenariosLoaded,
      npcsLoaded,
      modulesLoaded,
      timestamp: new Date().toISOString(),
      worldBuilderModule: true,
    };
  }

  // Regular module loading (old format)
  console.log(`Loading regular module: ${modName}`);

  const scenarioLoader = new ScenarioLoader(db, undefined, {
    emailId: emailId,
    moduleName: modName,
  });
  const npcLoader = new NPCLoader(db, undefined, undefined, {
    emailId: emailId,
  });
  const moduleLoader = new ModuleLoader(db, undefined, { emailId: emailId });

  onProgress?.("Scanning", 15, "Scanning mod directory...");

  const subdirs = fs
    .readdirSync(modPath, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  const scenarioDirs = subdirs.filter((name) =>
    name.toLowerCase().includes("scenario")
  );
  const npcDirs = subdirs.filter((name) => name.toLowerCase().includes("npc"));
  const backgroundDirs = subdirs.filter(
    (name) =>
      name.toLowerCase().includes("background") ||
      name.toLowerCase().includes("module")
  );

  let scenariosLoaded = 0;
  let npcsLoaded = 0;
  let modulesLoaded = 0;

  // Load scenarios
  if (scenarioDirs.length > 0) {
    onProgress?.("Loading Scenarios", 30, "Loading scenario data...");
    for (const dir of scenarioDirs) {
      const scenarios = await scenarioLoader.loadScenariosFromJSONDirectory(
        path.join(modPath, dir),
        false
      );
      scenariosLoaded += scenarios.length;
    }
  }

  // Load NPCs
  if (npcDirs.length > 0) {
    onProgress?.("Loading NPCs", 50, "Loading NPC data...");
    for (const dir of npcDirs) {
      const npcs = await npcLoader.loadNPCsFromJSONDirectory(
        path.join(modPath, dir),
        false
      );
      npcsLoaded += npcs.length;
    }
  }

  // Load modules
  if (backgroundDirs.length > 0) {
    onProgress?.("Loading Modules", 70, "Loading module data...");
    for (const dir of backgroundDirs) {
      const moduleDir = path.join(modPath, dir);
      const jsonFiles = fs
        .readdirSync(moduleDir)
        .filter((f) => f.toLowerCase().endsWith(".json"));

      const modules =
        jsonFiles.length > 0
          ? await moduleLoader.loadModulesFromJSONDirectory(moduleDir, false)
          : await moduleLoader.loadModulesFromDirectory(moduleDir, false);
      modulesLoaded += modules.length;
    }
  }

  onProgress?.(
    "Complete",
    100,
    `Loaded ${scenariosLoaded} scenarios, ${npcsLoaded} NPCs, ${modulesLoaded} modules`
  );

  return {
    success: true,
    message: `Mod data loaded: ${scenariosLoaded} scenarios, ${npcsLoaded} NPCs, ${modulesLoaded} modules`,
    scenariosLoaded,
    npcsLoaded,
    modulesLoaded,
    timestamp: new Date().toISOString(),
    worldBuilderModule: false,
  };
}

async function clearExistingModData(
  emailId?: string,
  modName?: string
): Promise<void> {
  if (!emailId) throw new Error("emailId is required for clearExistingModData");

  const prisma = getPrismaClient();
  const moduleId = modName
    ? await resolveModuleIdByName(modName, emailId)
    : null;
  const noMatchModuleId = "00000000-0000-0000-0000-000000000000";

  // Delete in FK-respecting order within a transaction
  await prisma.$transaction([
    prisma.scenarioClue.deleteMany({
      where: moduleId ? { moduleId } : { moduleId: noMatchModuleId },
    }),
    prisma.scenarioCondition.deleteMany({
      where: moduleId ? { moduleId } : { moduleId: noMatchModuleId },
    }),
    prisma.scenarioCharacter.deleteMany({
      where: moduleId ? { moduleId } : { moduleId: noMatchModuleId },
    }),
    prisma.scenarioSnapshot.deleteMany({
      where: moduleId ? { moduleId } : { moduleId: noMatchModuleId },
    }),
    prisma.scenario.deleteMany({
      where: moduleId ? { moduleId } : { moduleId: noMatchModuleId },
    }),
    prisma.moduleBackground.deleteMany({
      where: moduleId ? { moduleId } : { moduleId: noMatchModuleId },
    }),
    prisma.npcRelationship.deleteMany({ where: { emailId } }),
    prisma.npcClue.deleteMany({ where: { emailId } }),
    prisma.relationship.deleteMany({ where: { emailId } }),
    prisma.character.deleteMany({ where: { isNpc: true, emailId } }),
  ]);
}
