import type { MovementStep } from "../../dynamicBasicAgent/npcPlanning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { hasBlockedConnection } from "../../state/blockedConnections.js";
import type {
  CharacterPosition,
  RoadNode,
  TownTopology,
} from "../../state/topologyTypes.js";

/**
 * If a scene is not in sceneToParent (interior sub-scene),
 * find its building's entry scene which IS in the topology.
 */
function resolveToEntryScene(
  sceneId: string,
  topology: TownTopology,
  dgsm?: DynamicGameStateManager
): string | null {
  if (topology.sceneToParent.has(sceneId)) return sceneId;
  if (!dgsm) return null;
  const state = dgsm.getState();
  const scene = state.scenes.get(sceneId);
  if (!scene) return null;
  const outline = (state.scenarioOutlines ?? []).find(
    (o) => o.id === scene.parentLocationId
  );
  if (
    outline?.entrySceneId &&
    topology.sceneToParent.has(outline.entrySceneId)
  ) {
    return outline.entrySceneId;
  }
  return null;
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

interface RouteJunctionEntry {
  junctionId: string;
  transitionSteps: MovementStep[];
  transitionMinutes: number;
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
  blockedConnections: Map<string, string>,
  dgsm?: DynamicGameStateManager
): TopologyPath | null {
  // Same location check
  if (positionsEqual(from, to)) {
    return { steps: [], totalMinutes: 0 };
  }

  const startInfo = resolveToJunctions(
    from,
    topology,
    blockedConnections,
    dgsm
  );
  const endInfo = resolveToJunctions(to, topology, blockedConnections, dgsm);

  if (!startInfo || !endInfo) return null;

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
      const otherJunctionId =
        road.endpointA === current.junctionId ? road.endpointB : road.endpointA;

      if (visited.has(otherJunctionId)) continue;

      if (
        hasBlockedConnection(
          blockedConnections,
          { type: "junction", id: current.junctionId },
          { type: "road", id: road.id }
        )
      ) {
        continue;
      }

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

export function buildMovementRouteIgnoringBlocks(
  from: CharacterPosition,
  to: CharacterPosition,
  topology: TownTopology,
  dgsm?: DynamicGameStateManager
): { steps: MovementStep[]; totalMinutes: number } | null {
  if (positionsEqual(from, to)) {
    return { steps: [], totalMinutes: 0 };
  }

  const startEntries = resolveToRouteJunctions(from, topology, dgsm);
  const endEntries = resolveToRouteJunctionsFromTarget(to, topology);
  if (!startEntries || !endEntries) return null;

  let bestRoute:
    | {
        startEntry: RouteJunctionEntry;
        endEntry: RouteJunctionEntry;
        roadPath: RoadNode[];
        totalMinutes: number;
      }
    | undefined;

  for (const startEntry of startEntries) {
    const dijkstra = computeShortestRoadPaths(startEntry.junctionId, topology);
    for (const endEntry of endEntries) {
      const roadMinutes = dijkstra.distances.get(endEntry.junctionId);
      if (roadMinutes === undefined) continue;
      const totalMinutes =
        startEntry.transitionMinutes + roadMinutes + endEntry.transitionMinutes;
      if (!bestRoute || totalMinutes < bestRoute.totalMinutes) {
        bestRoute = {
          startEntry,
          endEntry,
          roadPath: reconstructRoadPath(
            startEntry.junctionId,
            endEntry.junctionId,
            dijkstra.previous,
            topology
          ),
          totalMinutes,
        };
      }
    }
  }

  if (!bestRoute) return null;

  const roadSteps: MovementStep[] = [];
  let currentJunctionId = bestRoute.startEntry.junctionId;
  for (const road of bestRoute.roadPath) {
    roadSteps.push(...buildRoadTraversalSteps(currentJunctionId, road));
    currentJunctionId =
      road.endpointA === currentJunctionId ? road.endpointB : road.endpointA;
  }

  return {
    steps: [
      ...bestRoute.startEntry.transitionSteps,
      ...roadSteps,
      ...bestRoute.endEntry.transitionSteps,
    ],
    totalMinutes: bestRoute.totalMinutes,
  };
}

/** Resolve a CharacterPosition to reachable junction(s) with initial travel cost */
function resolveToJunctions(
  pos: CharacterPosition,
  topology: TownTopology,
  blockedConnections: Map<string, string>,
  dgsm?: DynamicGameStateManager
): JunctionEntry[] | null {
  switch (pos.type) {
    case "junction":
      return [
        {
          junctionId: pos.junctionId,
          initialSteps: [],
          initialMinutes: 0,
          finalSteps: [],
          finalMinutes: 0,
        },
      ];

    case "road": {
      const road = topology.roads.get(pos.roadId);
      if (!road) return null;
      const toA = pos.position * road.travelTimeMinutes;
      const toB = (1 - pos.position) * road.travelTimeMinutes;
      const entries: JunctionEntry[] = [];

      if (
        !hasBlockedConnection(
          blockedConnections,
          { type: "road", id: road.id },
          { type: "junction", id: road.endpointA }
        )
      ) {
        entries.push({
          junctionId: road.endpointA,
          initialSteps: [{ type: "road", id: road.id, minutes: toA }],
          initialMinutes: toA,
          finalSteps: [{ type: "road", id: road.id, minutes: toA }],
          finalMinutes: toA,
        });
      }

      if (
        !hasBlockedConnection(
          blockedConnections,
          { type: "road", id: road.id },
          { type: "junction", id: road.endpointB }
        )
      ) {
        entries.push({
          junctionId: road.endpointB,
          initialSteps: [{ type: "road", id: road.id, minutes: toB }],
          initialMinutes: toB,
          finalSteps: [{ type: "road", id: road.id, minutes: toB }],
          finalMinutes: toB,
        });
      }

      return entries.length > 0 ? entries : null;
    }

    case "scene": {
      let sceneId = pos.sceneId;
      let parent = topology.sceneToParent.get(sceneId);
      // Interior sub-scene → resolve to building entry scene
      if (!parent) {
        const entryId = resolveToEntryScene(pos.sceneId, topology, dgsm);
        if (!entryId) return null;
        sceneId = entryId;
        parent = topology.sceneToParent.get(sceneId);
        if (!parent) return null;
      }

      if (parent.type === "junction") {
        if (
          hasBlockedConnection(
            blockedConnections,
            { type: "scene", id: sceneId },
            { type: "junction", id: parent.junctionId }
          )
        ) {
          return null;
        }

        return [
          {
            junctionId: parent.junctionId,
            initialSteps: [{ type: "exit_scene", id: sceneId, minutes: 1 }],
            initialMinutes: 1,
            finalSteps: [{ type: "enter_scene", id: sceneId, minutes: 1 }],
            finalMinutes: 1,
          },
        ];
      }

      // Scene on a road — can reach either junction
      const road = topology.roads.get(parent.roadId);
      if (!road) return null;
      if (
        hasBlockedConnection(
          blockedConnections,
          { type: "scene", id: sceneId },
          { type: "road", id: road.id }
        )
      ) {
        return null;
      }

      const toA = parent.position * road.travelTimeMinutes;
      const toB = (1 - parent.position) * road.travelTimeMinutes;
      const entries: JunctionEntry[] = [];

      if (
        !hasBlockedConnection(
          blockedConnections,
          { type: "road", id: road.id },
          { type: "junction", id: road.endpointA }
        )
      ) {
        entries.push({
          junctionId: road.endpointA,
          initialSteps: [
            { type: "exit_scene", id: sceneId, minutes: 1 },
            { type: "road", id: road.id, minutes: toA },
          ],
          initialMinutes: 1 + toA,
          finalSteps: [
            { type: "road", id: road.id, minutes: toA },
            { type: "enter_scene", id: sceneId, minutes: 1 },
          ],
          finalMinutes: 1 + toA,
        });
      }

      if (
        !hasBlockedConnection(
          blockedConnections,
          { type: "road", id: road.id },
          { type: "junction", id: road.endpointB }
        )
      ) {
        entries.push({
          junctionId: road.endpointB,
          initialSteps: [
            { type: "exit_scene", id: sceneId, minutes: 1 },
            { type: "road", id: road.id, minutes: toB },
          ],
          initialMinutes: 1 + toB,
          finalSteps: [
            { type: "road", id: road.id, minutes: toB },
            { type: "enter_scene", id: sceneId, minutes: 1 },
          ],
          finalMinutes: 1 + toB,
        });
      }

      return entries.length > 0 ? entries : null;
    }
  }
}

function positionsEqual(a: CharacterPosition, b: CharacterPosition): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "junction":
      return a.junctionId === (b as typeof a).junctionId;
    case "road":
      return (
        a.roadId === (b as typeof a).roadId &&
        a.position === (b as typeof a).position
      );
    case "scene":
      return a.sceneId === (b as typeof a).sceneId;
  }
}

