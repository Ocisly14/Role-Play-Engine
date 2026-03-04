import type { Request, Response } from "express";
import { WebSocketManager } from "../../websocket/WebSocketManager.js";
import { notifyRoom } from "../../websocket/notifier.js";
import * as roomService from "./service.js";

function broadcastToRoom(roomId: string, message: object): void {
  const wsMgr = WebSocketManager.getInstance();
  if (!wsMgr) return;
  const clients = wsMgr.getRoomClients(roomId);
  if (clients.size > 0) {
    notifyRoom(roomId, clients, message);
  }
}

export async function createRoom(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { checkpointId } = (req.body ?? {}) as { checkpointId?: string };
    const result = await roomService.createRoom(userId, checkpointId);
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    console.error("[Multiplayer] createRoom error:", error);
    const msg = (error as Error).message;
    const status = msg.includes("not a player") || msg.includes("not found") ? 400 : 500;
    res.status(status).json({ success: false, error: msg });
  }
}

export async function joinRoom(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomCode } = req.body as { roomCode?: string };

    if (!roomCode || typeof roomCode !== "string" || roomCode.trim().length !== 5) {
      res.status(400).json({ success: false, error: "roomCode must be a 5-digit string" });
      return;
    }

    const result = await roomService.joinRoom(userId, roomCode.trim());
    res.json({ success: true, ...result });
    broadcastToRoom(result.roomId, { type: "room_member_joined", userId });
  } catch (error) {
    console.error("[Multiplayer] joinRoom error:", error);
    const msg = (error as Error).message;
    const status = msg.includes("not found") || msg.includes("not accepting") ? 404 : 400;
    res.status(status).json({ success: false, error: msg });
  }
}

export async function selectModule(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId } = req.params;
    const { moduleName } = req.body as { moduleName?: string };

    if (!moduleName) {
      res.status(400).json({ success: false, error: "moduleName is required" });
      return;
    }

    await roomService.selectModule(roomId, userId, moduleName);
    res.json({ success: true });
    broadcastToRoom(roomId, { type: "room_module_selected", moduleName });
  } catch (error) {
    console.error("[Multiplayer] selectModule error:", error);
    const msg = (error as Error).message;
    const status = msg.includes("Only the host") ? 403 : msg.includes("not found") ? 404 : 400;
    res.status(status).json({ success: false, error: msg });
  }
}

export async function selectCharacter(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId } = req.params;
    const { characterId } = req.body as { characterId?: string };

    if (!characterId) {
      res.status(400).json({ success: false, error: "characterId is required" });
      return;
    }

    await roomService.selectCharacter(roomId, userId, characterId);
    res.json({ success: true });
    broadcastToRoom(roomId, { type: "room_character_selected", userId, characterId });
  } catch (error) {
    console.error("[Multiplayer] selectCharacter error:", error);
    const msg = (error as Error).message;
    const status = msg.includes("not a member") ? 403 : msg.includes("not found") ? 404 : 400;
    res.status(status).json({ success: false, error: msg });
  }
}

export async function confirmReady(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId } = req.params;

    await roomService.confirmReady(roomId, userId);
    res.json({ success: true });
    broadcastToRoom(roomId, { type: "room_member_confirmed", userId });
  } catch (error) {
    console.error("[Multiplayer] confirmReady error:", error);
    const msg = (error as Error).message;
    const status = msg.includes("not a member") ? 403 : 400;
    res.status(status).json({ success: false, error: msg });
  }
}

export async function unconfirmReady(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId } = req.params;

    await roomService.unconfirmReady(roomId, userId);
    res.json({ success: true });
    broadcastToRoom(roomId, { type: "room_member_unconfirmed", userId });
  } catch (error) {
    console.error("[Multiplayer] unconfirmReady error:", error);
    const msg = (error as Error).message;
    const status = msg.includes("not a member") ? 403 : 400;
    res.status(status).json({ success: false, error: msg });
  }
}

export async function startGame(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId } = req.params;

    await roomService.startGame(roomId, userId);
    res.json({ success: true });
    // NOTE: room_game_starting is broadcast from game/controller.ts (initGame)
    // or checkpoint/controller.ts (loadCheckpoint) AFTER the game state is ready,
    // so non-host players don't navigate before the state exists.
  } catch (error) {
    console.error("[Multiplayer] startGame error:", error);
    const msg = (error as Error).message;
    const status = msg.includes("Only the host") ? 403 : msg.includes("not found") ? 404 : 400;
    res.status(status).json({ success: false, error: msg });
  }
}

export async function getRoomOverview(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId } = req.params;

    const overview = await roomService.getRoomOverview(roomId, userId);
    res.json({ success: true, room: overview });
  } catch (error) {
    console.error("[Multiplayer] getRoomOverview error:", error);
    const msg = (error as Error).message;
    const status = msg.includes("not a member") ? 403 : msg.includes("not found") ? 404 : 500;
    res.status(status).json({ success: false, error: msg });
  }
}

export async function listMyRooms(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const rooms = await roomService.listMyRooms(userId);
    res.json({ success: true, rooms });
  } catch (error) {
    console.error("[Multiplayer] listMyRooms error:", error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}
