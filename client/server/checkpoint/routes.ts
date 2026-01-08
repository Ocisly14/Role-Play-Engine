import { Router } from "express";
import * as checkpointController from "./controller.js";

const router = Router();

// Checkpoint endpoints
router.post("/checkpoints/save", checkpointController.saveCheckpoint);
router.get("/checkpoints/list", checkpointController.listCheckpoints);
router.post("/checkpoints/load", checkpointController.loadCheckpointData);

export default router;
