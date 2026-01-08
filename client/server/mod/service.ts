import type { CoCDatabase } from "../../../src/coc_multiagents_system/agents/memory/database/index.js";
import { ScenarioLoader } from "../../../src/coc_multiagents_system/agents/memory/scenarioloader/index.js";
import { NPCLoader } from "../../../src/coc_multiagents_system/agents/character/npcloader/index.js";
import { ModuleLoader } from "../../../src/coc_multiagents_system/agents/memory/moduleloader/index.js";
import path from "path";
import fs from "fs";

type ProgressCallback = (stage: string, progress: number, message: string) => void;

/**
 * Load mod data from directory
 * @param db - Database instance
 * @param modName - Name of the mod to load
 * @param onProgress - Optional progress callback for SSE
 */
export async function loadMod(
  db: CoCDatabase,
  modName: string,
  onProgress?: ProgressCallback
): Promise<any> {
  const modsDir = path.join(process.cwd(), "data", "Mods");
  const modPath = path.join(modsDir, modName);

  if (!fs.existsSync(modPath)) {
    throw new Error(`Mod "${modName}" not found`);
  }

  onProgress?.("Initializing", 10, "Initializing loaders...");

  const scenarioLoader = new ScenarioLoader(db);
  const npcLoader = new NPCLoader(db);
  const moduleLoader = new ModuleLoader(db);

  onProgress?.("Scanning", 15, "Scanning mod directory...");

  const subdirs = fs.readdirSync(modPath, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name);

  const scenarioDirs = subdirs.filter(name => name.toLowerCase().includes("scenario"));
  const npcDirs = subdirs.filter(name => name.toLowerCase().includes("npc"));
  const backgroundDirs = subdirs.filter(name =>
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
      const jsonFiles = fs.readdirSync(moduleDir).filter(f => f.toLowerCase().endsWith('.json'));

      const modules = jsonFiles.length > 0
        ? await moduleLoader.loadModulesFromJSONDirectory(moduleDir, false)
        : await moduleLoader.loadModulesFromDirectory(moduleDir, false);
      modulesLoaded += modules.length;
    }
  }

  onProgress?.("Complete", 100, `Loaded ${scenariosLoaded} scenarios, ${npcsLoaded} NPCs, ${modulesLoaded} modules`);

  return {
    success: true,
    message: `Mod data loaded: ${scenariosLoaded} scenarios, ${npcsLoaded} NPCs, ${modulesLoaded} modules`,
    scenariosLoaded,
    npcsLoaded,
    modulesLoaded,
    timestamp: new Date().toISOString(),
  };
}
