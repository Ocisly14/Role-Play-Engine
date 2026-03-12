import fs from "node:fs";
import path from "node:path";
/// <reference path="../types/express.d.ts" />
import type { Request, Response } from "express";
import { WorldModuleLoader } from "../../../src/dynamicworldagent/state/worldModuleLoader.js";
import { ModuleLoader } from "../../../src/shared/agents/memory/moduleloader/index.js";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { isNameSimilar } from "../utils/stringUtils.js";
import {
  addModuleToAllUsers,
  addSharedModuleToLibrary,
  listActiveModulesForAdmin,
  listDeletedMods,
  listSharedMods,
  removeModuleFromLibrary,
  restoreDeletedModule,
  shareModule,
  unshareModule,
} from "./library.js";
import { loadMod } from "./service.js";

/**
 * Check if a module is a world-builder generated module
 * by checking for world-builder specific files
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
 * Load mod data (scenarios, NPCs, modules)
 * POST /api/mod/load
 */
export async function loadModData(req: Request, res: Response): Promise<void> {
  const useSSE =
    req.headers.accept?.includes("text/event-stream") ||
    req.query.stream === "true";

  if (useSSE) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
  }

  try {
    const { modName } = req.body;

    if (!modName || typeof modName !== "string") {
      if (useSSE) {
        res.write(
          `data: ${JSON.stringify({ stage: "Error", progress: 0, message: "modName is required" })}\n\n`
        );
        res.end();
      } else {
        res.status(400).json({ error: "modName is required" });
      }
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase();
    const emailId = req.user?.email;

    // Load mod with progress reporting
    const result = await loadMod(
      db,
      modName,
      emailId,
      (stage, progress, message) => {
        if (useSSE) {
          res.write(
            `data: ${JSON.stringify({ stage, progress, message })}\n\n`
          );
        }
      }
    );

    if (useSSE) {
      res.write(
        `data: ${JSON.stringify({ ...result, stage: "Complete", progress: 100 })}\n\n`
      );
      res.end();
    } else {
      res.json(result);
    }
  } catch (error) {
    console.error("Error loading mod data:", error);
    const errorMessage = `Failed to load mod data: ${(error as Error).message}`;
    if (useSSE) {
      res.write(
        `data: ${JSON.stringify({ stage: "Error", progress: 0, message: errorMessage })}\n\n`
      );
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
export async function getModuleIntroduction(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { modName } = req.query;

    if (!modName || typeof modName !== "string") {
      res.status(400).json({ error: "modName is required" });
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase();
    const emailId = req.user?.email;

    const modsDir = path.join(process.cwd(), "data", "Mods");
    const modPath = path.join(modsDir, modName);

    if (!fs.existsSync(modPath)) {
      res.status(404).json({ error: `Mod "${modName}" not found` });
      return;
    }

    // Check if this is a world-builder generated module
    if (isWorldBuilderModule(modPath)) {
      console.log(`Loading world-builder module: ${modName}`);

      const worldModuleLoader = new WorldModuleLoader(db, { emailId: emailId });
      const loadedModule = await worldModuleLoader.loadAndSaveWorldModule(
        modPath,
        false
      );

      if (!loadedModule) {
        // Module hasn't changed, get from database
        const moduleLoader = new ModuleLoader(db, undefined, {
          emailId: emailId,
        });
        const modules = await moduleLoader.getAllModules();
        const normalizedModName = modName.trim().toLowerCase();
        const module =
          modules.find(
            (candidate) =>
              candidate.title?.trim().toLowerCase() === normalizedModName
          ) ||
          modules.find(
            (candidate) =>
              candidate.title && isNameSimilar(candidate.title, modName)
          ) ||
          modules[0];

        if (!module) {
          res.status(404).json({ error: "Module not found in database" });
          return;
        }

        const moduleIntroduction = module.introduction
          ? {
              introduction: module.introduction,
              moduleNotes: module.moduleNotes || "",
            }
          : null;

        res.json({
          success: true,
          moduleIntroduction: moduleIntroduction,
          moduleTitle: module.title,
        });
      } else {
        // Freshly loaded world module
        const moduleIntroduction = loadedModule.moduleDigest.introduction
          ? {
              introduction: loadedModule.moduleDigest.introduction,
              moduleNotes: loadedModule.moduleDigest.moduleNotes || "",
            }
          : null;

        res.json({
          success: true,
          moduleIntroduction: moduleIntroduction,
          moduleTitle: loadedModule.moduleName,
        });
      }
    } else {
      // Regular module (old format)
      console.log(`Loading regular module: ${modName}`);

      const moduleLoader = new ModuleLoader(db, undefined, {
        emailId: emailId,
      });

      // Load module data
      const moduleDigestPath = path.join(modPath, "module_digest.json");
      if (fs.existsSync(moduleDigestPath)) {
        await moduleLoader.loadModuleFromJSON(moduleDigestPath);
      }

      const modules = await moduleLoader.getAllModules();
      if (modules.length === 0) {
        res.status(404).json({ error: "No module data found" });
        return;
      }

      const normalizedModName = modName.trim().toLowerCase();
      const module =
        modules.find(
          (candidate) =>
            candidate.title?.trim().toLowerCase() === normalizedModName
        ) ||
        modules.find(
          (candidate) =>
            candidate.title && isNameSimilar(candidate.title, modName)
        ) ||
        modules[0];
      const moduleIntroduction = module.introduction
        ? {
            introduction: module.introduction,
            moduleNotes: module.moduleNotes || "",
          }
        : null;

      res.json({
        success: true,
        moduleIntroduction: moduleIntroduction,
        moduleTitle: module.title,
      });
    }
  } catch (error) {
    console.error("Error getting module introduction:", error);
    res.status(500).json({
      error: `Failed to get module introduction: ${(error as Error).message}`,
    });
  }
}

/**
 * List shared modules (searchable)
 * GET /api/mods/shared
 */
export async function getSharedMods(
  req: Request,
  res: Response
): Promise<void> {
  try {
    res.setHeader("Cache-Control", "no-store");
    const email = req.user?.email;
    if (!email) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const query = typeof req.query.q === "string" ? req.query.q : undefined;
    const mods = await listSharedMods(email, query);

    res.json({ success: true, mods });
  } catch (error) {
    console.error("Error listing shared mods:", error);
    res.status(500).json({
      error: `Failed to list shared mods: ${(error as Error).message}`,
    });
  }
}

/**
 * Share a module (owner only)
 * POST /api/mods/share
 */
export async function shareMod(req: Request, res: Response): Promise<void> {
  try {
    const email = req.user?.email;
    const { modName } = req.body;

    if (!email) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!modName || typeof modName !== "string") {
      res.status(400).json({ error: "modName is required" });
      return;
    }

    await shareModule(email, modName);

    res.json({ success: true, shared: true });
  } catch (error) {
    console.error("Error sharing mod:", error);
    res
      .status(500)
      .json({ error: `Failed to share mod: ${(error as Error).message}` });
  }
}

/**
 * Unshare a module (owner only)
 * POST /api/mods/unshare
 */
export async function unshareMod(req: Request, res: Response): Promise<void> {
  try {
    const email = req.user?.email;
    const { modName } = req.body;

    if (!email) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!modName || typeof modName !== "string") {
      res.status(400).json({ error: "modName is required" });
      return;
    }

    await unshareModule(email, modName);

    res.json({ success: true, shared: false });
  } catch (error) {
    console.error("Error unsharing mod:", error);
    res
      .status(500)
      .json({ error: `Failed to unshare mod: ${(error as Error).message}` });
  }
}

/**
 * Remove module from user's library
 * POST /api/mods/remove
 */
export async function removeMod(req: Request, res: Response): Promise<void> {
  try {
    const email = req.user?.email;
    const { modName } = req.body;

    if (!email) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!modName || typeof modName !== "string") {
      res.status(400).json({ error: "modName is required" });
      return;
    }

    const result = await removeModuleFromLibrary(email, modName);

    res.json({ success: true, removed: true, trashed: result.trashed });
  } catch (error) {
    console.error("Error removing mod:", error);
    res
      .status(500)
      .json({ error: `Failed to remove mod: ${(error as Error).message}` });
  }
}

