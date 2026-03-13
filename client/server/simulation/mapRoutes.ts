import { Router } from "express";
import * as mapController from "./mapController.js";

const router = Router();

// Map viewer endpoints — unauthenticated (read-only public viewer)
router.get("/simulation/:id/topology", mapController.getTopology);
router.get("/simulation/:id/map-layout", mapController.getMapLayout);
router.get("/simulation/:id/positions", mapController.getPositions);
router.get("/simulation/:id/npc-statuses", mapController.getNpcStatuses);

export default router;
