/**
 * Multiplayer Turn Controller
 *
 * Handles HTTP requests for round input submission and state polling.
 */

/// <reference path="../../types/express.d.ts" />
import type { Request, Response } from "express";
import { DatabaseManager } from "../../core/DatabaseManager.js";
import { getPrismaClient } from "../../../../src/shared/agents/memory/database/prismaClient.js";
import { multiplayerSessionStore } from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.js";
import { submitRoundInput, getRoundState, resolveSkillSelection } from "./service.js";

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

/**
 * GET /api/multiplayer/rooms/:roomId/scene-rooms/:sceneRoomId/turns
 *
 * Returns conversation history for a scene room as Message[].
 */
export async function getTurnHistory(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { roomId, sceneRoomId } = req.params;
    const prisma = getPrismaClient();

    // Get manager to find the sessionId
    const manager = multiplayerSessionStore.get(roomId);
    if (!manager) {
      res.status(404).json({ success: false, error: "Game not initialised" });
      return;
    }

    const sessionId = manager.getState().sessionId;

    // Verify requesting user is a room member
    const userId = req.user!.userId;
    const state = manager.getState();
    if (!state.players[userId]) {
      const membership = await prisma.multiplayerRoomMember.findUnique({
        where: { roomId_userId: { roomId, userId } },
        select: { userId: true },
      });
      if (!membership) {
        res.status(403).json({ success: false, error: "Not a member of this room" });
        return;
      }
    }

    // Fetch turns for this session, optionally filtered by sceneRoomId
    // Support ?all=true query param to fetch turns across all scene rooms
    const fetchAll = req.query.all === "true" || sceneRoomId === "all";
    const turns = await prisma.gameTurn.findMany({
      where: {
        sessionId,
        ...(!fetchAll ? { sceneRoomId } : {}),
      },
      orderBy: { turnNumber: "asc" },
      select: {
        turnId: true,
        turnNumber: true,
        characterInput: true,
        characterName: true,
        keeperNarrative: true,
        status: true,
        startedAt: true,
        completedAt: true,
        gameDay: true,
        gameTime: true,
        sceneRoomId: true,
      },
    });

    // Convert to Message[] format
    const messages: any[] = [];
    for (const turn of turns) {
      if (turn.characterInput) {
        messages.push({
          role: "character",
          content: turn.characterInput,
          timestamp: turn.startedAt?.toISOString() ?? new Date().toISOString(),
          turnNumber: turn.turnNumber,
          turnId: turn.turnId,
          gameDay: turn.gameDay,
          gameTime: turn.gameTime,
          sceneRoomId: turn.sceneRoomId,
          characterName: turn.characterName,
        });
      }
      if (turn.keeperNarrative) {
        messages.push({
          role: "keeper",
          content: turn.keeperNarrative,
          timestamp: turn.completedAt?.toISOString() ?? new Date().toISOString(),
          turnNumber: turn.turnNumber,
          turnId: turn.turnId,
          gameDay: turn.gameDay,
          gameTime: turn.gameTime,
          sceneRoomId: turn.sceneRoomId,
        });
      }
    }

    res.json({ success: true, messages });
  } catch (error) {
    console.error("[MultiplayerTurn] getTurnHistory error:", error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * GET /api/multiplayer/rooms/:roomId/scene-rooms/:sceneRoomId/turns/:turnId/status
 *
 * Poll the status of a specific turn (fallback for WebSocket).
 * Returns the turn result if completed, or processing status if pending.
 */
export async function getTurnStatus(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { roomId, sceneRoomId, turnId } = req.params;
    const prisma = getPrismaClient();

    // Look up the turn in the DB
    const turn = await prisma.gameTurn.findFirst({
      where: { turnId },
      select: {
        turnId: true,
        turnNumber: true,
        status: true,
        characterInput: true,
        keeperNarrative: true,
        gameDay: true,
        gameTime: true,
        startedAt: true,
        completedAt: true,
        sceneRoomId: true,
      },
    });

    if (!turn) {
      // Turn may not have been persisted yet — check in-memory state
      const manager = multiplayerSessionStore.get(roomId);
      if (!manager) {
        res.status(404).json({ success: false, error: "Game session not found" });
        return;
      }

      const sceneRoom = manager.getSceneRoom(sceneRoomId);
      if (!sceneRoom) {
        res.status(404).json({ success: false, error: "Scene room not found" });
        return;
      }

      // Turn doesn't exist in DB yet — still processing
      res.json({
        success: true,
        status: "processing",
        turnId,
        sceneRoomId,
      });
      return;
    }

    res.json({
      success: true,
      status: turn.status ?? "processing",
      turnId: turn.turnId,
      turnNumber: turn.turnNumber,
      sceneRoomId: turn.sceneRoomId,
      keeperNarrative: turn.keeperNarrative ?? null,
      gameDay: turn.gameDay ?? null,
      gameTime: turn.gameTime ?? null,
      startedAt: turn.startedAt?.toISOString() ?? null,
      completedAt: turn.completedAt?.toISOString() ?? null,
    });
  } catch (error) {
    console.error("[MultiplayerTurn] getTurnStatus error:", error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * POST /api/multiplayer/rooms/:roomId/scene-rooms/:sceneRoomId/skill-selection
 *
 * Submit a player's chosen skill for a pending skill selection request.
 * Body: { playerId, selectedSkill }
 */
export async function submitSkillSelection(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId, sceneRoomId } = req.params;
    const { playerId, selectedSkill } = req.body ?? {};

    // Validate: playerId must match the authenticated user
    if (!playerId || playerId !== userId) {
      res.status(403).json({
        success: false,
        error: "playerId must match authenticated user",
      });
      return;
    }

    if (!selectedSkill || typeof selectedSkill !== "string" || !selectedSkill.trim()) {
      res.status(400).json({
        success: false,
        error: "selectedSkill is required",
      });
      return;
    }

    // Validate sceneRoom has pending skill selections for this player
    const manager = multiplayerSessionStore.get(roomId);
    if (!manager) {
      res.status(404).json({ success: false, error: "Game session not found" });
      return;
    }

    const sceneRoom = manager.getSceneRoom(sceneRoomId);
    if (!sceneRoom) {
      res.status(404).json({ success: false, error: "Scene room not found" });
      return;
    }

    if (!sceneRoom.pendingSkillSelections) {
      res.status(409).json({
        success: false,
        error: "No pending skill selections for this scene room",
      });
      return;
    }

    if (!sceneRoom.pendingSkillSelections.players[playerId]) {
      res.status(404).json({
        success: false,
        error: "This player does not have a pending skill selection",
      });
      return;
    }

    const db = DatabaseManager.getInstance().getDatabase();
    const result = await resolveSkillSelection(
      db,
      roomId,
      sceneRoomId,
      playerId,
      selectedSkill.trim()
    );

    res.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("not found") ? 404 : 500;
    res.status(status).json({ success: false, error: message });
  }
}
