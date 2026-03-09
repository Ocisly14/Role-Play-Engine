import type { DynamicScene, TransportEdge } from "../../world_builder/types.js";

/**
 * BFS pathfinding between sub-scenes.
 * Returns ordered scene IDs [from, hop1, ..., to], or null if unreachable.
 */
export function findPath(
  fromSceneId: string,
  toSceneId: string,
  scenes: Map<string, DynamicScene>,
  blockedConnections: Map<string, string>
): string[] | null {
  if (fromSceneId === toSceneId) return [fromSceneId];

  const visited = new Set<string>();
  const queue: Array<{ sceneId: string; path: string[] }> = [
    { sceneId: fromSceneId, path: [fromSceneId] },
  ];

  while (queue.length > 0) {
    const { sceneId, path } = queue.shift()!;
    if (visited.has(sceneId)) continue;
    visited.add(sceneId);

    const scene = scenes.get(sceneId);
    if (!scene) continue;

    for (const connId of scene.connections) {
      if (visited.has(connId)) continue;

      const key1 = `${sceneId}::${connId}`;
      const key2 = `${connId}::${sceneId}`;
      if (blockedConnections.has(key1) || blockedConnections.has(key2)) continue;

      const newPath = [...path, connId];
      if (connId === toSceneId) return newPath;
      queue.push({ sceneId: connId, path: newPath });
    }
  }

  return null;
}

/**
 * Calculate total travel time for a path in minutes.
 * Internal hops (same parentLocationId) = 1 min each.
 * Cross-location hops use TransportEdge travel times.
 */
export function calculateTravelTime(
  path: string[],
  scenes: Map<string, DynamicScene>,
  transportEdges: TransportEdge[]
): number {
  let totalMinutes = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const from = scenes.get(path[i]);
    const to = scenes.get(path[i + 1]);
    if (!from || !to) continue;

    if (from.parentLocationId === to.parentLocationId) {
      totalMinutes += 1;
    } else {
      const edge = transportEdges.find(
        (e) =>
          (e.streetSceneId === from.id || e.streetSceneId === to.id) &&
          ((e.fromLocationId === from.parentLocationId && e.toLocationId === to.parentLocationId) ||
           (e.fromLocationId === to.parentLocationId && e.toLocationId === from.parentLocationId))
      );
      totalMinutes += edge?.travelTimeMinutes ?? 5;
    }
  }
  return totalMinutes;
}
