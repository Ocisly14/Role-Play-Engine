import { randomUUID } from "crypto";
import { getPrismaClient } from "../../../../src/shared/agents/memory/database/prismaClient.js";
import { generateUniqueRoomCode } from "./roomCodeGenerator.js";

export interface RoomOverview {
  roomId: string;
  roomCode: string;
  status: string;
  hostUserId: string;
  moduleName: string | null;
  sourceCheckpointId: string | null;
  checkpointPlayerIds: string[] | null;
  createdAt: Date;
  members: Array<{
    id: string;
    userId: string;
    role: string;
    characterId: string | null;
    characterName: string | null;
    seatOrder: number;
    confirmStatus: string;
    joinedAt: Date;
  }>;
  isHost: boolean;
}

/**
 * Create a new multiplayer room and add the creator as host.
 * If checkpointId is provided, creates a checkpoint-mode room with locked module/characters.
 */
export async function createRoom(
  hostUserId: string,
  checkpointId?: string
): Promise<{ roomId: string; roomCode: string }> {
  const prisma = getPrismaClient();
  const roomId = randomUUID();
  const roomCode = await generateUniqueRoomCode();

  let moduleName: string | null = null;
  let hostCharacterId: string | null = null;

  if (checkpointId) {
    const checkpoint = await prisma.multiplayerCheckpoint.findUnique({
      where: { checkpointId },
      select: { payload: true },
    });
    if (!checkpoint) throw new Error("Checkpoint not found");

    const payload = (typeof checkpoint.payload === "string"
      ? JSON.parse(checkpoint.payload)
      : checkpoint.payload) as any;

    const players: Record<string, any> = payload?.players ?? {};
    if (!players[hostUserId]) {
      throw new Error("You are not a player in this checkpoint");
    }
    moduleName = payload?.moduleName ?? null;
    hostCharacterId = players[hostUserId]?.characterId ?? null;
  }

  await prisma.$transaction(async (tx) => {
    await tx.multiplayerRoom.create({
      data: {
        roomId,
        roomCode,
        hostUserId,
        status: "waiting",
        moduleName,
        sourceCheckpointId: checkpointId ?? null,
      },
    });

    await tx.multiplayerRoomMember.create({
      data: {
        id: randomUUID(),
        roomId,
        userId: hostUserId,
        role: "host",
        seatOrder: 1,
        characterId: hostCharacterId,
        confirmStatus: checkpointId ? "confirmed" : "pending",
      },
    });
  });

  return { roomId, roomCode };
}

/**
 * Join an existing room via room code.
 */
export async function joinRoom(
  userId: string,
  roomCode: string
): Promise<{ roomId: string }> {
  const prisma = getPrismaClient();

  const room = await prisma.multiplayerRoom.findFirst({
    where: {
      roomCode,
      status: { in: ["waiting", "ready"] },
    },
    include: {
      members: { select: { userId: true, seatOrder: true } },
    },
  });

  if (!room) {
    throw new Error("Room not found or not accepting new players");
  }

  const alreadyJoined = room.members.some((m) => m.userId === userId);
  if (alreadyJoined) {
    return { roomId: room.roomId };
  }

  // Checkpoint mode: only original players can join
  let characterId: string | null = null;
  let confirmStatus: "pending" | "confirmed" = "pending";

  if (room.sourceCheckpointId) {
    const checkpoint = await prisma.multiplayerCheckpoint.findUnique({
      where: { checkpointId: room.sourceCheckpointId },
      select: { payload: true },
    });
    if (!checkpoint) throw new Error("Source checkpoint not found");

    const payload = (typeof checkpoint.payload === "string"
      ? JSON.parse(checkpoint.payload)
      : checkpoint.payload) as any;
    const players: Record<string, any> = payload?.players ?? {};

    if (!players[userId]) {
      throw new Error("Only original players can join this room");
    }
    characterId = players[userId]?.characterId ?? null;
    confirmStatus = "confirmed";
  }

  const maxSeat =
    room.members.reduce((max, m) => Math.max(max, m.seatOrder), 0) + 1;

  await prisma.multiplayerRoomMember.create({
    data: {
      id: randomUUID(),
      roomId: room.roomId,
      userId,
      role: "player",
      seatOrder: maxSeat,
      characterId,
      confirmStatus,
    },
  });

  return { roomId: room.roomId };
}

/**
 * Host selects a module for the room (by module name).
 */
