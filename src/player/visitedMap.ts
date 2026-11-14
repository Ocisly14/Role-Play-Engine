import type { CharacterPosition } from "../state/topologyTypes.js";

export interface VisitedMap {
  /** sceneId -> first arrival gameDateTime */
  scenes: Record<string, string>;
  /** roadId -> first full traversal gameDateTime */
  roads: Record<string, string>;
  lastSceneId?: string;
  roadEntry?: { roadId: string; fromSceneId: string };
}

export interface VisitTopology {
  road(id: string): { endpointA: string; endpointB: string } | null;
  roadsBetween(a: string, b: string): string[];
}

export function emptyVisited(): VisitedMap {
  return { scenes: {}, roads: {} };
}

function otherEnd(
  road: { endpointA: string; endpointB: string },
  from: string
): string | null {
  if (road.endpointA === from) return road.endpointB;
  if (road.endpointB === from) return road.endpointA;
  return null;
}

function withScene(v: VisitedMap, id: string, t: string): VisitedMap {
  return id in v.scenes ? v : { ...v, scenes: { ...v.scenes, [id]: t } };
}

function withRoad(v: VisitedMap, id: string, t: string): VisitedMap {
  return id in v.roads ? v : { ...v, roads: { ...v.roads, [id]: t } };
}

/**
 * Fold one observed position into the visited map. Returns the same object
 * reference when nothing changed.
 */
export function recordPosition(
  v: VisitedMap,
  pos: CharacterPosition | null,
  topo: VisitTopology,
  gameDateTime: string
): VisitedMap {
  if (!pos) return v;

  if (pos.type === "scene") {
    const sceneId = pos.sceneId;
    let next = withScene(v, sceneId, gameDateTime);
    const entry = v.roadEntry;
    if (entry) {
      // Road fully walked only if we arrive at the far endpoint.
      const road = topo.road(entry.roadId);
      const far = road ? otherEnd(road, entry.fromSceneId) : null;
      if (far !== null && far === sceneId) {
        next = withRoad(next, entry.roadId, gameDateTime);
      }
    } else if (v.lastSceneId && v.lastSceneId !== sceneId) {
      // Jumped between scenes without being seen on a road: only an
      // unambiguous single connecting road counts as walked.
      const roads = topo.roadsBetween(v.lastSceneId, sceneId);
      if (roads.length === 1) next = withRoad(next, roads[0], gameDateTime);
    }
    if (next.roadEntry) {
      const { roadEntry: _drop, ...rest } = next;
      next = rest;
    }
    if (next.lastSceneId !== sceneId) next = { ...next, lastSceneId: sceneId };
    return next;
  }

  // On a road.
  const entry = v.roadEntry;
  if (entry && entry.roadId === pos.roadId) return v;

  const road = topo.road(pos.roadId);
  if (entry) {
    // Switched roads within one tick, crossing the shared node.
    const prev = topo.road(entry.roadId);
    const node = prev ? otherEnd(prev, entry.fromSceneId) : null;
    if (prev && node !== null && road && otherEnd(road, node) !== null) {
      let next = withScene(v, node, gameDateTime);
      next = withRoad(next, entry.roadId, gameDateTime);
      return {
        ...next,
        lastSceneId: node,
        roadEntry: { roadId: pos.roadId, fromSceneId: node },
      };
    }
    // Not a clean hand-over: forget the entry.
    const { roadEntry: _drop, ...rest } = v;
    return rest;
  }

  // Stepping onto a road from the last scene we stood in.
  if (road && v.lastSceneId && otherEnd(road, v.lastSceneId) !== null) {
    return {
      ...v,
      roadEntry: { roadId: pos.roadId, fromSceneId: v.lastSceneId },
    };
  }
  return v;
}