/**
 * Remove multiple modules from user's library
 * POST /api/mods/remove-bulk
 */
export async function removeModsBulk(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const email = req.user?.email;
    const { modNames } = req.body as { modNames?: string[] };

    if (!email) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!Array.isArray(modNames) || modNames.length === 0) {
      res.status(400).json({ error: "modNames is required" });
      return;
    }

    const results = await Promise.all(
      modNames.map((modName) =>
        typeof modName === "string"
          ? removeModuleFromLibrary(email, modName)
          : Promise.resolve({ trashed: false })
      )
    );
    const trashedCount = results.filter((r) => r.trashed).length;

    res.json({ success: true, removed: true, trashedCount });
  } catch (error) {
    console.error("Error removing mods:", error);
    res
      .status(500)
      .json({ error: `Failed to remove mods: ${(error as Error).message}` });
  }
}

/**
 * Add shared module to user's library
 * POST /api/mods/add
 */
export async function addSharedMod(req: Request, res: Response): Promise<void> {
  try {
    const email = req.user?.email;
    const { modName } = req.body;

    if (!email) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!modName || typeof modName !== "string") {
      res.status(400).json({ error: "modName is required" });
      return;
    }

    await addSharedModuleToLibrary(email, modName);

    res.json({ success: true, added: true });
  } catch (error) {
    console.error("Error adding shared mod:", error);
    res
      .status(500)
      .json({ error: `Failed to add shared mod: ${(error as Error).message}` });
  }
}

