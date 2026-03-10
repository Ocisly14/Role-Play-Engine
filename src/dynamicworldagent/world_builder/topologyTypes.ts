import type { ScenarioClue, ScenarioCondition } from "../../shared/agents/models/scenarioTypes.js";
import type { Item } from "./types.js";

/**
 * Junction — a first-class intersection/endpoint node.
 * Loaded from JUNC_*.json files.
 */
export interface JunctionNode {
  id: string;
  name: string;
  description: string;
  parentLocationId: string;       // typically "OUTDOOR"
  items: Item[];
  clues: ScenarioClue[];
  conditions: ScenarioCondition[];
  events: string[];
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
  parentLocationId: string;       // typically "OUTDOOR"
  /** Junction ID at the start */
  endpointA: string;
  /** Junction ID at the end */
  endpointB: string;
  /** Minutes to walk the full length */
  travelTimeMinutes: number;
  /** Buildings accessible along this road */
  alongConnections: AlongConnection[];
  items: Item[];
  clues: ScenarioClue[];
  conditions: ScenarioCondition[];
  events: string[];
}

/**
 * Character position — where a character currently is in the topology.
 */
export type CharacterPosition =
  | { type: "junction"; junctionId: string }
  | { type: "road"; roadId: string; position: number }  // 0.0–1.0
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
  sceneToParent: Map<string, {
    type: "junction";
    junctionId: string;
  } | {
    type: "road";
    roadId: string;
    position: number;
  }>;
}

/**
 * Build a TownTopology index from loaded junctions and roads.
 */
export function buildTopology(
  junctions: Map<string, JunctionNode>,
  roads: Map<string, RoadNode>
): TownTopology {
  const junctionToRoads = new Map<string, RoadNode[]>();
  const sceneToParent = new Map<string, { type: "junction"; junctionId: string } | { type: "road"; roadId: string; position: number }>();

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
