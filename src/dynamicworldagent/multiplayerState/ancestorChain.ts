/**
 * Ancestor Chain Utility
 * Walks the parentSceneRoomIds tree to collect the full ancestor chain for a scene room.
 * Used by memory agent and orchestrator to query history across frozen parent rooms.
 */

import type { MultiplayerDynamicGameStateManager } from "./MultiplayerDynamicGameState.js";

/**
 * BFS walk of parentSceneRoomIds from the current room.
 * Returns [currentId, ...parentIds, ...grandparentIds, ...].
 * Safety cap at 20 iterations to prevent cycles.
 * For root rooms (no parents), returns [currentId].
 */
export function getAncestorSceneRoomIds(
  manager: MultiplayerDynamicGameStateManager,
  sceneRoomId: string
): string[] {
  const visited = new Set<string>();
  const queue: string[] = [sceneRoomId];
  const result: string[] = [];

  const MAX_ITERATIONS = 20;
  let iterations = 0;

  while (queue.length > 0 && iterations < MAX_ITERATIONS) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    result.push(current);
    iterations++;

    const room = manager.getSceneRoom(current);
    if (!room) continue;

    for (const parentId of room.parentSceneRoomIds) {
      if (!visited.has(parentId)) {
        queue.push(parentId);
      }
    }
  }

  return result;
}
