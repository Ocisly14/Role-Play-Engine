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
import {
  createAndStoreMultiplayerSession,
  multiplayerSessionStore,
} from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.js";
import { resolveModuleIdByName } from "../../../../src/shared/agents/memory/database/moduleScope.js";

export interface MultiplayerGameInitResult {
  sessionId: string;
  initialSceneRoomId: string;
  playerCount: number;
  moduleIntroduction: { introduction: string; moduleNotes: string } | null;
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
          user: { select: { email: true } },
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

  // 1b. Guard against double-initialisation (would overwrite in-memory state)
  if (multiplayerSessionStore.has(roomId)) {
    const existing = multiplayerSessionStore.get(roomId)!;
    const existingSessionId = existing.getState().sessionId;
    console.warn(
      `[MultiplayerGame] initGame called but session already exists for room ${roomId} (session=${existingSessionId})`
    );
    const existingState = existing.getState();
    const existingSceneRoomId = Object.keys(existingState.sceneRooms)[0];

    // Return the existing session info instead of re-initialising
    let existingIntro: { introduction: string; moduleNotes: string } | null = null;
    if (existingState.moduleDigest) {
      const intro = (existingState.moduleDigest as any).introduction;
      const notes = (existingState.moduleDigest as any).moduleNotes || "";
      if (intro) {
        existingIntro = { introduction: intro, moduleNotes: notes };
      }
    }

    return {
      sessionId: existingSessionId,
      initialSceneRoomId: existingSceneRoomId,
      playerCount: Object.keys(existingState.players).length,
      moduleIntroduction: existingIntro,
    };
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
  if (!initialSceneRoomId) {
    throw new Error("Failed to create initial scene room — state.sceneRooms is empty");
  }

  // 4b. Auto-grant module access to all non-host members
  //     so they don't get errors when they haven't added the module to their library
  const moduleId = await resolveModuleIdByName(room.moduleName, hostEmail);
  if (moduleId) {
    const nonHostMembers = room.members.filter((m) => m.userId !== hostUserId);
    for (const member of nonHostMembers) {
      const memberEmail = member.user.email;
      try {
        await prisma.modulePermission.upsert({
          where: { moduleId_emailId: { moduleId, emailId: memberEmail } },
          update: {},
          create: {
            moduleId,
            emailId: memberEmail,
            role: "viewer",
            canPlay: true,
            canManage: false,
          },
        });
        await prisma.userModuleLibrary.upsert({
          where: { emailId_moduleId: { emailId: memberEmail, moduleId } },
          update: {},
          create: {
            emailId: memberEmail,
            moduleId,
            source: "shared_added",
          },
        });
      } catch (err) {
        console.warn(
          `[MultiplayerGame] Failed to grant module access to ${memberEmail}:`,
          err
        );
      }
    }
    console.log(
      `[MultiplayerGame] Module access granted to ${nonHostMembers.length} non-host member(s)`
    );
  }

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

  // 7. Extract module introduction from loaded state
  let moduleIntroduction: { introduction: string; moduleNotes: string } | null = null;
  if (state.moduleDigest) {
    const intro = (state.moduleDigest as any).introduction;
    const notes = (state.moduleDigest as any).moduleNotes || "";
    if (intro) {
      moduleIntroduction = { introduction: intro, moduleNotes: notes };
    }
  }

  // 8. Create introduction turn (turnNumber: 0) if module has an introduction
  //    Mirrors single-player pattern from client/server/game/controller.ts
  if (moduleIntroduction && moduleIntroduction.introduction) {
    try {
      const existingIntro = await prisma.gameTurn.findFirst({
        where: {
          sessionId,
          turnNumber: 0,
          characterInput: "",
        },
        select: { turnId: true },
      });

      if (!existingIntro) {
        const introTurnId = `turn-intro-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const initialGameDay = state.gameDay ?? null;
        const initialGameTime = state.timeOfDay ?? null;

        // Look up the session record for moduleId/emailId
        const sessionRecord = await prisma.session.findUnique({
          where: { sessionId },
          select: { moduleId: true, emailId: true },
        });

        await prisma.gameTurn.create({
          data: {
            turnId: introTurnId,
            sessionId,
            moduleId: sessionRecord?.moduleId || null,
            emailId: sessionRecord?.emailId || hostEmail,
            turnNumber: 0,
            characterInput: "",
            characterId: null,
            characterName: null,
            keeperNarrative: moduleIntroduction.introduction,
            status: "completed",
            startedAt: new Date(),
            completedAt: new Date(),
            gameDay: initialGameDay,
            gameTime: initialGameTime,
            sceneRoomId: initialSceneRoomId,
          },
        });

        console.log(
          `[MultiplayerGame] Introduction turn created: ${introTurnId} — Day ${initialGameDay}, ${initialGameTime}`
        );
      } else {
        console.log(
          `[MultiplayerGame] Introduction turn already exists for session ${sessionId}`
        );
      }
    } catch (error) {
      // Don't fail the game start if introduction turn creation fails
      console.error("[MultiplayerGame] Failed to create introduction turn:", error);
    }
  }

  console.log(
    `[MultiplayerGame] Room ${roomId} game initialised — sessionId=${sessionId}, sceneRoomId=${initialSceneRoomId}`
  );

  return {
    sessionId,
    initialSceneRoomId,
    playerCount: players.length,
    moduleIntroduction,
  };
}