function resolveToRouteJunctions(
  pos: CharacterPosition,
  topology: TownTopology,
  dgsm?: DynamicGameStateManager
): RouteJunctionEntry[] | null {
  switch (pos.type) {
    case "junction":
      return [
        {
          junctionId: pos.junctionId,
          transitionSteps: [],
          transitionMinutes: 0,
        },
      ];
    case "road": {
      const road = topology.roads.get(pos.roadId);
      if (!road) return null;
      return [
        {
          junctionId: road.endpointA,
          transitionSteps: buildRoadPositionToJunctionSteps(
            pos,
            road,
            road.endpointA
          ),
          transitionMinutes: pos.position * road.travelTimeMinutes,
        },
        {
          junctionId: road.endpointB,
          transitionSteps: buildRoadPositionToJunctionSteps(
            pos,
            road,
            road.endpointB
          ),
          transitionMinutes: (1 - pos.position) * road.travelTimeMinutes,
        },
      ];
    }
    case "scene": {
      let sceneId = pos.sceneId;
      let parent = topology.sceneToParent.get(sceneId);
      if (!parent) {
        const entryId = resolveToEntryScene(pos.sceneId, topology, dgsm);
        if (!entryId) return null;
        sceneId = entryId;
        parent = topology.sceneToParent.get(sceneId);
        if (!parent) return null;
      }
      const effectivePos: CharacterPosition = { type: "scene", sceneId };
      if (parent.type === "junction") {
        return [
          {
            junctionId: parent.junctionId,
            transitionSteps: [
              {
                kind: "to_junction",
                from: effectivePos,
                to: { type: "junction", junctionId: parent.junctionId },
                durationMinutes: 1,
                blockCheck: {
                  fromId: sceneId,
                  toId: parent.junctionId,
                },
              },
            ],
            transitionMinutes: 1,
          },
        ];
      }

      const road = topology.roads.get(parent.roadId);
      if (!road) return null;
      const roadPos: CharacterPosition = {
        type: "road",
        roadId: road.id,
        position: parent.position,
      };
      return [
        {
          junctionId: road.endpointA,
          transitionSteps: [
            {
              kind: "along_road",
              from: effectivePos,
              to: roadPos,
              roadId: road.id,
              durationMinutes: 1,
              blockCheck: {
                fromId: sceneId,
                toId: road.id,
              },
            },
            ...buildRoadPositionToJunctionSteps(roadPos, road, road.endpointA),
          ],
          transitionMinutes: 1 + parent.position * road.travelTimeMinutes,
        },
        {
          junctionId: road.endpointB,
          transitionSteps: [
            {
              kind: "along_road",
              from: effectivePos,
              to: roadPos,
              roadId: road.id,
              durationMinutes: 1,
              blockCheck: {
                fromId: sceneId,
                toId: road.id,
              },
            },
            ...buildRoadPositionToJunctionSteps(roadPos, road, road.endpointB),
          ],
          transitionMinutes: 1 + (1 - parent.position) * road.travelTimeMinutes,
        },
      ];
    }
  }
}

