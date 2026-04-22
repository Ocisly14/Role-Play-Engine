import type { SceneCondition } from "../engine/core/types.js";
import type { Item } from "./types.js";

/**
 * Junction — a first-class intersection/endpoint node.
 * Loaded from JUNC_*.json files.
 */
export interface JunctionNode {
  id: string;
  name: string;
  description: string;
  parentLocationId: string; // typically "OUTDOOR"
  items: Item[];
  itemContexts?: Record<string, string>;
  conditions: SceneCondition[];
  /** Scene IDs directly accessible from this junction (buildings at the intersection) */
  connectedSceneIds: string[];
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
 * Road — a linear path between two Junctions.
 * Loaded from ROAD_*.json files.
 */
export interface RoadNode {
  id: string;
  name: string;
  description: string;
  parentLocationId: string; // typically "OUTDOOR"
  /** Junction ID at the start */
  endpointA: string;
  /** Junction ID at the end */
  endpointB: string;
  /** Minutes to walk the full length */
  travelTimeMinutes: number;
  /** Buildings accessible along this road */
  alongConnections: AlongConnection[];
  items: Item[];
  itemContexts?: Record<string, string>;
  conditions: SceneCondition[];
}

/**
 * Character position — where a character currently is in the topology.
 */
export type CharacterPosition =
  | { type: "junction"; junctionId: string }
  | { type: "road"; roadId: string; position: number } // 0.0–1.0
  | { type: "scene"; sceneId: string };

/**
 * Pre-computed topology index built after loading all nodes.
 */
export interface TownTopology {
  junctions: Map<string, JunctionNode>;
  roads: Map<string, RoadNode>;

  /** Junction ID → roads that have this junction as endpointA or endpointB */
  junctionToRoads: Map<string, RoadNode[]>;

  /** Scene ID → where this scene is attached */
  sceneToParent: Map<
    string,
    | {
        type: "junction";
        junctionId: string;
      }
    | {
        type: "road";
        roadId: string;
        position: number;
      }
  >;
}

/**
 * Build a TownTopology index from loaded junctions and roads.
 */
export function buildTopology(
  junctions: Map<string, JunctionNode>,
  roads: Map<string, RoadNode>
): TownTopology {
  const junctionToRoads = new Map<string, RoadNode[]>();
  const sceneToParent = new Map<
    string,
    | { type: "junction"; junctionId: string }
    | { type: "road"; roadId: string; position: number }
  >();

  // Index roads by their endpoint junctions
  for (const road of roads.values()) {
    for (const juncId of [road.endpointA, road.endpointB]) {
      const existing = junctionToRoads.get(juncId) ?? [];
      existing.push(road);
      junctionToRoads.set(juncId, existing);
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

  // Index junction connected scenes
  for (const junction of junctions.values()) {
    for (const sceneId of junction.connectedSceneIds) {
      sceneToParent.set(sceneId, {
        type: "junction",
        junctionId: junction.id,
      });
    }
  }

  return { junctions, roads, junctionToRoads, sceneToParent };
}

/**
 * Enrich a topology by adding interior sub-scenes to `sceneToParent`.
 *
 * Interior sub-scenes (e.g. SCN_6_SUB_1, 2nd floor) are not directly
 * connected to junctions/roads but belong to a building whose entry scene IS.
 * This function gives every sub-scene the same topology attachment as its
 * building's entry scene, so pathfinding can route to/from them.
 */
export function enrichTopologyWithInteriorScenes(
  topology: TownTopology,
  scenes: Map<string, { id: string; parentLocationId: string }>,
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
    // Skip scenes already indexed
    if (topology.sceneToParent.has(scene.id)) continue;

    // Find the building's entry scene via the parent outline
    const entrySceneId = outlineEntryMap.get(scene.parentLocationId);
    if (!entrySceneId) continue;

    // Inherit the entry scene's topology attachment
    const parentEntry = topology.sceneToParent.get(entrySceneId);
    if (!parentEntry) continue;

    topology.sceneToParent.set(scene.id, parentEntry);
  }
}
