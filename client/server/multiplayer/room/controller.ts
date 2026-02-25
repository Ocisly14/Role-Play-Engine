import type { Request, Response } from "express";
import * as roomService from "./service.js";

export async function createRoom(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const result = await roomService.createRoom(userId);
    res.status(201).json({ success: true, ...result });
  } catch (error) {
    console.error("[Multiplayer] createRoom error:", error);
    res.status(500).json({ success: false, error: (error as Error).message });
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
  } catch (error) {
    console.error("[Multiplayer] confirmReady error:", error);
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
