import { randomUUID } from "crypto";
import type { Request, Response } from "express";
import { getPrismaClient } from "../../../../src/shared/agents/memory/database/prismaClient.js";
import {
  MultiplayerDynamicGameStateManager,
} from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameState.js";
import { multiplayerSessionStore } from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.js";
import {
  serializeMultiplayerCheckpoint,
  generateMultiplayerCheckpointName,
} from "../../../../src/dynamicworldagent/multiplayerAgent/memory/checkpoint.js";
import { DatabaseManager } from "../../core/DatabaseManager.js";
import { WebSocketManager } from "../../websocket/WebSocketManager.js";
import { notifySceneRoom, notifyRoom } from "../../websocket/notifier.js";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

async function verifyHost(
  roomId: string,
  userId: string
): Promise<{ ok: true; room: any } | { ok: false; status: number; error: string }> {
  const prisma = getPrismaClient();
  const room = await prisma.multiplayerRoom.findUnique({
    where: { roomId },
    select: { roomId: true, hostUserId: true, moduleName: true },
  });
  if (!room) return { ok: false, status: 404, error: "Room not found" };
  if (room.hostUserId !== userId) {
    return { ok: false, status: 403, error: "Only the host can perform this action" };
  }
  return { ok: true, room };
}

async function verifyMember(
  roomId: string,
  userId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const prisma = getPrismaClient();
  const member = await prisma.multiplayerRoomMember.findUnique({
    where: { roomId_userId: { roomId, userId } },
    select: { id: true },
  });
  if (!member) return { ok: false, status: 403, error: "Not a member of this room" };
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────
// GET /checkpoints/mine?moduleName=...
// ─────────────────────────────────────────────────────────────

export async function listMyCheckpoints(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const moduleName = req.query.moduleName as string | undefined;
    const prisma = getPrismaClient();

    // Build where clause — filter by moduleName via roomId lookup (no relation defined)
    let roomIdFilter: string[] | undefined;
    if (moduleName) {
      const rooms = await prisma.multiplayerRoom.findMany({
        where: { moduleName },
        select: { roomId: true },
      });
      roomIdFilter = rooms.map((r) => r.roomId);
    }

    const checkpoints = await prisma.multiplayerCheckpoint.findMany({
      where: {
        createdBy: userId,
        ...(roomIdFilter ? { roomId: { in: roomIdFilter } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: {
        checkpointId: true,
        name: true,
        createdAt: true,
        payload: true,
      },
    });

    const items = checkpoints.map((cp) => {
      const payload = cp.payload as any;
      const activeScenes: string[] = [];
      if (payload?.sceneRooms && typeof payload.sceneRooms === "object") {
        for (const room of Object.values(payload.sceneRooms) as any[]) {
          if (!room.isFrozen && room.currentScenario?.name) {
            activeScenes.push(room.currentScenario.name);
          }
        }
      }
      return {
        checkpointId: cp.checkpointId,
        name: cp.name,
        createdAt: cp.createdAt,
        gameDay: payload?.gameDay ?? null,
        timeOfDay: payload?.timeOfDay ?? null,
        activeScenes,
        playerCount: payload?.players
          ? Object.keys(payload.players).length
          : 0,
      };
    });

    res.json({ success: true, checkpoints: items });
  } catch (error) {
    console.error("[MP Checkpoint] listMyCheckpoints error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to list checkpoints: " + (error as Error).message,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// POST /rooms/:roomId/checkpoints/save
// ─────────────────────────────────────────────────────────────

export async function saveCheckpoint(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId } = req.params;
    const prisma = getPrismaClient();

    // 1. Host-only check
    const hostCheck = await verifyHost(roomId, userId);
    if (!hostCheck.ok) {
      res.status(hostCheck.status).json({ success: false, error: hostCheck.error });
      return;
    }

    // 2. Get manager from in-memory store
    const manager = multiplayerSessionStore.get(roomId);
    if (!manager) {
      res.status(400).json({
        success: false,
        error: "No active game for this room. Start the game first.",
      });
      return;
    }

    // 3. Serialize
    const db = DatabaseManager.getInstance().getDatabase();
    const payload = await serializeMultiplayerCheckpoint(manager, db);
    const checkpointName =
      typeof req.body?.name === "string" && req.body.name.trim().length > 0
        ? req.body.name.trim()
        : generateMultiplayerCheckpointName(manager);

    const checkpointId = `mp-ckpt-${Date.now()}-${randomUUID().slice(0, 8)}`;

    // 4. Persist
    await prisma.multiplayerCheckpoint.create({
      data: {
        checkpointId,
        roomId,
        name: checkpointName,
        payload: payload as any,
        createdBy: userId,
      },
    });

    // 5. Create member records for every current room member
    const members = await prisma.multiplayerRoomMember.findMany({
      where: { roomId },
      select: { userId: true },
    });
    if (members.length > 0) {
      await prisma.multiplayerCheckpointMember.createMany({
        data: members.map((m) => ({
          id: randomUUID(),
          checkpointId,
          userId: m.userId,
        })),
        skipDuplicates: true,
      });
    }

    console.log(
      `[MP Checkpoint] Saved checkpoint "${checkpointName}" (${checkpointId}) for room ${roomId}`
    );

    res.json({
      success: true,
      checkpointId,
      checkpointName,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[MP Checkpoint] saveCheckpoint error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to save checkpoint: " + (error as Error).message,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// GET /rooms/:roomId/checkpoints
// ─────────────────────────────────────────────────────────────

export async function listCheckpoints(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId } = req.params;
    const prisma = getPrismaClient();

    // Any room member can list
    const memberCheck = await verifyMember(roomId, userId);
    if (!memberCheck.ok) {
      res.status(memberCheck.status).json({ success: false, error: memberCheck.error });
      return;
    }

    const limit = Number.parseInt(req.query.limit as string) || 50;

    const checkpoints = await prisma.multiplayerCheckpoint.findMany({
      where: { roomId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        checkpointId: true,
        name: true,
        createdBy: true,
        createdAt: true,
        payload: true,
      },
    });

    const items = checkpoints.map((cp) => {
      const payload = cp.payload as any;
      // Extract summary metadata from payload
      const activeScenes: string[] = [];
      if (payload?.sceneRooms && typeof payload.sceneRooms === "object") {
        for (const room of Object.values(payload.sceneRooms) as any[]) {
          if (!room.isFrozen && room.currentScenario?.name) {
            activeScenes.push(room.currentScenario.name);
          }
        }
      }
      return {
        checkpointId: cp.checkpointId,
        name: cp.name,
        createdBy: cp.createdBy,
        createdAt: cp.createdAt,
        gameDay: payload?.gameDay ?? null,
        timeOfDay: payload?.timeOfDay ?? null,
        activeScenes,
        playerCount: payload?.players
          ? Object.keys(payload.players).length
          : 0,
      };
    });

    res.json({ success: true, checkpoints: items });
  } catch (error) {
    console.error("[MP Checkpoint] listCheckpoints error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to list checkpoints: " + (error as Error).message,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Core restore logic — shared by loadCheckpoint (explicit) and
// getGameState (auto-restore on server restart).
// ─────────────────────────────────────────────────────────────

/**
 * Reads checkpoint payload → deserializes → creates new session → stores manager.
 * Returns the new manager, sessionId, and restored state metadata.
 */
export async function restoreRoomFromCheckpoint(
  roomId: string,
  checkpoint: { checkpointId: string; payload: any; name: string },
): Promise<{ manager: MultiplayerDynamicGameStateManager; sessionId: string }> {
  const prisma = getPrismaClient();

  // Parse payload (handle both string and object — auto-save may double-encode)
  const raw = checkpoint.payload;
  const payload = typeof raw === "string" ? JSON.parse(raw) : raw;

  // 1. Deserialize into a new MultiplayerDynamicGameState
  const restoredState = MultiplayerDynamicGameStateManager.deserialize(payload);

  // Generate a fresh session ID for the restored game
  const newSessionId = `mp-session-${randomUUID()}`;
  restoredState.sessionId = newSessionId;
  // Keep the roomId aligned with the current room
  restoredState.roomId = roomId;
  // Clear ephemeral data
  restoredState.roundInputs = [];

  const newManager = new MultiplayerDynamicGameStateManager(restoredState);

  // 2. Replace the in-memory store entry
  multiplayerSessionStore.set(roomId, newManager);

  // 3. Restore conversation history to a new session record
  const conversationHistory: any[] = payload.conversationHistory ?? [];
  const restoredLanguage: "en" | "zh" =
    payload.language === "en" || payload.language === "zh"
      ? payload.language
      : "zh";

  await prisma.session.upsert({
    where: { sessionId: newSessionId },
    update: {},
    create: {
      sessionId: newSessionId,
      emailId: null,
      modName: payload.moduleName ?? null,
      status: "active",
      metadata: { language: restoredLanguage },
    },
  });

  // Bulk-insert turn rows from the saved conversation
  if (conversationHistory.length > 0) {
    const turnsByNumber = new Map<
      number,
      { characterInput: string; keeperNarrative: string | null; startedAt: Date; completedAt: Date | null; gameDay: number | null; gameTime: string | null; sceneRoomId: string | null }
    >();

    for (const msg of conversationHistory) {
      if (!msg || typeof msg !== "object") continue;
      const turnNumber = typeof msg.turnNumber === "number" ? msg.turnNumber : 0;
      const existing = turnsByNumber.get(turnNumber) ?? {
        characterInput: "",
        keeperNarrative: null,
        startedAt: toDateOrNow(msg.timestamp),
        completedAt: null,
        gameDay: typeof msg.gameDay === "number" ? msg.gameDay : null,
        gameTime: typeof msg.gameTime === "string" ? msg.gameTime : null,
        sceneRoomId: typeof msg.sceneRoomId === "string" ? msg.sceneRoomId : null,
      };
      if (msg.role === "character") {
        existing.characterInput = typeof msg.content === "string" ? msg.content : "";
        existing.startedAt = toDateOrNow(msg.timestamp);
      } else if (msg.role === "keeper") {
        existing.keeperNarrative = typeof msg.content === "string" ? msg.content : "";
        existing.completedAt = toDateOrNow(msg.timestamp);
      }
      // Update sceneRoomId if present on this message and not yet set
      if (!existing.sceneRoomId && typeof msg.sceneRoomId === "string") {
        existing.sceneRoomId = msg.sceneRoomId;
      }
      turnsByNumber.set(turnNumber, existing);
    }

    const turnRows = [...turnsByNumber.values()]
      .sort((a, b) => {
        const aNum = [...turnsByNumber.entries()].find(([, v]) => v === a)?.[0] ?? 0;
        const bNum = [...turnsByNumber.entries()].find(([, v]) => v === b)?.[0] ?? 0;
        return aNum - bNum;
      })
      .map((turn, idx) => ({
        turnId: `turn-mprestore-${newSessionId.slice(0, 12)}-${idx}-${randomUUID().slice(0, 8)}`,
        sessionId: newSessionId,
        turnNumber: idx,
        characterInput: turn.characterInput,
        characterId: null,
        characterName: null,
        moduleId: null,
        emailId: null,
        keeperNarrative: turn.keeperNarrative,
        status: "completed",
        startedAt: turn.startedAt,
        completedAt: turn.completedAt ?? turn.startedAt,
        gameDay: turn.gameDay,
        gameTime: turn.gameTime,
        sceneRoomId: turn.sceneRoomId,
      }));

    if (turnRows.length > 0) {
      await prisma.gameTurn.createMany({ data: turnRows, skipDuplicates: true });
    }
  }

  // 4. Update DB sceneRoom records + member pointers
  for (const [sceneRoomId, scr] of Object.entries(restoredState.sceneRooms)) {
    await prisma.multiplayerSceneRoom.upsert({
      where: { sceneRoomId },
      update: {
        scenarioId: scr.scenarioId,
        scenarioName: scr.scenarioName,
        snapshotId: scr.snapshotId,
        snapshotName: scr.snapshotName,
        status: scr.isFrozen ? "frozen" : "active",
        roundNumber: scr.roundNumber,
        frozenAt: scr.frozenAt,
        parentSceneRoomIds: scr.parentSceneRoomIds,
      },
      create: {
        sceneRoomId,
        roomId,
        scenarioId: scr.scenarioId,
        scenarioName: scr.scenarioName,
        snapshotId: scr.snapshotId,
        snapshotName: scr.snapshotName,
        status: scr.isFrozen ? "frozen" : "active",
        roundNumber: scr.roundNumber,
        frozenAt: scr.frozenAt,
        parentSceneRoomIds: scr.parentSceneRoomIds,
      },
    });
  }

  // Update member pointers — place each player in their saved sceneRoom
  for (const [playerId, playerState] of Object.entries(restoredState.players)) {
    await prisma.multiplayerRoomMember.updateMany({
      where: { roomId, userId: playerId },
      data: { currentSceneRoomId: playerState.currentSceneRoomId },
    });
  }

  // 5. Copy RAG chunks from old session to new session (async, non-blocking)
  const oldSessionId =
    typeof payload.sessionId === "string" ? payload.sessionId : null;
  if (oldSessionId) {
    void (async () => {
      try {
        await prisma.$executeRaw`
          INSERT INTO session_rag_chunks (
            id, session_id, turn_id, turn_number, chunk_type, scene_room_id,
            role, content, metadata, source_key, embedding, language, email_id, created_at
          )
          SELECT
            gen_random_uuid()::text, ${newSessionId}, turn_id, turn_number, chunk_type, scene_room_id,
            role, content, metadata, source_key, embedding, language, email_id, NOW()
          FROM session_rag_chunks
          WHERE session_id = ${oldSessionId}
          ON CONFLICT (session_id, source_key) DO NOTHING
        `;
        console.log(
          `[MP Checkpoint RAG] Copied RAG chunks ${oldSessionId} → ${newSessionId}`
        );
      } catch (error) {
        console.warn("[MP Checkpoint RAG] Failed to copy RAG chunks:", error);
      }
    })();
  }

  return { manager: newManager, sessionId: newSessionId };
}

// ─────────────────────────────────────────────────────────────
// POST /rooms/:roomId/checkpoints/load
// ─────────────────────────────────────────────────────────────

export async function loadCheckpoint(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId } = req.params;
    const { checkpointId } = req.body as { checkpointId?: string };
    const prisma = getPrismaClient();

    if (!checkpointId) {
      res.status(400).json({ success: false, error: "checkpointId is required" });
      return;
    }

    // 1. Host-only check
    const hostCheck = await verifyHost(roomId, userId);
    if (!hostCheck.ok) {
      res.status(hostCheck.status).json({ success: false, error: hostCheck.error });
      return;
    }

    // 2. Fetch checkpoint (allow cross-room loading — user may load a checkpoint
    //    from a previous room with the same module into the current room)
    const checkpoint = await prisma.multiplayerCheckpoint.findUnique({
      where: { checkpointId },
      select: { checkpointId: true, roomId: true, payload: true, name: true, createdBy: true },
    });
    if (!checkpoint) {
      res.status(404).json({ success: false, error: "Checkpoint not found" });
      return;
    }
    // Verify the current user owns or is a member of the checkpoint
    if (checkpoint.createdBy !== userId) {
      const memberRecord = await prisma.multiplayerCheckpointMember.findFirst({
        where: { checkpointId, userId },
        select: { id: true },
      });
      if (!memberRecord) {
        res.status(403).json({ success: false, error: "Not authorized to load this checkpoint" });
        return;
      }
    }

    // 3. Restore from checkpoint (shared logic)
    const { manager: newManager, sessionId: newSessionId } =
      await restoreRoomFromCheckpoint(roomId, checkpoint);

    const restoredState = newManager.getState();
    const activeSceneRoomIds = Object.keys(restoredState.sceneRooms);

    // 4a. Broadcast room_game_starting so non-host players navigate to game page
    try {
      const wsManager0 = WebSocketManager.getInstance();
      if (wsManager0) {
        const roomClients = wsManager0.getRoomClients(roomId);
        if (roomClients.size > 0) {
          notifyRoom(roomId, roomClients, { type: "room_game_starting" });
        }
      }
    } catch (wsError) {
      console.warn("[MP Checkpoint] room_game_starting broadcast failed:", wsError);
    }

    // 4b. Broadcast checkpoint_loaded to all active sceneRooms
    try {
      const wsManager = WebSocketManager.getInstance();
      if (wsManager) {
        const allClients = wsManager.getMultiplayerClientsByRoom(activeSceneRoomIds);
        const broadcastPayload = {
          type: "checkpoint_loaded",
          checkpointId,
          checkpointName: checkpoint.name,
          sessionId: newSessionId,
          timestamp: new Date().toISOString(),
        };
        for (const clientsMap of allClients) {
          notifySceneRoom("*", clientsMap, broadcastPayload);
        }
      }
    } catch (wsError) {
      console.warn("[MP Checkpoint] WS broadcast failed:", wsError);
    }

    console.log(
      `[MP Checkpoint] Loaded checkpoint "${checkpoint.name}" (${checkpointId}) → session ${newSessionId}`
    );

    // Parse payload to extract language (handle both string and object)
    const rawPayload = checkpoint.payload as any;
    const parsedPayload = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
    const restoredLanguage: "en" | "zh" =
      parsedPayload?.language === "en" || parsedPayload?.language === "zh"
        ? parsedPayload.language
        : "zh";

    res.json({
      success: true,
      sessionId: newSessionId,
      checkpointName: checkpoint.name,
      language: restoredLanguage,
      gameDay: restoredState.gameDay,
      timeOfDay: restoredState.timeOfDay,
      activeSceneRoomIds,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[MP Checkpoint] loadCheckpoint error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to load checkpoint: " + (error as Error).message,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// DELETE /rooms/:roomId/checkpoints/:checkpointId
// ─────────────────────────────────────────────────────────────

export async function deleteCheckpoint(
  req: Request,
  res: Response
): Promise<void> {
  try {
    const userId = req.user!.userId;
    const { roomId, checkpointId } = req.params;
    const prisma = getPrismaClient();

    // Host-only check
    const hostCheck = await verifyHost(roomId, userId);
    if (!hostCheck.ok) {
      res.status(hostCheck.status).json({ success: false, error: hostCheck.error });
      return;
    }

    // Verify checkpoint belongs to this room
    const checkpoint = await prisma.multiplayerCheckpoint.findUnique({
      where: { checkpointId },
      select: { roomId: true },
    });
    if (!checkpoint || checkpoint.roomId !== roomId) {
      res.status(404).json({ success: false, error: "Checkpoint not found" });
      return;
    }

    // Delete (cascades to MultiplayerCheckpointMember)
    await prisma.multiplayerCheckpoint.delete({ where: { checkpointId } });

    console.log(
      `[MP Checkpoint] Deleted checkpoint ${checkpointId} from room ${roomId}`
    );

    res.json({
      success: true,
      message: "Checkpoint deleted",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[MP Checkpoint] deleteCheckpoint error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete checkpoint: " + (error as Error).message,
    });
  }
}

// ─────────────────────────────────────────────────────────────
// Utility
// ─────────────────────────────────────────────────────────────

function toDateOrNow(value: unknown): Date {
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}
