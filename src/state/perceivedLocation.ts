// src/state/perceivedLocation.ts
//
// One resolver for "where is this character, and what can they perceive from
// there" — covering both CharacterPosition kinds.
//
// Both the perceivable directory and the renderer used to compute this as
// `position.type === "scene" ? position.sceneId : null`, which made a
// character on a road perceive NOTHING: no citable place, no co-located
// people, no items underfoot, no local conditions. Since every cross-scene
// trip spends its whole duration on roads, a traveller was effectively blind
// for the entire walk — observed live as an NPC citing the road he was
// standing on and having the decision rejected.
//
// Roads carry the same `items` / `conditions` / connection data scenes do,
// so one uniform view serves both.
//
// This resolver is also the single choke point for `hidden`: an item or
// connection flagged hidden exists in the world (the Engine sees it, the
// trust boundary counts it as real) but must not reach perception — not the
// rendered narrative, not the citable directory. All three branches filter
// here so no caller can leak an unrevealed thing by reading the raw node.

import type { SceneCondition } from "../engine/core/types.js";
import type { DynamicGameStateManager } from "./DynamicGameState.js";
import type { CharacterPosition } from "./topologyTypes.js";
import type { Item } from "./types.js";

/** A location as perceived from inside it, regardless of its topology kind. */
export interface PerceivedLocation {
  id: string;
  kind: "scene" | "road";
  name: string;
  description: string;
  conditions: SceneCondition[];
  items: Item[];
  /** Place ids one hop away — the citation scope beyond the current place. */
  adjacentIds: string[];
  /** Road only: where along the length this view is taken from (0-1). */
  selfPosition?: number;
  /** Road only: the full walking length in minutes. */
  travelTimeMinutes?: number;
}

/** Two travellers count as together while within this many minutes' walk of
 *  each other along the same road. Without a bound, everyone strung out along
 *  a long street would perceive each other as co-present. */
const ROAD_PROXIMITY_MINUTES = 1;

/** A road item with a `position` is perceivable only within this many
 *  minutes' walk of it along the road. A positionless road item is ambient —
 *  visible anywhere along the length. The trust boundary and the renderer
 *  both read perception through this resolver, so what is rendered and what
 *  is citable stay one set. */
export const ROAD_ITEM_REACH_MINUTES = 5;

/** True when this passage is open to everyone, or this viewer has found it.
 *  `hidden` is the world's answer, `discoveredBy` this viewer's. */
function passageVisible(
  connection: { hidden?: boolean; discoveredBy?: string[] },
  viewerId: string | undefined
): boolean {
  if (!connection.hidden) return true;
  return (
    viewerId !== undefined && !!connection.discoveredBy?.includes(viewerId)
  );
}

/**
 * @param viewerId Whose eyes. Omit only where nobody is looking — resolving a
 *   place by id to print its NAME, say. A concealed passage one character has
 *   found is visible to them and to nobody else, so the viewer has to come
 *   with the position: the trust boundary and the renderer both read this
 *   resolver, and they must be given the same one or the citable set and the
 *   rendered set stop agreeing.
 */
export function resolvePerceivedLocation(
  position: CharacterPosition | null | undefined,
  dgsm: DynamicGameStateManager,
  viewerId?: string
): PerceivedLocation | null {
  if (!position) return null;
  const topology = dgsm.getTopology();

  if (position.type === "scene") {
    const scene = dgsm.getScene(position.sceneId);
    if (!scene) return null;
    // A vehicle standing here is perceivable (and citable) like an item;
    // from inside a vehicle's cab, the place the vehicle stands at is one
    // hop away — the view out the window.
    const vehiclesHere = (dgsm.getVehicles?.() ?? []).filter(
      (v) =>
        v.position.type === "scene" && v.position.sceneId === position.sceneId
    );
    const cabOf = dgsm.getVehicleByInterior?.(position.sceneId) ?? null;
    return {
      id: scene.id,
      kind: "scene",
      name: scene.name,
      description: scene.description ?? "",
      conditions: dgsm.getSceneConditions(scene.id),
      items: [
        ...visibleItems(scene.items),
        ...vehiclesHere.map((v) => ({
          id: v.id,
          name: v.name,
          description: v.description,
        })),
      ],
      // `getScene` answers null, not undefined, for an id it does not know —
      // so the old `!== undefined` test kept everything it meant to drop.
      // Hidden connections stay out until revealed: an unfound door must not
      // enter the citable set. A node scene (street, yard) additionally sees
      // its incident roads — a road has no hidden flag of its own.
      adjacentIds: [
        ...(scene.connections ?? [])
          .filter((c) => passageVisible(c, viewerId))
          .map((c) => c.targetId)
          .filter((id) => dgsm.getScene(id) != null),
        ...(topology.sceneToRoads.get(scene.id) ?? []).map((r) => r.id),
        // Interior of a vehicle: adjacent to wherever the vehicle stands.
        ...(cabOf
          ? [
              cabOf.position.type === "scene"
                ? cabOf.position.sceneId
                : cabOf.position.roadId,
            ]
          : []),
        // Vehicles parked here: their interiors are one door away.
        ...vehiclesHere.map((v) => v.interiorSceneId),
      ],
    };
  }

  const road = topology.roads.get(position.roadId);
  if (!road) return null;
  // `alongConnections` is derived with hidden entries included; the hidden
  // flag lives on the authored `access` connection, matched by sceneId. The
  // two endpoint node scenes are always visible — you can see where a road
  // leads even before you have found every doorway along it.
  const hiddenAccessIds = new Set(
    (road.connections ?? [])
      .filter((c) => c.role === "access" && !passageVisible(c, viewerId))
      .map((c) => c.targetId)
  );
  return {
    id: road.id,
    kind: "road",
    name: road.name,
    description: road.description ?? "",
    conditions: dgsm.getSceneConditions(road.id),
    items: [
      ...visibleItems(road.items).filter(
        (item) =>
          item.position === undefined ||
          Math.abs(item.position - position.position) *
            road.travelTimeMinutes <=
            ROAD_ITEM_REACH_MINUTES
      ),
      // Vehicles on this stretch, within the same reach radius.
      ...(dgsm.getVehicles?.() ?? [])
        .filter(
          (v) =>
            v.position.type === "road" &&
            v.position.roadId === position.roadId &&
            Math.abs(v.position.position - position.position) *
              road.travelTimeMinutes <=
              ROAD_ITEM_REACH_MINUTES
        )
        .map((v) => ({ id: v.id, name: v.name, description: v.description })),
    ],
    adjacentIds: [
      road.endpointA,
      road.endpointB,
      ...road.alongConnections
        .filter((a) => !hiddenAccessIds.has(a.sceneId))
        .map((a) => a.sceneId),
    ],
    selfPosition: position.position,
    travelTimeMinutes: road.travelTimeMinutes,
  };
}

/** Items minus the ones not yet revealed. */
function visibleItems(items: Item[] | undefined): Item[] {
  return (items ?? []).filter((item) => !item.hidden);
}

/** Same view, addressed by id — for callers holding only a location id
 *  (the renderer's prompt formatter). */
export function resolveLocationById(
  locationId: string,
  dgsm: DynamicGameStateManager
): PerceivedLocation | null {
  if (!locationId) return null;
  const topology = dgsm.getTopology();
  if (dgsm.getScene(locationId) && !topology.roads.has(locationId)) {
    return resolvePerceivedLocation(
      { type: "scene", sceneId: locationId },
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

/** Ids of the living characters sharing this actor's location — scene, or a
 *  nearby stretch of the same road. Excludes the actor. */
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
