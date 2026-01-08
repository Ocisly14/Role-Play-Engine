import { Router } from "express";
import * as modController from "./controller.js";

const router = Router();

// Mod management endpoints
router.post("/mod/load", modController.loadModData);
router.get("/module/introduction", modController.getModuleIntroduction);

export default router;
