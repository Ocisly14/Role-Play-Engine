import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as characterController from "./characterController.js";
import * as simulationController from "./controller.js";
import * as mapController from "./mapController.js";
import * as playerController from "./playerController.js";

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
router.delete("/simulation/:id", simulationController.deleteSimulation);
router.get("/simulations", simulationController.listSimulations);
router.get(
  "/simulation/resolve/:moduleName",
  simulationController.resolveByModuleName
);

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

// Single-player: the one character the player lives as
router.get("/simulation/:id/player", playerController.getPlayer);
router.post("/simulation/:id/player/input", playerController.submitInput);
router.post("/simulation/:id/player/continue", playerController.continuePlayer);
router.post("/simulation/:id/player/answer", playerController.answerFriend);
router.put("/simulation/:id/player/mode", playerController.setMode);
router.put("/simulation/:id/player/queue", playerController.replaceQueue);
router.post("/simulation/:id/player/memories", playerController.editMemory);

export default router;
