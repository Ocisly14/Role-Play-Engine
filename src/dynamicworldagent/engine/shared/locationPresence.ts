import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type {
  CharacterPosition,
  JunctionNode,
  RoadNode,
} from "../../state/topologyTypes.js";

export const ROAD_COPRESENCE_THRESHOLD_MINUTES = 2;

function roundTravelMinutes(minutes: number): number {
  return Math.max(0, Math.round(minutes));
}

function getRoad(position: CharacterPosition, dgsm: DynamicGameStateManager): RoadNode | null {
  if (position.type !== "road") return null;
  return dgsm.getState().roads?.get(position.roadId) ?? null;
}

function getJunctionName(
  junctionId: string,
  dgsm: DynamicGameStateManager
): string {
  const junction = dgsm.getState().junctions.get(junctionId) as JunctionNode | undefined;
  return junction?.name ?? junctionId;
}

export function isCharacterAtLocation(
  position: CharacterPosition | null | undefined,
  locationId: string
): boolean {
  if (!position) return false;

  switch (position.type) {
    case "scene":
      return position.sceneId === locationId;
    case "junction":
      return position.junctionId === locationId;
    case "road":
      return position.roadId === locationId;
  }
}

export function getRoadDistanceMinutesBetweenPositions(
  a: CharacterPosition | null | undefined,
  b: CharacterPosition | null | undefined,
  dgsm: DynamicGameStateManager
): number | null {
  if (!a || !b || a.type !== "road" || b.type !== "road") return null;
  if (a.roadId !== b.roadId) return null;

  const road = getRoad(a, dgsm);
  if (!road) return null;

  return Math.abs(a.position - b.position) * road.travelTimeMinutes;
}

export function arePositionsCoLocated(
  a: CharacterPosition | null | undefined,
  b: CharacterPosition | null | undefined,
  dgsm: DynamicGameStateManager,
  roadThresholdMinutes = ROAD_COPRESENCE_THRESHOLD_MINUTES
): boolean {
  if (!a || !b) return false;

  if (a.type === "scene" && b.type === "scene") {
    return a.sceneId === b.sceneId;
  }

  if (a.type === "junction" && b.type === "junction") {
    return a.junctionId === b.junctionId;
  }

  if (a.type === "road" && b.type === "road" && a.roadId === b.roadId) {
    const distanceMinutes = getRoadDistanceMinutesBetweenPositions(a, b, dgsm);
    return distanceMinutes !== null && distanceMinutes <= roadThresholdMinutes;
  }

  return false;
}

export function describePrecisePosition(
  position: CharacterPosition | null | undefined,
  dgsm: DynamicGameStateManager
): string {
  if (!position) return "Unknown.";

  switch (position.type) {
    case "scene": {
      const scene = dgsm.getScene(position.sceneId);
      return `Inside ${scene?.name ?? position.sceneId}.`;
    }
    case "junction":
      return `At ${getJunctionName(position.junctionId, dgsm)}.`;
    case "road": {
      const road = getRoad(position, dgsm);
      if (!road) return `On ${position.roadId}.`;

      const minutesFromA = roundTravelMinutes(position.position * road.travelTimeMinutes);
      const minutesFromB = roundTravelMinutes(
        (1 - position.position) * road.travelTimeMinutes
      );

      return `On ${road.name}, about ${minutesFromA} minute(s) from ${getJunctionName(
        road.endpointA,
        dgsm
      )} and ${minutesFromB} minute(s) from ${getJunctionName(
        road.endpointB,
        dgsm
      )}.`;
    }
  }
}