export async function selectModule(
  roomId: string,
  hostUserId: string,
  moduleName: string
): Promise<void> {
  const prisma = getPrismaClient();

  const room = await prisma.multiplayerRoom.findUnique({
    where: { roomId },
    select: { hostUserId: true, status: true, sourceCheckpointId: true },
  });

  if (!room) throw new Error("Room not found");
  if (room.sourceCheckpointId) throw new Error("Cannot change module in checkpoint mode");
  if (room.hostUserId !== hostUserId) throw new Error("Only the host can select a module");
  if (room.status !== "waiting" && room.status !== "ready") {
    throw new Error("Cannot change module after game has started");
  }

  await prisma.multiplayerRoom.update({
    where: { roomId },
    data: { moduleName, status: "ready" },
  });
}

/**
 * A player selects a character for this room.
 */
export async function selectCharacter(
  roomId: string,
  userId: string,
  characterId: string
): Promise<void> {
  const prisma = getPrismaClient();

  // Block in checkpoint mode
  const roomCheck = await prisma.multiplayerRoom.findUnique({
    where: { roomId },
    select: { sourceCheckpointId: true },
  });
  if (roomCheck?.sourceCheckpointId) throw new Error("Cannot change character in checkpoint mode");

  // Verify character belongs to this user
  const character = await prisma.character.findFirst({
    where: { characterId, emailId: { not: null }, isNpc: false },
    select: { characterId: true, emailId: true },
  });
  if (!character) throw new Error("Character not found");

  // Verify the user's membership
  const member = await prisma.multiplayerRoomMember.findFirst({
    where: { roomId, userId },
    select: { id: true },
  });
  if (!member) throw new Error("You are not a member of this room");

  // Check no other member has selected this character
  const conflict = await prisma.multiplayerRoomMember.findFirst({
    where: { roomId, characterId, userId: { not: userId } },
    select: { id: true },
  });
  if (conflict) throw new Error("This character is already selected by another player");

  await prisma.multiplayerRoomMember.update({
    where: { id: member.id },
    data: { characterId, confirmStatus: "pending" },
  });
}

/**
 * A player confirms their character selection.
 */
export async function confirmReady(
  roomId: string,
  userId: string
): Promise<void> {
  const prisma = getPrismaClient();

  const roomCheck = await prisma.multiplayerRoom.findUnique({
    where: { roomId },
    select: { sourceCheckpointId: true },
  });
  if (roomCheck?.sourceCheckpointId) throw new Error("Cannot manually confirm in checkpoint mode");

  const member = await prisma.multiplayerRoomMember.findFirst({
    where: { roomId, userId },
    select: { id: true, characterId: true },
  });
  if (!member) throw new Error("You are not a member of this room");
  if (!member.characterId)
    throw new Error("You must select a character before confirming");

  await prisma.multiplayerRoomMember.update({
    where: { id: member.id },
    data: { confirmStatus: "confirmed" },
  });
}

/**
 * A player cancels their ready confirmation, reverting to pending.
 */
export async function unconfirmReady(
  roomId: string,
  userId: string
): Promise<void> {
  const prisma = getPrismaClient();

  const room = await prisma.multiplayerRoom.findUnique({
    where: { roomId },
    select: { status: true, sourceCheckpointId: true },
  });
  if (room?.sourceCheckpointId) throw new Error("Cannot cancel ready in checkpoint mode");
  if (room?.status === "playing") throw new Error("Cannot cancel ready after game has started");

  const member = await prisma.multiplayerRoomMember.findFirst({
    where: { roomId, userId },
    select: { id: true, confirmStatus: true },
  });
  if (!member) throw new Error("You are not a member of this room");

  await prisma.multiplayerRoomMember.update({
    where: { id: member.id },
    data: { confirmStatus: "pending" },
  });
}

/**
 * Host starts the game. All members must be confirmed and module must be set.
 */
