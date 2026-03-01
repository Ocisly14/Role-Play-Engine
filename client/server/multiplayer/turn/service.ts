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
import { generateMapOnSceneSwitch, generateMergedMap } from "../../../../src/dynamicworldagent/visual/mapImage.js";
import { TurnManager } from "../../../../src/dynamicworldagent/multiplayerAgent/memory/turnManager.js";
import { TurnRagAgent } from "../../../../src/dynamicworldagent/multiplayerAgent/knowledge/turnRagAgent.js";
import { ScenarioLoader } from "../../../../src/shared/agents/memory/scenarioloader/index.js";
import { DirectorAgent } from "../../../../src/dynamicworldagent/multiplayerAgent/director/directorAgent.js";
import { WebSocketManager } from "../../websocket/WebSocketManager.js";
import { notifySceneRoom } from "../../websocket/notifier.js";
import { MultiplayerOrchestratorAgent } from "../../../../src/dynamicworldagent/multiplayerAgent/orchestrator/orchestratorAgent.js";

// =============================================
// RoomProcessingQueue — serializes per-room graph execution
// =============================================

class RoomProcessingQueue {
  private chains = new Map<string, Promise<void>>();
  private pendingCount = new Map<string, number>();
  private drainCallbacks = new Map<string, (() => Promise<void>) | null>();

  /**
   * Enqueue a task for a given roomId.  Tasks for the same roomId run
   * sequentially (chained).  The returned promise resolves/rejects when
   * the task itself completes.
   *
   * When the last task for a roomId completes and a drain callback is set,
   * the drain callback is invoked atomically after the count reaches 0.
   */
  enqueue(roomId: string, task: () => Promise<void>): Promise<void> {
    this.pendingCount.set(roomId, (this.pendingCount.get(roomId) ?? 0) + 1);

    const prev = this.chains.get(roomId) ?? Promise.resolve();

    const taskPromise = prev.then(async () => {
      try {
        await task();
      } finally {
        const newCount = (this.pendingCount.get(roomId) ?? 1) - 1;
        this.pendingCount.set(roomId, newCount);
        // Run drain callback atomically when count reaches 0
        if (newCount === 0) {
          const cb = this.drainCallbacks.get(roomId);
          this.drainCallbacks.delete(roomId);
          if (cb) {
            try {
              await cb();
            } catch (e) {
              console.error(`[RoomProcessingQueue] Drain callback error for ${roomId}:`, e);
            }
          }
        }
      }
    });

    // Swallow rejections on the chain so a failed task doesn't block the next.
    this.chains.set(roomId, taskPromise.catch(() => {}));

    return taskPromise;
  }

  /** Number of tasks still pending (queued + running) for the given roomId. */
  getPendingCount(roomId: string): number {
    return this.pendingCount.get(roomId) ?? 0;
  }

  /**
   * Set a callback to run once after ALL currently pending tasks for roomId complete.
   * Replaces any previously set drain callback.
   */
  setDrainCallback(roomId: string, cb: () => Promise<void>): void {
    this.drainCallbacks.set(roomId, cb);
  }
}

