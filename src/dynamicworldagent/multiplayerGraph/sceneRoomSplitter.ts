/**
 * Scene Room Splitter — Phase 4
 *
 * After a round completes, reads playerActionAnalyses from each sceneRoom
 * to find players who want to move to a different scene.
 *
 * Groups them by targetSceneName, creates new sceneRooms in the manager,
 * moves players, then calls DirectorAgent.handleActionDrivenSceneChange()
 * per new sceneRoom to generate proper snapshots.
 *
 * All DB writes (creating MultiplayerSceneRoom rows, updating member
 * currentSceneRoomId) are done by the caller (turn service) after this
 * function returns — to keep this module pure in-memory.
 */

import { randomUUID } from "crypto";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../shared/agents/memory/database/index.js";
import type { DirectorAgent } from "../multiplayerAgent/director/directorAgent.js";
import type { PlayerActionAnalysis } from "../multiplayerAgent/orchestrator/orchestratorAgent.js";
import {
  MultiplayerDynamicGameStateManager,
  emptyTemporaryInfo,
} from "../multiplayerState/MultiplayerDynamicGameState.js";

// =============================================
// Public types
// =============================================

export interface SplitSceneRoom {
  /** New sceneRoomId (UUID) */
  sceneRoomId: string;
  /** Player IDs moved into this new sceneRoom */
  playerIds: string[];
  /** The target scene name these players are moving to */
  targetSceneName: string;
  /** Reason for the scene change */
  reason: string;
}

export interface SceneRoomSplitResult {
  /** True if at least one new sceneRoom was created */
  splitOccurred: boolean;
  /** Player IDs that stayed in the original sceneRoom */
  remainingPlayerIds: string[];
  /** Info about each newly created sceneRoom */
  newSceneRooms: SplitSceneRoom[];
}

// =============================================
// evaluateAndSplitSceneRooms
// =============================================

/**
 * Inspect the completed round's playerActionAnalyses and split the sceneRoom
 * if any players requested a scene change.
 *
 * @param manager   In-memory multiplayer game state manager
 * @param sceneRoomId  The sceneRoom that just finished its round
 * @param directorAgent  DirectorAgent instance (needed for scene transition logic)
 * @param db  Database adapter (passed through to director)
 * @returns   Split result describing any new sceneRooms created
 */
export async function evaluateAndSplitSceneRooms(
  manager: MultiplayerDynamicGameStateManager,
  sceneRoomId: string,
  directorAgent: DirectorAgent,
  _db: CoCDatabase | CoCDatabaseAdapter
): Promise<SceneRoomSplitResult> {
  const sceneRoom = manager.getSceneRoom(sceneRoomId);
  if (!sceneRoom) {
    return { splitOccurred: false, remainingPlayerIds: [], newSceneRooms: [] };
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
      remainingPlayerIds: [...sceneRoom.memberPlayerIds],
      newSceneRooms: [],
    };
  }

  // Group by target scene name (players heading to the same scene share a sceneRoom)
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

  const movingPlayerIds = new Set(movingPlayers.map((m) => m.playerId));
  const remainingPlayerIds = sceneRoom.memberPlayerIds.filter(
    (id) => !movingPlayerIds.has(id)
  );

  const newSceneRooms: SplitSceneRoom[] = [];

  for (const [targetSceneName, group] of groups) {
    const newSceneRoomId = randomUUID();
    const { playerIds, reason } = group;

    console.log(
      `[SceneRoomSplitter] Creating sceneRoom ${newSceneRoomId} for ` +
        `${playerIds.length} player(s) → "${targetSceneName}"`
    );

    // Create a new sceneRoom in the manager:
    // - Inherits current scenario snapshot as departure point
    // - Primes temporaryInfo.sceneChangeRequest so DirectorAgent sees the request
    manager.createSceneRoom(newSceneRoomId, [], {
      currentScenario: sceneRoom.currentScenario,
      scenarioName: sceneRoom.scenarioName,
      snapshotId: sceneRoom.snapshotId,
      snapshotName: sceneRoom.snapshotName,
      temporaryInfo: {
        ...emptyTemporaryInfo(),
        sceneChangeRequest: {
          shouldChange: true,
          targetSceneName,
          reason,
          timestamp: new Date(),
        },
      },
    });

    // Move players into the new sceneRoom
    for (const playerId of playerIds) {
      manager.movePlayerToSceneRoom(playerId, newSceneRoomId);
    }

    // Run DirectorAgent's scene transition logic — this does LLM calls to
    // generate a complete snapshot for the target scene and updates the sceneRoom
    try {
      await directorAgent.handleActionDrivenSceneChange(
        manager,
        newSceneRoomId,
        targetSceneName,
        reason
      );
      console.log(
        `[SceneRoomSplitter] Scene transition complete → "${targetSceneName}"`
      );
    } catch (e) {
      console.error(
        `[SceneRoomSplitter] Scene transition failed for "${targetSceneName}":`,
        e
      );
      // Non-fatal: sceneRoom is created even without a snapshot; next round will retry
    }

    newSceneRooms.push({
      sceneRoomId: newSceneRoomId,
      playerIds,
      targetSceneName,
      reason,
    });
  }

  return {
    splitOccurred: newSceneRooms.length > 0,
    remainingPlayerIds,
    newSceneRooms,
  };
}
