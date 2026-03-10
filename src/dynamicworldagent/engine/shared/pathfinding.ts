import type { DynamicScene, TransportEdge } from "../../world_builder/types.js";
import type { CharacterPosition, TownTopology } from "../../world_builder/topologyTypes.js";

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

// ===== Topology-aware pathfinding (Junction-Road graph) =====

/** A step in a topology path */
export interface TopologyPathStep {
  type: "road" | "enter_scene" | "exit_scene" | "junction";
  id: string;
  /** Travel time for this step in minutes */
  minutes: number;
}

/** Result of topology pathfinding */
export interface TopologyPath {
  steps: TopologyPathStep[];
  totalMinutes: number;
}

/** Internal: entry/exit info for resolving a CharacterPosition to junction(s) */
interface JunctionEntry {
  junctionId: string;
  initialSteps: TopologyPathStep[];
  initialMinutes: number;
  finalSteps: TopologyPathStep[];
  finalMinutes: number;
}

/**
 * BFS pathfinding on the Junction-Road topology graph.
 * Supports starting/ending at junctions, roads (with position), or scenes.
 */
export function findTopologyPath(
  from: CharacterPosition,
  to: CharacterPosition,
  topology: TownTopology,
  blockedConnections: Map<string, string>
): TopologyPath | null {
  const startInfo = resolveToJunctions(from, topology);
  const endInfo = resolveToJunctions(to, topology);

  if (!startInfo || !endInfo) return null;

  // Same location check
  if (positionsEqual(from, to)) {
    return { steps: [], totalMinutes: 0 };
  }

  // BFS on junctions
  const visited = new Set<string>();
  const queue: Array<{
    junctionId: string;
    steps: TopologyPathStep[];
    minutes: number;
  }> = [];

  // Seed queue with start junction(s)
  for (const entry of startInfo) {
    queue.push({
      junctionId: entry.junctionId,
      steps: entry.initialSteps,
      minutes: entry.initialMinutes,
    });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.junctionId)) continue;
    visited.add(current.junctionId);

    // Check if we reached any end junction
    for (const end of endInfo) {
      if (current.junctionId === end.junctionId) {
        const finalSteps = [...current.steps, ...end.finalSteps];
        const finalMinutes = current.minutes + end.finalMinutes;
        return { steps: finalSteps, totalMinutes: finalMinutes };
      }
    }

    // Expand: find all roads connected to this junction
    const roads = topology.junctionToRoads.get(current.junctionId) ?? [];
    for (const road of roads) {
      const otherJunctionId = road.endpointA === current.junctionId
        ? road.endpointB
        : road.endpointA;

      if (visited.has(otherJunctionId)) continue;

      // Topology blocking uses "junctionId::roadId" format.
      // This is separate from old-style "sceneA::sceneB" blocking which is used by legacy BFS.
      const key1 = `${current.junctionId}::${road.id}`;
      const key2 = `${road.id}::${current.junctionId}`;
      if (blockedConnections.has(key1) || blockedConnections.has(key2)) continue;

      const roadStep: TopologyPathStep = {
        type: "road",
        id: road.id,
        minutes: road.travelTimeMinutes,
      };

      queue.push({
        junctionId: otherJunctionId,
        steps: [...current.steps, roadStep],
        minutes: current.minutes + road.travelTimeMinutes,
      });
    }
  }

  return null;
}

/** Resolve a CharacterPosition to reachable junction(s) with initial travel cost */
function resolveToJunctions(
  pos: CharacterPosition,
  topology: TownTopology
): JunctionEntry[] | null {
  switch (pos.type) {
    case "junction":
      return [{
        junctionId: pos.junctionId,
        initialSteps: [],
        initialMinutes: 0,
        finalSteps: [],
        finalMinutes: 0,
      }];

    case "road": {
      const road = topology.roads.get(pos.roadId);
      if (!road) return null;
      const toA = pos.position * road.travelTimeMinutes;
      const toB = (1 - pos.position) * road.travelTimeMinutes;
      return [
        {
          junctionId: road.endpointA,
          initialSteps: [{ type: "road", id: road.id, minutes: toA }],
          initialMinutes: toA,
          finalSteps: [{ type: "road", id: road.id, minutes: toA }],
          finalMinutes: toA,
        },
        {
          junctionId: road.endpointB,
          initialSteps: [{ type: "road", id: road.id, minutes: toB }],
          initialMinutes: toB,
          finalSteps: [{ type: "road", id: road.id, minutes: toB }],
          finalMinutes: toB,
        },
      ];
    }

    case "scene": {
      const parent = topology.sceneToParent.get(pos.sceneId);
      if (!parent) return null;

      if (parent.type === "junction") {
        return [{
          junctionId: parent.junctionId,
          initialSteps: [{ type: "exit_scene", id: pos.sceneId, minutes: 1 }],
          initialMinutes: 1,
          finalSteps: [{ type: "enter_scene", id: pos.sceneId, minutes: 1 }],
          finalMinutes: 1,
        }];
      }

      // Scene on a road — can reach either junction
      const road = topology.roads.get(parent.roadId);
      if (!road) return null;
      const toA = parent.position * road.travelTimeMinutes;
      const toB = (1 - parent.position) * road.travelTimeMinutes;
      return [
        {
          junctionId: road.endpointA,
          initialSteps: [
            { type: "exit_scene", id: pos.sceneId, minutes: 1 },
            { type: "road", id: road.id, minutes: toA },
          ],
          initialMinutes: 1 + toA,
          finalSteps: [
            { type: "road", id: road.id, minutes: toA },
            { type: "enter_scene", id: pos.sceneId, minutes: 1 },
          ],
          finalMinutes: 1 + toA,
        },
        {
          junctionId: road.endpointB,
          initialSteps: [
            { type: "exit_scene", id: pos.sceneId, minutes: 1 },
            { type: "road", id: road.id, minutes: toB },
          ],
          initialMinutes: 1 + toB,
          finalSteps: [
            { type: "road", id: road.id, minutes: toB },
            { type: "enter_scene", id: pos.sceneId, minutes: 1 },
          ],
          finalMinutes: 1 + toB,
        },
      ];
    }
  }
}

function positionsEqual(a: CharacterPosition, b: CharacterPosition): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "junction": return a.junctionId === (b as typeof a).junctionId;
    case "road": return a.roadId === (b as typeof a).roadId && a.position === (b as typeof a).position;
    case "scene": return a.sceneId === (b as typeof a).sceneId;
  }
}
