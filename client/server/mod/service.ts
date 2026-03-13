import fs from "fs";
import path from "path";
import { WorldModuleLoader } from "../../../src/dynamicworldagent/state/worldModuleLoader.js";
import { NPCLoader } from "../../../src/shared/agents/character/npcloader/index.js";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../../src/shared/agents/memory/database/index.js";
import { resolveModuleIdByName } from "../../../src/shared/agents/memory/database/moduleScope.js";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import { ModuleLoader } from "../../../src/shared/agents/memory/moduleloader/index.js";
import { registerModuleForUser } from "./library.js";

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
  const moduleName = path.basename(modPath);
  return (
    fs.existsSync(path.join(modPath, "module_setup.json")) &&
    fs.existsSync(path.join(modPath, "scenarios_outline.json")) &&
    fs.existsSync(path.join(modPath, `${moduleName}_Scenarios`))
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

    const scenariosLoaded = loadedModule.importStats.scenariosLoaded;
    const npcsLoaded = loadedModule.importStats.npcsLoaded;
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

  const npcLoader = new NPCLoader(db, undefined, undefined, {
    emailId: emailId,
  });
  const moduleLoader = new ModuleLoader(db, undefined, { emailId: emailId });

  onProgress?.("Scanning", 15, "Scanning mod directory...");

  const subdirs = fs
    .readdirSync(modPath, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  const npcDirs = subdirs.filter((name) => name.toLowerCase().includes("npc"));
  const backgroundDirs = subdirs.filter(
    (name) =>
      name.toLowerCase().includes("background") ||
      name.toLowerCase().includes("module")
  );

  let npcsLoaded = 0;
  let modulesLoaded = 0;

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
    `Loaded ${npcsLoaded} NPCs, ${modulesLoaded} modules`
  );

  return {
    success: true,
    message: `Mod data loaded: ${npcsLoaded} NPCs, ${modulesLoaded} modules`,
    scenariosLoaded: 0,
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
    prisma.scenarioCondition.deleteMany({
      where: moduleId ? { moduleId } : { moduleId: noMatchModuleId },
    }),
    prisma.scenario.deleteMany({
      where: moduleId ? { moduleId } : { moduleId: noMatchModuleId },
    }),
    prisma.moduleBackground.deleteMany({
      where: moduleId ? { moduleId } : { moduleId: noMatchModuleId },
    }),
    prisma.npcRelationship.deleteMany({ where: { emailId } }),
    prisma.character.deleteMany({ where: { isNpc: true, emailId } }),
  ]);
}
