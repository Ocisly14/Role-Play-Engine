/**
 * Multiplayer Turn Controller
 *
 * Handles HTTP requests for round input submission and state polling.
 */

/// <reference path="../../types/express.d.ts" />
import type { Request, Response } from "express";
import { DatabaseManager } from "../../core/DatabaseManager.js";
import { submitRoundInput, getRoundState } from "./service.js";

/**
 * POST /api/multiplayer/rooms/:roomId/scene-rooms/:sceneRoomId/input
 *
 * Submit a player's action for the current round.
 * When all players in the sceneRoom have submitted, the graph executes automatically.
 */
export async function submitInput(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId, sceneRoomId } = req.params;
    const {
      characterId,
      inputType,
      content,
      selectedSkill,
      skillSelectionMode,
      language,
    } = req.body ?? {};

    if (!characterId || !inputType) {
      res
        .status(400)
        .json({
          success: false,
          error: "characterId and inputType are required",
        });
      return;
    }

    if (inputType !== "input" && inputType !== "skip") {
      res
        .status(400)
        .json({ success: false, error: "inputType must be 'input' or 'skip'" });
      return;
    }

    if (inputType === "input" && !content) {
      res
        .status(400)
        .json({ success: false, error: "content is required for input type" });
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase();
    const result = await submitRoundInput(db, roomId, sceneRoomId, userId, {
      characterId,
      inputType,
      content: typeof content === "string" ? content : undefined,
      selectedSkill: typeof selectedSkill === "string" ? selectedSkill : null,
      skillSelectionMode:
        skillSelectionMode === "auto" || skillSelectionMode === "manual"
          ? skillSelectionMode
          : "manual",
      language: language === "en" ? "en" : "zh",
    });

    res.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      message.includes("not found") || message.includes("not a member")
        ? 404
        : message.includes("already ended")
          ? 409
          : 500;
    res.status(status).json({ success: false, error: message });
  }
}

/**
 * GET /api/multiplayer/rooms/:roomId/scene-rooms/:sceneRoomId/round
 *
 * Get the current round state: who has submitted, total expected, round number.
 * Used for polling to show waiting state on the client.
 */
export async function getRound(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId, sceneRoomId } = req.params;

    const result = await getRoundState(roomId, sceneRoomId, userId);
    res.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      message.includes("not found") || message.includes("not a member")
        ? 404
        : 500;
    res.status(status).json({ success: false, error: message });
  }
}
