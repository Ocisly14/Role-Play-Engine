import type { Request, Response } from "express";
import { DatabaseManager } from "../../core/DatabaseManager.js";
import { multiplayerSessionStore } from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.js";
import { initMultiplayerGame } from "./service.js";

/**
 * POST /api/multiplayer/rooms/:roomId/game/init
 * Host calls this after startGame succeeds (room status = "playing").
 * Loads module + all characters into a MultiplayerDynamicGameState.
 */
export async function initGame(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const email = req.user!.email;
    const { roomId } = req.params;

    const db = DatabaseManager.getInstance().getDatabase();
    const result = await initMultiplayerGame(db, roomId, userId, email);

    res.status(201).json({ success: true, ...result });
  } catch (error) {
    console.error("[MultiplayerGame] initGame error:", error);
    const msg = (error as Error).message;
    const status =
      msg.includes("Only the host") ? 403
      : msg.includes("not found") ? 404
      : 400;
    res.status(status).json({ success: false, error: msg });
  }
}

/**
 * GET /api/multiplayer/rooms/:roomId/game/state
 * Returns a lightweight summary of the in-memory game state for a room.
 * Used by the client to confirm initialisation and get the initial sceneRoomId.
 */
export async function getGameState(req: Request, res: Response): Promise<void> {
  try {
    const { roomId } = req.params;

    const manager = multiplayerSessionStore.get(roomId);
    if (!manager) {
      res.status(404).json({ success: false, error: "Game not initialised for this room" });
      return;
    }

    const s = manager.getState();
    res.json({
      success: true,
      sessionId: s.sessionId,
      moduleName: s.moduleName,
      gameDay: s.gameDay,
      timeOfDay: s.timeOfDay,
      isBattle: s.isBattle,
      gameEnding: s.gameEnding,
      sceneRooms: Object.keys(s.sceneRooms).map((id) => {
        const sr = s.sceneRooms[id];
        return {
          sceneRoomId: id,
          scenarioName: sr.scenarioName,
          roundNumber: sr.roundNumber,
          memberPlayerIds: sr.memberPlayerIds,
        };
      }),
    });
  } catch (error) {
    console.error("[MultiplayerGame] getGameState error:", error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}
