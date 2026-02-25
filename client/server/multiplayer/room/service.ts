import { randomUUID } from "crypto";
import { getPrismaClient } from "../../../../src/shared/agents/memory/database/prismaClient.js";
import { generateUniqueRoomCode } from "./roomCodeGenerator.js";

export interface RoomOverview {
  roomId: string;
  roomCode: string;
  status: string;
  hostUserId: string;
  moduleName: string | null;
  createdAt: Date;
  members: Array<{
    id: string;
    userId: string;
    role: string;
    characterId: string | null;
    seatOrder: number;
    confirmStatus: string;
    joinedAt: Date;
  }>;
  isHost: boolean;
}

/**
 * Create a new multiplayer room and add the creator as host.
 */
export async function createRoom(
  hostUserId: string
): Promise<{ roomId: string; roomCode: string }> {
  const prisma = getPrismaClient();
  const roomId = randomUUID();
  const roomCode = await generateUniqueRoomCode();

  await prisma.$transaction(async (tx) => {
    await tx.multiplayerRoom.create({
      data: {
        roomId,
        roomCode,
        hostUserId,
        status: "waiting",
      },
    });

    await tx.multiplayerRoomMember.create({
      data: {
        id: randomUUID(),
        roomId,
        userId: hostUserId,
        role: "host",
        seatOrder: 1,
        confirmStatus: "pending",
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
    // Idempotent: return room if already a member
    return { roomId: room.roomId };
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
      confirmStatus: "pending",
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
    select: { hostUserId: true, status: true },
  });

  if (!room) throw new Error("Room not found");
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

  const unconfirmed = room.members.filter((m) => m.confirmStatus !== "confirmed");
  if (unconfirmed.length > 0) {
    throw new Error(`Waiting for ${unconfirmed.length} player(s) to confirm their character`);
  }

  if (room.members.some((m) => !m.characterId)) {
    throw new Error("All players must select a character before starting");
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

  return {
    roomId: room.roomId,
    roomCode: room.roomCode,
    status: room.status,
    hostUserId: room.hostUserId,
    moduleName: room.moduleName,
    createdAt: room.createdAt,
    members: room.members,
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
