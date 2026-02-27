/**
 * Multiplayer Turn Input Service
 *
 * Collects per-player inputs for a sceneRoom round.
 * Triggers the multiplayer graph when all players have submitted.
 * Broadcasts result via WebSocket when the graph completes.
 */

import { randomUUID } from "crypto";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../../../src/shared/agents/memory/database/index.js";
import { getPrismaClient } from "../../../../src/shared/agents/memory/database/prismaClient.js";
import {
  MultiplayerDynamicGameStateManager,
  toAbsoluteMinutes,
  type MultiplayerTurnInput,
} from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameState.js";
import { multiplayerSessionStore } from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.js";
import { buildMultiplayerGraph } from "../../../../src/dynamicworldagent/multiplayerGraph/index.js";
import { resolveAllMovements, type TimeBubbleMergeInfo } from "../../../../src/dynamicworldagent/multiplayerGraph/sceneRoomMerger.js";
import { generateSceneRoomImage } from "../../../../src/dynamicworldagent/multiplayerVisual/sceneImage.js";
import { TurnManager } from "../../../../src/dynamicworldagent/multiplayerAgent/memory/turnManager.js";
import { ScenarioLoader } from "../../../../src/shared/agents/memory/scenarioloader/index.js";
import { DirectorAgent } from "../../../../src/dynamicworldagent/multiplayerAgent/director/directorAgent.js";
import { WebSocketManager } from "../../websocket/WebSocketManager.js";
import { notifySceneRoom } from "../../websocket/notifier.js";

// =============================================
// Types
// =============================================

export interface SubmitInputResult {
  status: "waiting" | "processing";
  roundNumber: number;
  submittedCount: number;
  totalCount: number;
}

export interface RoundStateResult {
  roundNumber: number;
  submittedPlayerIds: string[];
  totalCount: number;
  gameDay: number;
  timeOfDay: string;
  /** Per-sceneRoom game day (independent time tracking) */
  sceneRoomGameDay: number;
  /** Per-sceneRoom time of day */
  sceneRoomTimeOfDay: string;
  /** True if this room is currently blocked due to time drift */
  timeDriftBlocked: boolean;
  /** Time drift in minutes between fastest and slowest active rooms */
  timeDriftMinutes: number;
  /** Player IDs that are currently time-frozen in this room */
  timeFrozenPlayerIds: string[];
  /** True if the requesting player is time-frozen */
  isCurrentPlayerTimeFrozen: boolean;
}

// =============================================
// submitRoundInput
// =============================================

