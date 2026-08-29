import type { SceneCondition } from "../engine/core/types.js";
import type { DynamicScene, Item, SceneConnection } from "./types.js";

/**
 * The junction node type is gone: a "junction" was a place with a name, a
 * description, items, conditions and connections — exactly a scene. A
 * TOP-LEVEL scene (one with no `parentLocationId`) is a geography node: a
 * street stretch, a crossroads, a yard. Roads run between top-level scenes;
 * interior scenes hang off them (or off a road access point) and inherit
 * their topology attachment.
 */

/**
 * A road's connection carries a role: the two endpoint node scenes, or an
 * `access` point somewhere along the length (with a 0-1 position).
 */
export interface RoadConnection extends SceneConnection {
  role: "endpointA" | "endpointB" | "access";
  /** 0.0 = endpointA side, 1.0 = endpointB side. Required for role "access". */
  position?: number;
}

/**
 * Along-the-road connection — a building/scene accessible from a point on a road.
 */
export interface AlongConnection {
  sceneId: string;
  /** 0.0 = endpointA side, 1.0 = endpointB side */
  position: number;
}

/**
 * Road — a linear path between two top-level node scenes.
 * Loaded from ROAD_*.json files.
 */
export interface RoadNode {
  id: string;
  name: string;
  description: string;
  parentLocationId?: string;
  /** Authored connections (source of truth; carries id/role/position/hidden). */
  connections: RoadConnection[];
  /** Node scene ID at the start (derived from the `endpointA` connection) */
  endpointA: string;
  /** Node scene ID at the end (derived from the `endpointB` connection) */
  endpointB: string;
  /** Minutes to walk the full length */
  travelTimeMinutes: number;
  /** Buildings accessible along this road (derived from `access` connections) */
  alongConnections: AlongConnection[];
  items: Item[];
  conditions: SceneCondition[];
}

/**
 * Character position — where a character currently is in the topology.
 */
export type CharacterPosition =
  | { type: "road"; roadId: string; position: number } // 0.0–1.0
  | { type: "scene"; sceneId: string };

/**
 * Pre-computed topology index built after loading all scenes and roads.
 */
export interface TownTopology {
  /** Top-level scenes — the nodes of the road network. */
  nodeSceneIds: Set<string>;
  roads: Map<string, RoadNode>;

  /** Node scene ID → roads that have this scene as endpointA or endpointB */
  sceneToRoads: Map<string, RoadNode[]>;

  /** Scene ID → where this (non-node) scene is attached */
  sceneToParent: Map<
    string,
    | {
        type: "scene";
        sceneId: string;
      }
    | {
        type: "road";
        roadId: string;
        position: number;
      }
  >;
}

/** A scene with no parent location is a geography node in its own right. */
export function isTopLevelScene(scene: {
  parentLocationId?: string;
}): boolean {
  return !scene.parentLocationId;
}

/**
 * Build a TownTopology index from loaded scenes and roads.
 */
export function buildTopology(
  scenes: Map<string, DynamicScene>,
  roads: Map<string, RoadNode>
): TownTopology {
  const nodeSceneIds = new Set<string>();
  const sceneToRoads = new Map<string, RoadNode[]>();
  const sceneToParent = new Map<
    string,
    | { type: "scene"; sceneId: string }
    | { type: "road"; roadId: string; position: number }
  >();

  for (const scene of scenes.values()) {
    if (isTopLevelScene(scene)) nodeSceneIds.add(scene.id);
  }

  // Index roads by their endpoint node scenes
  for (const road of roads.values()) {
    for (const nodeId of [road.endpointA, road.endpointB]) {
      const existing = sceneToRoads.get(nodeId) ?? [];
      existing.push(road);
      sceneToRoads.set(nodeId, existing);
    }

    // Index along connections
    for (const along of road.alongConnections) {
      sceneToParent.set(along.sceneId, {
        type: "road",
        roadId: road.id,
        position: along.position,
      });
    }
  }

  // A node scene's connections into interior scenes attach those scenes to
  // the node (the former junction.connectedSceneIds role).
  for (const scene of scenes.values()) {
    if (!nodeSceneIds.has(scene.id)) continue;
    for (const connection of scene.connections ?? []) {
      const target = scenes.get(connection.targetId);
      if (!target || nodeSceneIds.has(target.id)) continue;
      if (sceneToParent.has(target.id)) continue;
      sceneToParent.set(target.id, { type: "scene", sceneId: scene.id });
    }
  }

  return { nodeSceneIds, roads, sceneToRoads, sceneToParent };
}

/**
 * Enrich a topology by adding interior sub-scenes to `sceneToParent`.
 *
 * Interior sub-scenes (e.g. a 2nd-floor room) are not directly connected to
 * node scenes/roads but belong to a building whose entry scene IS. This
 * function gives every sub-scene the same topology attachment as its
 * building's entry scene, so pathfinding can route to/from them.
 */
export function enrichTopologyWithInteriorScenes(
  topology: TownTopology,
  scenes: Map<string, { id: string; parentLocationId?: string }>,
  outlines: Array<{ id: string; entrySceneId?: string }>
): void {
  // Build outline lookup: outlineId → entrySceneId
  const outlineEntryMap = new Map<string, string>();
  for (const outline of outlines) {
    if (outline.entrySceneId) {
      outlineEntryMap.set(outline.id, outline.entrySceneId);
    }
  }

  for (const scene of scenes.values()) {
    // Skip scenes already indexed, and geography nodes.
    if (topology.sceneToParent.has(scene.id)) continue;
    if (!scene.parentLocationId) continue;

    // The parent may itself be a node scene (a cabin off a yard) …
    if (topology.nodeSceneIds.has(scene.parentLocationId)) {
      topology.sceneToParent.set(scene.id, {
        type: "scene",
        sceneId: scene.parentLocationId,
      });
      continue;
    }

    // … or an outline (building) whose entry scene carries the attachment.
    const entrySceneId = outlineEntryMap.get(scene.parentLocationId);
    if (!entrySceneId) continue;

    if (topology.nodeSceneIds.has(entrySceneId)) {
      topology.sceneToParent.set(scene.id, {
        type: "scene",
        sceneId: entrySceneId,
      });
      continue;
    }
    const parentEntry = topology.sceneToParent.get(entrySceneId);
    if (!parentEntry) continue;

    topology.sceneToParent.set(scene.id, parentEntry);
  }
}
