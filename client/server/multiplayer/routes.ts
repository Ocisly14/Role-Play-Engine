import { Router } from "express";
import { authenticate } from "../auth/middleware.js";
import * as roomController from "./room/controller.js";
import * as gameController from "./game/controller.js";
import * as turnController from "./turn/controller.js";
import * as checkpointController from "./checkpoint/controller.js";
import * as memoController from "../memos/controller.js";
import sceneRoomRoutes from "./sceneroom/routes.js";

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
router.get("/rooms/:roomId/gamestate", gameController.getPlayerState);
router.post("/rooms/:roomId/game/update-language", gameController.updateLanguage);

// Turn input collection (Phase 3)
router.post("/rooms/:roomId/scene-rooms/:sceneRoomId/input", turnController.submitInput);
router.get("/rooms/:roomId/scene-rooms/:sceneRoomId/round", turnController.getRound);
router.get("/rooms/:roomId/scene-rooms/:sceneRoomId/round-result", turnController.getRoundResult);
router.get("/rooms/:roomId/scene-rooms/:sceneRoomId/turns", turnController.getTurnHistory);
router.get("/rooms/:roomId/scene-rooms/:sceneRoomId/turns/:turnId/status", turnController.getTurnStatus);

// Scene room listing
router.use("/rooms/:roomId/scene-rooms-list", sceneRoomRoutes);

// Skill selection (two-phase commit)
router.post("/rooms/:roomId/scene-rooms/:sceneRoomId/skill-selection", turnController.submitSkillSelection);

// Checkpoint — cross-room listing (must precede :roomId routes)
router.get("/checkpoints/mine", checkpointController.listMyCheckpoints);

// Checkpoint save/load (host-only for save/load/delete, any member for list)
router.post("/rooms/:roomId/checkpoints/save", checkpointController.saveCheckpoint);
router.get("/rooms/:roomId/checkpoints", checkpointController.listCheckpoints);
router.post("/rooms/:roomId/checkpoints/load", checkpointController.loadCheckpoint);
router.delete("/rooms/:roomId/checkpoints/:checkpointId", checkpointController.deleteCheckpoint);

// Game stop/abandon (host-only)
router.post("/rooms/:roomId/game/stop", gameController.stopGame);

// Skill suggestion (both paths: frontend hook calls /skills/suggest, keep /game/skills/suggest for compat)
router.post("/rooms/:roomId/skills/suggest", gameController.suggestSkills);
router.post("/rooms/:roomId/game/skills/suggest", gameController.suggestSkills);

// Player memos (reuses existing memo CRUD — clients pass sessionId in query/body)
router.get("/rooms/:roomId/memos", memoController.listMemos);
router.post("/rooms/:roomId/memos", memoController.createMemo);
router.put("/rooms/:roomId/memos/:memoId", memoController.updateMemo);
router.delete("/rooms/:roomId/memos/:memoId", memoController.deleteMemo);

// RAG Q&A (both paths: frontend calls /rag/ask, keep /game/rag/ask for compat)
router.post("/rooms/:roomId/rag/ask", gameController.askRag);
router.post("/rooms/:roomId/game/rag/ask", gameController.askRag);

export { router as multiplayerRoutes };
