import type { Request, Response } from "express";
import { DatabaseManager } from "../../core/DatabaseManager.js";
import { multiplayerSessionStore } from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.js";
import { getPrismaClient } from "../../../../src/shared/agents/memory/database/prismaClient.js";
import { initMultiplayerGame } from "./service.js";
import { restoreRoomFromCheckpoint } from "../checkpoint/controller.js";
import { WebSocketManager } from "../../websocket/WebSocketManager.js";
import { notifyRoom } from "../../websocket/notifier.js";
import type { MultiplayerDynamicGameStateManager } from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameState.js";

function broadcastToRoom(roomId: string, message: object): void {
  const wsMgr = WebSocketManager.getInstance();
  if (!wsMgr) return;
  const clients = wsMgr.getRoomClients(roomId);
  if (clients.size > 0) {
    notifyRoom(roomId, clients, message);
  }
}

/**
 * Try to auto-restore a room's in-memory state from its latest checkpoint.
 * Returns the restored manager, or null if no checkpoint is available.
 */
async function tryAutoRestore(roomId: string): Promise<MultiplayerDynamicGameStateManager | null> {
  const prisma = getPrismaClient();
  const latestCheckpoint = await prisma.multiplayerCheckpoint.findFirst({
    where: { roomId },
    orderBy: { createdAt: "desc" },
    select: { checkpointId: true, payload: true, name: true },
  });

  if (!latestCheckpoint) return null;

  const result = await restoreRoomFromCheckpoint(roomId, latestCheckpoint);
  console.log(
    `[MultiplayerGame] Auto-restored room ${roomId} from checkpoint "${latestCheckpoint.name}"`
  );
  return result.manager;
}

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

    // Broadcast room_game_starting AFTER the game state is ready,
    // so non-host players can safely navigate and fetch state.
    broadcastToRoom(roomId, { type: "room_game_starting" });

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

    let manager = multiplayerSessionStore.get(roomId);

    // Auto-restore: if store is empty after server restart, try latest checkpoint
    if (!manager) {
      try {
        manager = await tryAutoRestore(roomId) ?? undefined;
      } catch (err) {
        console.error("[MultiplayerGame] Auto-restore failed:", err);
      }
    }

    if (!manager) {
      res.status(404).json({ success: false, error: "Game not initialised for this room" });
      return;
    }

    const s = manager.getState();

    // Verify requesting user is a room member
    const userId = req.user!.userId;
    if (!s.players[userId]) {
      const prisma = getPrismaClient();
      const membership = await prisma.multiplayerRoomMember.findUnique({
        where: { roomId_userId: { roomId, userId } },
        select: { userId: true },
      });
      if (!membership) {
        res.status(403).json({ success: false, error: "Not a member of this room" });
        return;
      }
    }

    // Determine the requesting player's authoritative sceneRoomId
    const playerState = s.players[userId];
    const myCurrentSceneRoomId = playerState?.currentSceneRoomId ?? null;

    res.json({
      success: true,
      sessionId: s.sessionId,
      moduleName: s.moduleName,
      gameDay: s.gameDay,
      timeOfDay: s.timeOfDay,
      isBattle: Object.values(s.sceneRooms).some((sr) => sr.isBattle),
      gameEnding: s.gameEnding,
      myCurrentSceneRoomId,
      sceneRooms: Object.keys(s.sceneRooms).map((id) => {
        const sr = s.sceneRooms[id];
        return {
          sceneRoomId: id,
          scenarioName: sr.scenarioName,
          roundNumber: sr.roundNumber,
          memberPlayerIds: sr.memberPlayerIds,
          isBattle: sr.isBattle ?? false,
          isFrozen: sr.isFrozen ?? false,
        };
      }),
      players: Object.fromEntries(
        Object.entries(s.players).map(([pid, p]) => [pid, {
          characterName: p.characterName,
          currentSceneRoomId: p.currentSceneRoomId,
          profile: {
            status: p.profile.status,
            attributes: p.profile.attributes,
          },
        }])
      ),
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

    let manager = multiplayerSessionStore.get(roomId);

    // Auto-restore: if store is empty after server restart, try latest checkpoint
    if (!manager) {
      try {
        manager = await tryAutoRestore(roomId) ?? undefined;
      } catch (err) {
        console.error("[MultiplayerGame] Auto-restore failed:", err);
      }
    }

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

    // Support optional ?sceneRoomId query param for viewing other rooms' data
    const viewSceneRoomId = req.query.sceneRoomId as string | undefined;
    const targetSceneRoomId = viewSceneRoomId && state.sceneRooms[viewSceneRoomId]
      ? viewSceneRoomId
      : player.currentSceneRoomId;
    const sceneRoom = state.sceneRooms[targetSceneRoomId];

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
      moduleDigest: state.moduleDigest ?? null,
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

/**
 * POST /api/multiplayer/rooms/:roomId/game/update-language
 * Updates the session language preference for the room.
 */
export async function updateLanguage(req: Request, res: Response): Promise<void> {
  try {
    const { roomId } = req.params;
    const { language } = req.body ?? {};

    if (language !== "en" && language !== "zh") {
      res.status(400).json({ success: false, error: "language must be 'en' or 'zh'" });
      return;
    }

    const manager = multiplayerSessionStore.get(roomId);
    if (!manager) {
      res.status(404).json({ success: false, error: "Game not initialised for this room" });
      return;
    }

    // Update session metadata in DB
    const prisma = getPrismaClient();
    const sessionId = manager.getState().sessionId;
    if (sessionId) {
      const session = await prisma.session.findUnique({
        where: { sessionId },
        select: { metadata: true },
      });
      const existing = session?.metadata
        ? typeof session.metadata === "string"
          ? JSON.parse(session.metadata)
          : (session.metadata as Record<string, unknown>)
        : {};
      await prisma.session.update({
        where: { sessionId },
        data: { metadata: JSON.stringify({ ...existing, language }) },
      });
    }

    res.json({ success: true, language });
  } catch (error) {
    console.error("[MultiplayerGame] updateLanguage error:", error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * POST /api/multiplayer/rooms/:roomId/game/stop
 * Host-only. Stops/abandons the current game, marks room as ended.
 */
export async function stopGame(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId } = req.params;

    const prisma = getPrismaClient();
    const room = await prisma.multiplayerRoom.findUnique({
      where: { roomId },
      select: { hostUserId: true, status: true },
    });

    if (!room) {
      res.status(404).json({ success: false, error: "Room not found" });
      return;
    }

    if (room.hostUserId !== userId) {
      res.status(403).json({ success: false, error: "Only the host can stop the game" });
      return;
    }

    if (room.status !== "playing") {
      res.status(400).json({ success: false, error: "Game is not currently playing" });
      return;
    }

    // Update room status in DB
    await prisma.multiplayerRoom.update({
      where: { roomId },
      data: { status: "ended" },
    });

    // Clear in-memory session
    multiplayerSessionStore.delete(roomId);

    // Broadcast game_stopped to all scene rooms
    const { WebSocketManager } = await import("../../websocket/WebSocketManager.js");
    const { notifySceneRoom } = await import("../../websocket/notifier.js");
    const wsManager = WebSocketManager.getInstance();
    if (wsManager) {
      // Get all scene rooms for this room
      const sceneRooms = await prisma.multiplayerSceneRoom.findMany({
        where: { roomId, status: "active" },
        select: { sceneRoomId: true },
      });
      for (const sr of sceneRooms) {
        const clients = wsManager.getMultiplayerClients(sr.sceneRoomId);
        notifySceneRoom(sr.sceneRoomId, clients, {
          type: "game_stopped",
          roomId,
          stoppedBy: userId,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Mark all active scene rooms as ended
    await prisma.multiplayerSceneRoom.updateMany({
      where: { roomId, status: "active" },
      data: { status: "ended" },
    });

    res.json({ success: true, message: "Game stopped" });
  } catch (error) {
    console.error("[MultiplayerGame] stopGame error:", error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * POST /api/multiplayer/rooms/:roomId/game/skills/suggest
 * Suggests relevant skills based on player input.
 */
export async function suggestSkills(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId } = req.params;
    const { input, max, language: rawLanguage } = req.body ?? {};

    if (!input || typeof input !== "string" || !input.trim()) {
      res.status(400).json({ success: false, error: "input is required" });
      return;
    }

    const manager = multiplayerSessionStore.get(roomId);
    if (!manager) {
      res.status(404).json({ success: false, error: "Game not initialised for this room" });
      return;
    }

    const player = manager.getState().players[userId];
    if (!player) {
      res.status(404).json({ success: false, error: "Player not found in game state" });
      return;
    }

    const maxSuggestions =
      typeof max === "number" && Number.isFinite(max) ? max : undefined;
    const language = rawLanguage === "en" || rawLanguage === "zh" ? rawLanguage : "zh";

    const rawSkills = player.profile?.skills ?? {};
    const skills = Object.entries(rawSkills)
      .map(([name, raw]) => {
        if (typeof raw === "number") return { name, value: raw };
        if (raw && typeof raw === "object" && "value" in raw && typeof (raw as { value: unknown }).value === "number") {
          return { name, value: (raw as { value: number }).value };
        }
        return null;
      })
      .filter((entry): entry is { name: string; value: number } => Boolean(entry));

    if (skills.length === 0) {
      res.json({ success: true, suggestions: [] });
      return;
    }

    const { suggestSkillsFromInput } = await import("../../skills/skillMatcher.js");
    const { getSkillNameZh } = await import("../../skills/skillDescriptions.js");

    const result = await suggestSkillsFromInput({
      input: input.trim(),
      skills,
      max: maxSuggestions,
      language,
    });

    res.json({
      success: true,
      language: result.language,
      suggestions: result.suggestions.map((item) => ({
        ...item,
        displayName: result.language === "zh" ? getSkillNameZh(item.name) : item.name,
      })),
    });
  } catch (error) {
    console.error("[MultiplayerGame] suggestSkills error:", error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}

/**
 * POST /api/multiplayer/rooms/:roomId/game/rag/ask
 * Ask a question against session RAG memory (multiplayer context).
 */
export async function askRag(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId } = req.params;
    const { question, sceneRoomId, topK: rawTopK, language: rawLanguage } = req.body ?? {};

    if (!question || typeof question !== "string" || !question.trim()) {
      res.status(400).json({ success: false, error: "question is required" });
      return;
    }

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

    const topK =
      typeof rawTopK === "number" && Number.isFinite(rawTopK)
        ? Math.max(1, Math.min(20, Math.floor(rawTopK)))
        : 8;
    const language = rawLanguage === "en" ? "en" : "zh";
    const normalizedSceneRoomId =
      typeof sceneRoomId === "string" && sceneRoomId.trim().length > 0
        ? sceneRoomId.trim()
        : player.currentSceneRoomId || null;

    const sceneRoom = normalizedSceneRoomId
      ? state.sceneRooms[normalizedSceneRoomId]
      : null;
    const sceneName = sceneRoom?.currentScenario?.name || null;
    const sceneLocation = sceneRoom?.currentScenario?.location || null;
    const playerName = player.characterName || null;
    const npcNames = Array.from(
      new Set(
        (state.npcCharacters || [])
          .map((npc: any) => npc?.name)
          .filter((name: unknown): name is string => typeof name === "string" && (name as string).trim().length > 0)
      )
    ).slice(0, 30);
    const allScenes = (state.scenarioOutlines || [])
      .filter((s: any) => s?.name && s?.description)
      .map((s: any) => ({ name: s.name, description: s.description }))
      .slice(0, 50);

    // Fetch last 5 turns for recent context
    let recentTurns: Array<{ turnNumber: number; playerInput: string; keeperNarrative: string }> = [];
    try {
      const prisma2 = getPrismaClient();
      const rows = await prisma2.gameTurn.findMany({
        where: {
          sessionId: state.sessionId,
          status: "completed",
          ...(normalizedSceneRoomId ? { sceneRoomId: normalizedSceneRoomId } : {}),
        },
        orderBy: { turnNumber: "desc" },
        take: 5,
        select: { turnNumber: true, characterInput: true, keeperNarrative: true },
      });
      recentTurns = rows
        .reverse()
        .filter((r) => r.characterInput && r.keeperNarrative)
        .map((r) => ({
          turnNumber: r.turnNumber,
          playerInput: r.characterInput!,
          keeperNarrative: r.keeperNarrative!,
        }));
    } catch (err) {
      console.warn("[MP RAG] Failed to fetch recent turns:", err);
    }

    const { SessionRagQaService } = await import(
      "../../../../src/dynamicworldagent/dynamicBasicAgent/knowledge/sessionRagQaService.js"
    );
    const qaService = new SessionRagQaService();

    const result = await qaService.ask({
      sessionId: state.sessionId,
      question: question.trim(),
      topK,
      language,
      sceneRoomId: normalizedSceneRoomId,
      sceneName,
      sceneLocation,
      npcNames: npcNames as string[],
      playerName,
      recentTurns,
      allScenes,
    });

    res.json({
      success: true,
      answer: result.answer,
      citations: result.citations,
      retrievedCount: result.retrievedCount,
      ragQuery: result.ragQuery,
      rewrite: result.rewrite,
    });
  } catch (error) {
    console.error("[MultiplayerGame] askRag error:", error);
    res.status(500).json({ success: false, error: (error as Error).message });
  }
}
