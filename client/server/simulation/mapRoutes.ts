import { Router } from "express";
import * as simulationController from "./controller.js";
import * as mapController from "./mapController.js";

const router = Router();

// Public simulation viewer endpoints — unauthenticated and read-only
router.get(
  "/simulation/resolve/:moduleName",
  simulationController.resolveByModuleNamePublic
);
router.get("/simulation/:id/topology", mapController.getTopology);
router.get("/simulation/:id/map-layout", mapController.getMapLayout);
router.get("/simulation/:id/positions", mapController.getPositions);
router.get("/simulation/:id/npc-statuses", mapController.getNpcStatuses);
router.get("/simulation/:id/status", simulationController.getStatus);
router.get(
  "/simulation/:id/playback-status",
  simulationController.getPlaybackStatus
);
router.get("/simulation/:id/events", simulationController.getEvents);

export default router;