export async function submitRoundInput(
  db: CoCDatabase | CoCDatabaseAdapter,
  roomId: string,
  sceneRoomId: string,
  userId: string,
  inputData: {
    characterId: string;
    inputType: "input" | "skip";
    content?: string;
    selectedSkill?: string | null;
    skillSelectionMode?: "manual" | "auto";
    language?: "en" | "zh";
  }
): Promise<SubmitInputResult> {
  const manager = multiplayerSessionStore.get(roomId);
  if (!manager) {
    throw new Error("Game session not found. Has the game been initialized?");
  }

  const sceneRoom = manager.getSceneRoom(sceneRoomId);
  if (!sceneRoom) {
    throw new Error(`SceneRoom ${sceneRoomId} not found`);
  }

  if (!sceneRoom.memberPlayerIds.includes(userId)) {
    throw new Error("You are not a member of this scene room");
  }

  // Reject input to frozen rooms (they are historical snapshots, not active)
  if (sceneRoom.isFrozen) {
    throw new Error(
      "This scene room is frozen and no longer accepts input. " +
        "Your character has been moved to a new scene room."
    );
  }

  // Reject input to rest-frozen rooms (waiting for other rooms to catch up)
  if (manager.isSceneRoomRestFrozen(sceneRoomId)) {
    throw new Error(
      "REST_FROZEN: This scene room is resting and waiting for other rooms to catch up."
    );
  }

  // Reject input from players who are time-frozen (waiting for room time to catch up)
  if (manager.isPlayerTimeFrozen(sceneRoomId, userId)) {
    const frozenTime = sceneRoom.timeFrozenPlayers?.[userId];
    throw new Error(
      "TIME_FROZEN: Your character is adjusting to the local timeline. " +
        `Waiting for room time to catch up (your time: Day ${frozenTime?.gameDay ?? "?"}, ${frozenTime?.timeOfDay ?? "?"}).`
    );
  }

  // Check game ending
  if (manager.getState().gameEnding?.isEnded) {
    throw new Error("The game has already ended");
  }

  // Check time drift — block input for rooms that are too far ahead
  const driftInfo = manager.getTimeDriftInfo();
  if (driftInfo.blockedRoomIds.includes(sceneRoomId)) {
    const state = manager.getState();
    const isRoomInCombat = state.isBattle && state.combatSceneRoomId === sceneRoomId;
    if (!isRoomInCombat) {
      throw new Error(
        "TIME_DRIFT_BLOCKED: This scene room is too far ahead in time. " +
        `Waiting for slower rooms to catch up (drift: ${driftInfo.driftMinutes} minutes).`
      );
    }
  }

  const input: MultiplayerTurnInput = {
    playerId: userId,
    characterId: inputData.characterId,
    inputType: inputData.inputType,
    content: inputData.content,
    selectedSkill: inputData.selectedSkill ?? null,
    skillSelectionMode: inputData.skillSelectionMode ?? "manual",
  };

  // 1. Add to in-memory manager (idempotent — replaces prior input from same player)
  manager.addRoundInput(input);

  // 2. Persist to DB
  const prisma = getPrismaClient();
  const roundNumber = sceneRoom.roundNumber;
  const inputId = randomUUID();

  try {
    await prisma.multiplayerRoundInput.upsert({
      where: {
        sceneRoomId_roundNumber_playerId: {
          sceneRoomId,
          roundNumber,
          playerId: userId,
        },
      },
      create: {
        inputId,
        roomId,
        sceneRoomId,
        roundNumber,
        playerId: userId,
        characterId: inputData.characterId,
        inputType: inputData.inputType,
        content: inputData.content ?? null,
        selectedSkill: inputData.selectedSkill ?? null,
        skillSelectionMode: inputData.skillSelectionMode ?? null,
      },
      update: {
        inputType: inputData.inputType,
        content: inputData.content ?? null,
        selectedSkill: inputData.selectedSkill ?? null,
        skillSelectionMode: inputData.skillSelectionMode ?? null,
        submittedAt: new Date(),
      },
    });
  } catch (e) {
    // Non-fatal: in-memory state is authoritative; DB is for auditing
    console.warn("[MP Turn] Failed to persist round input to DB:", e);
  }

  // 3. Check if all players have submitted
  const roundInputs = manager.getRoundInputsForSceneRoom(sceneRoomId);
  const submittedCount = roundInputs.length;
  const totalCount = sceneRoom.memberPlayerIds.length;
  const allSubmitted = manager.allPlayersSubmittedForSceneRoom(sceneRoomId);

  if (allSubmitted) {
    const language = inputData.language ?? "zh";
    const roundTurnId = randomUUID();

    // Trigger graph asynchronously
    triggerMultiplayerGraph(
      db,
      roomId,
      sceneRoomId,
      roundTurnId,
      [...roundInputs],
      language
    ).catch((err) => {
      console.error(
        `[MP Turn] Graph execution failed for sceneRoom ${sceneRoomId}:`,
        err
      );
      const wsManager = WebSocketManager.getInstance();
      if (wsManager) {
        const clients = wsManager.getMultiplayerClients(sceneRoomId);
        notifySceneRoom(sceneRoomId, clients, {
          type: "round_error",
          sceneRoomId,
          roundTurnId,
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        });
      }
    });

    return { status: "processing", roundNumber, submittedCount, totalCount };
  }

  return { status: "waiting", roundNumber, submittedCount, totalCount };
}

// =============================================
// triggerMultiplayerGraph (async, after all players submit)
// =============================================

