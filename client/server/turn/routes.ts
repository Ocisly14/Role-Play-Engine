import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as turnController from "./controller.js";

const router = Router();

// Turn management endpoints
router.use(authenticate);
router.post("/turns", turnController.createTurn);
router.post("/rest", turnController.restAction);
router.get("/turns/:turnId", turnController.getTurnStatus);
router.get("/sessions/latest", turnController.getLatestSession);
router.get("/sessions/:sessionId/conversation", turnController.getConversation);
router.get("/sessions/:sessionId/turns", turnController.getTurnHistory);

export default router;