/**
 * List active modules with IDs for admin tools
 * GET /api/mods/admin/catalog
 */
export async function getAdminModsCatalog(
  req: Request,
  res: Response
): Promise<void> {
  try {
    if (req.user?.role !== "ADMIN") {
      res.status(403).json({ error: "Admin permission required" });
      return;
    }

    const mods = await listActiveModulesForAdmin();
    res.json({ success: true, mods });
  } catch (error) {
    console.error("Error listing admin module catalog:", error);
    res.status(500).json({
      error: `Failed to list module catalog: ${(error as Error).message}`,
    });
  }
}

/**
 * Add one selected module to every active user's library (admin only)
 * POST /api/mods/admin/add-to-all
 */
export async function addModToAllUsers(
  req: Request,
  res: Response
): Promise<void> {
  try {
    if (req.user?.role !== "ADMIN") {
      res.status(403).json({ error: "Admin permission required" });
      return;
    }

    const { moduleId, modName } = req.body as {
      moduleId?: string;
      modName?: string;
    };

    if (
      (typeof moduleId !== "string" || !moduleId.trim()) &&
      (typeof modName !== "string" || !modName.trim())
    ) {
      res.status(400).json({ error: "moduleId or modName is required" });
      return;
    }

    const result = await addModuleToAllUsers({
      moduleId: typeof moduleId === "string" ? moduleId : undefined,
      modName: typeof modName === "string" ? modName : undefined,
    });

    res.json({
      success: true,
      moduleId: result.moduleId,
      moduleName: result.moduleName,
      totalUsers: result.totalUsers,
      affectedUsers: result.affectedUsers,
    });
  } catch (error) {
    console.error("Error adding module to all users:", error);
    const message = (error as Error).message;
    const statusCode = message.includes("required")
      ? 400
      : message.includes("Multiple modules")
        ? 400
        : message.includes("not found")
          ? 404
          : 500;

    res.status(statusCode).json({
      error: `Failed to add module to all users: ${message}`,
    });
  }
}

/**
 * List deleted modules for current user
 * GET /api/mods/deleted
 */
export async function getDeletedMods(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const email = req.user?.email;
    if (!email) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const mods = await listDeletedMods(email);

    res.json({ success: true, mods });
  } catch (error) {
    console.error("Error listing deleted mods:", error);
    res.status(500).json({
      error: `Failed to list deleted mods: ${(error as Error).message}`,
    });
  }
}

/**
 * Restore a deleted module (owner only)
 * POST /api/mods/restore
 */
export async function restoreMod(req: Request, res: Response): Promise<void> {
  try {
    const email = req.user?.email;
    const { modName } = req.body;

    if (!email) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!modName || typeof modName !== "string") {
      res.status(400).json({ error: "modName is required" });
      return;
    }

    await restoreDeletedModule(email, modName);

    res.json({ success: true, restored: true });
  } catch (error) {
    console.error("Error restoring mod:", error);
    res
      .status(500)
      .json({ error: `Failed to restore mod: ${(error as Error).message}` });
  }
}

/**
 * Restore multiple deleted modules
 * POST /api/mods/restore-bulk
 */
export async function restoreModsBulk(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const email = req.user?.email;
    const { modNames } = req.body as { modNames?: string[] };

    if (!email) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!Array.isArray(modNames) || modNames.length === 0) {
      res.status(400).json({ error: "modNames is required" });
      return;
    }

    for (const modName of modNames) {
      if (typeof modName !== "string") continue;
      await restoreDeletedModule(email, modName);
    }

    res.json({ success: true, restored: true });
  } catch (error) {
    console.error("Error restoring mods:", error);
    res
      .status(500)
      .json({ error: `Failed to restore mods: ${(error as Error).message}` });
  }
}