function resolveToRouteJunctionsFromTarget(
  pos: CharacterPosition,
  topology: TownTopology
): RouteJunctionEntry[] | null {
  switch (pos.type) {
    case "junction":
      return [
        {
          junctionId: pos.junctionId,
          transitionSteps: [],
          transitionMinutes: 0,
        },
      ];
    case "road": {
      const road = topology.roads.get(pos.roadId);
      if (!road) return null;
      return [
        {
          junctionId: road.endpointA,
          transitionSteps: buildJunctionToRoadPositionSteps(
            road.endpointA,
            road,
            pos
          ),
          transitionMinutes: pos.position * road.travelTimeMinutes,
        },
        {
          junctionId: road.endpointB,
          transitionSteps: buildJunctionToRoadPositionSteps(
            road.endpointB,
            road,
            pos
          ),
          transitionMinutes: (1 - pos.position) * road.travelTimeMinutes,
        },
      ];
    }
    case "scene": {
      const parent = topology.sceneToParent.get(pos.sceneId);
      if (!parent) return null;
      if (parent.type === "junction") {
        return [
          {
            junctionId: parent.junctionId,
            transitionSteps: [
              {
                kind: "to_scene",
                from: { type: "junction", junctionId: parent.junctionId },
                to: pos,
                durationMinutes: 1,
                blockCheck: {
                  fromId: parent.junctionId,
                  toId: pos.sceneId,
                },
              },
            ],
            transitionMinutes: 1,
          },
        ];
      }

      const road = topology.roads.get(parent.roadId);
      if (!road) return null;
      const roadPos: CharacterPosition = {
        type: "road",
        roadId: road.id,
        position: parent.position,
      };
      return [
        {
          junctionId: road.endpointA,
          transitionSteps: [
            ...buildJunctionToRoadPositionSteps(road.endpointA, road, roadPos),
            {
              kind: "to_scene",
              from: roadPos,
              to: pos,
              durationMinutes: 1,
              blockCheck: {
                fromId: road.id,
                toId: pos.sceneId,
              },
            },
          ],
          transitionMinutes: parent.position * road.travelTimeMinutes + 1,
        },
        {
          junctionId: road.endpointB,
          transitionSteps: [
            ...buildJunctionToRoadPositionSteps(road.endpointB, road, roadPos),
            {
              kind: "to_scene",
              from: roadPos,
              to: pos,
              durationMinutes: 1,
              blockCheck: {
                fromId: road.id,
                toId: pos.sceneId,
              },
            },
          ],
          transitionMinutes: (1 - parent.position) * road.travelTimeMinutes + 1,
        },
      ];
    }
  }
}