async function triggerMultiplayerGraph(
  db: CoCDatabase | CoCDatabaseAdapter,
  roomId: string,
  sceneRoomId: string,
  roundTurnId: string,
  roundInputs: MultiplayerTurnInput[],
  language: "en" | "zh"
): Promise<void> {
  const manager = multiplayerSessionStore.get(roomId);
  if (!manager) {
    throw new Error(`Manager for room ${roomId} not found`);
  }

  const wsManager = WebSocketManager.getInstance();

  // Persist a per-sceneRoom "turn" record for DB-backed conversationHistory / RAG.
  // Only create a turn when there is at least one non-empty input.
  const initialState = manager.getState();
  const initialSceneRoom = manager.getSceneRoom(sceneRoomId);
  const effectiveInputs = roundInputs.filter(
    (i) => i.inputType === "input" && Boolean(i.content?.trim())
  );
  const combinedInputForTurn = effectiveInputs
    .map((i) => {
      const playerName = initialState.players[i.playerId]?.characterName ?? i.playerId;
      return `${playerName}: ${i.content?.trim() ?? ""}`;
    })
    .join("\n");

  const turnManager = new TurnManager(db);
  let persistedTurnId: string | null = null;
  if (combinedInputForTurn) {
    persistedTurnId = await turnManager.createTurn({
      sessionId: initialState.sessionId,
      sceneRoomId,
      characterInput: combinedInputForTurn,
      // Multiplayer: aggregated input, no single character identity.
      characterId: undefined,
      characterName: undefined,
      sceneId: initialSceneRoom?.currentScenario?.id ?? undefined,
      sceneName: initialSceneRoom?.currentScenario?.name ?? undefined,
      location: initialSceneRoom?.currentScenario?.location ?? undefined,
      gameDay: initialSceneRoom?.gameDay ?? initialState.gameDay ?? null,
      gameTime: initialSceneRoom?.timeOfDay ?? initialState.timeOfDay ?? null,
    });
  }

  // Notify clients that round processing has started
  if (wsManager) {
    const clients = wsManager.getMultiplayerClients(sceneRoomId);
    notifySceneRoom(sceneRoomId, clients, {
      type: "round_processing",
      sceneRoomId,
      roundTurnId,
      timestamp: new Date().toISOString(),
    });
  }

  const stream = buildStreamHandlers(sceneRoomId, roundTurnId);
  const graph = buildMultiplayerGraph(db);

  const graphState = {
    dynamicGameState: manager.getState(),
    sceneRoomId,
    roundInputs,
    roundTurnId,
    language,
    stream,
  };

  let result: any;
  try {
    result = await graph.invoke(graphState, {
      configurable: { thread_id: roundTurnId },
    });
  } catch (err) {
    if (persistedTurnId) {
      try {
        (db as any).markTurnError?.(
          persistedTurnId,
          err instanceof Error ? err.message : String(err)
        );
      } catch {
        // non-fatal
      }
    }
    throw err;
  }

  // Replace stored manager with the updated state from graph result
  if (result.dynamicGameState) {
    const newManager = new MultiplayerDynamicGameStateManager(
      result.dynamicGameState
    );
    multiplayerSessionStore.set(roomId, newManager);
  }

  // Extract keeper narrative from final sceneRoom temporaryInfo
  const updatedManager = multiplayerSessionStore.get(roomId);
  const updatedSceneRoom = updatedManager?.getSceneRoom(sceneRoomId);
  const keeperNarrative =
    (updatedSceneRoom?.temporaryInfo.contextualData
      ?.keeperNarrative as string) ?? "";
  const diceRolls =
    (updatedSceneRoom?.temporaryInfo.contextualData?.diceRolls as
      | unknown[]
      | undefined) ?? [];

  if (persistedTurnId && updatedSceneRoom) {
    // Store orchestrator analyses + action results for RAG and debugging.
    turnManager.updateProcessing(persistedTurnId, {
      actionAnalysis:
        updatedSceneRoom.temporaryInfo.contextualData?.playerActionAnalyses ?? null,
      actionResults: updatedSceneRoom.temporaryInfo.actionResults ?? null,
    });
    // Use per-room time for turn record
    const roomGameDay = updatedSceneRoom.gameDay ?? result.dynamicGameState?.gameDay ?? null;
    const roomTimeOfDay = updatedSceneRoom.timeOfDay ?? result.dynamicGameState?.timeOfDay ?? null;
    turnManager.completeTurn(
      persistedTurnId,
      {
        keeperNarrative,
        gameDay: roomGameDay,
        gameTime: roomTimeOfDay,
      },
      language
    );
  }

  // Use per-room time for broadcast
  const broadcastGameDay = updatedSceneRoom?.gameDay ?? result.dynamicGameState?.gameDay;
  const broadcastTimeOfDay = updatedSceneRoom?.timeOfDay ?? result.dynamicGameState?.timeOfDay;

  // Broadcast round complete
  if (wsManager) {
    const clients = wsManager.getMultiplayerClients(sceneRoomId);
    notifySceneRoom(sceneRoomId, clients, {
      type: "round_complete",
      sceneRoomId,
      roundTurnId,
      keeperNarrative,
      diceRolls,
      gameDay: broadcastGameDay,
      gameTime: broadcastTimeOfDay,
      isBattle: result.dynamicGameState?.isBattle ?? false,
      gameEnding: result.dynamicGameState?.gameEnding ?? null,
      timestamp: new Date().toISOString(),
    });
  }

  console.log(
    `[MP Turn] Round ${roundTurnId} complete for sceneRoom ${sceneRoomId}`
  );

  // ---- Check for rest-frozen room ----
  if (updatedManager && wsManager && updatedManager.isSceneRoomRestFrozen(sceneRoomId)) {
    const restFrozenRoom = updatedManager.getSceneRoom(sceneRoomId);
    const clients = wsManager.getMultiplayerClients(sceneRoomId);
    notifySceneRoom(sceneRoomId, clients, {
      type: "rest_frozen",
      sceneRoomId,
      message: "Resting... waiting for other rooms to catch up.",
      gameDay: restFrozenRoom?.gameDay,
      timeOfDay: restFrozenRoom?.timeOfDay,
      timestamp: new Date().toISOString(),
    });
    console.log(
      `[MP Turn] SceneRoom ${sceneRoomId} is rest-frozen after rest round`
    );
  }

  // ---- Check for time-unfrozen players ----
  if (updatedManager && wsManager && updatedSceneRoom) {
    const unfrozenPlayerIds =
      (updatedSceneRoom.temporaryInfo.contextualData?.unfrozenPlayerIds as
        | string[]
        | undefined) ?? [];
    if (unfrozenPlayerIds.length > 0) {
      const clients = wsManager.getMultiplayerClients(sceneRoomId);
      for (const unfrozenId of unfrozenPlayerIds) {
        const player = updatedManager.getState().players[unfrozenId];
        notifySceneRoom(sceneRoomId, clients, {
          type: "player_time_unfrozen",
          sceneRoomId,
          playerId: unfrozenId,
          playerName: player?.characterName ?? unfrozenId,
          timestamp: new Date().toISOString(),
        });
      }
      console.log(
        `[MP Turn] Time-unfrozen players in ${sceneRoomId}: ${unfrozenPlayerIds.join(", ")}`
      );
    }
  }

  // ---- Phase 4: Scene Room Splitting ----
  // Check if any players requested a scene change; if so, split sceneRooms
  // and notify clients. This runs after round_complete so clients see the
  // round result before the scene transition notification.
  if (updatedManager) {
    await handlePostRoundSceneSplit(
      db,
      roomId,
      sceneRoomId,
      updatedManager,
      wsManager
    );
  }

  // ---- Time drift broadcast ----
  // After round completion (and possible scene splits), check drift and notify rooms
  if (updatedManager && wsManager) {
    const postDrift = updatedManager.getTimeDriftInfo();
    if (postDrift.blockedRoomIds.length > 0) {
      for (const blockedId of postDrift.blockedRoomIds) {
        const blockedClients = wsManager.getMultiplayerClients(blockedId);
        notifySceneRoom(blockedId, blockedClients, {
          type: "time_drift_blocked",
          sceneRoomId: blockedId,
          driftMinutes: postDrift.driftMinutes,
          fastestRoomId: postDrift.fastestRoomId,
          slowestRoomId: postDrift.slowestRoomId,
          timestamp: new Date().toISOString(),
        });
      }
    }
    if (postDrift.allWithinResume && postDrift.driftMinutes > 0) {
      // All rooms are within 1H — send resume to any room that might have been blocked
      for (const room of updatedManager.getActiveSceneRooms()) {
        const resumeClients = wsManager.getMultiplayerClients(room.sceneRoomId);
        notifySceneRoom(room.sceneRoomId, resumeClients, {
          type: "time_drift_resumed",
          sceneRoomId: room.sceneRoomId,
          driftMinutes: postDrift.driftMinutes,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // ---- Phase 4: Scene Image Generation ----
  // Generate scene image for the (possibly updated) sceneRoom, fire-and-forget
  if (updatedManager) {
    const state = updatedManager.getState();
    const finalSceneRoom = updatedManager.getSceneRoom(sceneRoomId);
    if (finalSceneRoom?.currentScenario && state.moduleName) {
      generateSceneRoomImage(finalSceneRoom.currentScenario, state.moduleName)
        .then((imageResult) => {
          if (imageResult && wsManager) {
            const clients = wsManager.getMultiplayerClients(sceneRoomId);
            notifySceneRoom(sceneRoomId, clients, {
              type: "scene_image_ready",
              sceneRoomId,
              imagePath: imageResult.path,
              mimeType: imageResult.mimeType,
              timestamp: new Date().toISOString(),
            });
          }
        })
        .catch((err) => {
          console.warn("[MP Turn] Scene image generation failed:", err);
        });
    }
  }

  // ---- Rest-unfreeze coordination ----
  // After every round completes, check if any rest-frozen rooms can now be unfrozen
  if (updatedManager) {
    await handleRestUnfreezeCheck(updatedManager, db, wsManager);
  }
}

// =============================================
// handleRestUnfreezeCheck — Unfreeze rest-frozen rooms + run deferred trigger checks
// =============================================

async function handleRestUnfreezeCheck(
  manager: MultiplayerDynamicGameStateManager,
  db: CoCDatabase | CoCDatabaseAdapter,
  wsManager: ReturnType<typeof WebSocketManager.getInstance>
): Promise<void> {
  const eligible = manager.checkRestUnfreezeEligibility();
  if (eligible.length === 0) return;

  // Sort by time ascending — unfreeze shorter-time rooms first
  eligible.sort((a, b) => {
    const roomA = manager.getSceneRoom(a);
    const roomB = manager.getSceneRoom(b);
    if (!roomA || !roomB) return 0;
    const minA = toAbsoluteMinutes(roomA.gameDay, roomA.timeOfDay);
    const minB = toAbsoluteMinutes(roomB.gameDay, roomB.timeOfDay);
    return minA - minB;
  });

  console.log(
    `[MP Turn] Rest-unfreeze eligible rooms: ${eligible.join(", ")}`
  );

  const scenarioLoader = new ScenarioLoader(db);
  const directorAgent = new DirectorAgent(scenarioLoader, db);

  for (const roomId of eligible) {
    manager.restUnfreezeSceneRoom(roomId);

    // Send WS notification
    if (wsManager) {
      const clients = wsManager.getMultiplayerClients(roomId);
      notifySceneRoom(roomId, clients, {
        type: "rest_unfrozen",
        sceneRoomId: roomId,
        message: "Rest complete. Resuming play.",
        timestamp: new Date().toISOString(),
      });
    }

    console.log(`[MP Turn] Rest-unfrozen sceneRoom ${roomId}`);

    // Run deferred trigger check
    try {
      const triggerResult = await directorAgent.checkGlobalTriggerAndGameEnd(
        manager,
        roomId
      );

      if (triggerResult.victoryAchieved) {
        console.log(
          `[MP Turn] Deferred trigger check: victory achieved after rest-unfreeze of ${roomId}`
        );
        if (wsManager) {
          for (const room of manager.getActiveSceneRooms()) {
            const clients = wsManager.getMultiplayerClients(room.sceneRoomId);
            notifySceneRoom(room.sceneRoomId, clients, {
              type: "game_ending_update",
              gameEnding: manager.getState().gameEnding,
              timestamp: new Date().toISOString(),
            });
          }
        }
        break; // Don't unfreeze more rooms if game ended
      }

      if (triggerResult.triggered && triggerResult.causesGameEnd) {
        console.log(
          `[MP Turn] Deferred trigger check: game end triggered after rest-unfreeze of ${roomId}`
        );
        if (wsManager) {
          for (const room of manager.getActiveSceneRooms()) {
            const clients = wsManager.getMultiplayerClients(room.sceneRoomId);
            notifySceneRoom(room.sceneRoomId, clients, {
              type: "game_ending_update",
              gameEnding: manager.getState().gameEnding,
              timestamp: new Date().toISOString(),
            });
          }
        }
        break; // Don't unfreeze more rooms if game ended
      }

      if (triggerResult.triggered) {
        console.log(
          `[MP Turn] Deferred trigger check: trigger fired (non-ending) after rest-unfreeze of ${roomId}`
        );
      }
    } catch (e) {
      console.error(
        `[MP Turn] Deferred trigger check failed for sceneRoom ${roomId}:`,
        e
      );
    }
  }

  // Persist updated state back to session store
  // (manager is already the reference from multiplayerSessionStore, mutations are in-place)
}

// =============================================
// handlePostRoundSceneSplit — Freeze-Fork-Merge (Phase 5)
// =============================================

async function handlePostRoundSceneSplit(
  db: CoCDatabase | CoCDatabaseAdapter,
  roomId: string,
  _sceneRoomId: string,
  manager: MultiplayerDynamicGameStateManager,
  wsManager: ReturnType<typeof WebSocketManager.getInstance>
): Promise<void> {
  try {
    // resolveAllMovements handles ALL active sceneRooms globally:
    // splits, merges, and cross-room merges — all in one pass.
    // Snapshots are pre-generated by handleMultiplayerSceneChanges in the director node.
    const result = await resolveAllMovements(manager);

    if (!result.anyChanges) return;

    const prisma = getPrismaClient();
    const frozenAt = new Date();

    // ── Persist frozen rooms to DB ──
    for (const frozenId of result.frozenSceneRoomIds) {
      try {
        await prisma.multiplayerSceneRoom.update({
          where: { sceneRoomId: frozenId },
          data: { status: "frozen", frozenAt },
        });
      } catch (e) {
        console.warn(`[MP Turn] Failed to freeze sceneRoom ${frozenId} in DB:`, e);
      }
    }

    // ── Persist new child rooms to DB (with per-room time) ──
    for (const childRoom of result.newChildRooms) {
      const childState = manager.getSceneRoom(childRoom.sceneRoomId);
      try {
        await prisma.multiplayerSceneRoom.create({
          data: {
            sceneRoomId: childRoom.sceneRoomId,
            roomId,
            scenarioName: childState?.scenarioName ?? null,
            snapshotName: childState?.snapshotName ?? null,
            status: "active",
            roundNumber: 1,
            parentSceneRoomIds: childRoom.parentSceneRoomIds,
            gameDay: childState?.gameDay ?? 1,
            timeOfDay: childState?.timeOfDay ?? "08:00",
          },
        });
      } catch (e) {
        console.warn(
          `[MP Turn] Failed to create child sceneRoom ${childRoom.sceneRoomId} in DB:`, e
        );
      }

      // Update each member's currentSceneRoomId pointer
      for (const playerId of childRoom.playerIds) {
        try {
          await prisma.multiplayerRoomMember.update({
            where: { roomId_userId: { roomId, userId: playerId } },
            data: { currentSceneRoomId: childRoom.sceneRoomId },
          });
        } catch (e) {
          console.warn(
            `[MP Turn] Failed to update member ${playerId} → ${childRoom.sceneRoomId}:`, e
          );
        }
      }
    }

    // ── WebSocket notifications ──
    if (wsManager) {
      const stayerRooms = result.newChildRooms.filter((r) => r.isStayerRoom);
      const moverRooms = result.newChildRooms.filter((r) => !r.isStayerRoom);

      // Notify each frozen room's clients about what happened
      for (const frozenId of result.frozenSceneRoomIds) {
        const frozenClients = wsManager.getMultiplayerClients(frozenId);
        const stayerChild = stayerRooms.find((r) =>
          r.parentSceneRoomIds.includes(frozenId)
        );
        const moverChildren = moverRooms.filter((r) =>
          r.parentSceneRoomIds.includes(frozenId)
        );

        if (moverChildren.length > 0) {
          // Determine if this is a merge (mover child has multiple parents)
          const mergedChildren = moverChildren.filter(
            (r) => r.parentSceneRoomIds.length > 1
          );
          const simpleChildren = moverChildren.filter(
            (r) => r.parentSceneRoomIds.length === 1
          );

          if (mergedChildren.length > 0) {
            // Emit scene_room_merged for rooms involved in a cross-room merge
            for (const merged of mergedChildren) {
              notifySceneRoom(frozenId, frozenClients, {
                type: "scene_room_merged",
                frozenSceneRoomIds: merged.parentSceneRoomIds,
                mergedChildRoom: {
                  sceneRoomId: merged.sceneRoomId,
                  playerIds: merged.playerIds,
                  targetSceneName: merged.targetSceneName,
                },
                timestamp: new Date().toISOString(),
              });
            }
          }

          if (simpleChildren.length > 0 || stayerChild) {
            // Emit scene_room_split for simple fork (one source)
            notifySceneRoom(frozenId, frozenClients, {
              type: "scene_room_split",
              frozenSceneRoomId: frozenId,
              stayerChildRoom: stayerChild
                ? {
                    sceneRoomId: stayerChild.sceneRoomId,
                    playerIds: stayerChild.playerIds,
                  }
                : null,
              moverChildRooms: simpleChildren.map((r) => ({
                sceneRoomId: r.sceneRoomId,
                playerIds: r.playerIds,
                targetSceneName: r.targetSceneName,
              })),
              timestamp: new Date().toISOString(),
            });
          }
        }
      }

      // Notify each new child room's clients that they joined
      for (const childRoom of result.newChildRooms) {
        const childClients = wsManager.getMultiplayerClients(childRoom.sceneRoomId);
        notifySceneRoom(childRoom.sceneRoomId, childClients, {
          type: "scene_room_joined",
          sceneRoomId: childRoom.sceneRoomId,
          targetSceneName: childRoom.targetSceneName,
          playerIds: childRoom.playerIds,
          isStayerRoom: childRoom.isStayerRoom,
          parentSceneRoomIds: childRoom.parentSceneRoomIds,
          timestamp: new Date().toISOString(),
        });

        // Generate scene images for new rooms (fire-and-forget)
        const state = manager.getState();
        const childState = manager.getSceneRoom(childRoom.sceneRoomId);
        if (childState?.currentScenario && state.moduleName) {
          generateSceneRoomImage(childState.currentScenario, state.moduleName)
            .then((imageResult) => {
              if (imageResult && wsManager) {
                const imgClients = wsManager.getMultiplayerClients(
                  childRoom.sceneRoomId
                );
                notifySceneRoom(childRoom.sceneRoomId, imgClients, {
                  type: "scene_image_ready",
                  sceneRoomId: childRoom.sceneRoomId,
                  imagePath: imageResult.path,
                  mimeType: imageResult.mimeType,
                  timestamp: new Date().toISOString(),
                });
              }
            })
            .catch((err) => {
              console.warn(
                `[MP Turn] Scene image for ${childRoom.sceneRoomId} failed:`,
                err
              );
            });
        }
      }
    }

    const stayerCount = result.newChildRooms.filter((r) => r.isStayerRoom).length;
    const moverCount = result.newChildRooms.filter((r) => !r.isStayerRoom).length;
    console.log(
      `[MP Turn] Movements resolved: ${result.frozenSceneRoomIds.length} frozen, ` +
        `${stayerCount} stayer child(ren), ${moverCount} mover/merged child(ren), ` +
        `${result.timeBubbleMerges.length} time bubble merge(s)`
    );

    // ── Handle time bubble merges ──
    if (result.timeBubbleMerges.length > 0) {
      await handleTimeBubbleMerges(
        db,
        roomId,
        manager,
        result.timeBubbleMerges,
        wsManager
      );
    }
  } catch (e) {
    console.error("[MP Turn] handlePostRoundSceneSplit failed:", e);
  }
}

// =============================================
// handleTimeBubbleMerges — Yog-Sothoth time bubble narrative
// =============================================

async function handleTimeBubbleMerges(
  _db: CoCDatabase | CoCDatabaseAdapter,
  _roomId: string,
  manager: MultiplayerDynamicGameStateManager,
  merges: TimeBubbleMergeInfo[],
  wsManager: ReturnType<typeof WebSocketManager.getInstance>
): Promise<void> {
  // DB persistence (frozen rooms, new child rooms, member pointer updates)
  // is already handled by the main handlePostRoundSceneSplit loop above.
  // This function only sends WS join notifications.

  for (const merge of merges) {
    if (wsManager) {
      const childClients = wsManager.getMultiplayerClients(merge.newChildSceneRoomId);
      const state = manager.getState();
      const enteringPlayer = state.players[merge.enteringPlayerId];
      notifySceneRoom(merge.newChildSceneRoomId, childClients, {
        type: "player_joined_via_time_bubble",
        sceneRoomId: merge.newChildSceneRoomId,
        enteringPlayerId: merge.enteringPlayerId,
        enteringPlayerName: enteringPlayer?.characterName ?? merge.enteringPlayerId,
        targetSceneName: merge.targetSceneName,
        timestamp: new Date().toISOString(),
      });
    }

    console.log(
      `[MP Turn] Time bubble merge: player ${merge.enteringPlayerId} → ` +
        `"${merge.targetSceneName}" (child room ${merge.newChildSceneRoomId})`
    );
  }
}

// =============================================
// Streaming handlers for narrative deltas
// =============================================

function buildStreamHandlers(sceneRoomId: string, roundTurnId: string) {
  const modelProvider = (process.env.MODEL_PROVIDER || "").toLowerCase();
  const enableStreaming = modelProvider === "google";
  const wsManager = WebSocketManager.getInstance();

  if (!wsManager || !enableStreaming) return undefined;

  let pending = "";
  let started = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const send = (message: object) => {
    const clients = wsManager.getMultiplayerClients(sceneRoomId);
    notifySceneRoom(sceneRoomId, clients, message);
  };

  const flush = () => {
    if (!pending) return;
    send({ type: "keeper_stream_delta", roundTurnId, sceneRoomId, delta: pending });
    pending = "";
  };

  return {
    onNarrativeStart: () => {
      if (started) return;
      started = true;
      send({ type: "keeper_stream_start", roundTurnId, sceneRoomId });
    },
    onNarrativeDelta: (delta: string) => {
      if (!delta) return;
      if (!started) {
        started = true;
        send({ type: "keeper_stream_start", roundTurnId, sceneRoomId });
      }
      pending += delta;
      if (pending.length >= 48) {
        flush();
        return;
      }
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flush();
          flushTimer = null;
        }, 50);
      }
    },
    onNarrativeEnd: () => {
      if (!started) return;
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
      send({ type: "keeper_stream_end", roundTurnId, sceneRoomId });
    },
    onWorldlineUpdateStart: () => {
      send({ type: "worldline_update_start", roundTurnId, sceneRoomId });
    },
    onWorldlineUpdateEnd: () => {
      send({ type: "worldline_update_end", roundTurnId, sceneRoomId });
    },
  };
}

// =============================================
// getRoundState
// =============================================

export async function getRoundState(
  roomId: string,
  sceneRoomId: string,
  userId: string
): Promise<RoundStateResult> {
  const manager = multiplayerSessionStore.get(roomId);
  if (!manager) throw new Error("Game session not found");

  const sceneRoom = manager.getSceneRoom(sceneRoomId);
  if (!sceneRoom) throw new Error(`SceneRoom ${sceneRoomId} not found`);

  if (!sceneRoom.memberPlayerIds.includes(userId)) {
    throw new Error("Not a member of this scene room");
  }

  const roundInputs = manager.getRoundInputsForSceneRoom(sceneRoomId);
  const state = manager.getState();
  const driftInfo = manager.getTimeDriftInfo();

  return {
    roundNumber: sceneRoom.roundNumber,
    submittedPlayerIds: roundInputs.map((i) => i.playerId),
    totalCount: sceneRoom.memberPlayerIds.length,
    gameDay: state.gameDay,
    timeOfDay: state.timeOfDay,
    sceneRoomGameDay: sceneRoom.gameDay,
    sceneRoomTimeOfDay: sceneRoom.timeOfDay,
    timeDriftBlocked: driftInfo.blockedRoomIds.includes(sceneRoomId),
    timeDriftMinutes: driftInfo.driftMinutes,
    timeFrozenPlayerIds: Object.keys(sceneRoom.timeFrozenPlayers ?? {}),
    isCurrentPlayerTimeFrozen: manager.isPlayerTimeFrozen(sceneRoomId, userId),
  };
}
