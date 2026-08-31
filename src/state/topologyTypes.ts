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
  /** Minutes to DRIVE the full length. Present = the road takes vehicles;
   *  absent = it does not (trails, alleys, cliff paths). */
  driveTimeMinutes?: number;
  /** Buildings accessible along this road (derived from `access` connections) */
  alongConnections: AlongConnection[];
  items: Item[];
  conditions: SceneCondition[];
}

/**
 * A vehicle: a movable perception boundary. Outside it is an item-like
 * presence at `position`; inside it is `interiorSceneId`, a normal scene
 * whose occupants ride along for free — moving the vehicle moves nobody's
 * position, because "in the cab" IS their position.
 */
export interface VehicleState {
  id: string;
  name: string;
  description: string;
  interiorSceneId: string;
  position: CharacterPosition;
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

  // Deep interiors attach transitively: a kitchen reached only through the
  // dining room inherits the dining room's attachment, an upstairs room the
  // kitchen's, until every scene reachable from the topology has a root.
  // This is purely structural — derived from connections, no outline data —
  // so the topology is self-contained.
  let grew = true;
  while (grew) {
    grew = false;
    for (const scene of scenes.values()) {
      const attachment = nodeSceneIds.has(scene.id)
        ? { type: "scene" as const, sceneId: scene.id }
        : sceneToParent.get(scene.id);
      if (attachment) {
        // Forward: rooms reached through this one inherit its root.
        for (const connection of scene.connections ?? []) {
          const target = scenes.get(connection.targetId);
          if (!target || nodeSceneIds.has(target.id)) continue;
          if (sceneToParent.has(target.id)) continue;
          sceneToParent.set(target.id, attachment);
          grew = true;
        }
        continue;
      }
      // Reverse: an unattached room whose own door opens onto an attached
      // place (or a node) stands there too — a one-way authored exit must
      // not strand the room outside the topology.
      for (const connection of scene.connections ?? []) {
        const targetId = connection.targetId;
        const viaNode = nodeSceneIds.has(targetId)
          ? { type: "scene" as const, sceneId: targetId }
          : sceneToParent.get(targetId);
        if (!viaNode) continue;
        sceneToParent.set(scene.id, viaNode);
        grew = true;
        break;
      }
    }
  }

  return { nodeSceneIds, roads, sceneToRoads, sceneToParent };
}
