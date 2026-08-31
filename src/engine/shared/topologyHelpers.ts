import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { TownTopology } from "../../state/topologyTypes.js";

/**
 * Returns true if the given location ID is a road in the topology.
 */
export function isRoadId(locationId: string, topology: TownTopology): boolean {
  return topology.roads.has(locationId);
}

/**
 * Returns adjacent location IDs for a given location in the topology.
 *
 * - Attached scene → parent node scene or road (via sceneToParent)
 * - Road → endpoint node scenes + along-road scenes
 * - Node scene → incident roads + attached scenes
 *
 * Returns an empty array if the locationId is not found in the topology.
 */
export function getTopologyNeighbors(
  locationId: string,
  topology: TownTopology
): string[] {
  // Check if it's an attached scene (in sceneToParent)
  const parentInfo = topology.sceneToParent.get(locationId);
  if (parentInfo) {
    if (parentInfo.type === "scene") {
      return [parentInfo.sceneId];
    }
    // type === "road"
    return [parentInfo.roadId];
  }

  // Check if it's a road
  const road = topology.roads.get(locationId);
  if (road) {
    const neighbors: string[] = [road.endpointA, road.endpointB];
    for (const along of road.alongConnections) {
      neighbors.push(along.sceneId);
    }
    return neighbors;
  }

  // Check if it's a node scene
  if (topology.nodeSceneIds.has(locationId)) {
    const neighbors: string[] = [];
    // Incident roads
    for (const r of topology.sceneToRoads.get(locationId) ?? []) {
      neighbors.push(r.id);
    }
    // Attached scenes
    for (const [sceneId, parent] of topology.sceneToParent) {
      if (parent.type === "scene" && parent.sceneId === locationId) {
        neighbors.push(sceneId);
      }
    }
    return neighbors;
  }

  return [];
}

/**
 * Resolve a character's current location ID from the game state manager.
 *
 * Uses `dgsm.getCharacterPosition()` → `dgsm.resolveLocationId()`.
 *
 * Returns undefined if no location can be determined.
 */
export function resolveCharacterLocationId(
  characterId: string,
  dgsm: DynamicGameStateManager
): string | undefined {
  const position = dgsm.getCharacterPosition(characterId);
  if (!position) return undefined;
  return dgsm.resolveLocationId(position);
}
