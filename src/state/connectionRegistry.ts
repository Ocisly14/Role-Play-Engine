/**
 * Connection registry — the id-addressed index over every authored connection
 * in the world (scenes and roads). Derivable from state, so it is
 * never serialized; build it lazily where needed.
 *
 * `resolveConnectionEdge` maps a connection id onto the same symmetric edge
 * key `state.blockedConnections` uses, so a pair of one-way exit ids authored
 * in both directions collapses onto one edge.
 */

import {
  type BlockedConnectionLookup,
  type BlockedConnectionNodeRef,
  makeBlockedConnectionKey,
  parseFeatureEdgeId,
  resolveBlockedConnectionNodeRef,
} from "./blockedConnections.js";
import type { RoadNode } from "./topologyTypes.js";
import type { DynamicScene } from "./types.js";

export type ConnectionOwnerKind = "scene" | "road";

export interface ConnectionRegistryEntry {
  /** The connection's own id (`connection.<place>.<slug>`). */
  id: string;
  /** The place whose file declares this connection. */
  ownerId: string;
  ownerKind: ConnectionOwnerKind;
  /** The place the connection leads to. */
  targetId: string;
  targetKind: ConnectionOwnerKind;
}

export type ConnectionRegistry = Map<string, ConnectionRegistryEntry>;

export interface ConnectionRegistryState {
  scenes: Map<string, DynamicScene>;
  roads: Map<string, RoadNode>;
}

function resolveTargetKind(
  targetId: string,
  state: ConnectionRegistryState
): ConnectionOwnerKind | null {
  if (state.scenes.has(targetId)) return "scene";
  if (state.roads.has(targetId)) return "road";
  return null;
}

/**
 * Index every connection by its id. Connections whose target does not resolve
 * to a loaded place are skipped — the loader's reference validation rejects
 * them at import time, so a miss here means stale runtime state, not a bug in
 * the caller.
 */
export function buildConnectionRegistry(
  state: ConnectionRegistryState
): ConnectionRegistry {
  const registry: ConnectionRegistry = new Map();
  const add = (
    ownerId: string,
    ownerKind: ConnectionOwnerKind,
    connections: Array<{ id: string; targetId: string }>
  ) => {
    for (const connection of connections) {
      const targetKind = resolveTargetKind(connection.targetId, state);
      if (targetKind === null) continue;
      registry.set(connection.id, {
        id: connection.id,
        ownerId,
        ownerKind,
        targetId: connection.targetId,
        targetKind,
      });
    }
  };
  for (const scene of state.scenes.values()) {
    add(scene.id, "scene", scene.connections ?? []);
  }
  for (const road of state.roads.values()) {
    add(road.id, "road", road.connections ?? []);
  }
  return registry;
}

export interface ConnectionEdge {
  /** Canonical symmetric edge key (same scheme as `state.blockedConnections`). */
  key: string;
  a: BlockedConnectionNodeRef;
  b: BlockedConnectionNodeRef;
}

/**
 * Resolve a connection id to its canonical symmetric edge. Two exit ids that
 * describe the same pair of places (one authored in each direction) resolve
 * to the same `key`.
 *
 * Two id languages arrive here, because an edge has two kinds of author. A
 * `connection.*` id is a passage someone WROTE, and the registry knows where
 * it leads. A `<featureId>:<a>|<b>` id is a subsystem naming the pair itself
 * (see `makeFeatureEdgeId`) — weather closing a road —
 * and there is no authored exit to look up, only two places. Both land on the
 * same key, which is the point: a road the module authored one exit for is
 * still one edge when the snow closes it from the other side.
 */
export function resolveConnectionEdge(
  connectionId: string,
  registry: ConnectionRegistry,
  lookup?: BlockedConnectionLookup
): ConnectionEdge | null {
  const entry = registry.get(connectionId);
  if (!entry) {
    const pair = lookup ? parseFeatureEdgeId(connectionId) : null;
    if (!pair) return null;
    // Both ends must be real places. An unknown id is a bug in the voter, and
    // inventing an edge for it would put a block on a key nothing can lift.
    const a = resolveBlockedConnectionNodeRef(
      pair.a,
      lookup as BlockedConnectionLookup
    );
    const b = resolveBlockedConnectionNodeRef(
      pair.b,
      lookup as BlockedConnectionLookup
    );
    if (!a || !b) return null;
    return { key: makeBlockedConnectionKey(a, b), a, b };
  }
  const a: BlockedConnectionNodeRef = {
    type: entry.ownerKind,
    id: entry.ownerId,
  };
  const b: BlockedConnectionNodeRef = {
    type: entry.targetKind,
    id: entry.targetId,
  };
  return { key: makeBlockedConnectionKey(a, b), a, b };
}