function buildRoadPositionToJunctionSteps(
  from: { type: "road"; roadId: string; position: number },
  road: RoadNode,
  junctionId: string
): MovementStep[] {
  const targetPosition = junctionId === road.endpointA ? 0 : 1;
  return [
    {
      kind: "along_road",
      from,
      to: { type: "road", roadId: road.id, position: targetPosition },
      roadId: road.id,
      durationMinutes:
        Math.abs(targetPosition - from.position) * road.travelTimeMinutes,
    },
    {
      kind: "to_junction",
      from: { type: "road", roadId: road.id, position: targetPosition },
      to: { type: "junction", junctionId },
      durationMinutes: 0,
      blockCheck: {
        fromId: road.id,
        toId: junctionId,
      },
    },
  ];
}

function buildJunctionToRoadPositionSteps(
  junctionId: string,
  road: RoadNode,
  to: { type: "road"; roadId: string; position: number }
): MovementStep[] {
  const startPosition = junctionId === road.endpointA ? 0 : 1;
  return [
    {
      kind: "to_junction",
      from: { type: "junction", junctionId },
      to: { type: "road", roadId: road.id, position: startPosition },
      durationMinutes: 0,
      blockCheck: {
        fromId: junctionId,
        toId: road.id,
      },
    },
    {
      kind: "along_road",
      from: { type: "road", roadId: road.id, position: startPosition },
      to,
      roadId: road.id,
      durationMinutes:
        Math.abs(to.position - startPosition) * road.travelTimeMinutes,
    },
  ];
}

