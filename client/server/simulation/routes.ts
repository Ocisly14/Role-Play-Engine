import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as characterController from "./characterController.js";
import * as simulationController from "./controller.js";
import * as mapController from "./mapController.js";

const router = Router();

// All simulation routes require authentication
router.use(authenticate);

// Simulation lifecycle
router.post("/simulation", simulationController.createSimulation);
router.post("/simulation/:id/start", simulationController.startSimulation);
router.post("/simulation/:id/pause", simulationController.pauseSimulation);
router.post("/simulation/:id/resume", simulationController.resumeSimulation);
router.post("/simulation/:id/step", simulationController.stepSimulation);
router.post("/simulation/:id/stop", simulationController.stopSimulation);
router.get("/simulation/:id/status", simulationController.getStatus);
router.get("/simulation/:id/events", simulationController.getEvents);
router.get("/simulations", simulationController.listSimulations);

// Configuration
router.put("/simulation/:id/config", mapController.updateConfig);

// Character management
router.post("/simulation/:id/characters", characterController.injectCharacter);
router.get(
  "/simulation/:id/characters",
  characterController.listInjectedCharacters
);
router.put(
  "/simulation/:id/characters/:charId/intent",
  characterController.updateIntent
);
router.delete(
  "/simulation/:id/characters/:charId",
  characterController.removeCharacter
);

export default router;