/** Module-level singleton queue — one per server process. */
const roomProcessingQueue = new RoomProcessingQueue();

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

  // Reject input when skill selection is pending
  if (sceneRoom.pendingSkillSelections) {
    throw new Error(
      "SKILL_SELECTION_PENDING: Skill selection is in progress. " +
      "Please complete your skill selection before submitting new input."
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

  // ---- Basic input validation ----
  if (inputData.inputType === "input") {
    if (!inputData.content || !inputData.content.trim()) {
      throw new Error("VALIDATION: Input content cannot be empty");
    }
    if (inputData.content.length > 2000) {
      throw new Error("VALIDATION: Input content exceeds 2000 character limit");
    }
  }

  // Check time drift — block input for rooms that are too far ahead
  const driftInfo = manager.getTimeDriftInfo();
  if (driftInfo.blockedRoomIds.includes(sceneRoomId)) {
    const isRoomInCombat = manager.isSceneRoomInBattle(sceneRoomId);
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

  // Store language preference from the first player's submission for this round
  // (subsequent players' submissions won't overwrite it, ensuring consistency)
  if (inputData.language) {
    const existingLang = sceneRoom.temporaryInfo?.contextualData?.roundLanguage;
    if (!existingLang) {
      manager.setContextualData(sceneRoomId, "roundLanguage", inputData.language);
    }
  }

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
    // Use language stored from first player's submission (consistent for the room)
    const storedLang = sceneRoom.temporaryInfo?.contextualData?.roundLanguage as string | undefined;
    const language: "en" | "zh" =
      storedLang === "en" || storedLang === "zh" ? storedLang : (inputData.language ?? "zh");
    const roundTurnId = randomUUID();

    // Set drain callback: runs unified scene processing ONCE after ALL
    // queued graph tasks for this roomId complete (count reaches 0).
    roomProcessingQueue.setDrainCallback(roomId, async () => {
      const latestManager = multiplayerSessionStore.get(roomId);
      if (latestManager) {
        await processUnifiedSceneChanges(roomId, latestManager, db);
      }
    });

    // Enqueue graph execution — tasks for the same roomId run sequentially,
    // preventing concurrent state mutations.
    // Two-phase commit: run orchestrator pre-check first to detect skill selection needs.
    roomProcessingQueue
      .enqueue(roomId, async () => {
        const currentManager = multiplayerSessionStore.get(roomId);
        if (!currentManager) throw new Error(`Manager for room ${roomId} not found`);
        const currentRoundInputs = [...roundInputs];

        // --- Orchestrator pre-check for skill selection ---
        const effectiveInputs = currentRoundInputs.filter(
          (i) => i.inputType === "input" && Boolean(i.content?.trim()) && !i.selectedSkill
        );

        if (effectiveInputs.length > 0) {
          try {
            const orchestratorAgent = new MultiplayerOrchestratorAgent();
            const orchestratorResult = await orchestratorAgent.processRound(
              currentRoundInputs,
              currentManager,
              sceneRoomId,
              db,
              language
            );

            // Check which players need skill selection
            const playersNeedingSkill: Record<string, { requiredBy: string }> = {};
            for (const pa of orchestratorResult.playerAnalyses) {
              if (
                pa.actionAnalysis.requiresSkillSelection &&
                !currentRoundInputs.find((i) => i.playerId === pa.playerId)?.selectedSkill
              ) {
                playersNeedingSkill[pa.playerId] = {
                  requiredBy: pa.actionAnalysis.action || "action requires skill",
                };
              }
            }

            if (Object.keys(playersNeedingSkill).length > 0) {
              console.log(
                `[MP Turn] Skill selection required for ${Object.keys(playersNeedingSkill).join(", ")} in sceneRoom ${sceneRoomId}`
              );

              // Cache orchestrator results in contextualData (will be reused by graph orchestrator node)
              const sr = currentManager.getSceneRoom(sceneRoomId);
              if (sr) {
                currentManager.updateSceneRoom(sceneRoomId, {
                  temporaryInfo: {
                    ...sr.temporaryInfo,
                    contextualData: {
                      ...sr.temporaryInfo.contextualData,
                      cachedOrchestratorResult: orchestratorResult,
                    },
                  },
                });
              }

              // Set pending skill selections
              currentManager.setPendingSkillSelections(sceneRoomId, roundTurnId, playersNeedingSkill);

              // Notify frontend via WS
              const wsManager = WebSocketManager.getInstance();
              if (wsManager) {
                const clients = wsManager.getMultiplayerClients(sceneRoomId);
                notifySceneRoom(sceneRoomId, clients, {
                  type: "skill_selection_required",
                  roundTurnId,
                  sceneRoomId,
                  players: playersNeedingSkill,
                });
              }

              return; // Do NOT trigger graph yet — wait for skill selections
            } else {
              // No skill selection needed — cache orchestrator result for graph reuse
              const sr = currentManager.getSceneRoom(sceneRoomId);
              if (sr) {
                currentManager.updateSceneRoom(sceneRoomId, {
                  temporaryInfo: {
                    ...sr.temporaryInfo,
                    contextualData: {
                      ...sr.temporaryInfo.contextualData,
                      cachedOrchestratorResult: orchestratorResult,
                    },
                  },
                });
              }
            }
          } catch (err) {
            console.warn("[MP Turn] Orchestrator pre-check failed, proceeding without skill check:", err);
            // On failure, proceed normally — orchestrator will run again in the graph
          }
        }

        // No skill selection needed — proceed with full graph execution
        await triggerMultiplayerGraphCore(
          db,
          roomId,
          sceneRoomId,
          roundTurnId,
          currentRoundInputs,
          language
        );
      })
      .catch((err) => {
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
// resolveSkillSelection — Phase 2: player submits their chosen skill
// =============================================

export async function resolveSkillSelection(
  db: CoCDatabase | CoCDatabaseAdapter,
  roomId: string,
  sceneRoomId: string,
  playerId: string,
  selectedSkill: string
): Promise<{ allResolved: boolean }> {
  const manager = multiplayerSessionStore.get(roomId);
  if (!manager) {
    throw new Error("Game session not found. Has the game been initialized?");
  }

  const sceneRoom = manager.getSceneRoom(sceneRoomId);
  if (!sceneRoom) {
    throw new Error(`SceneRoom ${sceneRoomId} not found`);
  }

  if (!sceneRoom.pendingSkillSelections) {
    throw new Error("No pending skill selections for this scene room");
  }

  if (!sceneRoom.pendingSkillSelections.players[playerId]) {
    throw new Error("This player does not have a pending skill selection");
  }

  const allResolved = manager.resolveSkillSelection(sceneRoomId, playerId, selectedSkill);

  // Broadcast update to room
  const wsManager = WebSocketManager.getInstance();
  if (wsManager) {
    const clients = wsManager.getMultiplayerClients(sceneRoomId);
    notifySceneRoom(sceneRoomId, clients, {
      type: "skill_selection_update",
      sceneRoomId,
      playerId,
      selectedSkill,
      allResolved,
    });
  }

  if (allResolved) {
    const pending = sceneRoom.pendingSkillSelections;
    const roundTurnId = pending.roundTurnId;

    // Merge selected skills into round inputs
    const roundInputs = manager.getRoundInputsForSceneRoom(sceneRoomId);
    for (const input of roundInputs) {
      const playerPending = pending.players[input.playerId];
      if (playerPending?.selectedSkill) {
        input.selectedSkill = playerPending.selectedSkill;
        input.skillSelectionMode = "manual";
      }
    }

    // Clear pending state
    manager.clearPendingSkillSelections(sceneRoomId);

    // Determine language from contextual data
    const storedLang = sceneRoom.temporaryInfo?.contextualData?.roundLanguage as string | undefined;
    const language: "en" | "zh" = storedLang === "en" || storedLang === "zh" ? storedLang : "zh";

    // Set drain callback for unified scene processing
    roomProcessingQueue.setDrainCallback(roomId, async () => {
      const latestManager = multiplayerSessionStore.get(roomId);
      if (latestManager) {
        await processUnifiedSceneChanges(roomId, latestManager, db);
      }
    });

    // Trigger graph with cached orchestrator results
    roomProcessingQueue
      .enqueue(roomId, async () => {
        await triggerMultiplayerGraphCore(
          db,
          roomId,
          sceneRoomId,
          roundTurnId,
          [...roundInputs],
          language
        );
      })
      .catch((err) => {
        console.error(
          `[MP Turn] Graph execution failed after skill selection for sceneRoom ${sceneRoomId}:`,
          err
        );
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
  }

  return { allResolved };
}

// =============================================
// triggerMultiplayerGraphCore — graph execution + round_complete broadcast
// Does NOT handle scene splits, time drift, or rest unfreeze.
// =============================================

async function triggerMultiplayerGraphCore(
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

  // Replace stored manager with the updated state from graph result,
  // preserving roundInputs from OTHER sceneRooms submitted during graph execution.
  if (result.dynamicGameState) {
    const oldManager = multiplayerSessionStore.get(roomId);
    const preservedInputs: MultiplayerTurnInput[] = [];
    if (oldManager) {
      const oldState = oldManager.getState();
      for (const input of oldState.roundInputs) {
        const player = oldState.players[input.playerId];
        if (player && player.currentSceneRoomId !== sceneRoomId) {
          preservedInputs.push(input);
        }
      }
    }

    const newManager = new MultiplayerDynamicGameStateManager(
      result.dynamicGameState
    );
    for (const input of preservedInputs) {
      newManager.addRoundInput(input);
    }
    // Record round completion time for minutesSinceLastInput
    newManager.updateSceneRoom(sceneRoomId, {
      lastRoundCompletedAt: new Date().toISOString(),
    });
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

  const clueRevelations =
    updatedSceneRoom?.temporaryInfo.contextualData?.clueRevelations ?? null;

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
        clueRevelations,
        gameDay: roomGameDay,
        gameTime: roomTimeOfDay,
      },
      language
    );

    // Record RAG chunks (fire-and-forget) — uses multiplayer state natively
    if (result.dynamicGameState) {
      const turnRagAgent = new TurnRagAgent();
      const turn = turnManager.getTurn(persistedTurnId);
      if (turn) {
        void turnRagAgent
          .recordTurn({
            turn,
            multiplayerState: result.dynamicGameState,
            sceneRoomId,
            language,
          })
          .catch((err) => {
            console.warn(
              `[MP Turn] RAG recording failed for turn ${persistedTurnId}:`,
              err
            );
          });
      }
    }
  }

  // ---- Auto-save checkpoint (fire-and-forget) ----
  try {
    const cpManager = multiplayerSessionStore.get(roomId);
    if (cpManager) {
      const { serializeMultiplayerCheckpoint, generateMultiplayerCheckpointName } = await import(
        "../../../../src/dynamicworldagent/multiplayerAgent/memory/checkpoint.js"
      );
      const payload = await serializeMultiplayerCheckpoint(cpManager, db);
      const prisma2 = getPrismaClient();
      // Delete old auto checkpoints to prevent unbounded growth
      await prisma2.multiplayerCheckpoint.deleteMany({
        where: { roomId, name: { startsWith: "[Auto]" } },
      });
      await prisma2.multiplayerCheckpoint.create({
        data: {
          checkpointId: `auto-${randomUUID()}`,
          roomId,
          name: `[Auto] ${generateMultiplayerCheckpointName(cpManager)}`,
          payload: JSON.stringify(payload),
          createdBy: "system",
        },
      });
    }
  } catch (e) {
    console.warn("[MP Turn] Auto-checkpoint failed:", e);
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
      isBattle: result.dynamicGameState?.sceneRooms?.[sceneRoomId]?.isBattle ?? false,
      gameEnding: result.dynamicGameState?.gameEnding ?? null,
      timestamp: new Date().toISOString(),
    });
  }

  console.log(
    `[MP Turn] Round ${roundTurnId} complete for sceneRoom ${sceneRoomId}`
  );

  // ---- Broadcast epilogue to other scene rooms when game ends ----
  if (result.dynamicGameState?.gameEnding?.isEnded && updatedManager && wsManager) {
    const allActiveRooms = updatedManager.getActiveSceneRooms();
    const otherRooms = allActiveRooms.filter((r) => r.sceneRoomId !== sceneRoomId);

    if (otherRooms.length > 0) {
      console.log(
        `[MP Turn] Game ended — broadcasting epilogue to ${otherRooms.length} other room(s)`
      );

      for (const otherRoom of otherRooms) {
        try {
          const endingRoomNarrative = keeperNarrative || "The story has reached its conclusion.";

          const otherClients = wsManager.getMultiplayerClients(otherRoom.sceneRoomId);
          notifySceneRoom(otherRoom.sceneRoomId, otherClients, {
            type: "round_complete",
            sceneRoomId: otherRoom.sceneRoomId,
            roundTurnId: `epilogue-${otherRoom.sceneRoomId}`,
            keeperNarrative: endingRoomNarrative,
            diceRolls: [],
            gameDay: otherRoom.gameDay,
            gameTime: otherRoom.timeOfDay,
            isBattle: false,
            gameEnding: result.dynamicGameState.gameEnding,
            timestamp: new Date().toISOString(),
          });

          // P2-10: Create turn record + RAG index for epilogue in other rooms
          try {
            const epilogueTurnId = await turnManager.createTurn({
              sessionId: initialState.sessionId,
              sceneRoomId: otherRoom.sceneRoomId,
              characterInput: "[Game Ending — Epilogue broadcast]",
              gameDay: otherRoom.gameDay ?? null,
              gameTime: otherRoom.timeOfDay ?? null,
              sceneId: otherRoom.currentScenario?.id ?? undefined,
              sceneName: otherRoom.currentScenario?.name ?? undefined,
              location: otherRoom.currentScenario?.location ?? undefined,
            });
            if (epilogueTurnId) {
              turnManager.completeTurn(epilogueTurnId, {
                keeperNarrative: endingRoomNarrative,
                gameDay: otherRoom.gameDay ?? null,
                gameTime: otherRoom.timeOfDay ?? null,
              }, language);
              const epilogueTurn = turnManager.getTurn(epilogueTurnId);
              if (epilogueTurn && result.dynamicGameState) {
                const turnRagAgent = new TurnRagAgent();
                void turnRagAgent.recordTurn({
                  turn: epilogueTurn,
                  multiplayerState: result.dynamicGameState,
                  sceneRoomId: otherRoom.sceneRoomId,
                  language,
                }).catch((err) => {
                  console.warn(`[MP Turn] Epilogue RAG for ${otherRoom.sceneRoomId} failed:`, err);
                });
              }
            }
          } catch (ragErr) {
            console.warn(`[MP Turn] Epilogue turn/RAG for ${otherRoom.sceneRoomId} failed:`, ragErr);
          }
        } catch (e) {
          console.warn(
            `[MP Turn] Failed to broadcast epilogue to room ${otherRoom.sceneRoomId}:`,
            e
          );
        }
      }
    }
  }

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
}

// =============================================
// processUnifiedSceneChanges — runs ONCE after all rooms finish their rounds
// Collects movements from ALL rooms, generates snapshots in one pass,
// then performs freeze-fork-merge, time drift, images, rest unfreeze.
// =============================================

async function processUnifiedSceneChanges(
  roomId: string,
  manager: MultiplayerDynamicGameStateManager,
  db: CoCDatabase | CoCDatabaseAdapter
): Promise<void> {
  const wsManager = WebSocketManager.getInstance();

  // ---- Unified scene snapshot generation ----
  try {
    const scenarioLoader = new ScenarioLoader(db);
    const directorAgent = new DirectorAgent(scenarioLoader, db);
    const sceneChangeResult = await directorAgent.handleUnifiedSceneChanges(manager);

    if (sceneChangeResult.anyChanges) {
      // Notify rooms with movements that scene change processing happened
      for (const srId of sceneChangeResult.roomsWithMovements) {
        if (wsManager) {
          const clients = wsManager.getMultiplayerClients(srId);
          notifySceneRoom(srId, clients, {
            type: "scene_change_processing",
            sceneRoomId: srId,
            targetSceneNames: sceneChangeResult.targetSceneNames,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  } catch (e) {
    console.error("[MP Turn] Unified scene change handling failed:", e);
  }

  // ---- Scene Room Splitting (freeze-fork-merge) ----
  // resolveAllMovements reads pre-generated snapshots from ALL active rooms
  await handlePostRoundSceneSplit(
    db,
    roomId,
    "_unified_", // not scoped to one sceneRoom
    manager,
    wsManager
  );

  // ---- Time drift broadcast ----
  if (wsManager) {
    const postDrift = manager.getTimeDriftInfo();
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
      for (const room of manager.getActiveSceneRooms()) {
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

  // ---- Scene Image Generation (fire-and-forget for all active rooms) ----
  const state = manager.getState();
  if (state.moduleName) {
    for (const room of manager.getActiveSceneRooms()) {
      if (room.currentScenario) {
        generateSceneRoomImage(room.currentScenario, state.moduleName)
          .then((imageResult) => {
            if (imageResult && wsManager) {
              const clients = wsManager.getMultiplayerClients(room.sceneRoomId);
              notifySceneRoom(room.sceneRoomId, clients, {
                type: "scene_image_ready",
                sceneRoomId: room.sceneRoomId,
                imagePath: imageResult.path,
                mimeType: imageResult.mimeType,
                timestamp: new Date().toISOString(),
              });
            }
          })
          .catch((err) => {
            console.warn(`[MP Turn] Scene image generation failed for ${room.sceneRoomId}:`, err);
          });
      }
    }
  }

  // ---- Rest-unfreeze coordination ----
  await handleRestUnfreezeCheck(manager, db, wsManager);
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

        // Generate scene images + maps only for mover rooms (stayer rooms keep parent's assets)
        if (!childRoom.isStayerRoom) {
          const state = manager.getState();
          const childState = manager.getSceneRoom(childRoom.sceneRoomId);
          if (childState?.currentScenario && state.moduleName) {
            // ── BG generation (fire-and-forget) ──
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

            // ── Map generation (fire-and-forget) ──
            const getConns = (scenarioName: string) => {
              return state.scenarioOutlines?.find(
                (o) => o.name === scenarioName
              )?.connections ?? [];
            };

            const broadcastMap = (mapResult: { path: string; mimeType: string }) => {
              // Fetch latest manager from store (not stale closure capture)
              const latestMgr = multiplayerSessionStore.get(roomId) ?? manager;
              const room = latestMgr.getSceneRoom(childRoom.sceneRoomId);
              if (room?.currentScenario) {
                room.currentScenario.mapImagePath = mapResult.path;
              }
              if (wsManager) {
                const mapClients = wsManager.getMultiplayerClients(
                  childRoom.sceneRoomId
                );
                notifySceneRoom(childRoom.sceneRoomId, mapClients, {
                  type: "map_image_ready",
                  sceneRoomId: childRoom.sceneRoomId,
                  mapImagePath: mapResult.path,
                  mimeType: mapResult.mimeType,
                  timestamp: new Date().toISOString(),
                });
              }
            };

            const parentIds = childRoom.parentSceneRoomIds;

            if (parentIds.length > 1) {
              // ── Multi-parent merge: collect ALL parent maps as references ──
              const parentScenes = parentIds
                .map((pid) => manager.getSceneRoom(pid))
                .filter((r) => r?.currentScenario)
                .map((r) => ({
                  name: r!.currentScenario!.name,
                  description: r!.currentScenario!.description,
                  connections: getConns(r!.currentScenario!.name),
                  mapImagePath: r!.currentScenario!.mapImagePath ?? null,
                }));

              // Target scene is the child's scenario (may already be on a parent map)
              const targetSceneData = {
                name: childState.currentScenario.name,
                description: childState.currentScenario.description,
                connections: getConns(childState.currentScenario.name),
              };

              generateMergedMap(
                state.moduleName,
                parentScenes,
                targetSceneData,
                state.moduleDigest?.macroMapPath
              )
                .then((mapResult) => {
                  if (mapResult) broadcastMap(mapResult);
                })
                .catch((err) => {
                  console.warn(
                    `[MP Turn] Merged map generation for ${childRoom.sceneRoomId} failed:`,
                    err
                  );
                });
            } else {
              // ── Single parent: incremental map update ──
              const parentRoom = parentIds[0] ? manager.getSceneRoom(parentIds[0]) : null;
              const parentScenario = parentRoom?.currentScenario;

              if (parentScenario) {
                generateMapOnSceneSwitch(
                  state.moduleName,
                  {
                    name: parentScenario.name,
                    description: parentScenario.description,
                    connections: getConns(parentScenario.name),
                  },
                  {
                    name: childState.currentScenario.name,
                    description: childState.currentScenario.description,
                    connections: getConns(childState.currentScenario.name),
                  },
                  parentScenario.mapImagePath ?? state.moduleDigest?.macroMapPath
                )
                  .then((mapResult) => {
                    if (mapResult) broadcastMap(mapResult);
                  })
                  .catch((err) => {
                    console.warn(
                      `[MP Turn] Map generation for ${childRoom.sceneRoomId} failed:`,
                      err
                    );
                  });
              }
            }
          }
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
    onCombatStart: () => {
      send({ type: "combat_start", roundTurnId, sceneRoomId, timestamp: new Date().toISOString() });
    },
    onCombatEnd: () => {
      send({ type: "combat_end", roundTurnId, sceneRoomId, timestamp: new Date().toISOString() });
    },
    onDiceRolls: (diceRolls: Array<Record<string, unknown>>) => {
      if (diceRolls.length > 0) {
        send({ type: "keeper_dice_rolls", roundTurnId, sceneRoomId, diceRolls, timestamp: new Date().toISOString() });
      }
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
