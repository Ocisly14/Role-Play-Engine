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
import type { PlayerActionAnalysis } from "../multiplayerAgent/orchestrator/orchestratorAgent.js";
import {
  type MultiplayerDynamicGameStateManager,
  type MultiplayerSceneRoomState,
  toAbsoluteMinutes,
} from "../multiplayerState/MultiplayerDynamicGameState.js";
import type { DynamicScenarioSnapshot } from "../world_builder/types.js";

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

/** Info about a time-bubble merge (player entering an occupied active room). */
export interface TimeBubbleMergeInfo {
  enteringPlayerId: string;
  sourceSceneRoomId: string;
  /** The old target room (now frozen as a historical snapshot) */
  frozenTargetSceneRoomId: string;
  /** The new child room created from the merge */
  newChildSceneRoomId: string;
  targetSceneName: string;
}

export interface ResolveMovementsResult {
  anyChanges: boolean;
  frozenSceneRoomIds: string[];
  newChildRooms: ChildRoomInfo[];
  /** Players that joined an existing active room via time-bubble merge. */
  timeBubbleMerges: TimeBubbleMergeInfo[];
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
 * Compute the maximum gameDay/timeOfDay across a set of rooms.
 * Used when creating merged child rooms to pick the latest time.
 */
function getMaxRoomTime(
  rooms: MultiplayerSceneRoomState[]
): { gameDay: number; timeOfDay: string } {
  if (rooms.length === 0) return { gameDay: 1, timeOfDay: "08:00" };
  let maxAbs = 0;
  let result = { gameDay: rooms[0].gameDay, timeOfDay: rooms[0].timeOfDay };
  for (const room of rooms) {
    const abs = toAbsoluteMinutes(room.gameDay, room.timeOfDay);
    if (abs > maxAbs) {
      maxAbs = abs;
      result = { gameDay: room.gameDay, timeOfDay: room.timeOfDay };
    }
  }
  return result;
}

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

/**
 * Look up a pre-generated DynamicScenarioSnapshot by scene name.
 * Returns the latest snapshot for the matching scenario, or null if none found.
 */
export function findSnapshotBySceneName(
  manager: MultiplayerDynamicGameStateManager,
  targetSceneName: string
): { scenarioId: string; snapshot: DynamicScenarioSnapshot } | null {
  const state = manager.getState();
  const outline = state.scenarioOutlines.find(
    (o) => o.name.toLowerCase() === targetSceneName.toLowerCase()
  );
  if (!outline) return null;
  const snapshots = state.updatedDynamicScenarioSnapshots.get(outline.id);
  if (!snapshots || snapshots.length === 0) return null;
  return { scenarioId: outline.id, snapshot: snapshots[snapshots.length - 1] };
}

/**
 * Sync scenario clue discovered/damaged state from parent rooms into a child room.
 * When rooms merge, the child inherits the union of all parent rooms' clue states.
 */
function syncScenarioCluesFromParents(
  manager: MultiplayerDynamicGameStateManager,
  childRoomId: string,
  parentRoomIds: string[]
): void {
  const childRoom = manager.getSceneRoom(childRoomId);
  if (!childRoom?.currentScenario?.clues) return;

  const discoveredIds = new Set<string>();
  const damagedIds = new Set<string>();

  for (const parentId of parentRoomIds) {
    const parent = manager.getSceneRoom(parentId);
    if (!parent?.currentScenario?.clues) continue;
    for (const clue of parent.currentScenario.clues) {
      if (clue.discovered) discoveredIds.add(clue.id);
      if (clue.damaged) damagedIds.add(clue.id);
    }
  }

  for (const clue of childRoom.currentScenario.clues) {
    if (discoveredIds.has(clue.id) && !clue.discovered) {
      clue.discovered = true;
      clue.discoveryDetails = {
        discoveredBy: "Room merge sync",
        discoveredAt: new Date().toISOString(),
        method: "Room merge sync",
      };
    }
    if (damagedIds.has(clue.id) && !clue.damaged) {
      clue.damaged = true;
      clue.damageDetails = {
        damagedBy: "Room merge sync",
        damagedAt: new Date().toISOString(),
        reason: "Damage carried over from parent room",
      };
    }
  }
}

/**
 * Merge per-player clue/secret knowledge across all members of a child room.
 * After a room merge, every player in the room learns the union of all
 * members' revealed/damaged clue IDs — simulating knowledge sharing.
 */
function syncPlayerClueKnowledge(
  manager: MultiplayerDynamicGameStateManager,
  childRoomId: string
): void {
  const childRoom = manager.getSceneRoom(childRoomId);
  if (!childRoom) return;

  const state = manager.getState();
  const memberIds = childRoom.memberPlayerIds;
  if (memberIds.length <= 1) return;

  // Collect the union of all members' knowledge
  const unionNpcClueIds = new Set<string>();
  const unionNpcSecretKeys = new Set<string>();
  const unionScenarioClueIds = new Set<string>();
  const unionDamagedScenarioClueIds = new Set<string>();

  for (const pid of memberIds) {
    const ps = state.players[pid];
    if (!ps) continue;
    for (const id of ps.revealedNpcClueIds ?? []) unionNpcClueIds.add(id);
    for (const key of ps.revealedNpcSecretKeys ?? []) unionNpcSecretKeys.add(key);
    for (const id of ps.revealedScenarioClueIds ?? []) unionScenarioClueIds.add(id);
    for (const id of ps.damagedScenarioClueIds ?? []) unionDamagedScenarioClueIds.add(id);
  }

  // Write the union back to every member
  for (const pid of memberIds) {
    const ps = state.players[pid];
    if (!ps) continue;
    ps.revealedNpcClueIds = [...unionNpcClueIds];
    ps.revealedNpcSecretKeys = [...unionNpcSecretKeys];
    ps.revealedScenarioClueIds = [...unionScenarioClueIds];
    ps.damagedScenarioClueIds = [...unionDamagedScenarioClueIds];
  }
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
  manager: MultiplayerDynamicGameStateManager
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
    return { anyChanges: false, frozenSceneRoomIds: [], newChildRooms: [], timeBubbleMerges: [] };
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

  // ── Step 2b: Check for existing active rooms & detect time bubble merges ──
  const existingRoomIds = new Set<string>();
  const timeBubbleMerges: TimeBubbleMergeInfo[] = [];
  /** Target groups that are handled as time-bubble merges (skip normal freeze-fork for these) */
  const timeBubbleTargetKeys = new Set<string>();

  for (const [targetSceneName, group] of targetGroups) {
    const existingRoom = findActiveSceneRoomByScene(manager, targetSceneName);
    if (existingRoom) {
      // Check if this is a time-bubble merge: players entering an existing
      // occupied room (the target room has players who are NOT moving away)
      const targetHasOtherPlayers = existingRoom.memberPlayerIds.some(
        (p) => !movingPlayersSet.has(p)
      );
      const allIncomingFromDifferentRoom = group.incomingPlayerIds.every(
        (pid) => {
          const mov = movingPlayersMap.get(pid);
          return mov && mov.fromSceneRoomId !== existingRoom.sceneRoomId;
        }
      );

      if (targetHasOtherPlayers && allIncomingFromDifferentRoom) {
        // Time bubble merge: freeze both source + target, create a new child room
        timeBubbleTargetKeys.add(targetSceneName);

        // Collect all unique source rooms for these entering players
        const sourceRoomIds = [...new Set(
          group.incomingPlayerIds.map((pid) => movingPlayersMap.get(pid)!.fromSceneRoomId)
        )];

        // Freeze source rooms
        for (const srcId of sourceRoomIds) {
          const srcRoom = manager.getSceneRoom(srcId);
          if (srcRoom && !srcRoom.isFrozen) {
            manager.freezeSceneRoom(srcId);
            console.log(`[SceneRoomMerger] Time bubble: frozen source room ${srcId}`);
          }
        }

        // Freeze the target room (preserves its history as a snapshot)
        manager.freezeSceneRoom(existingRoom.sceneRoomId);
        console.log(`[SceneRoomMerger] Time bubble: frozen target room ${existingRoom.sceneRoomId}`);

        // Create new child room: all target room members + entering players
        const allChildMembers = [
          ...existingRoom.memberPlayerIds,
          ...group.incomingPlayerIds,
        ];
        const parentIds = [...new Set([...sourceRoomIds, existingRoom.sceneRoomId])];
        const newChildId = randomUUID();

        // Child inherits target room's scenario and time (the ongoing game)
        manager.createSceneRoom(newChildId, allChildMembers, {
          parentSceneRoomIds: parentIds,
          currentScenario: existingRoom.currentScenario,
          scenarioId: existingRoom.scenarioId,
          scenarioName: existingRoom.scenarioName,
          snapshotId: existingRoom.snapshotId,
          snapshotName: existingRoom.snapshotName,
          gameDay: existingRoom.gameDay,
          timeOfDay: existingRoom.timeOfDay,
          roundNumber: 1,
          turnsInCurrentScene: 0,
        });

        // Move all players to the new child room
        for (const playerId of allChildMembers) {
          manager.relocatePlayerToSceneRoom(playerId, newChildId);
        }

        // Sync discovered/damaged clue state from parent rooms
        syncScenarioCluesFromParents(manager, newChildId, parentIds);
        syncPlayerClueKnowledge(manager, newChildId);

        // Time-freeze entering players whose source time is >20 min ahead of target
        const targetAbsMin = toAbsoluteMinutes(
          existingRoom.gameDay,
          existingRoom.timeOfDay
        );
        for (const enteringPid of group.incomingPlayerIds) {
          const mov = movingPlayersMap.get(enteringPid)!;
          const srcRoom = manager.getSceneRoom(mov.fromSceneRoomId);
          if (!srcRoom) continue;
          const sourceAbsMin = toAbsoluteMinutes(
            srcRoom.gameDay,
            srcRoom.timeOfDay
          );
          if (sourceAbsMin > targetAbsMin + 20) {
            manager.freezePlayerByTime(
              newChildId,
              enteringPid,
              srcRoom.gameDay,
              srcRoom.timeOfDay
            );
            console.log(
              `[SceneRoomMerger] Time-froze player ${enteringPid} in child ${newChildId} ` +
                `(source: Day ${srcRoom.gameDay} ${srcRoom.timeOfDay}, ` +
                `target: Day ${existingRoom.gameDay} ${existingRoom.timeOfDay})`
            );
          }
        }

        console.log(
          `[SceneRoomMerger] Time bubble child ${newChildId} created: ` +
            `${allChildMembers.length} player(s) → "${targetSceneName}" ` +
            `(parents: ${parentIds.join(", ")})`
        );

        // Record time bubble merge info for each entering player
        for (const enteringPlayerId of group.incomingPlayerIds) {
          const mov = movingPlayersMap.get(enteringPlayerId)!;
          timeBubbleMerges.push({
            enteringPlayerId,
            sourceSceneRoomId: mov.fromSceneRoomId,
            frozenTargetSceneRoomId: existingRoom.sceneRoomId,
            newChildSceneRoomId: newChildId,
            targetSceneName,
          });
        }

        continue; // skip normal existingRoom handling for this target
      }

      // Normal merge: freeze the existing room too
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
  // Include rooms already frozen by time-bubble handling
  for (const tbm of timeBubbleMerges) {
    frozenSceneRoomIdsSet.add(tbm.sourceSceneRoomId);
    frozenSceneRoomIdsSet.add(tbm.frozenTargetSceneRoomId);
  }

  // Remove target groups that are time-bubble merges from normal processing
  for (const key of timeBubbleTargetKeys) {
    targetGroups.delete(key);
  }

  // Collect time-bubble child rooms into newChildRooms
  const timeBubbleChildRooms: ChildRoomInfo[] = [];
  // Deduplicate: multiple entering players may share the same newChildSceneRoomId
  const seenTimeBubbleChildren = new Set<string>();
  for (const tbm of timeBubbleMerges) {
    if (seenTimeBubbleChildren.has(tbm.newChildSceneRoomId)) continue;
    seenTimeBubbleChildren.add(tbm.newChildSceneRoomId);
    const childRoom = manager.getSceneRoom(tbm.newChildSceneRoomId);
    if (childRoom) {
      timeBubbleChildRooms.push({
        sceneRoomId: tbm.newChildSceneRoomId,
        playerIds: [...childRoom.memberPlayerIds],
        parentSceneRoomIds: [...childRoom.parentSceneRoomIds],
        targetSceneName: tbm.targetSceneName,
        isStayerRoom: false,
      });
    }
  }

  // Also create stayer child rooms for source rooms that still have remaining players
  for (const tbm of timeBubbleMerges) {
    const srcRoom = manager.getSceneRoom(tbm.sourceSceneRoomId);
    if (!srcRoom || !srcRoom.isFrozen) continue;
    const stayers = srcRoom.memberPlayerIds.filter((p) => !movingPlayersSet.has(p));
    if (stayers.length === 0) continue;
    // Check if we already created a stayer child for this source room
    if (timeBubbleChildRooms.some(
      (c) => c.isStayerRoom && c.parentSceneRoomIds.includes(tbm.sourceSceneRoomId)
    )) continue;

    const stayerChildId = randomUUID();
    manager.createSceneRoom(stayerChildId, stayers, {
      parentSceneRoomIds: [tbm.sourceSceneRoomId],
      currentScenario: srcRoom.currentScenario,
      scenarioId: srcRoom.scenarioId,
      scenarioName: srcRoom.scenarioName,
      snapshotId: srcRoom.snapshotId,
      snapshotName: srcRoom.snapshotName,
      gameDay: srcRoom.gameDay,
      timeOfDay: srcRoom.timeOfDay,
      roundNumber: 1,
      turnsInCurrentScene: 0,
    });
    for (const stayerId of stayers) {
      manager.relocatePlayerToSceneRoom(stayerId, stayerChildId);
    }
    timeBubbleChildRooms.push({
      sceneRoomId: stayerChildId,
      playerIds: stayers,
      parentSceneRoomIds: [tbm.sourceSceneRoomId],
      targetSceneName: null,
      isStayerRoom: true,
    });
  }

  // If only time-bubble merges remain (no normal splits), return early
  if (targetGroups.size === 0 && timeBubbleMerges.length > 0) {
    // Clear stale data from frozen rooms
    for (const roomId of frozenSceneRoomIdsSet) {
      const room = manager.getSceneRoom(roomId);
      if (room?.temporaryInfo.contextualData?.playerActionAnalyses) {
        manager.setContextualData(roomId, "playerActionAnalyses", undefined);
      }
    }

    return {
      anyChanges: true,
      frozenSceneRoomIds: [...frozenSceneRoomIdsSet],
      newChildRooms: timeBubbleChildRooms,
      timeBubbleMerges,
    };
  }

  // ── Step 4: Freeze all affected rooms ──
  for (const roomId of frozenSceneRoomIdsSet) {
    const room = manager.getSceneRoom(roomId);
    if (room && !room.isFrozen) {
      manager.freezeSceneRoom(roomId);
      console.log(`[SceneRoomMerger] Frozen sceneRoom: ${roomId}`);
    }
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
      gameDay: room.gameDay,
      timeOfDay: room.timeOfDay,
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

    // Compute max time across all parent rooms for the merged child
    const parentRooms = parentIds
      .map((id) => manager.getSceneRoom(id))
      .filter((r): r is MultiplayerSceneRoomState => r != null);
    const maxTime = getMaxRoomTime(parentRooms);

    const mergedChildId = randomUUID();
    const sourceRoom = manager.getSceneRoom(group.fromSceneRoomIds[0]);

    manager.createSceneRoom(mergedChildId, allMemberIds, {
      parentSceneRoomIds: parentIds,
      currentScenario: sourceRoom?.currentScenario ?? null,
      scenarioName: targetSceneName,
      gameDay: maxTime.gameDay,
      timeOfDay: maxTime.timeOfDay,
      roundNumber: 1,
      turnsInCurrentScene: 0,
    });

    for (const playerId of allMemberIds) {
      manager.relocatePlayerToSceneRoom(playerId, mergedChildId);
    }

    const parentCount = parentIds.length;
    console.log(
      `[SceneRoomMerger] Merged child ${mergedChildId} created for ` +
        `${allMemberIds.length} player(s) → "${targetSceneName}" ` +
        `(${parentCount} parent${parentCount > 1 ? "s" : ""}, ` +
        `time: Day ${maxTime.gameDay}, ${maxTime.timeOfDay})`
    );

    // Look up pre-generated snapshot and set as current scenario
    const found = findSnapshotBySceneName(manager, targetSceneName);
    if (found) {
      manager.updateCurrentScenario(mergedChildId, {
        snapshot: found.snapshot,
        scenarioName: targetSceneName,
        scenarioId: found.scenarioId,
      });
      console.log(
        `[SceneRoomMerger] Scene transition complete → "${targetSceneName}"`
      );
    } else {
      console.warn(
        `[SceneRoomMerger] No pre-generated snapshot found for "${targetSceneName}"`
      );
    }

    // Sync discovered/damaged clue state from parent rooms
    syncScenarioCluesFromParents(manager, mergedChildId, parentIds);
    syncPlayerClueKnowledge(manager, mergedChildId);

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
    timeBubbleMerges,
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

  // Compute max time across all source rooms
  const sourceRooms = sourceIds
    .map((id) => manager.getSceneRoom(id))
    .filter((r): r is MultiplayerSceneRoomState => r != null);
  const maxTime = getMaxRoomTime(sourceRooms);

  const mergedChildId = randomUUID();
  const sourceRoom = manager.getSceneRoom(sourceIds[0]);

  manager.createSceneRoom(mergedChildId, uniquePlayerIds, {
    parentSceneRoomIds: sourceIds,
    currentScenario: sourceRoom?.currentScenario ?? null,
    scenarioName: targetSceneName,
    gameDay: maxTime.gameDay,
    timeOfDay: maxTime.timeOfDay,
    roundNumber: 1,
    turnsInCurrentScene: 0,
  });

  for (const playerId of uniquePlayerIds) {
    manager.relocatePlayerToSceneRoom(playerId, mergedChildId);
  }

  // Look up pre-generated snapshot and set as current scenario
  const found = findSnapshotBySceneName(manager, targetSceneName);
  if (found) {
    manager.updateCurrentScenario(mergedChildId, {
      snapshot: found.snapshot,
      scenarioName: targetSceneName,
      scenarioId: found.scenarioId,
    });
  } else {
    console.warn(
      `[SceneRoomMerger] mergeSceneRooms — no pre-generated snapshot for "${targetSceneName}"`
    );
  }

  // Sync discovered/damaged clue state from parent rooms
  syncScenarioCluesFromParents(manager, mergedChildId, sourceIds);
  syncPlayerClueKnowledge(manager, mergedChildId);

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
