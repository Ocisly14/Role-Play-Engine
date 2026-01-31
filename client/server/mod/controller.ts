import type { Request, Response } from "express";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { loadMod } from "./service.js";
import { ModuleLoader } from "../../../src/coc_multiagents_system/agents/memory/moduleloader/index.js";
import { WorldModuleLoader } from "../../../src/dynamicworldagent/world_builder/worldModuleLoader.js";
import path from "path";
import fs from "fs";

/**
 * Check if a module is a world-builder generated module
 * by checking for world-builder specific files
 */
function isWorldBuilderModule(modPath: string): boolean {
  const worldBuilderFiles = [
    "truth_timeline.json",
    "knowledge_matrix.json",
    "macro_scene.json"
  ];

  return worldBuilderFiles.every(file =>
    fs.existsSync(path.join(modPath, file))
  );
}

/**
 * Load mod data (scenarios, NPCs, modules)
 * POST /api/mod/load
 */
export async function loadModData(req: Request, res: Response): Promise<void> {
  const useSSE = req.headers.accept?.includes('text/event-stream') || req.query.stream === 'true';

  if (useSSE) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
  }

  try {
    const { modName } = req.body;

    if (!modName || typeof modName !== 'string') {
      if (useSSE) {
        res.write(`data: ${JSON.stringify({ stage: "Error", progress: 0, message: "modName is required" })}\n\n`);
        res.end();
      } else {
        res.status(400).json({ error: "modName is required" });
      }
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase();

    // Load mod with progress reporting
    const result = await loadMod(db, modName, (stage, progress, message) => {
      if (useSSE) {
        res.write(`data: ${JSON.stringify({ stage, progress, message })}\n\n`);
      }
    });

    if (useSSE) {
      res.write(`data: ${JSON.stringify({ ...result, stage: "Complete", progress: 100 })}\n\n`);
      res.end();
    } else {
      res.json(result);
    }
  } catch (error) {
    console.error("Error loading mod data:", error);
    const errorMessage = "Failed to load mod data: " + (error as Error).message;
    if (useSSE) {
      res.write(`data: ${JSON.stringify({ stage: "Error", progress: 0, message: errorMessage })}\n\n`);
      res.end();
    } else {
      res.status(500).json({ error: errorMessage });
    }
  }
}

/**
 * Get module introduction (without starting game)
 * GET /api/module/introduction
 */
export async function getModuleIntroduction(req: Request, res: Response): Promise<void> {
  try {
    const { modName } = req.query;

    if (!modName || typeof modName !== 'string') {
      res.status(400).json({ error: "modName is required" });
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase();

    const modsDir = path.join(process.cwd(), "data", "Mods");
    const modPath = path.join(modsDir, modName);

    if (!fs.existsSync(modPath)) {
      res.status(404).json({ error: `Mod "${modName}" not found` });
      return;
    }

    // Check if this is a world-builder generated module
    if (isWorldBuilderModule(modPath)) {
      console.log(`Loading world-builder module: ${modName}`);

      const worldModuleLoader = new WorldModuleLoader(db);
      const loadedModule = await worldModuleLoader.loadAndSaveWorldModule(modPath, false);

      if (!loadedModule) {
        // Module hasn't changed, get from database
        const moduleLoader = new ModuleLoader(db);
        const modules = moduleLoader.getAllModules();
        const module = modules.find(m => m.title === modName);

        if (!module) {
          res.status(404).json({ error: "Module not found in database" });
          return;
        }

        const moduleIntroduction = module.introduction ? {
          introduction: module.introduction,
          moduleNotes: module.moduleNotes || ""
        } : null;

        res.json({
          success: true,
          moduleIntroduction: moduleIntroduction,
          moduleTitle: module.title,
        });
      } else {
        // Freshly loaded world module
        const moduleIntroduction = loadedModule.moduleDigest.introduction ? {
          introduction: loadedModule.moduleDigest.introduction,
          moduleNotes: loadedModule.moduleDigest.moduleNotes || ""
        } : null;

        res.json({
          success: true,
          moduleIntroduction: moduleIntroduction,
          moduleTitle: loadedModule.moduleName,
        });
      }
    } else {
      // Regular module (old format)
      console.log(`Loading regular module: ${modName}`);

      const moduleLoader = new ModuleLoader(db);

      // Load module data
      const moduleDigestPath = path.join(modPath, "module_digest.json");
      if (fs.existsSync(moduleDigestPath)) {
        await moduleLoader.loadModuleFromJSON(moduleDigestPath);
      }

      const modules = moduleLoader.getAllModules();
      if (modules.length === 0) {
        res.status(404).json({ error: "No module data found" });
        return;
      }

      const module = modules[0];
      const moduleIntroduction = module.introduction ? {
        introduction: module.introduction,
        moduleNotes: module.moduleNotes || ""
      } : null;

      res.json({
        success: true,
        moduleIntroduction: moduleIntroduction,
        moduleTitle: module.title,
      });
    }
  } catch (error) {
    console.error("Error getting module introduction:", error);
    res.status(500).json({ error: "Failed to get module introduction: " + (error as Error).message });
  }
}