function buildRoadTraversalSteps(
  fromJunctionId: string,
  road: RoadNode
): MovementStep[] {
  const startPosition = fromJunctionId === road.endpointA ? 0 : 1;
  const targetJunctionId =
    fromJunctionId === road.endpointA ? road.endpointB : road.endpointA;
  const targetPosition = targetJunctionId === road.endpointA ? 0 : 1;

  return [
    {
      kind: "to_junction",
      from: { type: "junction", junctionId: fromJunctionId },
      to: { type: "road", roadId: road.id, position: startPosition },
      durationMinutes: 0,
      blockCheck: {
        fromId: fromJunctionId,
        toId: road.id,
      },
    },
    {
      kind: "along_road",
      from: { type: "road", roadId: road.id, position: startPosition },
      to: { type: "road", roadId: road.id, position: targetPosition },
      roadId: road.id,
      durationMinutes: road.travelTimeMinutes,
    },
    {
      kind: "to_junction",
      from: { type: "road", roadId: road.id, position: targetPosition },
      to: { type: "junction", junctionId: targetJunctionId },
      durationMinutes: 0,
      blockCheck: {
        fromId: road.id,
        toId: targetJunctionId,
      },
    },
  ];
}

function computeShortestRoadPaths(
  startJunctionId: string,
  topology: TownTopology
): {
  distances: Map<string, number>;
  previous: Map<string, { junctionId: string; roadId: string }>;
} {
  const distances = new Map<string, number>();
  const previous = new Map<string, { junctionId: string; roadId: string }>();
  const unvisited = new Set<string>(topology.junctions.keys());

  distances.set(startJunctionId, 0);

  while (unvisited.size > 0) {
    let currentId: string | null = null;
    let currentDist = Number.POSITIVE_INFINITY;

    for (const junctionId of unvisited) {
      const dist = distances.get(junctionId) ?? Number.POSITIVE_INFINITY;
      if (dist < currentDist) {
        currentDist = dist;
        currentId = junctionId;
      }
    }

    if (!currentId || currentDist === Number.POSITIVE_INFINITY) break;
    unvisited.delete(currentId);

    const roads = topology.junctionToRoads.get(currentId) ?? [];
    for (const road of roads) {
      const neighborId =
        road.endpointA === currentId ? road.endpointB : road.endpointA;
      if (!unvisited.has(neighborId)) continue;
      const candidate = currentDist + road.travelTimeMinutes;
      if (candidate < (distances.get(neighborId) ?? Number.POSITIVE_INFINITY)) {
        distances.set(neighborId, candidate);
        previous.set(neighborId, { junctionId: currentId, roadId: road.id });
      }
    }
  }

  return { distances, previous };
}

function reconstructRoadPath(
  startJunctionId: string,
  endJunctionId: string,
  previous: Map<string, { junctionId: string; roadId: string }>,
  topology: TownTopology
): RoadNode[] {
  const roads: RoadNode[] = [];
  let current = endJunctionId;
  while (current !== startJunctionId) {
    const prev = previous.get(current);
    if (!prev) return [];
    const road = topology.roads.get(prev.roadId);
    if (!road) return [];
    roads.unshift(road);
    current = prev.junctionId;
  }
  return roads;
}
