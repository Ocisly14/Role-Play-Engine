import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { TransportEdge } from "../../state/types.js";
import type { ReferencedEntity } from "../core/types.js";
import { arePositionsCoLocated } from "./locationPresence.js";

/**
 * Minimal action shape consumed by impact propagation. Engine-core and legacy
 * CharacterAction shapes both satisfy this contract: they expose `characterId`
 * + `referencedEntities` directly, and `location` is filled from `sceneId`
 * (engine-core) or read directly (legacy).
 */
interface ImpactPropagationAction {
  characterId: string;
  referencedEntities?: ReferencedEntity[];
  location: string;
}

const NEIGHBORHOOD_TRAVEL_MINUTES = 15;

function findNeighborMacroLocations(
  fromLocationId: string,
  transportEdges: TransportEdge[],
  maxTravelMinutes: number
): string[] {
  const visited = new Map<string, number>();
  visited.set(fromLocationId, 0);
  const queue: Array<{ locationId: string; travelTime: number }> = [
    { locationId: fromLocationId, travelTime: 0 },
  ];
  while (queue.length > 0) {
    const { locationId, travelTime } = queue.shift()!;
    for (const edge of transportEdges) {
      let neighbor: string | null = null;
      if (edge.fromLocationId === locationId) neighbor = edge.toLocationId;
      else if (edge.toLocationId === locationId) neighbor = edge.fromLocationId;
      if (!neighbor) continue;
      const newTime = travelTime + edge.travelTimeMinutes;
      if (newTime > maxTravelMinutes) continue;
      if (visited.has(neighbor) && visited.get(neighbor)! <= newTime) continue;
      visited.set(neighbor, newTime);
      queue.push({ locationId: neighbor, travelTime: newTime });
    }
  }
  visited.delete(fromLocationId);
  return [...visited.keys()];
}

function getParentLocationId(
  sceneId: string,
  dgsm: DynamicGameStateManager
): string | null {
  const scene = dgsm.getScene(sceneId);
  return scene?.parentLocationId ?? null;
}

/**
 * Find all characters affected by an action at a given impact level.
 * Returns Map<characterId, perceivedImpactLevel>.
 * Excludes the acting character itself.
 */
export function findAffectedCharacters(
  action: ImpactPropagationAction,
  impactLevel: number,
  dgsm: DynamicGameStateManager
): Map<string, number> {
  const state = dgsm.getState();

  const result = new Map<string, number>();

  const addChar = (charId: string, level: number) => {
    if (charId === action.characterId) return;
    if (!dgsm.isNpcAlive(charId)) return;
    const existing = result.get(charId);
    if (existing === undefined || level > existing) {
      result.set(charId, level);
    }
  };

  const allCharacterIds = state.npcCharacters
    .map((n) => n.id)
    .filter((id) => dgsm.isNpcAlive(id));

  const getCharPosition = (charId: string) => {
    return dgsm.getCharacterPosition(charId);
  };

  const getCharLocation = (charId: string): string | undefined => {
    const pos = dgsm.getCharacterPosition(charId);
    return pos ? dgsm.resolveLocationId(pos) : undefined;
  };

  // Level 1: targeted (character entities only)
  if (impactLevel >= 1 && action.referencedEntities?.length) {
    for (const ref of action.referencedEntities) {
      if (ref.kind === "character") {
        addChar(ref.id, 1);
      }
    }
  }

  // Level 2: same sub-scene
  if (impactLevel >= 2) {
    const sourcePos = getCharPosition(action.characterId);
    if (sourcePos) {
      for (const charId of allCharacterIds) {
        if (arePositionsCoLocated(sourcePos, getCharPosition(charId), dgsm)) {
          addChar(charId, 2);
        }
      }
    } else {
      for (const charId of allCharacterIds) {
        if (getCharLocation(charId) === action.location) {
          addChar(charId, 2);
        }
      }
    }
  }

  // Level 3: same macro location
  if (impactLevel >= 3) {
    const eventParent = getParentLocationId(action.location, dgsm);
    if (eventParent) {
      for (const charId of allCharacterIds) {
        const charLoc = getCharLocation(charId);
        if (charLoc && getParentLocationId(charLoc, dgsm) === eventParent) {
          addChar(charId, 3);
        }
      }
    }
  }

  // Level 4: neighborhood
  if (impactLevel >= 4) {
    const eventParent = getParentLocationId(action.location, dgsm);
    if (eventParent && state.transportEdges) {
      const neighbors = findNeighborMacroLocations(
        eventParent,
        state.transportEdges,
        NEIGHBORHOOD_TRAVEL_MINUTES
      );
      for (const charId of allCharacterIds) {
        const charLoc = getCharLocation(charId);
        if (charLoc) {
          const charParent = getParentLocationId(charLoc, dgsm);
          if (charParent && neighbors.includes(charParent)) {
            addChar(charId, 4);
          }
        }
      }
    }
  }

  // Level 5: global
  if (impactLevel >= 5) {
    for (const charId of allCharacterIds) {
      addChar(charId, 5);
    }
  }

  return result;
}

/**
 * Find all scene IDs affected by an event at a given scope level.
 */
export function findAffectedScenes(
  sourceSceneId: string,
  scopeLevel: number,
  dgsm: DynamicGameStateManager
): string[] {
  const state = dgsm.getState();
  const scenes = new Set<string>();

  // Level 2: same scene
  if (scopeLevel >= 2) {
    scenes.add(sourceSceneId);
  }

  // Level 3: same macro location
  if (scopeLevel >= 3) {
    const parent = getParentLocationId(sourceSceneId, dgsm);
    if (parent) {
      for (const [id, scene] of state.scenes) {
        if (scene.parentLocationId === parent) scenes.add(id);
      }
      for (const [id, junc] of state.junctions) {
        if (junc.parentLocationId === parent) scenes.add(id);
      }
      for (const [id, road] of state.roads) {
        if (road.parentLocationId === parent) scenes.add(id);
      }
    }
  }

  // Level 4: neighborhood
  if (scopeLevel >= 4) {
    const parent = getParentLocationId(sourceSceneId, dgsm);
    if (parent && state.transportEdges) {
      const neighbors = findNeighborMacroLocations(
        parent,
        state.transportEdges,
        NEIGHBORHOOD_TRAVEL_MINUTES
      );
      for (const [id, scene] of state.scenes) {
        if (
          scene.parentLocationId &&
          neighbors.includes(scene.parentLocationId)
        ) {
          scenes.add(id);
        }
      }
      for (const [id, junc] of state.junctions) {
        if (
          junc.parentLocationId &&
          neighbors.includes(junc.parentLocationId)
        ) {
          scenes.add(id);
        }
      }
      for (const [id, road] of state.roads) {
        if (
          road.parentLocationId &&
          neighbors.includes(road.parentLocationId)
        ) {
          scenes.add(id);
        }
      }
    }
  }

  // Level 5: global
  if (scopeLevel >= 5) {
    for (const id of state.scenes.keys()) {
      scenes.add(id);
    }
    for (const id of state.junctions.keys()) {
      scenes.add(id);
    }
    for (const id of state.roads.keys()) {
      scenes.add(id);
    }
  }

  return [...scenes];
}
