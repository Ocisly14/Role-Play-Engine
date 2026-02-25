/**
 * Multiplayer game initialisation service
 * Called after the room transitions to "playing" status.
 * Creates the MultiplayerDynamicGameState and registers it in the in-memory store.
 */

import { randomUUID } from "crypto";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../../../src/shared/agents/memory/database/index.js";
import { getPrismaClient } from "../../../../src/shared/agents/memory/database/prismaClient.js";
import { createAndStoreMultiplayerSession } from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.js";

export interface MultiplayerGameInitResult {
  sessionId: string;
  initialSceneRoomId: string;
  playerCount: number;
}

/**
 * Initialise the multiplayer game for a room that is already in "playing" status.
 * Returns basic info the front-end needs (sessionId, initial sceneRoomId).
 */
export async function initMultiplayerGame(
  db: CoCDatabase | CoCDatabaseAdapter,
  roomId: string,
  hostUserId: string,
  hostEmail: string
): Promise<MultiplayerGameInitResult> {
  const prisma = getPrismaClient();

  // 1. Fetch room + members
  const room = await prisma.multiplayerRoom.findUnique({
    where: { roomId },
    include: {
      members: {
        select: {
          userId: true,
          characterId: true,
          role: true,
          confirmStatus: true,
        },
      },
    },
  });

  if (!room) throw new Error("Room not found");
  if (room.hostUserId !== hostUserId) {
    throw new Error("Only the host can initialise the game");
  }
  if (room.status !== "playing") {
    throw new Error("Room must be in playing status before initialising game");
  }
  if (!room.moduleName) {
    throw new Error("No module selected for this room");
  }

  // 2. Validate all members have a confirmed character
  for (const m of room.members) {
    if (!m.characterId) {
      throw new Error(
        `Player ${m.userId} has not selected a character`
      );
    }
    if (m.confirmStatus !== "confirmed") {
      throw new Error(`Player ${m.userId} has not confirmed their character`);
    }
  }

  // 3. Build player list
  const players = room.members.map((m) => ({
    userId: m.userId,
    characterId: m.characterId!, // confirmed non-null above
  }));

  const sessionId = `multi-${roomId}-${randomUUID().slice(0, 8)}`;

  // 4. Load module + characters and build MultiplayerDynamicGameState
  const manager = await createAndStoreMultiplayerSession(db, {
    roomId,
    sessionId,
    moduleName: room.moduleName,
    players,
    hostEmailId: hostEmail,
  });

  const state = manager.getState();
  // The first (and only at this point) sceneRoom
  const initialSceneRoomId = Object.keys(state.sceneRooms)[0];

  // 5. Persist the initial sceneRoom record to DB so polling can see it
  await prisma.multiplayerSceneRoom.upsert({
    where: { sceneRoomId: initialSceneRoomId },
    create: {
      sceneRoomId: initialSceneRoomId,
      roomId,
      status: "active",
      roundNumber: 1,
    },
    update: {
      status: "active",
      roundNumber: 1,
    },
  });

  // 6. Point all room members to the initial sceneRoom in DB
  await prisma.multiplayerRoomMember.updateMany({
    where: { roomId },
    data: { currentSceneRoomId: initialSceneRoomId },
  });

  console.log(
    `[MultiplayerGame] Room ${roomId} game initialised — sessionId=${sessionId}, sceneRoomId=${initialSceneRoomId}`
  );

  return {
    sessionId,
    initialSceneRoomId,
    playerCount: players.length,
  };
}
