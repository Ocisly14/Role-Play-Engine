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
import { resolveAllMovements, type TimeBubbleMergeInfo, type ResolveMovementsResult } from "../../../../src/dynamicworldagent/multiplayerGraph/sceneRoomMerger.js";
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
// setupTwoPhaseDrainCallbacks — shared drain logic for both submitRoundInput and resolveSkillSelection
// =============================================

function setupTwoPhaseDrainCallbacks(
  roomId: string,
  sceneRoomId: string,
  db: CoCDatabase | CoCDatabaseAdapter,
  phase1Results: Map<string, Phase1Metadata>
): void {
  // Drain: after ALL Phase 1 tasks for this sceneRoom complete
  roomProcessingQueue.setDrainCallback(sceneRoomId, async () => {
    const mgr = multiplayerSessionStore.get(roomId);
    if (!mgr) return;

    // 1. Generate scene snapshots (NPC timelines + target snapshots)
    await handleUnifiedSceneSnapshots(roomId, mgr, db);

    // 2. Room splitting (freeze-fork-merge)
    const wsManager = WebSocketManager.getInstance();
    const splitResult = await handlePostRoundSceneSplit(db, roomId, mgr, wsManager);

    // 3. Copy parent temporaryInfo to child rooms
    if (splitResult?.anyChanges) {
      copyParentTemporaryInfoToChildren(mgr, splitResult);
    }

    // 4. Determine Phase 2 target rooms
    const phase2Rooms: Array<{ sceneRoomId: string; metadata: Phase1Metadata }> = [];
    if (splitResult?.anyChanges && splitResult.newChildRooms.length > 0) {
      // Use child rooms; map each child back to its parent's Phase1Metadata
      for (const child of splitResult.newChildRooms) {
        const parentMeta = child.parentSceneRoomIds
          .map((pid) => phase1Results.get(pid))
          .find(Boolean);
        if (parentMeta && !parentMeta.isCombatComplete) {
          phase2Rooms.push({ sceneRoomId: child.sceneRoomId, metadata: parentMeta });
        }
      }
    } else {
      // No split — use original rooms
      for (const [srId, meta] of phase1Results) {
        if (!meta.isCombatComplete) {
          phase2Rooms.push({ sceneRoomId: srId, metadata: meta });
        }
      }
    }

    // 5. Run Phase 2 for each target room IN PARALLEL
    //    Each child sceneRoom gets its own narrative generation concurrently.
    //    State merging is safe because Node.js is single-threaded: the synchronous
    //    merge step after each `await graph.invoke()` cannot be interrupted.
    if (phase2Rooms.length > 0) {
      const phase2Promises = phase2Rooms.map(({ sceneRoomId: srId, metadata }) =>
        triggerNarrativePhase(db, roomId, srId, metadata).catch((err) => {
          console.error(`[MP Turn] Phase 2 failed for sceneRoom ${srId}:`, err);
          // Broadcast error to the specific room's clients
          const errWsManager = WebSocketManager.getInstance();
          if (errWsManager) {
            const clients = errWsManager.getMultiplayerClients(srId);
            notifySceneRoom(srId, clients, {
              type: "round_error",
              sceneRoomId: srId,
              roundTurnId: metadata.roundTurnId,
              error: err instanceof Error ? err.message : String(err),
              timestamp: new Date().toISOString(),
            });
          }
        })
      );
      await Promise.all(phase2Promises);
    }

    // 6. Post-processing (after all Phase 2 tasks complete)
    const latestMgr = multiplayerSessionStore.get(roomId);
    if (latestMgr) {
      // Collect IDs of rooms processed in this round
      const processedIds = [...phase1Results.keys()];
      if (splitResult?.anyChanges) {
        for (const child of splitResult.newChildRooms) {
          processedIds.push(child.sceneRoomId);
        }
      }
      await processPostNarrative(roomId, latestMgr, db, processedIds);
    }
  });
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

  // ── Location-based routing validation ──
  // The player's currentSceneRoomId is the authoritative source of their location.
  // Only allow input to the room the player actually belongs to.
  const playerState = manager.getState().players[userId];
  if (playerState && playerState.currentSceneRoomId !== sceneRoomId) {
    const correctRoomId = playerState.currentSceneRoomId;
    throw new Error(
      `WRONG_ROOM:${correctRoomId}: Your character is located in a different scene room. ` +
        "Redirecting you to the correct room."
    );
  }

  // Reject input to frozen rooms (they are historical snapshots, not active)
  if (sceneRoom.isFrozen) {
    const correctRoomId = playerState?.currentSceneRoomId ?? sceneRoomId;
    throw new Error(
      `WRONG_ROOM:${correctRoomId}: This scene room is frozen and no longer accepts input. ` +
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

  // 2b. Broadcast player_input_submitted so other players see it in real-time
  try {
    const wsManager = WebSocketManager.getInstance();
    if (wsManager) {
      const clients = wsManager.getMultiplayerClients(sceneRoomId);
      const playerName =
        manager.getState().players[userId]?.characterName ?? "Unknown";
      const allMemberIds = sceneRoom.memberPlayerIds;
      const currentRoundInputs =
        manager.getRoundInputsForSceneRoom(sceneRoomId);
      const submittedPlayerIds = new Set(
        currentRoundInputs.map((i) => i.playerId)
      );
      const pendingPlayerNames = allMemberIds
        .filter((id) => !submittedPlayerIds.has(id))
        .map(
          (id) =>
            manager.getState().players[id]?.characterName ?? "Unknown"
        );

      notifySceneRoom(sceneRoomId, clients, {
        type: "player_input_submitted",
        sceneRoomId,
        playerId: userId,
        playerName,
        characterId: inputData.characterId,
        content:
          inputData.inputType === "skip"
            ? ""
            : (inputData.content ?? ""),
        inputType: inputData.inputType,
        submittedCount: submittedPlayerIds.size,
        totalCount: allMemberIds.length,
        pendingPlayerNames,
        timestamp: new Date().toISOString(),
      });
    }
  } catch (e) {
    console.warn("[MP Turn] Failed to broadcast player_input_submitted:", e);
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

    // Enqueue graph execution — tasks for the same sceneRoomId run sequentially,
    // but different sceneRooms process in parallel after a split.
    // Two-phase commit: run orchestrator pre-check first to detect skill selection needs.
    // NOTE: drain callback is set INSIDE the task, only when the graph will actually run.
    // This prevents processUnifiedSceneChanges from firing prematurely when skill
    // selection is pending (the task returns early without running the graph).
    roomProcessingQueue
      .enqueue(sceneRoomId, async () => {
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

              // Do NOT set drain callback — graph hasn't run yet.
              // resolveSkillSelection will set the drain callback when it triggers the graph.
              return;
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

        // No skill selection needed — run Phase 1 (action) and set up two-phase drain callbacks.
        const phase1Results = new Map<string, Phase1Metadata>();
        setupTwoPhaseDrainCallbacks(roomId, sceneRoomId, db, phase1Results);

        const metadata = await triggerActionPhase(
          db,
          roomId,
          sceneRoomId,
          roundTurnId,
          currentRoundInputs,
          language
        );
        phase1Results.set(sceneRoomId, metadata);
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

    // Set up two-phase drain callbacks and trigger Phase 1
    const phase1Results = new Map<string, Phase1Metadata>();
    setupTwoPhaseDrainCallbacks(roomId, sceneRoomId, db, phase1Results);

    roomProcessingQueue
      .enqueue(sceneRoomId, async () => {
        const metadata = await triggerActionPhase(
          db,
          roomId,
          sceneRoomId,
          roundTurnId,
          [...roundInputs],
          language
        );
        phase1Results.set(sceneRoomId, metadata);
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
// Phase1Metadata — returned by triggerActionPhase for drain callback use
// =============================================

interface Phase1Metadata {
  persistedTurnId: string | null;
  sceneRoomId: string;
  language: "en" | "zh";
  roundInputs: MultiplayerTurnInput[];
  roundTurnId: string;
  /** True when combat completed fully in Phase 1 (battleKeeper ran) — skip Phase 2 */
  isCombatComplete: boolean;
}

// =============================================
// mergeGraphResultIntoManager — shared merge helper for Phase 1 & Phase 2
// Merges sceneRoom-specific + additive global state from graph result
// into the live manager without replacing it wholesale.
// =============================================

function mergeGraphResultIntoManager(
  manager: MultiplayerDynamicGameStateManager,
  sceneRoomId: string,
  resultState: any
): void {
  // 1. Merge this sceneRoom's state
  const resultSceneRoom = resultState.sceneRooms?.[sceneRoomId];
  if (resultSceneRoom) {
    manager.updateSceneRoom(sceneRoomId, resultSceneRoom);
  }

  // 2. Merge player states for players in this sceneRoom
  const sceneRoom = manager.getSceneRoom(sceneRoomId);
  if (sceneRoom) {
    for (const playerId of sceneRoom.memberPlayerIds) {
      const resultPlayer = resultState.players?.[playerId];
      if (resultPlayer) {
        const currentState = manager.getState();
        if (currentState.players[playerId]) {
          currentState.players[playerId] = resultPlayer;
        }
      }
    }
  }

  // 3. Merge global state: gameEnding (any room can trigger)
  if (resultState.gameEnding?.isEnded) {
    manager.getState().gameEnding = resultState.gameEnding;
  }

  // 4. Merge discoveredClues (additive — avoid duplicates)
  if (resultState.discoveredClues?.length) {
    const existing = manager.getState().discoveredClues ?? [];
    const existingIds = new Set(existing.map((c: any) => c.id ?? c.name));
    for (const clue of resultState.discoveredClues) {
      const clueKey = (clue as any).id ?? (clue as any).name;
      if (clueKey && !existingIds.has(clueKey)) {
        existing.push(clue);
        existingIds.add(clueKey);
      }
    }
    manager.getState().discoveredClues = existing;
  }

  // 5. Merge DynamicWorld tracking sets (additive)
  const currentState = manager.getState();
  if (resultState.revealedTruthEvents?.size) {
    for (const v of resultState.revealedTruthEvents) currentState.revealedTruthEvents.add(v);
  }
  if (resultState.activatedKnowledgeHolders?.size) {
    for (const v of resultState.activatedKnowledgeHolders) currentState.activatedKnowledgeHolders.add(v);
  }
  if (resultState.deployedRedHerrings?.size) {
    for (const v of resultState.deployedRedHerrings) currentState.deployedRedHerrings.add(v);
  }
  if (resultState.mythosRevelations?.size) {
    for (const v of resultState.mythosRevelations) currentState.mythosRevelations.add(v);
  }

  // 6. Merge defeated NPC history (additive)
  if (resultState.defeatedNpcHistory?.length) {
    const existingNpcs = new Set(
      (currentState.defeatedNpcHistory ?? []).map((e: any) => e.npcName)
    );
    for (const entry of resultState.defeatedNpcHistory) {
      if (!existingNpcs.has((entry as any).npcName)) {
        currentState.defeatedNpcHistory.push(entry);
      }
    }
  }

  // 7. Merge point of no return
  if (resultState.pointOfNoReturnReached && !currentState.pointOfNoReturnReached) {
    currentState.pointOfNoReturnReached = true;
    currentState.pointOfNoReturnTrigger = resultState.pointOfNoReturnTrigger;
  }

  // 8. Clear round inputs for players in this sceneRoom
  currentState.roundInputs = currentState.roundInputs.filter((input) => {
    const player = currentState.players[input.playerId];
    return player && player.currentSceneRoomId !== sceneRoomId;
  });

  // 9. Update timestamp
  currentState.lastUpdated = new Date();
}

// =============================================
// triggerActionPhase — Phase 1: entry → orchestrator → memory → action → END
// Combat rooms: full pipeline in Phase 1 (including battleKeeper + round_complete)
// =============================================

async function triggerActionPhase(
  db: CoCDatabase | CoCDatabaseAdapter,
  roomId: string,
  sceneRoomId: string,
  roundTurnId: string,
  roundInputs: MultiplayerTurnInput[],
  language: "en" | "zh"
): Promise<Phase1Metadata> {
  const manager = multiplayerSessionStore.get(roomId);
  if (!manager) {
    throw new Error(`Manager for room ${roomId} not found`);
  }

  const wsManager = WebSocketManager.getInstance();

  // Persist a per-sceneRoom "turn" record for DB-backed conversationHistory / RAG.
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
      turnId: roundTurnId,
      sceneRoomId,
      characterInput: combinedInputForTurn,
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

  // Determine if this is a combat room — combat completes fully in Phase 1
  const sceneRoom = manager.getSceneRoom(sceneRoomId);
  const isBattleRoom = sceneRoom?.isBattle === true;
  const phase: 1 | undefined = isBattleRoom ? undefined : 1;

  const stream = buildStreamHandlers(sceneRoomId, roundTurnId, roomId);
  const graph = buildMultiplayerGraph(db);

  const graphState = {
    dynamicGameState: manager.getState(),
    sceneRoomId,
    roundInputs,
    roundTurnId,
    language,
    phase,
    stream,
  };

  let result: any;
  try {
    result = await graph.invoke(graphState, {
      configurable: { thread_id: `${roundTurnId}-phase1` },
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

  // Merge sceneRoom-specific + additive global changes into the live manager.
  // This is safe for parallel execution: each sceneRoom modifies its own partition.
  if (result.dynamicGameState) {
    const currentManager = multiplayerSessionStore.get(roomId);
    if (currentManager) {
      mergeGraphResultIntoManager(currentManager, sceneRoomId, result.dynamicGameState);
      currentManager.updateSceneRoom(sceneRoomId, {
        lastRoundCompletedAt: new Date().toISOString(),
      });
    }
  }

  // Check if combat completed fully in Phase 1
  const updatedManager = multiplayerSessionStore.get(roomId);
  const updatedSceneRoom = updatedManager?.getSceneRoom(sceneRoomId);
  const isCombatComplete = isBattleRoom ||
    updatedSceneRoom?.temporaryInfo.contextualData?.combatPathCompleted === true;

  // Combat rooms: extract narrative and broadcast round_complete now (they skip Phase 2)
  if (isCombatComplete && updatedManager && updatedSceneRoom) {
    const keeperNarrative =
      (updatedSceneRoom.temporaryInfo.contextualData?.keeperNarrative as string) ?? "";
    const diceRolls =
      (updatedSceneRoom.temporaryInfo.contextualData?.diceRolls as unknown[] | undefined) ?? [];
    const clueRevelations =
      updatedSceneRoom.temporaryInfo.contextualData?.clueRevelations ?? null;

    if (persistedTurnId) {
      turnManager.updateProcessing(persistedTurnId, {
        actionAnalysis:
          updatedSceneRoom.temporaryInfo.contextualData?.playerActionAnalyses ?? null,
        actionResults: updatedSceneRoom.temporaryInfo.actionResults ?? null,
      });
      const roomGameDay = updatedSceneRoom.gameDay ?? result.dynamicGameState?.gameDay ?? null;
      const roomTimeOfDay = updatedSceneRoom.timeOfDay ?? result.dynamicGameState?.timeOfDay ?? null;
      turnManager.completeTurn(
        persistedTurnId,
        { keeperNarrative, clueRevelations, gameDay: roomGameDay, gameTime: roomTimeOfDay },
        language
      );

      if (result.dynamicGameState) {
        const turnRagAgent = new TurnRagAgent();
        const turn = turnManager.getTurn(persistedTurnId);
        if (turn) {
          void turnRagAgent
            .recordTurn({ turn, multiplayerState: result.dynamicGameState, sceneRoomId, language })
            .catch((err) => {
              console.warn(`[MP Turn] RAG recording failed for turn ${persistedTurnId}:`, err);
            });
        }
      }
    }

    const broadcastGameDay = updatedSceneRoom.gameDay ?? result.dynamicGameState?.gameDay;
    const broadcastTimeOfDay = updatedSceneRoom.timeOfDay ?? result.dynamicGameState?.timeOfDay;

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

    console.log(`[MP Turn] Phase 1 (combat) complete for sceneRoom ${sceneRoomId}`);

    // Broadcast epilogue to other rooms if game ended
    if (result.dynamicGameState?.gameEnding?.isEnded && wsManager) {
      await broadcastEpilogueToOtherRooms(
        updatedManager, sceneRoomId, keeperNarrative,
        result.dynamicGameState, turnManager, initialState.sessionId, language, wsManager
      );
    }

    // Rest-frozen check
    if (wsManager && updatedManager.isSceneRoomRestFrozen(sceneRoomId)) {
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
    }
  } else {
    // Non-combat Phase 1: store action processing data for Phase 2 turn completion
    if (persistedTurnId && updatedSceneRoom) {
      turnManager.updateProcessing(persistedTurnId, {
        actionAnalysis:
          updatedSceneRoom.temporaryInfo.contextualData?.playerActionAnalyses ?? null,
        actionResults: updatedSceneRoom.temporaryInfo.actionResults ?? null,
      });
    }
    console.log(`[MP Turn] Phase 1 (action) complete for sceneRoom ${sceneRoomId}`);
  }

  return {
    persistedTurnId,
    sceneRoomId,
    language,
    roundInputs,
    roundTurnId,
    isCombatComplete,
  };
}

// =============================================
// triggerNarrativePhase — Phase 2: director → gameEndCheck → keeper/epilogueKeeper → END
// Runs on each (possibly child) sceneRoom after scene splits are resolved.
// =============================================

async function triggerNarrativePhase(
  db: CoCDatabase | CoCDatabaseAdapter,
  roomId: string,
  sceneRoomId: string,
  metadata: Phase1Metadata
): Promise<void> {
  const manager = multiplayerSessionStore.get(roomId);
  if (!manager) {
    throw new Error(`Manager for room ${roomId} not found`);
  }

  const wsManager = WebSocketManager.getInstance();
  const turnManager = new TurnManager(db);

  // All players' inputs are passed to every child room — the keeper needs to
  // describe everyone's actions cohesively.  Each room's keeper gets different
  // scenario context (current/previous) to produce room-specific narrative.
  const isChildRoom = sceneRoomId !== metadata.sceneRoomId;

  // ── Determine the correct turnId for streaming and DB persistence ──
  // For child rooms from a split, create the DB turn EARLY so the streaming
  // turnId matches the persisted turnId (prevents duplicate display on history re-fetch).
  let effectiveTurnId = metadata.roundTurnId;
  let childTurnCreated = false;
  if (isChildRoom && combinedInputExists(metadata.roundInputs)) {
    const state = manager.getState();
    const childSceneRoom = manager.getSceneRoom(sceneRoomId);
    const combinedInput = metadata.roundInputs
      .filter((i) => i.inputType === "input" && Boolean(i.content?.trim()))
      .map((i) => {
        const playerName = state.players[i.playerId]?.characterName ?? i.playerId;
        return `${playerName}: ${i.content?.trim() ?? ""}`;
      })
      .join("\n");

    effectiveTurnId = await turnManager.createTurn({
      sessionId: state.sessionId,
      sceneRoomId,
      characterInput: combinedInput || "[Scene transition]",
      sceneId: childSceneRoom?.currentScenario?.id ?? undefined,
      sceneName: childSceneRoom?.currentScenario?.name ?? undefined,
      location: childSceneRoom?.currentScenario?.location ?? undefined,
      gameDay: childSceneRoom?.gameDay ?? state.gameDay ?? null,
      gameTime: childSceneRoom?.timeOfDay ?? state.timeOfDay ?? null,
    });
    childTurnCreated = true;
  }

  const stream = buildStreamHandlers(sceneRoomId, effectiveTurnId, roomId);
  const graph = buildMultiplayerGraph(db);

  const graphState = {
    dynamicGameState: manager.getState(),
    sceneRoomId,
    roundInputs: metadata.roundInputs,
    roundTurnId: effectiveTurnId,
    language: metadata.language,
    phase: 2 as const,
    stream,
  };

  let result: any;
  try {
    result = await graph.invoke(graphState, {
      configurable: { thread_id: `${metadata.roundTurnId}-phase2-${sceneRoomId}` },
    });
  } catch (err) {
    console.error(`[MP Turn] Phase 2 graph failed for sceneRoom ${sceneRoomId}:`, err);
    throw err;
  }

  // ── Merge sceneRoom-specific + additive global changes into the shared manager ──
  if (result.dynamicGameState) {
    const currentManager = multiplayerSessionStore.get(roomId);
    if (currentManager) {
      mergeGraphResultIntoManager(currentManager, sceneRoomId, result.dynamicGameState);
    }
  }

  // Extract keeper narrative from final sceneRoom temporaryInfo
  const updatedManager = multiplayerSessionStore.get(roomId);
  const updatedSceneRoom = updatedManager?.getSceneRoom(sceneRoomId);
  const keeperNarrative =
    (updatedSceneRoom?.temporaryInfo.contextualData?.keeperNarrative as string) ?? "";
  const diceRolls =
    (updatedSceneRoom?.temporaryInfo.contextualData?.diceRolls as unknown[] | undefined) ?? [];
  const clueRevelations =
    updatedSceneRoom?.temporaryInfo.contextualData?.clueRevelations ?? null;

  // Determine turn ID: child rooms already created their turn early (before streaming);
  // non-split rooms use the original Phase 1 turn.
  const turnId = childTurnCreated ? effectiveTurnId : metadata.persistedTurnId;

  if (turnId && updatedSceneRoom) {
    const roomGameDay = updatedSceneRoom.gameDay ?? result.dynamicGameState?.gameDay ?? null;
    const roomTimeOfDay = updatedSceneRoom.timeOfDay ?? result.dynamicGameState?.timeOfDay ?? null;
    turnManager.completeTurn(
      turnId,
      { keeperNarrative, clueRevelations, gameDay: roomGameDay, gameTime: roomTimeOfDay },
      metadata.language
    );

    // Record RAG chunks (fire-and-forget)
    if (result.dynamicGameState) {
      const turnRagAgent = new TurnRagAgent();
      const turn = turnManager.getTurn(turnId);
      if (turn) {
        void turnRagAgent
          .recordTurn({ turn, multiplayerState: result.dynamicGameState, sceneRoomId, language: metadata.language })
          .catch((err) => {
            console.warn(`[MP Turn] RAG recording failed for turn ${turnId}:`, err);
          });
      }
    }
  }

  // Broadcast round complete
  const broadcastGameDay = updatedSceneRoom?.gameDay ?? result.dynamicGameState?.gameDay;
  const broadcastTimeOfDay = updatedSceneRoom?.timeOfDay ?? result.dynamicGameState?.timeOfDay;

  if (wsManager) {
    const clients = wsManager.getMultiplayerClients(sceneRoomId);
    notifySceneRoom(sceneRoomId, clients, {
      type: "round_complete",
      sceneRoomId,
      roundTurnId: effectiveTurnId,
      keeperNarrative,
      diceRolls,
      gameDay: broadcastGameDay,
      gameTime: broadcastTimeOfDay,
      isBattle: false,
      gameEnding: result.dynamicGameState?.gameEnding ?? null,
      timestamp: new Date().toISOString(),
    });
  }

  console.log(`[MP Turn] Phase 2 (narrative) complete for sceneRoom ${sceneRoomId}`);

  // Broadcast epilogue to other rooms if game ended
  if (result.dynamicGameState?.gameEnding?.isEnded && updatedManager && wsManager) {
    const state = manager.getState();
    await broadcastEpilogueToOtherRooms(
      updatedManager, sceneRoomId, keeperNarrative,
      result.dynamicGameState, turnManager, state.sessionId, metadata.language, wsManager
    );
  }

  // Rest-frozen check
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
  }

  // Time-unfrozen players check
  if (updatedManager && wsManager && updatedSceneRoom) {
    const unfrozenPlayerIds =
      (updatedSceneRoom.temporaryInfo.contextualData?.unfrozenPlayerIds as string[] | undefined) ?? [];
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
    }
  }
}

// =============================================
// broadcastEpilogueToOtherRooms — shared helper for game ending broadcast
// =============================================

async function broadcastEpilogueToOtherRooms(
  updatedManager: MultiplayerDynamicGameStateManager,
  sceneRoomId: string,
  keeperNarrative: string,
  dynamicGameState: any,
  turnManager: TurnManager,
  sessionId: string,
  language: "en" | "zh",
  wsManager: NonNullable<ReturnType<typeof WebSocketManager.getInstance>>
): Promise<void> {
  const allActiveRooms = updatedManager.getActiveSceneRooms();
  const otherRooms = allActiveRooms.filter((r) => r.sceneRoomId !== sceneRoomId);

  if (otherRooms.length === 0) return;

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
        gameEnding: dynamicGameState.gameEnding,
        timestamp: new Date().toISOString(),
      });

      try {
        const epilogueTurnId = await turnManager.createTurn({
          sessionId,
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
          if (epilogueTurn && dynamicGameState) {
            const turnRagAgent = new TurnRagAgent();
            void turnRagAgent.recordTurn({
              turn: epilogueTurn,
              multiplayerState: dynamicGameState,
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

/** Helper: check if roundInputs has at least one non-empty input */
function combinedInputExists(roundInputs: MultiplayerTurnInput[]): boolean {
  return roundInputs.some((i) => i.inputType === "input" && Boolean(i.content?.trim()));
}

// =============================================
// handleUnifiedSceneSnapshots — Drain 1, Step 1
// Generates NPC timelines + target scene snapshots for all rooms.
// =============================================

async function handleUnifiedSceneSnapshots(
  roomId: string,
  manager: MultiplayerDynamicGameStateManager,
  db: CoCDatabase | CoCDatabaseAdapter
): Promise<void> {
  const wsManager = WebSocketManager.getInstance();

  try {
    const scenarioLoader = new ScenarioLoader(db);
    const directorAgent = new DirectorAgent(scenarioLoader, db);
    const sceneChangeResult = await directorAgent.handleUnifiedSceneChanges(manager);

    if (sceneChangeResult.anyChanges) {
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
}

// =============================================
// copyParentTemporaryInfoToChildren — Drain 1, Step 3
// Copies parent room(s) temporaryInfo to child rooms so Phase 2 has action context.
// Filters action results / inputs / analyses to only include data for this child room's players.
// =============================================

function copyParentTemporaryInfoToChildren(
  manager: MultiplayerDynamicGameStateManager,
  splitResult: ResolveMovementsResult
): void {
  const state = manager.getState();

  // Build the full set of all player character names (for distinguishing player vs NPC entries)
  const allPlayerCharNames = new Set<string>();
  for (const ps of Object.values(state.players)) {
    if (ps.characterName) allPlayerCharNames.add(ps.characterName);
  }

  for (const child of splitResult.newChildRooms) {
    const parentInfos = child.parentSceneRoomIds
      .map((pid) => manager.getSceneRoom(pid)?.temporaryInfo)
      .filter(
        (info): info is NonNullable<typeof info> => info != null
      );

    if (parentInfos.length === 0) continue;

    // Build child room's player ID set and character name set
    const childPlayerIdSet = new Set(child.playerIds);
    const childPlayerCharNames = new Set<string>();
    for (const pid of child.playerIds) {
      const ps = state.players[pid];
      if (ps?.characterName) childPlayerCharNames.add(ps.characterName);
    }

    // Helper: keep an action result if it belongs to a child-room player,
    // or if it's an NPC entry (not any player) and this is a stayer room.
    const keepActionResult = (character: string): boolean =>
      childPlayerCharNames.has(character) ||
      (child.isStayerRoom && !allPlayerCharNames.has(character));

    // Helper: filter contextualData entries scoped to child room players
    const filterContextualData = (cd: Record<string, unknown>): Record<string, unknown> => {
      const filtered = { ...cd };

      // roundInputsForKeeper — filter by playerId
      if (Array.isArray(filtered.roundInputsForKeeper)) {
        filtered.roundInputsForKeeper = (filtered.roundInputsForKeeper as any[]).filter(
          (i: any) => childPlayerIdSet.has(i.playerId)
        );
      }

      // playerActionAnalyses — filter by playerId keys
      if (filtered.playerActionAnalyses && typeof filtered.playerActionAnalyses === "object") {
        const scoped: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(filtered.playerActionAnalyses as Record<string, unknown>)) {
          if (childPlayerIdSet.has(key)) scoped[key] = val;
        }
        filtered.playerActionAnalyses = scoped;
      }

      return filtered;
    };

    // Single parent: deep copy + filter
    if (parentInfos.length === 1) {
      const cloned = structuredClone(parentInfos[0]);

      // Stayer rooms stay in the same scene — clear scene-transition context
      if (child.isStayerRoom) {
        cloned.sceneChangeRequest = null;
        cloned.previousScenario = null;
      }

      // Filter action results to this child room's players (+ NPC entries for stayer rooms)
      cloned.actionResults = cloned.actionResults.filter(
        (r) => keepActionResult(r.character)
      );
      cloned.actionResultsDetailed = cloned.actionResultsDetailed.filter(
        (r) => keepActionResult(typeof r.character === "string" ? r.character : "")
      );
      cloned.slowGroupActionResults = (cloned.slowGroupActionResults ?? []).filter(
        (r) => keepActionResult(r.character)
      );
      cloned.slowGroupActionResultsDetailed = (cloned.slowGroupActionResultsDetailed ?? []).filter(
        (r) => keepActionResult(typeof r.character === "string" ? r.character : "")
      );

      // Mover rooms: NPC responses happened at old scene — not relevant
      if (!child.isStayerRoom) {
        cloned.npcResponseAnalyses = [];
      }

      // Filter contextualData (roundInputsForKeeper, playerActionAnalyses)
      cloned.contextualData = filterContextualData(cloned.contextualData);

      manager.updateSceneRoom(child.sceneRoomId, {
        temporaryInfo: cloned,
      });
      continue;
    }

    // Multiple parents (merge): concat arrays + filter, merge contextualData
    const allActionResults = parentInfos.flatMap((p) => p.actionResults);
    const allActionResultsDetailed = parentInfos.flatMap((p) => p.actionResultsDetailed);
    const allSlowResults = parentInfos.flatMap((p) => p.slowGroupActionResults);
    const allSlowDetailed = parentInfos.flatMap((p) => p.slowGroupActionResultsDetailed);
    const allNpcResponses = parentInfos.flatMap((p) => p.npcResponseAnalyses);

    const merged = {
      rules: parentInfos.flatMap((p) => p.rules),
      actionResults: allActionResults.filter((r) => keepActionResult(r.character)),
      actionResultsDetailed: allActionResultsDetailed.filter(
        (r) => keepActionResult(typeof r.character === "string" ? r.character : "")
      ),
      currentActionAnalysis: parentInfos[0].currentActionAnalysis,
      npcResponseAnalyses: child.isStayerRoom ? allNpcResponses : [],
      // Only mover rooms get scene-transition context
      sceneChangeRequest: child.isStayerRoom
        ? null
        : parentInfos.find((p) => p.sceneChangeRequest)?.sceneChangeRequest ?? null,
      previousScenario: child.isStayerRoom
        ? null
        : parentInfos.find((p) => p.previousScenario)?.previousScenario ?? null,
      slowGroupActionResults: allSlowResults.filter((r) => keepActionResult(r.character)),
      slowGroupActionResultsDetailed: allSlowDetailed.filter(
        (r) => keepActionResult(typeof r.character === "string" ? r.character : "")
      ),
      contextualData: filterContextualData(
        Object.assign({}, ...parentInfos.map((p) => p.contextualData)) as Record<string, unknown>
      ),
    };

    // Merge playerActionAnalyses (already filtered by filterContextualData above,
    // but we need to re-merge since Object.assign may have clobbered keys)
    const mergedAnalyses: Record<string, unknown> = {};
    for (const p of parentInfos) {
      const analyses = p.contextualData?.playerActionAnalyses as
        | Record<string, unknown>
        | undefined;
      if (analyses) {
        for (const [key, val] of Object.entries(analyses)) {
          if (childPlayerIdSet.has(key)) mergedAnalyses[key] = val;
        }
      }
    }
    if (Object.keys(mergedAnalyses).length > 0) {
      merged.contextualData.playerActionAnalyses = mergedAnalyses;
    }

    manager.updateSceneRoom(child.sceneRoomId, { temporaryInfo: merged });
  }
}

// =============================================
// processPostNarrative — Drain 2
// Runs after ALL Phase 2 tasks complete: time drift, scene images,
// rest-unfreeze coordination, auto-save checkpoint.
// =============================================

async function processPostNarrative(
  roomId: string,
  manager: MultiplayerDynamicGameStateManager,
  db: CoCDatabase | CoCDatabaseAdapter,
  processedSceneRoomIds: string[]
): Promise<void> {
  const wsManager = WebSocketManager.getInstance();

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

  // ---- Scene Image Generation (fire-and-forget, only when scene changed or no image yet) ----
  const state = manager.getState();
  if (state.moduleName) {
    const processedSet = new Set(processedSceneRoomIds);
    for (const room of manager.getActiveSceneRooms().filter(r => processedSet.has(r.sceneRoomId))) {
      // Only generate when: (a) scene actually changed, or (b) no image exists yet
      const sceneChanged = room.temporaryInfo.previousScenario != null
        || room.temporaryInfo.sceneChangeRequest != null;
      const hasImage = room.currentScenario?.sceneImage != null;
      if (!room.currentScenario || (hasImage && !sceneChanged)) continue;

      generateSceneRoomImage(room.currentScenario, state.moduleName)
          .then((imageResult) => {
            if (imageResult) {
              // Write back to in-memory state so /gamestate API returns it
              const latestMgr = multiplayerSessionStore.get(roomId) ?? manager;
              const latestRoom = latestMgr.getSceneRoom(room.sceneRoomId);
              if (latestRoom?.currentScenario) {
                latestRoom.currentScenario.sceneImage = {
                  path: imageResult.path,
                  mimeType: imageResult.mimeType,
                  generatedAt: new Date().toISOString(),
                };
              }
              if (wsManager) {
                const clients = wsManager.getMultiplayerClients(room.sceneRoomId);
                notifySceneRoom(room.sceneRoomId, clients, {
                  type: "scene_image_ready",
                  sceneRoomId: room.sceneRoomId,
                  imagePath: imageResult.path,
                  mimeType: imageResult.mimeType,
                  timestamp: new Date().toISOString(),
                });
              }
            }
          })
          .catch((err) => {
            console.warn(`[MP Turn] Scene image generation failed for ${room.sceneRoomId}:`, err);
          });
    }
  }

  // ---- Rest-unfreeze coordination ----
  await handleRestUnfreezeCheck(manager, db, wsManager);

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
          payload: payload as any,
          createdBy: "system",
        },
      });
    }
  } catch (e) {
    console.warn("[MP Turn] Auto-checkpoint failed:", e);
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
  manager: MultiplayerDynamicGameStateManager,
  wsManager: ReturnType<typeof WebSocketManager.getInstance>
): Promise<ResolveMovementsResult | null> {
  try {
    // resolveAllMovements handles ALL active sceneRooms globally:
    // splits, merges, and cross-room merges — all in one pass.
    // Snapshots are pre-generated by handleMultiplayerSceneChanges in the director node.
    const result = await resolveAllMovements(manager);

    if (!result.anyChanges) return result;

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

    // ── Migrate WS clients to child rooms so they receive events before frontend reconnects ──
    // Register ALL players from frozen rooms to ALL child rooms, so every player
    // can observe other rooms' narratives when switching tabs.
    if (wsManager) {
      for (const frozenId of result.frozenSceneRoomIds) {
        const frozenClients = wsManager.getMultiplayerClients(frozenId);
        for (const childRoom of result.newChildRooms) {
          if (!childRoom.parentSceneRoomIds.includes(frozenId)) continue;
          for (const [playerId, client] of frozenClients) {
            wsManager.registerMultiplayerClient(childRoom.sceneRoomId, playerId, client);
          }
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

        // Generate maps only for mover rooms (stayer rooms keep parent's assets)
        // NOTE: BG image generation is handled by processPostNarrative for all processed rooms
        if (!childRoom.isStayerRoom) {
          const state = manager.getState();
          const childState = manager.getSceneRoom(childRoom.sceneRoomId);
          if (childState?.currentScenario && state.moduleName) {
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

    return result;
  } catch (e) {
    console.error("[MP Turn] handlePostRoundSceneSplit failed:", e);
    return null;
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

function buildStreamHandlers(sceneRoomId: string, roundTurnId: string, roomId?: string) {
  const modelProvider = (process.env.MODEL_PROVIDER || "").toLowerCase();
  const enableStreaming = modelProvider === "google";
  const wsManager = WebSocketManager.getInstance();

  if (!wsManager || !enableStreaming) return undefined;

  /** Resolve current gameDay/gameTime from the live manager state. */
  const getTimeMeta = () => {
    if (!roomId) return { gameDay: null, gameTime: null };
    const mgr = multiplayerSessionStore.get(roomId);
    if (!mgr) return { gameDay: null, gameTime: null };
    const sr = mgr.getSceneRoom(sceneRoomId);
    return {
      gameDay: sr?.gameDay ?? mgr.getState().gameDay ?? null,
      gameTime: sr?.timeOfDay ?? mgr.getState().timeOfDay ?? null,
    };
  };

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
        const tm = getTimeMeta();
        send({
          type: "keeper_dice_rolls",
          roundTurnId,
          sceneRoomId,
          diceRolls,
          timestamp: new Date().toISOString(),
          gameDay: tm.gameDay,
          gameTime: tm.gameTime,
        });
      }
    },
    onSceneImage: (payload: { imagePath: string; mimeType: string; sceneName: string; location: string; gameDay?: number | null; gameTime?: string | null; timestamp?: string }) => {
      send({
        type: "scene_image",
        roundTurnId,
        sceneRoomId,
        ...payload,
      });
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
