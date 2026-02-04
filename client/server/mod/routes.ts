import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as modController from "./controller.js";
import * as worldBuilderController from "./worldBuilder.js";

const router = Router();

// Apply authentication to all routes
router.use(authenticate);

// Mod management endpoints
router.post("/mod/load", modController.loadModData);
router.get("/module/introduction", modController.getModuleIntroduction);
router.get("/mods/shared", modController.getSharedMods);
router.get("/mods/quota", modController.getModQuota);
router.post("/mods/share", modController.shareMod);
router.post("/mods/unshare", modController.unshareMod);
router.post("/mods/delete", modController.removeMod);
router.post("/mods/delete-bulk", modController.removeModsBulk);
router.post("/mods/add", modController.addSharedMod);
router.get("/mods/deleted", modController.getDeletedMods);
router.post("/mods/restore", modController.restoreMod);
router.post("/mods/restore-bulk", modController.restoreModsBulk);

// World builder endpoints
router.post("/module/generate-world", worldBuilderController.generateWorld);
router.post("/module/generate-scene", worldBuilderController.generateScene);
router.post("/module/generate-npcs", worldBuilderController.generateNpcs);

export default router;
