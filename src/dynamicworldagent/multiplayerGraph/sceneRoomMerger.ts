/**
 * Scene Room Merger — Unified movement resolution (Freeze-Fork-Merge)
 *
 * This module is the single entry point for resolving all player movements
 * after a round completes.  It handles both simple splits (one source room)
 * and cross-room merges (multiple source rooms heading to the same target).
 *
 * Core rule: any sceneRoom whose membership changes (players leave OR
 * external players join) is frozen, and a new child room is created.
 *
 *   resolveAllMovements()  ← called by turn/service.ts after each round
 *   mergeSceneRooms()      ← lower-level helper (can be called directly)
 *   findActiveSceneRoomByScene() ← helper to detect existing active rooms
 */

import { randomUUID } from "crypto";
import type { DirectorAgent } from "../multiplayerAgent/director/directorAgent.js";
import type { PlayerActionAnalysis } from "../multiplayerAgent/orchestrator/orchestratorAgent.js";
import {
  emptyTemporaryInfo,
  type MultiplayerDynamicGameStateManager,
  type MultiplayerSceneRoomState,
} from "../multiplayerState/MultiplayerDynamicGameState.js";

// =============================================
// Public types
// =============================================

export interface ChildRoomInfo {
  sceneRoomId: string;
  playerIds: string[];
  parentSceneRoomIds: string[];
  /** Null for stayer rooms (scene name unchanged) */
  targetSceneName: string | null;
  isStayerRoom: boolean;
}

export interface ResolveMovementsResult {
  anyChanges: boolean;
  frozenSceneRoomIds: string[];
  newChildRooms: ChildRoomInfo[];
}

export interface SceneRoomMergeResult {
  mergeOccurred: boolean;
  frozenSceneRoomIds: string[];
  mergedChildRoom: ChildRoomInfo | null;
}

// =============================================
// Helpers
// =============================================

/**
 * Find an active (non-frozen) sceneRoom whose current scenario name
 * matches the given target scene name (case-insensitive).
 */
function findActiveSceneRoomByScene(
  manager: MultiplayerDynamicGameStateManager,
  targetSceneName: string
): MultiplayerSceneRoomState | null {
  const lower = targetSceneName.toLowerCase();
  return (
    manager.getActiveSceneRooms().find((r) => {
      const roomName =
        r.scenarioName?.toLowerCase() ??
        (r.currentScenario as any)?.name?.toLowerCase() ??
        "";
      return roomName === lower;
    }) ?? null
  );
}

// =============================================
// resolveAllMovements — unified entry point
// =============================================

/**
 * Inspect all active sceneRooms for pending movement intentions (stored in
 * temporaryInfo.contextualData.playerActionAnalyses by the Orchestrator).
 *
 * Applies the following rules:
 *  - Any sceneRoom that loses OR gains players is frozen.
 *  - Players that stay (no movement request in a frozen source room) get a
 *    dedicated stayer-child room inheriting the parent's scenario.
 *  - All players heading to the same targetSceneName are placed together
 *    in ONE merged-child room, regardless of which source rooms they came
 *    from.  The merged child's parentSceneRoomIds lists every frozen source.
 *  - If a target scene already has an active room, that room is also frozen
 *    and its stayers are folded into the merged child.
 *  - SceneRooms with no membership changes are left active.
 *
 * After processing, playerActionAnalyses in each active room's contextualData
 * is cleared to prevent stale data from affecting future rounds.
 */
