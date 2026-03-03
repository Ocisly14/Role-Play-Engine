/**
 * Scene Room Splitter — Freeze-Fork Implementation
 *
 * Implements the tree-history pattern for scene room splits:
 * - Parent room is frozen (becomes a historical snapshot)
 * - Child rooms are created for stayers and movers with parentSceneRoomIds set
 *
 * Note: For the unified cross-room merge/split entry point used by turn/service.ts,
 * see sceneRoomMerger.ts → resolveAllMovements().
 */

import { randomUUID } from "crypto";
import type { PlayerActionAnalysis } from "../multiplayerAgent/orchestrator/orchestratorAgent.js";
import {
  type MultiplayerDynamicGameStateManager,
} from "../multiplayerState/MultiplayerDynamicGameState.js";
import { findSnapshotBySceneName } from "./sceneRoomMerger.js";

// =============================================
// Public types
// =============================================

export interface SplitSceneRoom {
  /** New sceneRoomId (UUID) */
  sceneRoomId: string;
  /** Player IDs in this new sceneRoom */
  playerIds: string[];
  /** The target scene name (same as parent for stayer rooms) */
  targetSceneName: string;
  /** Reason for the scene change */
  reason: string;
  /** True if this room was created for players who stayed in the same scene */
  isStayerRoom: boolean;
  /** Parent room IDs (single entry for splits) */
  parentSceneRoomIds: string[];
}

export interface SceneRoomSplitResult {
  /** True if at least one child room was created */
  splitOccurred: boolean;
  /** The parent sceneRoomId that was frozen; null if no split occurred */
  frozenSceneRoomId: string | null;
  /** Child room for players who stayed (null if all players moved) */
  stayerChildRoom: SplitSceneRoom | null;
  /** Child rooms for players who moved (one per unique target scene) */
  moverChildRooms: SplitSceneRoom[];
  /** All new child rooms (convenience: stayerChildRoom + moverChildRooms, non-null) */
  newSceneRooms: SplitSceneRoom[];
  /** Player IDs that stayed in the original scene (backward-compat) */
  remainingPlayerIds: string[];
}

// =============================================
// evaluateAndSplitSceneRooms
// =============================================

/**
 * Inspect the completed round's playerActionAnalyses and split the sceneRoom
 * if any players requested a scene change.
 *
 * Freeze-fork pattern:
 *  1. Parent room is frozen (historical snapshot)
 *  2. Stayers → new child room inheriting parent scenario
 *  3. Movers (grouped by target) → new child room per target + DirectorAgent scene transition
 *
 * @param manager       In-memory multiplayer game state manager
 * @param sceneRoomId   The sceneRoom that just finished its round
 * @param directorAgent DirectorAgent instance (needed for scene transition logic)
 * @param _db           Database adapter (passed through to director)
 * @returns             Split result describing any new child rooms created
 */
