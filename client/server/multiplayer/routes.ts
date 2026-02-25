import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as roomController from "./room/controller.js";

const router = Router();
router.use(authenticate);

// Room management
router.post("/rooms/create", roomController.createRoom);
router.post("/rooms/join", roomController.joinRoom);
router.get("/rooms/mine", roomController.listMyRooms);
router.get("/rooms/:roomId/overview", roomController.getRoomOverview);
router.post("/rooms/:roomId/select-module", roomController.selectModule);
router.post("/rooms/:roomId/select-character", roomController.selectCharacter);
router.post("/rooms/:roomId/confirm", roomController.confirmReady);
router.post("/rooms/:roomId/start", roomController.startGame);

export { router as multiplayerRoutes };