export async function startGame(
  roomId: string,
  hostUserId: string
): Promise<void> {
  const prisma = getPrismaClient();

  const room = await prisma.multiplayerRoom.findUnique({
    where: { roomId },
    include: {
      members: { select: { userId: true, confirmStatus: true, characterId: true } },
    },
  });

  if (!room) throw new Error("Room not found");
  if (room.hostUserId !== hostUserId) throw new Error("Only the host can start the game");
  if (room.status === "playing") throw new Error("Game already started");
  if (!room.moduleName) throw new Error("Host must select a module before starting");

  // Checkpoint mode: all original players must be present
  if (room.sourceCheckpointId) {
    const checkpoint = await prisma.multiplayerCheckpoint.findUnique({
      where: { checkpointId: room.sourceCheckpointId },
      select: { payload: true },
    });
    if (checkpoint) {
      const payload = (typeof checkpoint.payload === "string"
        ? JSON.parse(checkpoint.payload)
        : checkpoint.payload) as any;
      const originalPlayerIds = Object.keys(payload?.players ?? {});
      const currentUserIds = new Set(room.members.map((m) => m.userId));
      const missing = originalPlayerIds.filter((id) => !currentUserIds.has(id));
      if (missing.length > 0) {
        throw new Error(`Waiting for ${missing.length} original player(s) to join`);
      }
    }
  } else {
    // Normal mode: all must be confirmed with characters
    const unconfirmed = room.members.filter((m) => m.confirmStatus !== "confirmed");
    if (unconfirmed.length > 0) {
      throw new Error(`Waiting for ${unconfirmed.length} player(s) to confirm their character`);
    }

    if (room.members.some((m) => !m.characterId)) {
      throw new Error("All players must select a character before starting");
    }
  }

  await prisma.multiplayerRoom.update({
    where: { roomId },
    data: { status: "playing" },
  });
}

/**
 * Get a full overview of a room (caller must be a member).
 */
export async function getRoomOverview(
  roomId: string,
  userId: string
): Promise<RoomOverview> {
  const prisma = getPrismaClient();

  const room = await prisma.multiplayerRoom.findUnique({
    where: { roomId },
    include: {
      members: {
        orderBy: { seatOrder: "asc" },
        select: {
          id: true,
          userId: true,
          role: true,
          characterId: true,
          seatOrder: true,
          confirmStatus: true,
          joinedAt: true,
        },
      },
    },
  });

  if (!room) throw new Error("Room not found");

  const isMember = room.members.some((m) => m.userId === userId);
  if (!isMember) throw new Error("You are not a member of this room");

  // Batch-fetch character names for members that have a characterId
  const characterIds = room.members
    .map((m) => m.characterId)
    .filter((id): id is string => id != null);

  const characterNameMap = new Map<string, string>();
  if (characterIds.length > 0) {
    const chars = await prisma.character.findMany({
      where: { characterId: { in: characterIds } },
      select: { characterId: true, name: true },
    });
    for (const c of chars) {
      characterNameMap.set(c.characterId, c.name);
    }
  }

  // Get checkpoint player IDs if in checkpoint mode
  let checkpointPlayerIds: string[] | null = null;
  if (room.sourceCheckpointId) {
    const checkpoint = await prisma.multiplayerCheckpoint.findUnique({
      where: { checkpointId: room.sourceCheckpointId },
      select: { payload: true },
    });
    if (checkpoint) {
      const payload = (typeof checkpoint.payload === "string"
        ? JSON.parse(checkpoint.payload)
        : checkpoint.payload) as any;
      checkpointPlayerIds = Object.keys(payload?.players ?? {});
    }
  }

  return {
    roomId: room.roomId,
    roomCode: room.roomCode,
    status: room.status,
    hostUserId: room.hostUserId,
    moduleName: room.moduleName,
    sourceCheckpointId: room.sourceCheckpointId,
    checkpointPlayerIds,
    createdAt: room.createdAt,
    members: room.members.map((m) => ({
      ...m,
      characterName: m.characterId ? (characterNameMap.get(m.characterId) ?? null) : null,
    })),
    isHost: room.hostUserId === userId,
  };
}

/**
 * List rooms the user is currently active in.
 */
export async function listMyRooms(
  userId: string
): Promise<Array<{ roomId: string; roomCode: string; status: string; role: string }>> {
  const prisma = getPrismaClient();

  const memberships = await prisma.multiplayerRoomMember.findMany({
    where: {
      userId,
      room: { status: { in: ["waiting", "ready", "playing"] } },
    },
    include: {
      room: { select: { roomId: true, roomCode: true, status: true } },
    },
    orderBy: { joinedAt: "desc" },
  });

  return memberships.map((m) => ({
    roomId: m.room.roomId,
    roomCode: m.room.roomCode,
    status: m.room.status,
    role: m.role,
  }));
}