export async function resolveAllMovements(
  manager: MultiplayerDynamicGameStateManager,
  directorAgent: DirectorAgent
): Promise<ResolveMovementsResult> {
  const activeRooms = manager.getActiveSceneRooms();

  // ── Step 1: Collect all movement intentions ──
  const movingPlayersMap = new Map<
    string,
    { fromSceneRoomId: string; targetSceneName: string; reason: string }
  >();

  for (const room of activeRooms) {
    const analyses = room.temporaryInfo.contextualData
      ?.playerActionAnalyses as Record<string, PlayerActionAnalysis> | undefined;
    if (!analyses) continue;

    for (const [playerId, pa] of Object.entries(analyses)) {
      const scr = pa.sceneChangeRequest;
      if (scr?.shouldChange && scr.targetSceneName) {
        movingPlayersMap.set(playerId, {
          fromSceneRoomId: room.sceneRoomId,
          targetSceneName: scr.targetSceneName,
          reason: scr.reason ?? "player moved to a new location",
        });
      }
    }
  }

  if (movingPlayersMap.size === 0) {
    return { anyChanges: false, frozenSceneRoomIds: [], newChildRooms: [] };
  }

  const movingPlayersSet = new Set(movingPlayersMap.keys());

  // ── Step 2: Build target groups ──
  interface TargetGroup {
    incomingPlayerIds: string[];
    fromSceneRoomIds: string[]; // unique source rooms for movers
    reason: string;
    existingSceneRoomId: string | null;
    existingRoomStayers: string[]; // stayers in an existing active room for this target
  }
  const targetGroups = new Map<string, TargetGroup>();

  for (const [playerId, movement] of movingPlayersMap) {
    const key = movement.targetSceneName;
    const existing = targetGroups.get(key);
    if (existing) {
      existing.incomingPlayerIds.push(playerId);
      if (!existing.fromSceneRoomIds.includes(movement.fromSceneRoomId)) {
        existing.fromSceneRoomIds.push(movement.fromSceneRoomId);
      }
    } else {
      targetGroups.set(key, {
        incomingPlayerIds: [playerId],
        fromSceneRoomIds: [movement.fromSceneRoomId],
        reason: movement.reason,
        existingSceneRoomId: null,
        existingRoomStayers: [],
      });
    }
  }

  // Check for existing active rooms for each target
  const existingRoomIds = new Set<string>();
  for (const [targetSceneName, group] of targetGroups) {
    const existingRoom = findActiveSceneRoomByScene(manager, targetSceneName);
    if (existingRoom) {
      group.existingSceneRoomId = existingRoom.sceneRoomId;
      group.existingRoomStayers = existingRoom.memberPlayerIds.filter(
        (p) => !movingPlayersSet.has(p)
      );
      existingRoomIds.add(existingRoom.sceneRoomId);
    }
  }

  // ── Step 3: Determine which rooms must be frozen ──
  const frozenSceneRoomIdsSet = new Set<string>();
  for (const movement of movingPlayersMap.values()) {
    frozenSceneRoomIdsSet.add(movement.fromSceneRoomId);
  }
  for (const id of existingRoomIds) {
    frozenSceneRoomIdsSet.add(id);
  }

  // ── Step 4: Freeze all affected rooms ──
  for (const roomId of frozenSceneRoomIdsSet) {
    manager.freezeSceneRoom(roomId);
    console.log(`[SceneRoomMerger] Frozen sceneRoom: ${roomId}`);
  }

  const newChildRooms: ChildRoomInfo[] = [];

  // ── Step 5: Create stayer-child rooms for source-only rooms ──
  // (existing rooms' stayers are absorbed into merged child — handled below)
  for (const roomId of frozenSceneRoomIdsSet) {
    if (existingRoomIds.has(roomId)) continue; // stayers go into merged child

    const room = manager.getSceneRoom(roomId);
    if (!room) continue;

    const stayers = room.memberPlayerIds.filter(
      (p) => !movingPlayersSet.has(p)
    );
    if (stayers.length === 0) continue;

    const stayerChildId = randomUUID();
    manager.createSceneRoom(stayerChildId, stayers, {
      parentSceneRoomIds: [roomId],
      currentScenario: room.currentScenario,
      scenarioId: room.scenarioId,
      scenarioName: room.scenarioName,
      snapshotId: room.snapshotId,
      snapshotName: room.snapshotName,
      roundNumber: 1,
      turnsInCurrentScene: 0,
    });
    for (const stayerId of stayers) {
      manager.relocatePlayerToSceneRoom(stayerId, stayerChildId);
    }

    console.log(
      `[SceneRoomMerger] Stayer child ${stayerChildId} created for ${stayers.length} player(s) ` +
        `(parent: ${roomId}, scene: ${room.scenarioName ?? "unknown"})`
    );

    newChildRooms.push({
      sceneRoomId: stayerChildId,
      playerIds: stayers,
      parentSceneRoomIds: [roomId],
      targetSceneName: null, // stays in same scene
      isStayerRoom: true,
    });
  }

  // ── Step 6: Create merged-child rooms for each target group ──
  for (const [targetSceneName, group] of targetGroups) {
    const allMemberIds = [
      ...group.incomingPlayerIds,
      ...group.existingRoomStayers,
    ];
    const parentIds = [...new Set([
      ...group.fromSceneRoomIds,
      ...(group.existingSceneRoomId ? [group.existingSceneRoomId] : []),
    ])];

    const mergedChildId = randomUUID();
    const sourceRoom = manager.getSceneRoom(group.fromSceneRoomIds[0]);

    manager.createSceneRoom(mergedChildId, allMemberIds, {
      parentSceneRoomIds: parentIds,
      currentScenario: sourceRoom?.currentScenario ?? null,
      scenarioName: targetSceneName,
      roundNumber: 1,
      turnsInCurrentScene: 0,
      temporaryInfo: {
        ...emptyTemporaryInfo(),
        sceneChangeRequest: {
          shouldChange: true,
          targetSceneName,
          reason: group.reason,
          timestamp: new Date(),
        },
      },
    });

    for (const playerId of allMemberIds) {
      manager.relocatePlayerToSceneRoom(playerId, mergedChildId);
    }

    const parentCount = parentIds.length;
    console.log(
      `[SceneRoomMerger] Merged child ${mergedChildId} created for ` +
        `${allMemberIds.length} player(s) → "${targetSceneName}" ` +
        `(${parentCount} parent${parentCount > 1 ? "s" : ""})`
    );

    // Run DirectorAgent to generate snapshot for the target scene
    try {
      await directorAgent.handleActionDrivenSceneChange(
        manager,
        mergedChildId,
        targetSceneName,
        group.reason
      );
      console.log(
        `[SceneRoomMerger] Scene transition complete → "${targetSceneName}"`
      );
    } catch (e) {
      console.error(
        `[SceneRoomMerger] Scene transition failed for "${targetSceneName}":`,
        e
      );
    }

    newChildRooms.push({
      sceneRoomId: mergedChildId,
      playerIds: allMemberIds,
      parentSceneRoomIds: parentIds,
      targetSceneName,
      isStayerRoom: false,
    });
  }

  // Clear playerActionAnalyses from frozen rooms to prevent stale data
  for (const roomId of frozenSceneRoomIdsSet) {
    const room = manager.getSceneRoom(roomId);
    if (room?.temporaryInfo.contextualData?.playerActionAnalyses) {
      manager.setContextualData(roomId, "playerActionAnalyses", undefined);
    }
  }

  return {
    anyChanges: true,
    frozenSceneRoomIds: [...frozenSceneRoomIdsSet],
    newChildRooms,
  };
}

