import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { hasBlockedConnection } from "../../state/blockedConnections.js";
import type {
  CharacterPosition,
  RoadNode,
  TownTopology,
} from "../../state/topologyTypes.js";
import type { MovementStep } from "../core/types.js";

/**
 * Convert a location ID string to a CharacterPosition using topology and dgsm state.
 * Checks: node scenes → sceneToParent → roads → outline fallback → interior sub-scene fallback.
 */
export function resolveTargetPosition(
  locationId: string,
  topology: TownTopology,
  dgsm?: DynamicGameStateManager
): CharacterPosition | null {
  if (
    topology.nodeSceneIds.has(locationId) ||
    topology.sceneToParent.has(locationId)
  ) {
    return { type: "scene", sceneId: locationId };
  }
  const atIdx = locationId.indexOf("@");
  const roadKey = atIdx >= 0 ? locationId.slice(0, atIdx) : locationId;
  const road = topology.roads.get(roadKey);
  if (road) {
    const parsed =
      atIdx >= 0 ? Number.parseFloat(locationId.slice(atIdx + 1)) : 0.5;
    const position = Number.isFinite(parsed)
      ? Math.max(0, Math.min(1, parsed))
      : 0.5;
    return { type: "road", roadId: road.id, position };
  }
  if (dgsm) {
    const state = dgsm.getState();
    const outline = (state.scenarioOutlines ?? []).find(
      (o) => o.id === locationId
    );
    // The entry may itself be a scene or a road — resolve it through the same
    // rules instead of demanding a scene, which stranded every road-entry
    // outline as "no path" (observed live: interpreter legally picked the
    // listed OUTDOOR id and the mover looped on "couldn't work out a way").
    if (outline?.entrySceneId && outline.entrySceneId !== locationId) {
      const entry = resolveTargetPosition(outline.entrySceneId, topology, dgsm);
      if (entry) return entry;
    }
    const scene = state.scenes.get(locationId);
    if (scene?.parentLocationId) {
      const parentOutline = (state.scenarioOutlines ?? []).find(
        (o) => o.id === scene.parentLocationId
      );
      if (
        parentOutline?.entrySceneId &&
        (topology.nodeSceneIds.has(parentOutline.entrySceneId) ||
          topology.sceneToParent.has(parentOutline.entrySceneId))
      ) {
        return { type: "scene", sceneId: parentOutline.entrySceneId };
      }
    }
  }
  return null;
}

/**
 * If a scene is neither a node scene nor in sceneToParent (interior
 * sub-scene), find its building's entry scene which IS in the topology.
 */
function resolveToEntryScene(
  sceneId: string,
  topology: TownTopology,
  dgsm?: DynamicGameStateManager
): string | null {
  if (
    topology.nodeSceneIds.has(sceneId) ||
    topology.sceneToParent.has(sceneId)
  ) {
    return sceneId;
  }
  if (!dgsm) return null;
  const state = dgsm.getState();
  const scene = state.scenes.get(sceneId);
  if (!scene?.parentLocationId) return null;
  const outline = (state.scenarioOutlines ?? []).find(
    (o) => o.id === scene.parentLocationId
  );
  if (
    outline?.entrySceneId &&
    (topology.nodeSceneIds.has(outline.entrySceneId) ||
      topology.sceneToParent.has(outline.entrySceneId))
  ) {
    return outline.entrySceneId;
  }
  return null;
}

// ===== Topology-aware pathfinding (node-scene / road graph) =====

/** A step in a topology path */
export interface TopologyPathStep {
  type: "road" | "enter_scene" | "exit_scene" | "node";
  id: string;
  /** Travel time for this step in minutes */
  minutes: number;
}

/** Result of topology pathfinding */
export interface TopologyPath {
  steps: TopologyPathStep[];
  totalMinutes: number;
}

interface RouteNodeEntry {
  nodeSceneId: string;
  transitionSteps: MovementStep[];
  transitionMinutes: number;
}

