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

    // Walk the parent chain to include frozen ancestor rooms' history
    const sceneRoomIdsToQuery: string[] = [sceneRoomId];

    if (!fetchAll) {
      const sceneRoom = state.sceneRooms[sceneRoomId];
      if (sceneRoom) {
        const visited = new Set<string>([sceneRoomId]);
        const queue = [...(sceneRoom.parentSceneRoomIds ?? [])];

        while (queue.length > 0) {
          const parentId = queue.shift()!;
          if (visited.has(parentId)) continue;
          visited.add(parentId);

          const parentRoom = state.sceneRooms[parentId];
          if (!parentRoom) continue;

          // Only include rooms where the requesting player was a member
          if (parentRoom.memberPlayerIds.includes(userId)) {
            sceneRoomIdsToQuery.push(parentId);
          }

          // Continue walking up
          for (const grandparentId of parentRoom.parentSceneRoomIds ?? []) {
            if (!visited.has(grandparentId)) {
              queue.push(grandparentId);
            }
          }
        }
      }
    }

    const turns = await prisma.gameTurn.findMany({
      where: {
        sessionId,
        ...(!fetchAll
          ? {
              sceneRoomId:
                sceneRoomIdsToQuery.length === 1
                  ? sceneRoomIdsToQuery[0]
                  : { in: sceneRoomIdsToQuery },
            }
          : {}),
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

    // Determine requesting user's character name to distinguish own vs other messages
    const myCharacterName = state.players[userId]?.characterName ?? null;

    // Convert to Message[] format
    const messages: any[] = [];
    for (const turn of turns) {
      if (turn.characterInput) {
        const isOtherPlayer = myCharacterName && turn.characterName && turn.characterName !== myCharacterName;
        messages.push({
          role: "character",
          content: turn.characterInput,
          timestamp: turn.startedAt?.toISOString() ?? new Date().toISOString(),
          turnNumber: turn.turnNumber,
          turnId: turn.turnId,
          gameDay: turn.gameDay,
          gameTime: turn.gameTime,
          sceneRoomId: turn.sceneRoomId,
          // Set playerName for other players so frontend renders them distinctly
          ...(isOtherPlayer ? { playerName: turn.characterName } : {}),
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
 * GET /api/multiplayer/rooms/:roomId/scene-rooms/:sceneRoomId/round-result?roundNumber=N&wait=true
 *
 * Long-polling fallback for receiving round results when WebSocket is unavailable.
 * If the round has completed, returns the result immediately.
 * If wait=true, holds the connection checking every 1s for up to 60s.
 */
export async function getRoundResult(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const { roomId, sceneRoomId } = req.params;
    const roundNumber = Number(req.query.roundNumber);
    const shouldWait = req.query.wait === "true";

    if (!Number.isFinite(roundNumber) || roundNumber < 0) {
      res.status(400).json({ success: false, error: "roundNumber query param is required" });
      return;
    }

    const manager = multiplayerSessionStore.get(roomId);
    if (!manager) {
      res.status(404).json({ success: false, error: "Game session not found" });
      return;
    }

    const sessionId = manager.getState().sessionId;
    const prisma = getPrismaClient();

    const MAX_WAIT_MS = 60_000;
    const POLL_INTERVAL_MS = 1_000;
    const startTime = Date.now();

    const check = async (): Promise<boolean> => {
      // Check if sceneRoom is frozen (scene split happened)
      const sceneRoom = manager.getSceneRoom(sceneRoomId);
      if (sceneRoom?.isFrozen) {
        res.json({ success: true, status: "scene_changed" });
        return true;
      }

      // Check if the round has advanced past the requested roundNumber
      const currentRoundNumber = sceneRoom?.roundNumber ?? 0;
      if (currentRoundNumber <= roundNumber) {
        return false; // Still on the same round — not complete yet
      }

      // Round advanced — query the latest completed turn for this sceneRoom
      const turn = await prisma.gameTurn.findFirst({
        where: { sessionId, sceneRoomId },
        orderBy: { turnNumber: "desc" },
        select: {
          turnId: true,
          turnNumber: true,
          keeperNarrative: true,
          gameDay: true,
          gameTime: true,
          completedAt: true,
          status: true,
        },
      });

      if (!turn || turn.status !== "completed") {
        return false; // Turn exists but not completed yet
      }

      res.json({
        success: true,
        status: "completed",
        roundTurnId: turn.turnId,
        keeperNarrative: turn.keeperNarrative ?? null,
        gameDay: turn.gameDay ?? null,
        gameTime: turn.gameTime ?? null,
        turnNumber: turn.turnNumber,
        diceRolls: [], // Dice rolls are WebSocket-only (not persisted)
        completedAt: turn.completedAt?.toISOString() ?? null,
      });
      return true;
    };

    // First check — may return immediately
    if (await check()) return;

    if (!shouldWait) {
      // No waiting requested — return current status
      const sceneRoom = manager.getSceneRoom(sceneRoomId);
      const currentRoundNumber = sceneRoom?.roundNumber ?? 0;
      const submitted = manager.getRoundInputsForSceneRoom(sceneRoomId).length;
      const total = sceneRoom?.memberPlayerIds.length ?? 0;
      res.json({
        success: true,
        status: currentRoundNumber <= roundNumber ? "waiting" : "processing",
        submittedCount: submitted,
        totalCount: total,
      });
      return;
    }

    // Long-poll loop
    const interval = setInterval(async () => {
      try {
        if (res.writableEnded) {
          clearInterval(interval);
          return;
        }
        if (await check()) {
          clearInterval(interval);
          return;
        }
        if (Date.now() - startTime >= MAX_WAIT_MS) {
          clearInterval(interval);
          res.json({ success: true, status: "timeout" });
        }
      } catch (err) {
        clearInterval(interval);
        if (!res.writableEnded) {
          res.status(500).json({ success: false, error: (err as Error).message });
        }
      }
    }, POLL_INTERVAL_MS);

    // Clean up on client disconnect
    req.on("close", () => {
      clearInterval(interval);
    });
  } catch (error) {
    console.error("[MultiplayerTurn] getRoundResult error:", error);
    if (!res.writableEnded) {
      res.status(500).json({ success: false, error: (error as Error).message });
    }
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
