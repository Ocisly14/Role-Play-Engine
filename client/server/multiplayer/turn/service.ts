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
  type MultiplayerTurnInput,
} from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameState.js";
import { multiplayerSessionStore } from "../../../../src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameStateLoader.js";
import { buildMultiplayerGraph } from "../../../../src/dynamicworldagent/multiplayerGraph/index.js";
import { evaluateAndSplitSceneRooms } from "../../../../src/dynamicworldagent/multiplayerGraph/sceneRoomSplitter.js";
import { DirectorAgent } from "../../../../src/dynamicworldagent/multiplayerAgent/director/directorAgent.js";
import { ScenarioLoader } from "../../../../src/shared/agents/memory/scenarioloader/index.js";
import { generateSceneRoomImage } from "../../../../src/dynamicworldagent/multiplayerVisual/sceneImage.js";
import { TurnManager } from "../../../../src/dynamicworldagent/multiplayerAgent/memory/turnManager.js";
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

  // Check game ending
  if (manager.getState().gameEnding?.isEnded) {
    throw new Error("The game has already ended");
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
      gameDay: initialState.gameDay ?? null,
      gameTime: initialState.timeOfDay ?? null,
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
    turnManager.completeTurn(
      persistedTurnId,
      {
        keeperNarrative,
        gameDay: result.dynamicGameState?.gameDay ?? null,
        gameTime: result.dynamicGameState?.timeOfDay ?? null,
      },
      language
    );
  }

  // Broadcast round complete
  if (wsManager) {
    const clients = wsManager.getMultiplayerClients(sceneRoomId);
    notifySceneRoom(sceneRoomId, clients, {
      type: "round_complete",
      sceneRoomId,
      roundTurnId,
      keeperNarrative,
      diceRolls,
      gameDay: result.dynamicGameState?.gameDay,
      gameTime: result.dynamicGameState?.timeOfDay,
      isBattle: result.dynamicGameState?.isBattle ?? false,
      gameEnding: result.dynamicGameState?.gameEnding ?? null,
      timestamp: new Date().toISOString(),
    });
  }

  console.log(
    `[MP Turn] Round ${roundTurnId} complete for sceneRoom ${sceneRoomId}`
  );

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
}

// =============================================
// handlePostRoundSceneSplit — Phase 4
// =============================================

async function handlePostRoundSceneSplit(
  db: CoCDatabase | CoCDatabaseAdapter,
  roomId: string,
  sceneRoomId: string,
  manager: MultiplayerDynamicGameStateManager,
  wsManager: ReturnType<typeof WebSocketManager.getInstance>
): Promise<void> {
  try {
    const scenarioLoader = new ScenarioLoader(db);
    const directorAgent = new DirectorAgent(scenarioLoader, db);

    const splitResult = await evaluateAndSplitSceneRooms(
      manager,
      sceneRoomId,
      directorAgent,
      db
    );

    if (!splitResult.splitOccurred) return;

    // Persist new sceneRooms to DB
    const prisma = getPrismaClient();
    for (const newRoom of splitResult.newSceneRooms) {
      const newSceneRoomState = manager.getSceneRoom(newRoom.sceneRoomId);

      await prisma.multiplayerSceneRoom.create({
        data: {
          sceneRoomId: newRoom.sceneRoomId,
          roomId,
          scenarioName: newSceneRoomState?.scenarioName ?? null,
          snapshotName: newSceneRoomState?.snapshotName ?? null,
          status: "active",
          roundNumber: 1,
        },
      });

      // Update DB members to point to the new sceneRoom
      for (const playerId of newRoom.playerIds) {
        await prisma.multiplayerRoomMember.update({
          where: { roomId_userId: { roomId, userId: playerId } },
          data: { currentSceneRoomId: newRoom.sceneRoomId },
        });
      }
    }

    // Broadcast scene_room_split to the original sceneRoom (so all players know)
    if (wsManager) {
      const clients = wsManager.getMultiplayerClients(sceneRoomId);
      notifySceneRoom(sceneRoomId, clients, {
        type: "scene_room_split",
        sceneRoomId,
        remainingPlayerIds: splitResult.remainingPlayerIds,
        newSceneRooms: splitResult.newSceneRooms.map((r) => ({
          sceneRoomId: r.sceneRoomId,
          playerIds: r.playerIds,
          targetSceneName: r.targetSceneName,
        })),
        timestamp: new Date().toISOString(),
      });

      // Also notify each new sceneRoom separately
      for (const newRoom of splitResult.newSceneRooms) {
        const newClients = wsManager.getMultiplayerClients(newRoom.sceneRoomId);
        notifySceneRoom(newRoom.sceneRoomId, newClients, {
          type: "scene_room_joined",
          sceneRoomId: newRoom.sceneRoomId,
          targetSceneName: newRoom.targetSceneName,
          playerIds: newRoom.playerIds,
          timestamp: new Date().toISOString(),
        });

        // Generate scene image for each new sceneRoom (fire-and-forget)
        const state = manager.getState();
        const newSceneRoomState = manager.getSceneRoom(newRoom.sceneRoomId);
        if (newSceneRoomState?.currentScenario && state.moduleName) {
          generateSceneRoomImage(
            newSceneRoomState.currentScenario,
            state.moduleName
          )
            .then((imageResult) => {
              if (imageResult && wsManager) {
                const imgClients = wsManager.getMultiplayerClients(
                  newRoom.sceneRoomId
                );
                notifySceneRoom(newRoom.sceneRoomId, imgClients, {
                  type: "scene_image_ready",
                  sceneRoomId: newRoom.sceneRoomId,
                  imagePath: imageResult.path,
                  mimeType: imageResult.mimeType,
                  timestamp: new Date().toISOString(),
                });
              }
            })
            .catch((err) => {
              console.warn(
                `[MP Turn] Scene image for new sceneRoom ${newRoom.sceneRoomId} failed:`,
                err
              );
            });
        }
      }
    }

    console.log(
      `[MP Turn] Scene split: ${splitResult.newSceneRooms.length} new sceneRoom(s) created`
    );
  } catch (e) {
    console.error("[MP Turn] handlePostRoundSceneSplit failed:", e);
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

  return {
    roundNumber: sceneRoom.roundNumber,
    submittedPlayerIds: roundInputs.map((i) => i.playerId),
    totalCount: sceneRoom.memberPlayerIds.length,
    gameDay: state.gameDay,
    timeOfDay: state.timeOfDay,
  };
}
