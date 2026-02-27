import type { Request, Response } from "express";
import { DatabaseManager } from "../../core/DatabaseManager.js";
import { multiplayerSessionStore } from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.js";
import { getPrismaClient } from "../../../../src/shared/agents/memory/database/prismaClient.js";
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
      isBattle: Object.values(s.sceneRooms).some((sr) => sr.isBattle),
      gameEnding: s.gameEnding,
      sceneRooms: Object.keys(s.sceneRooms).map((id) => {
        const sr = s.sceneRooms[id];
        return {
          sceneRoomId: id,
          scenarioName: sr.scenarioName,
          roundNumber: sr.roundNumber,
          memberPlayerIds: sr.memberPlayerIds,
          isBattle: sr.isBattle ?? false,
        };
      }),
    });
  } catch (error) {
    console.error("[MultiplayerGame] getGameState error:", error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * GET /api/multiplayer/rooms/:roomId/gamestate
 * Returns per-player game state in the same shape GameSidebar expects.
 */
export async function getPlayerState(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId } = req.params;

    const manager = multiplayerSessionStore.get(roomId);
    if (!manager) {
      res.status(404).json({ success: false, error: "Game not initialised for this room" });
      return;
    }

    const state = manager.getState();
    const player = state.players[userId];
    if (!player) {
      res.status(404).json({ success: false, error: "Player not found in game state" });
      return;
    }

    const sceneRoom = state.sceneRooms[player.currentSceneRoomId];

    // Build a GameState-compatible response for GameSidebar
    const gameState: Record<string, any> = {
      playerCharacter: player.profile,
      discoveredClues: (state.discoveredClues ?? []).filter(
        (c: any) => !c.discoveredBy || c.discoveredBy === player.characterName
      ),
      currentScenario: sceneRoom?.currentScenario ?? null,
      gameDay: sceneRoom?.gameDay ?? state.gameDay,
      timeOfDay: sceneRoom?.timeOfDay ?? state.timeOfDay,
      gameEnding: state.gameEnding,
      moduleName: state.moduleName,
      isBattle: sceneRoom?.isBattle ?? false,
      staminaState: player.staminaState,
      npcCharacters: state.npcCharacters ?? [],
    };

    res.json({ success: true, gameState });
  } catch (error) {
    console.error("[MultiplayerGame] getPlayerState error:", error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}
