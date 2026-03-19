import { Router } from "express";
import { authenticate, requireRole } from "../auth/middleware.js";
import * as modController from "./controller.js";

const router = Router();

// Apply authentication to all routes
router.use(authenticate);

// Mod management endpoints
router.post("/mod/load", modController.loadModData);
router.get("/mods/shared", modController.getSharedMods);
router.get(
  "/mods/admin/catalog",
  requireRole("ADMIN"),
  modController.getAdminModsCatalog
);
router.post(
  "/mods/admin/add-to-all",
  requireRole("ADMIN"),
  modController.addModToAllUsers
);
router.post("/mods/share", modController.shareMod);
router.post("/mods/unshare", modController.unshareMod);
router.post("/mods/delete", modController.removeMod);
router.post("/mods/delete-bulk", modController.removeModsBulk);
router.post("/mods/add", modController.addSharedMod);
router.get("/mods/deleted", modController.getDeletedMods);
router.post("/mods/restore", modController.restoreMod);
router.post("/mods/restore-bulk", modController.restoreModsBulk);

export default router;
