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

// World builder endpoints
router.post("/module/generate-world", worldBuilderController.generateWorld);
router.post("/module/generate-scene", worldBuilderController.generateScene);
router.post("/module/generate-npcs", worldBuilderController.generateNpcs);

export default router;
