import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as checkpointController from "./controller.js";

const router = Router();

// Checkpoint endpoints
router.use(authenticate);
router.post("/checkpoints/save", checkpointController.saveCheckpoint);
router.get("/checkpoints/list", checkpointController.listCheckpoints);
router.post("/checkpoints/load", checkpointController.loadCheckpointData);
router.delete("/checkpoints/:checkpointId", checkpointController.deleteCheckpoint);

export default router;
