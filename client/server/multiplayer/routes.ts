import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as roomController from "./room/controller.js";
import * as gameController from "./game/controller.js";
import * as turnController from "./turn/controller.js";
import * as checkpointController from "./checkpoint/controller.js";

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
router.post("/rooms/:roomId/unconfirm", roomController.unconfirmReady);
router.post("/rooms/:roomId/start", roomController.startGame);

// Game lifecycle (Phase 2)
router.post("/rooms/:roomId/game/init", gameController.initGame);
router.get("/rooms/:roomId/game/state", gameController.getGameState);

// Turn input collection (Phase 3)
router.post("/rooms/:roomId/scene-rooms/:sceneRoomId/input", turnController.submitInput);
router.get("/rooms/:roomId/scene-rooms/:sceneRoomId/round", turnController.getRound);

// Checkpoint save/load (host-only for save/load/delete, any member for list)
router.post("/rooms/:roomId/checkpoints/save", checkpointController.saveCheckpoint);
router.get("/rooms/:roomId/checkpoints", checkpointController.listCheckpoints);
router.post("/rooms/:roomId/checkpoints/load", checkpointController.loadCheckpoint);
router.delete("/rooms/:roomId/checkpoints/:checkpointId", checkpointController.deleteCheckpoint);

export { router as multiplayerRoutes };
