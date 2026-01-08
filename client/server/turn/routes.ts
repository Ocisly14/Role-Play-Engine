import { Router } from "express";
import * as turnController from "./controller.js";

const router = Router();

// Turn management endpoints
router.post("/turns", turnController.createTurn);
router.get("/turns/:turnId", turnController.getTurnStatus);
router.get("/sessions/:sessionId/conversation", turnController.getConversation);
router.get("/sessions/:sessionId/turns", turnController.getTurnHistory);

export default router;