// =============================================
// mergeSceneRooms — lower-level helper
// =============================================

/**
 * Merge two or more sceneRooms into a single child room.
 * All source rooms are frozen and all their members are moved to the new child.
 * DirectorAgent generates the target scene snapshot.
 */
export async function mergeSceneRooms(
  manager: MultiplayerDynamicGameStateManager,
  sourceIds: string[],
  targetSceneName: string,
  directorAgent: DirectorAgent,
  reason = "players converged to the same location"
): Promise<SceneRoomMergeResult> {
  if (sourceIds.length === 0) {
    return { mergeOccurred: false, frozenSceneRoomIds: [], mergedChildRoom: null };
  }

  // Collect all members before freezing
  const allPlayerIds: string[] = [];
  for (const id of sourceIds) {
    const room = manager.getSceneRoom(id);
    if (room) allPlayerIds.push(...room.memberPlayerIds);
  }
  const uniquePlayerIds = [...new Set(allPlayerIds)];

  // Freeze all source rooms
  for (const id of sourceIds) {
    manager.freezeSceneRoom(id);
    console.log(`[SceneRoomMerger] mergeSceneRooms — frozen: ${id}`);
  }

  const mergedChildId = randomUUID();
  const sourceRoom = manager.getSceneRoom(sourceIds[0]);

  manager.createSceneRoom(mergedChildId, uniquePlayerIds, {
    parentSceneRoomIds: sourceIds,
    currentScenario: sourceRoom?.currentScenario ?? null,
    scenarioName: targetSceneName,
    roundNumber: 1,
    turnsInCurrentScene: 0,
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

  for (const playerId of uniquePlayerIds) {
    manager.relocatePlayerToSceneRoom(playerId, mergedChildId);
  }

  try {
    await directorAgent.handleActionDrivenSceneChange(
      manager,
      mergedChildId,
      targetSceneName,
      reason
    );
  } catch (e) {
    console.error(`[SceneRoomMerger] mergeSceneRooms transition failed:`, e);
  }

  const mergedChildRoom: ChildRoomInfo = {
    sceneRoomId: mergedChildId,
    playerIds: uniquePlayerIds,
    parentSceneRoomIds: sourceIds,
    targetSceneName,
    isStayerRoom: false,
  };

  return {
    mergeOccurred: true,
    frozenSceneRoomIds: sourceIds,
    mergedChildRoom,
  };
}
