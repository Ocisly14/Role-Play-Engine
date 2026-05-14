import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as dataController from "./controller.js";

const router = Router();

// Static data endpoints
router.get("/occupations", dataController.getOccupations);
router.get("/weapons", dataController.getWeapons);
router.get("/mods", authenticate, dataController.getMods);

export default router;