/** Internal: entry/exit info for resolving a CharacterPosition to node scene(s) */
interface NodeEntry {
  nodeSceneId: string;
  initialSteps: TopologyPathStep[];
  initialMinutes: number;
  finalSteps: TopologyPathStep[];
  finalMinutes: number;
}

/**
 * BFS pathfinding on the node-scene/road topology graph.
 * Supports starting/ending at node scenes, roads (with position), or
 * attached scenes.
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

  const startInfo = resolveToNodes(from, topology, blockedConnections, dgsm);
  const endInfo = resolveToNodes(to, topology, blockedConnections, dgsm);

  if (!startInfo || !endInfo) return null;

  // BFS on node scenes
  const visited = new Set<string>();
  const queue: Array<{
    nodeSceneId: string;
    steps: TopologyPathStep[];
    minutes: number;
  }> = [];

  // Seed queue with start node(s)
  for (const entry of startInfo) {
    queue.push({
      nodeSceneId: entry.nodeSceneId,
      steps: entry.initialSteps,
      minutes: entry.initialMinutes,
    });
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.nodeSceneId)) continue;
    visited.add(current.nodeSceneId);

    // Check if we reached any end node
    for (const end of endInfo) {
      if (current.nodeSceneId === end.nodeSceneId) {
        const finalSteps = [...current.steps, ...end.finalSteps];
        const finalMinutes = current.minutes + end.finalMinutes;
        return { steps: finalSteps, totalMinutes: finalMinutes };
      }
    }

    // Expand: find all roads connected to this node
    const roads = topology.sceneToRoads.get(current.nodeSceneId) ?? [];
    for (const road of roads) {
      const otherNodeId =
        road.endpointA === current.nodeSceneId
          ? road.endpointB
          : road.endpointA;

      if (visited.has(otherNodeId)) continue;

      if (
        hasBlockedConnection(
          blockedConnections,
          { type: "scene", id: current.nodeSceneId },
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
        nodeSceneId: otherNodeId,
        steps: [...current.steps, roadStep],
        minutes: current.minutes + road.travelTimeMinutes,
      });
    }
  }

  return null;
}

/**
 * For a road destination with no explicit position ("去那条街"), arriving
 * means stepping ONTO the road — not walking to its midpoint. Pick the road
 * end that is cheapest to reach from `from`; if the mover is already on the
 * road, they are already there. Falls back to 0.5 when neither end routes.
 */
