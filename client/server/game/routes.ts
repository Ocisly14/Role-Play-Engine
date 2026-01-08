import { Router } from "express";
import * as gameController from "./controller.js";

const router = Router();

// Game lifecycle endpoints
router.post("/game/start", gameController.startGame);
router.post("/game/stop", gameController.stopGame);
router.post("/game/import-data", gameController.importGameData);
router.get("/gamestate", gameController.getGameState);

export default router;