export async function evaluateAndSplitSceneRooms(
  manager: MultiplayerDynamicGameStateManager,
  sceneRoomId: string
): Promise<SceneRoomSplitResult> {
  const sceneRoom = manager.getSceneRoom(sceneRoomId);
  if (!sceneRoom) {
    return {
      splitOccurred: false,
      frozenSceneRoomId: null,
      stayerChildRoom: null,
      moverChildRooms: [],
      newSceneRooms: [],
      remainingPlayerIds: [],
    };
  }

  if (sceneRoom.isFrozen) {
    console.warn(
      `[SceneRoomSplitter] sceneRoom ${sceneRoomId} is already frozen — skipping`
    );
    return {
      splitOccurred: false,
      frozenSceneRoomId: null,
      stayerChildRoom: null,
      moverChildRooms: [],
      newSceneRooms: [],
      remainingPlayerIds: [...sceneRoom.memberPlayerIds],
    };
  }

  // Read playerActionAnalyses stored by the Orchestrator node
  const playerActionAnalyses =
    (sceneRoom.temporaryInfo.contextualData
      ?.playerActionAnalyses as Record<string, PlayerActionAnalysis>) ?? {};

  // Collect players requesting a scene change
  const movingPlayers: Array<{
    playerId: string;
    targetSceneName: string;
    reason: string;
  }> = [];

  for (const [playerId, pa] of Object.entries(playerActionAnalyses)) {
    const scr = pa.sceneChangeRequest;
    if (scr?.shouldChange && scr.targetSceneName) {
      movingPlayers.push({
        playerId,
        targetSceneName: scr.targetSceneName,
        reason: scr.reason ?? "player moved to a new location",
      });
    }
  }

  if (movingPlayers.length === 0) {
    return {
      splitOccurred: false,
      frozenSceneRoomId: null,
      stayerChildRoom: null,
      moverChildRooms: [],
      newSceneRooms: [],
      remainingPlayerIds: [...sceneRoom.memberPlayerIds],
    };
  }

  const movingPlayerIds = new Set(movingPlayers.map((m) => m.playerId));
  const stayerIds = sceneRoom.memberPlayerIds.filter(
    (id) => !movingPlayerIds.has(id)
  );

  // ── Freeze the parent room ──
  manager.freezeSceneRoom(sceneRoomId);
  console.log(`[SceneRoomSplitter] Frozen parent sceneRoom: ${sceneRoomId}`);

  const newSceneRooms: SplitSceneRoom[] = [];
  let stayerChildRoom: SplitSceneRoom | null = null;

  // ── Create stayer child room (if there are stayers) ──
  if (stayerIds.length > 0) {
    const stayerChildId = randomUUID();
    manager.createSceneRoom(stayerChildId, stayerIds, {
      parentSceneRoomIds: [sceneRoomId],
      currentScenario: sceneRoom.currentScenario,
      scenarioId: sceneRoom.scenarioId,
      scenarioName: sceneRoom.scenarioName,
      snapshotId: sceneRoom.snapshotId,
      snapshotName: sceneRoom.snapshotName,
      gameDay: sceneRoom.gameDay,
      timeOfDay: sceneRoom.timeOfDay,
      roundNumber: 1,
      turnsInCurrentScene: 0,
    });
    for (const stayerId of stayerIds) {
      manager.relocatePlayerToSceneRoom(stayerId, stayerChildId);
    }
    console.log(
      `[SceneRoomSplitter] Stayer child ${stayerChildId} created for ${stayerIds.length} player(s)`
    );
    stayerChildRoom = {
      sceneRoomId: stayerChildId,
      playerIds: stayerIds,
      targetSceneName: sceneRoom.scenarioName ?? "",
      reason: "player(s) remained in current scene",
      isStayerRoom: true,
      parentSceneRoomIds: [sceneRoomId],
    };
    newSceneRooms.push(stayerChildRoom);
  }

  // ── Group movers by target scene and create mover child rooms ──
  const groups = new Map<
    string,
    { targetSceneName: string; reason: string; playerIds: string[] }
  >();
  for (const mp of movingPlayers) {
    const existing = groups.get(mp.targetSceneName);
    if (existing) {
      existing.playerIds.push(mp.playerId);
    } else {
      groups.set(mp.targetSceneName, {
        targetSceneName: mp.targetSceneName,
        reason: mp.reason,
        playerIds: [mp.playerId],
      });
    }
  }

  const moverChildRooms: SplitSceneRoom[] = [];

  for (const [targetSceneName, group] of groups) {
    const moverChildId = randomUUID();
    const { playerIds, reason } = group;

    manager.createSceneRoom(moverChildId, playerIds, {
      parentSceneRoomIds: [sceneRoomId],
      currentScenario: sceneRoom.currentScenario,
      scenarioName: sceneRoom.scenarioName,
      snapshotId: sceneRoom.snapshotId,
      snapshotName: sceneRoom.snapshotName,
      gameDay: sceneRoom.gameDay,
      timeOfDay: sceneRoom.timeOfDay,
      roundNumber: 1,
      turnsInCurrentScene: 0,
    });

    for (const playerId of playerIds) {
      manager.relocatePlayerToSceneRoom(playerId, moverChildId);
    }

    // Record scene transition in player actionLog (symmetric with NPC tracking)
    const moveTime = `Day ${sceneRoom.gameDay}, ${sceneRoom.timeOfDay}`;
    for (const playerId of playerIds) {
      manager.appendPlayerActionLog(playerId, {
        time: moveTime,
        location: targetSceneName,
        summary: `前往了${targetSceneName}`,
      });
    }

    console.log(
      `[SceneRoomSplitter] Mover child ${moverChildId} created for ` +
        `${playerIds.length} player(s) → "${targetSceneName}"`
    );

    // Look up pre-generated snapshot and set as current scenario
    const found = findSnapshotBySceneName(manager, targetSceneName);
    if (found) {
      manager.updateCurrentScenario(moverChildId, {
        snapshot: found.snapshot,
        scenarioName: targetSceneName,
        scenarioId: found.scenarioId,
      });
      console.log(
        `[SceneRoomSplitter] Scene transition complete → "${targetSceneName}"`
      );
    } else {
      console.warn(
        `[SceneRoomSplitter] No pre-generated snapshot found for "${targetSceneName}"`
      );
    }

    const moverRoom: SplitSceneRoom = {
      sceneRoomId: moverChildId,
      playerIds,
      targetSceneName,
      reason,
      isStayerRoom: false,
      parentSceneRoomIds: [sceneRoomId],
    };
    moverChildRooms.push(moverRoom);
    newSceneRooms.push(moverRoom);
  }

  return {
    splitOccurred: newSceneRooms.length > 0,
    frozenSceneRoomId: sceneRoomId,
    stayerChildRoom,
    moverChildRooms,
    newSceneRooms,
    remainingPlayerIds: stayerIds,
  };
}
