// src/state/perceivedLocation.ts
//
// One resolver for "where is this character, and what can they perceive from
// there" — covering all three CharacterPosition kinds.
//
// Both the perceivable directory and the renderer used to compute this as
// `position.type === "scene" ? position.sceneId : null`, which made a
// character on a road or at a junction perceive NOTHING: no citable place, no
// co-located people, no items underfoot, no local conditions. Since every
// cross-scene trip spends its whole duration on roads and junctions, a
// traveller was effectively blind for the entire walk — observed live as an
// NPC citing the road he was standing on and having the decision rejected.
//
// Roads and junctions carry the same `items` / `conditions` / connection data
// scenes do, so one uniform view serves all three.

import type { SceneCondition } from "../engine/core/types.js";
import type { DynamicGameStateManager } from "./DynamicGameState.js";
import type { CharacterPosition } from "./topologyTypes.js";
import type { Item } from "./types.js";

/** A location as perceived from inside it, regardless of its topology kind. */
export interface PerceivedLocation {
  id: string;
  kind: "scene" | "junction" | "road";
  name: string;
  description: string;
  conditions: SceneCondition[];
  items: Item[];
  /** Place ids one hop away — the citation scope beyond the current place. */
  adjacentIds: string[];
}

/** Two travellers count as together while within this many minutes' walk of
 *  each other along the same road. Without a bound, everyone strung out along
 *  a long street would perceive each other as co-present. */
const ROAD_PROXIMITY_MINUTES = 1;

export function resolvePerceivedLocation(
  position: CharacterPosition | null | undefined,
  dgsm: DynamicGameStateManager
): PerceivedLocation | null {
  if (!position) return null;
  const topology = dgsm.getTopology();

  if (position.type === "scene") {
    const scene = dgsm.getScene(position.sceneId);
    if (!scene) return null;
    return {
      id: scene.id,
      kind: "scene",
      name: scene.name,
      description: scene.description ?? "",
      conditions: dgsm.getSceneConditions(scene.id),
      items: scene.items ?? [],
      // `getScene` answers null, not undefined, for an id it does not know —
      // so the old `!== undefined` test kept everything it meant to drop.
      adjacentIds: (scene.connections ?? [])
        .map((c) => c.targetId)
        .filter((id) => dgsm.getScene(id) != null),
    };
  }

  if (position.type === "junction") {
    const junction = topology.junctions.get(position.junctionId);
    if (!junction) return null;
    return {
      id: junction.id,
      kind: "junction",
      name: junction.name,
      description: junction.description ?? "",
      conditions: dgsm.getSceneConditions(junction.id),
      items: junction.items ?? [],
      adjacentIds: [
        ...junction.connectedSceneIds,
        ...(topology.junctionToRoads.get(junction.id) ?? []).map((r) => r.id),
      ],
    };
  }

  const road = topology.roads.get(position.roadId);
  if (!road) return null;
  return {
    id: road.id,
    kind: "road",
    name: road.name,
    description: road.description ?? "",
    conditions: dgsm.getSceneConditions(road.id),
    items: road.items ?? [],
    adjacentIds: [
      road.endpointA,
      road.endpointB,
      ...road.alongConnections.map((a) => a.sceneId),
    ],
  };
}

/** Same view, addressed by id — for callers holding only a location id
 *  (the renderer's prompt formatter). */
export function resolveLocationById(
  locationId: string,
  dgsm: DynamicGameStateManager
): PerceivedLocation | null {
  if (!locationId) return null;
  const topology = dgsm.getTopology();
  if (dgsm.getScene(locationId)) {
    return resolvePerceivedLocation(
      { type: "scene", sceneId: locationId },
      dgsm
    );
  }
  if (topology.junctions.has(locationId)) {
    return resolvePerceivedLocation(
      { type: "junction", junctionId: locationId },
      dgsm
    );
  }
  if (topology.roads.has(locationId)) {
    return resolvePerceivedLocation(
      { type: "road", roadId: locationId, position: 0.5 },
      dgsm
    );
  }
  return null;
}

/** Ids of the living characters sharing this actor's location — scene,
 *  junction, or a nearby stretch of the same road. Excludes the actor. */
export function charactersAtSameLocation(
  actorId: string,
  dgsm: DynamicGameStateManager
): string[] {
  const actorPos = dgsm.getCharacterPosition(actorId);
  if (!actorPos) return [];
  const topology = dgsm.getTopology();
  const out: string[] = [];

  for (const npc of dgsm.getState().npcCharacters) {
    if (npc.id === actorId) continue;
    if (!dgsm.isNpcAlive(npc.id)) continue;
    const pos = dgsm.getCharacterPosition(npc.id);
    if (!pos || pos.type !== actorPos.type) continue;

    if (actorPos.type === "scene" && pos.type === "scene") {
      if (pos.sceneId === actorPos.sceneId) out.push(npc.id);
    } else if (actorPos.type === "junction" && pos.type === "junction") {
      if (pos.junctionId === actorPos.junctionId) out.push(npc.id);
    } else if (actorPos.type === "road" && pos.type === "road") {
      if (pos.roadId !== actorPos.roadId) continue;
      const travel =
        topology.roads.get(actorPos.roadId)?.travelTimeMinutes ?? 1;
      const apartMinutes = Math.abs(pos.position - actorPos.position) * travel;
      if (apartMinutes <= ROAD_PROXIMITY_MINUTES) out.push(npc.id);
    }
  }
  return out;
}

