import { getPrismaClient } from "../../../../src/shared/agents/memory/database/prismaClient.js";

const MAX_RETRIES = 10;

/**
 * Generates a unique 5-digit room code (10000-99999).
 * Retries up to MAX_RETRIES times if the code is already in use by an active room.
 */
export async function generateUniqueRoomCode(): Promise<string> {
  const prisma = getPrismaClient();

  for (let i = 0; i < MAX_RETRIES; i++) {
    const code = String(Math.floor(10000 + Math.random() * 90000));
    const existing = await prisma.multiplayerRoom.findFirst({
      where: {
        roomCode: code,
        status: { in: ["waiting", "ready", "playing"] },
      },
      select: { roomId: true },
    });
    if (!existing) return code;
  }

  throw new Error(
    `Failed to generate a unique room code after ${MAX_RETRIES} retries`
  );
}
