import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { TownTopology } from "../../state/topologyTypes.js";

/**
 * Returns true if the given location ID is a road in the topology.
 */
export function isRoadId(locationId: string, topology: TownTopology): boolean {
  return topology.roads.has(locationId);
}

/**
 * Returns true if the given location ID is a junction in the topology.
 */
export function isJunctionId(
  locationId: string,
  topology: TownTopology
): boolean {
  return topology.junctions.has(locationId);
}

/**
 * Returns adjacent location IDs for a given location in the topology.
 *
 * - Scene → parent road or junction (via sceneToParent)
 * - Road → endpoint junctions + along-road scenes
 * - Junction → connected roads + connected scenes
 *
 * Returns an empty array if the locationId is not found in the topology.
 */
export function getTopologyNeighbors(
  locationId: string,
  topology: TownTopology
): string[] {
  // Check if it's a scene (in sceneToParent)
  const parentInfo = topology.sceneToParent.get(locationId);
  if (parentInfo) {
    if (parentInfo.type === "junction") {
      return [parentInfo.junctionId];
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

  // Check if it's a junction
  const junction = topology.junctions.get(locationId);
  if (junction) {
    const neighbors: string[] = [];
    // Connected roads
    const roads = topology.junctionToRoads.get(locationId) ?? [];
    for (const r of roads) {
      neighbors.push(r.id);
    }
    // Connected scenes
    for (const sceneId of junction.connectedSceneIds) {
      neighbors.push(sceneId);
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