export function nearestRoadPosition(
  from: CharacterPosition,
  roadId: string,
  topology: TownTopology,
  dgsm?: DynamicGameStateManager
): number {
  if (from.type === "road" && from.roadId === roadId) return from.position;
  const costTo = (position: number): number => {
    const route = buildMovementRouteIgnoringBlocks(
      from,
      { type: "road", roadId, position },
      topology,
      dgsm
    );
    return route ? route.totalMinutes : Number.POSITIVE_INFINITY;
  };
  const a = costTo(0);
  const b = costTo(1);
  if (!Number.isFinite(a) && !Number.isFinite(b)) return 0.5;
  return a <= b ? 0 : 1;
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

  const startEntries = resolveToRouteNodes(from, topology, dgsm);
  const endEntries = resolveToRouteNodesFromTarget(to, topology);
  if (!startEntries || !endEntries) return null;

  let bestRoute:
    | {
        startEntry: RouteNodeEntry;
        endEntry: RouteNodeEntry;
        roadPath: RoadNode[];
        totalMinutes: number;
      }
    | undefined;

  for (const startEntry of startEntries) {
    const dijkstra = computeShortestRoadPaths(startEntry.nodeSceneId, topology);
    for (const endEntry of endEntries) {
      const roadMinutes = dijkstra.distances.get(endEntry.nodeSceneId);
      if (roadMinutes === undefined) continue;
      const totalMinutes =
        startEntry.transitionMinutes + roadMinutes + endEntry.transitionMinutes;
      if (!bestRoute || totalMinutes < bestRoute.totalMinutes) {
        bestRoute = {
          startEntry,
          endEntry,
          roadPath: reconstructRoadPath(
            startEntry.nodeSceneId,
            endEntry.nodeSceneId,
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
  let currentNodeId = bestRoute.startEntry.nodeSceneId;
  for (const road of bestRoute.roadPath) {
    roadSteps.push(...buildRoadTraversalSteps(currentNodeId, road));
    currentNodeId =
      road.endpointA === currentNodeId ? road.endpointB : road.endpointA;
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

/** Resolve a CharacterPosition to reachable node scene(s) with initial travel cost */
function resolveToNodes(
  pos: CharacterPosition,
  topology: TownTopology,
  blockedConnections: Map<string, string>,
  dgsm?: DynamicGameStateManager
): NodeEntry[] | null {
  switch (pos.type) {
    case "road": {
      const road = topology.roads.get(pos.roadId);
      if (!road) return null;
      const toA = pos.position * road.travelTimeMinutes;
      const toB = (1 - pos.position) * road.travelTimeMinutes;
      const entries: NodeEntry[] = [];

      if (
        !hasBlockedConnection(
          blockedConnections,
          { type: "road", id: road.id },
          { type: "scene", id: road.endpointA }
        )
      ) {
        entries.push({
          nodeSceneId: road.endpointA,
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
          { type: "scene", id: road.endpointB }
        )
      ) {
        entries.push({
          nodeSceneId: road.endpointB,
          initialSteps: [{ type: "road", id: road.id, minutes: toB }],
          initialMinutes: toB,
          finalSteps: [{ type: "road", id: road.id, minutes: toB }],
          finalMinutes: toB,
        });
      }

      return entries.length > 0 ? entries : null;
    }

    case "scene": {
      // A node scene is itself a graph node.
      if (topology.nodeSceneIds.has(pos.sceneId)) {
        return [
          {
            nodeSceneId: pos.sceneId,
            initialSteps: [],
            initialMinutes: 0,
            finalSteps: [],
            finalMinutes: 0,
          },
        ];
      }

      let sceneId = pos.sceneId;
      let parent = topology.sceneToParent.get(sceneId);
      // Interior sub-scene → resolve to building entry scene
      if (!parent) {
        const entryId = resolveToEntryScene(pos.sceneId, topology, dgsm);
        if (!entryId) return null;
        sceneId = entryId;
        if (topology.nodeSceneIds.has(sceneId)) {
          return [
            {
              nodeSceneId: sceneId,
              initialSteps: [],
              initialMinutes: 0,
              finalSteps: [],
              finalMinutes: 0,
            },
          ];
        }
        parent = topology.sceneToParent.get(sceneId);
        if (!parent) return null;
      }

      if (parent.type === "scene") {
        if (
          hasBlockedConnection(
            blockedConnections,
            { type: "scene", id: sceneId },
            { type: "scene", id: parent.sceneId }
          )
        ) {
          return null;
        }

        return [
          {
            nodeSceneId: parent.sceneId,
            initialSteps: [{ type: "exit_scene", id: sceneId, minutes: 1 }],
            initialMinutes: 1,
            finalSteps: [{ type: "enter_scene", id: sceneId, minutes: 1 }],
            finalMinutes: 1,
          },
        ];
      }

      // Scene on a road — can reach either endpoint node
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
      const entries: NodeEntry[] = [];

      if (
        !hasBlockedConnection(
          blockedConnections,
          { type: "road", id: road.id },
          { type: "scene", id: road.endpointA }
        )
      ) {
        entries.push({
          nodeSceneId: road.endpointA,
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
          { type: "scene", id: road.endpointB }
        )
      ) {
        entries.push({
          nodeSceneId: road.endpointB,
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
    case "road":
      return (
        a.roadId === (b as typeof a).roadId &&
        a.position === (b as typeof a).position
      );
    case "scene":
      return a.sceneId === (b as typeof a).sceneId;
  }
}

function resolveToRouteNodes(
  pos: CharacterPosition,
  topology: TownTopology,
  dgsm?: DynamicGameStateManager
): RouteNodeEntry[] | null {
  switch (pos.type) {
    case "road": {
      const road = topology.roads.get(pos.roadId);
      if (!road) return null;
      return [
        {
          nodeSceneId: road.endpointA,
          transitionSteps: buildRoadPositionToNodeSteps(
            pos,
            road,
            road.endpointA
          ),
          transitionMinutes: pos.position * road.travelTimeMinutes,
        },
        {
          nodeSceneId: road.endpointB,
          transitionSteps: buildRoadPositionToNodeSteps(
            pos,
            road,
            road.endpointB
          ),
          transitionMinutes: (1 - pos.position) * road.travelTimeMinutes,
        },
      ];
    }
    case "scene": {
      if (topology.nodeSceneIds.has(pos.sceneId)) {
        return [
          {
            nodeSceneId: pos.sceneId,
            transitionSteps: [],
            transitionMinutes: 0,
          },
        ];
      }

      let sceneId = pos.sceneId;
      let parent = topology.sceneToParent.get(sceneId);
      if (!parent) {
        const entryId = resolveToEntryScene(pos.sceneId, topology, dgsm);
        if (!entryId) return null;
        sceneId = entryId;
        if (topology.nodeSceneIds.has(sceneId)) {
          return [
            {
              nodeSceneId: sceneId,
              transitionSteps: [],
              transitionMinutes: 0,
            },
          ];
        }
        parent = topology.sceneToParent.get(sceneId);
        if (!parent) return null;
      }
      const effectivePos: CharacterPosition = { type: "scene", sceneId };
      if (parent.type === "scene") {
        return [
          {
            nodeSceneId: parent.sceneId,
            transitionSteps: [
              {
                kind: "to_scene",
                from: effectivePos,
                to: { type: "scene", sceneId: parent.sceneId },
                durationMinutes: 1,
                blockCheck: {
                  fromId: sceneId,
                  toId: parent.sceneId,
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
          nodeSceneId: road.endpointA,
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
            ...buildRoadPositionToNodeSteps(roadPos, road, road.endpointA),
          ],
          transitionMinutes: 1 + parent.position * road.travelTimeMinutes,
        },
        {
          nodeSceneId: road.endpointB,
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
            ...buildRoadPositionToNodeSteps(roadPos, road, road.endpointB),
          ],
          transitionMinutes: 1 + (1 - parent.position) * road.travelTimeMinutes,
        },
      ];
    }
  }
}

function resolveToRouteNodesFromTarget(
  pos: CharacterPosition,
  topology: TownTopology
): RouteNodeEntry[] | null {
  switch (pos.type) {
    case "road": {
      const road = topology.roads.get(pos.roadId);
      if (!road) return null;
      return [
        {
          nodeSceneId: road.endpointA,
          transitionSteps: buildNodeToRoadPositionSteps(
            road.endpointA,
            road,
            pos
          ),
          transitionMinutes: pos.position * road.travelTimeMinutes,
        },
        {
          nodeSceneId: road.endpointB,
          transitionSteps: buildNodeToRoadPositionSteps(
            road.endpointB,
            road,
            pos
          ),
          transitionMinutes: (1 - pos.position) * road.travelTimeMinutes,
        },
      ];
    }
    case "scene": {
      if (topology.nodeSceneIds.has(pos.sceneId)) {
        return [
          {
            nodeSceneId: pos.sceneId,
            transitionSteps: [],
            transitionMinutes: 0,
          },
        ];
      }
      const parent = topology.sceneToParent.get(pos.sceneId);
      if (!parent) return null;
      if (parent.type === "scene") {
        return [
          {
            nodeSceneId: parent.sceneId,
            transitionSteps: [
              {
                kind: "to_scene",
                from: { type: "scene", sceneId: parent.sceneId },
                to: pos,
                durationMinutes: 1,
                blockCheck: {
                  fromId: parent.sceneId,
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
          nodeSceneId: road.endpointA,
          transitionSteps: [
            ...buildNodeToRoadPositionSteps(road.endpointA, road, roadPos),
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
          nodeSceneId: road.endpointB,
          transitionSteps: [
            ...buildNodeToRoadPositionSteps(road.endpointB, road, roadPos),
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

function buildRoadPositionToNodeSteps(
  from: { type: "road"; roadId: string; position: number },
  road: RoadNode,
  nodeSceneId: string
): MovementStep[] {
  const targetPosition = nodeSceneId === road.endpointA ? 0 : 1;
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
      kind: "to_scene",
      from: { type: "road", roadId: road.id, position: targetPosition },
      to: { type: "scene", sceneId: nodeSceneId },
      durationMinutes: 0,
      blockCheck: {
        fromId: road.id,
        toId: nodeSceneId,
      },
    },
  ];
}

function buildNodeToRoadPositionSteps(
  nodeSceneId: string,
  road: RoadNode,
  to: { type: "road"; roadId: string; position: number }
): MovementStep[] {
  const startPosition = nodeSceneId === road.endpointA ? 0 : 1;
  return [
    {
      kind: "to_scene",
      from: { type: "scene", sceneId: nodeSceneId },
      to: { type: "road", roadId: road.id, position: startPosition },
      durationMinutes: 0,
      blockCheck: {
        fromId: nodeSceneId,
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
  fromNodeSceneId: string,
  road: RoadNode
): MovementStep[] {
  const startPosition = fromNodeSceneId === road.endpointA ? 0 : 1;
  const targetNodeSceneId =
    fromNodeSceneId === road.endpointA ? road.endpointB : road.endpointA;
  const targetPosition = targetNodeSceneId === road.endpointA ? 0 : 1;

  return [
    {
      kind: "to_scene",
      from: { type: "scene", sceneId: fromNodeSceneId },
      to: { type: "road", roadId: road.id, position: startPosition },
      durationMinutes: 0,
      blockCheck: {
        fromId: fromNodeSceneId,
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
      kind: "to_scene",
      from: { type: "road", roadId: road.id, position: targetPosition },
      to: { type: "scene", sceneId: targetNodeSceneId },
      durationMinutes: 0,
      blockCheck: {
        fromId: road.id,
        toId: targetNodeSceneId,
      },
    },
  ];
}

function computeShortestRoadPaths(
  startNodeSceneId: string,
  topology: TownTopology
): {
  distances: Map<string, number>;
  previous: Map<string, { nodeSceneId: string; roadId: string }>;
} {
  const distances = new Map<string, number>();
  const previous = new Map<string, { nodeSceneId: string; roadId: string }>();
  const unvisited = new Set<string>(topology.nodeSceneIds);

  distances.set(startNodeSceneId, 0);

  while (unvisited.size > 0) {
    let currentId: string | null = null;
    let currentDist = Number.POSITIVE_INFINITY;

    for (const nodeSceneId of unvisited) {
      const dist = distances.get(nodeSceneId) ?? Number.POSITIVE_INFINITY;
      if (dist < currentDist) {
        currentDist = dist;
        currentId = nodeSceneId;
      }
    }

    if (!currentId || currentDist === Number.POSITIVE_INFINITY) break;
    unvisited.delete(currentId);

    const roads = topology.sceneToRoads.get(currentId) ?? [];
    for (const road of roads) {
      const neighborId =
        road.endpointA === currentId ? road.endpointB : road.endpointA;
      if (!unvisited.has(neighborId)) continue;
      const candidate = currentDist + road.travelTimeMinutes;
      if (candidate < (distances.get(neighborId) ?? Number.POSITIVE_INFINITY)) {
        distances.set(neighborId, candidate);
        previous.set(neighborId, { nodeSceneId: currentId, roadId: road.id });
      }
    }
  }

  return { distances, previous };
}

function reconstructRoadPath(
  startNodeSceneId: string,
  endNodeSceneId: string,
  previous: Map<string, { nodeSceneId: string; roadId: string }>,
  topology: TownTopology
): RoadNode[] {
  const roads: RoadNode[] = [];
  let current = endNodeSceneId;
  while (current !== startNodeSceneId) {
    const prev = previous.get(current);
    if (!prev) return [];
    const road = topology.roads.get(prev.roadId);
    if (!road) return [];
    roads.unshift(road);
    current = prev.nodeSceneId;
  }
  return roads;
}
