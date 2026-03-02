import type { Request, Response } from "express";
import { multiplayerSessionStore } from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.js";

export async function listActiveSceneRooms(req: Request, res: Response) {
  try {
    const { roomId } = req.params;
    const manager = multiplayerSessionStore.get(roomId);
    if (!manager) {
      res.status(404).json({ success: false, error: "Game not found or not started" });
      return;
    }

    const state = manager.getState();
    const activeRooms = Object.values(state.sceneRooms)
      .filter((room) => !room.isFrozen)
      .map((room) => ({
        sceneRoomId: room.sceneRoomId,
        scenarioName: room.scenarioName,
        memberPlayerIds: room.memberPlayerIds,
        roundNumber: room.roundNumber,
        isBattle: room.isBattle,
        gameDay: room.gameDay,
        timeOfDay: room.timeOfDay,
      }));

    res.json({ success: true, sceneRooms: activeRooms });
  } catch (error) {
    console.error("Error listing scene rooms:", error);
    res.status(500).json({ success: false, error: "Failed to list scene rooms" });
  }
}
