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
// This resolver is also the single choke point for what is IN PLAIN VIEW.
// There is no hidden flag: an item in plain view is a fixture the place's
// setting cites, or a loose thing with a placement and no container. An item
// sitting in a container (a drawer, a closed cabinet) and a passage marked
// `concealed` are physically out of sight. Neither reaches perception — not
// the rendered narrative, not the citable directory — unless this viewer
// noticed it this minute (`noticed`). All branches filter here so no caller
// can leak an unnoticed thing by reading the raw node.

import type { SceneCondition } from "../engine/core/types.js";
import type { DynamicGameStateManager } from "./DynamicGameState.js";
import type { CharacterPosition } from "./topologyTypes.js";
import type { Item } from "./types.js";

/** A location as perceived from inside it, regardless of its topology kind. */
export interface PerceivedLocation {
  id: string;
  kind: "scene" | "road";
  name: string;
  /** The place itself (schema v3). */
  setting: string;
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

/** What a viewer noticed this minute beyond what is in plain view: an item
 *  sitting in a container, a concealed passage. Decided per render
 *  (concealment design §5.3); absent, only plain view counts. */
export interface NoticedThisMinute {
  itemIds?: ReadonlySet<string>;
  connectionIds?: ReadonlySet<string>;
}

const CITATION_RE = /\[([^\[\]\s]+)\]/g;

/** The ids a piece of prose cites as `[id]`. */
export function citedIds(prose: string | undefined): Set<string> {
  const out = new Set<string>();
  for (const m of (prose ?? "").matchAll(CITATION_RE)) out.add(m[1]);
  return out;
}

/** In plain view for anyone at the place: a fixture its setting cites, or a
 *  loose thing with a placement and no container. Pass a precomputed
 *  `citedIds(setting)` set when testing many items of one place. */
export function isInPlainView(
  item: Item,
  setting: string | undefined | ReadonlySet<string>
): boolean {
  const cited = typeof setting === "object" ? setting : citedIds(setting);
  if (cited.has(item.id)) return true;
  return Boolean(item.placement) && item.container === undefined;
}

/** True when this passage is in plain view, or this viewer noticed it. */
function passageVisible(
  connection: { id: string; concealed?: boolean },
  noticed: NoticedThisMinute | undefined
): boolean {
  if (!connection.concealed) return true;
  return noticed?.connectionIds?.has(connection.id) ?? false;
}

/**
 * @param _viewerId Whose eyes. Kept for callers; what differs between viewers
 *   now arrives as `noticed`, so the trust boundary and the renderer must be
 *   given the same `noticed` or the citable set and the rendered set stop
 *   agreeing.
 * @param noticed What this viewer noticed this minute beyond plain view.
 */
export function resolvePerceivedLocation(
  position: CharacterPosition | null | undefined,
  dgsm: DynamicGameStateManager,
  _viewerId?: string,
  noticed?: NoticedThisMinute
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
      setting: scene.setting ?? "",
      conditions: dgsm.getSceneConditions(scene.id),
      items: [
        ...visibleItems(scene.items, scene.setting, noticed),
        ...vehiclesHere.map((v) => ({
          id: v.id,
          name: v.name,
          description: v.description,
        })),
      ],
      // `getScene` answers null, not undefined, for an id it does not know —
      // so the old `!== undefined` test kept everything it meant to drop.
      // Concealed passages stay out unless noticed this minute: an unseen
      // door must not enter the citable set. A node scene (street, yard)
      // additionally sees its incident roads — a road is never concealed.
      adjacentIds: [
        ...(scene.connections ?? [])
          .filter((c) => passageVisible(c, noticed))
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
  // `alongConnections` is derived with concealed entries included; the flag
  // lives on the authored `access` connection, matched by sceneId. The two
  // endpoint node scenes are always visible — you can see where a road leads
  // even before you have noticed every doorway along it.
  // A doorway scene is out of view only when EVERY access to it is: an open
  // door beside a concealed one still shows the place.
  const accessByTarget = new Map<string, boolean>();
  for (const c of road.connections ?? []) {
    if (c.role !== "access") continue;
    accessByTarget.set(
      c.targetId,
      (accessByTarget.get(c.targetId) ?? false) || passageVisible(c, noticed)
    );
  }
  const hiddenAccessIds = new Set(
    [...accessByTarget].filter(([, visible]) => !visible).map(([id]) => id)
  );
  return {
    id: road.id,
    kind: "road",
    name: road.name,
    setting: road.setting ?? "",
    conditions: dgsm.getSceneConditions(road.id),
    items: [
      ...visibleItems(road.items, road.setting, noticed).filter(
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

/** The items in plain view — fixtures and loose placed things — plus the
 *  ones in containers this viewer noticed this minute. */
function visibleItems(
  items: Item[] | undefined,
  setting: string | undefined,
  noticed: NoticedThisMinute | undefined
): Item[] {
  const cited = citedIds(setting);
  return (items ?? []).filter(
    (item) =>
      isInPlainView(item, cited) || (noticed?.itemIds?.has(item.id) ?? false)
  );
}

/** The items at this position that are NOT in plain view — the things in
 *  containers a viewer may or may not notice (concealment design §5.3,
 *  setting design §5.3). Road items keep the reach radius. */
export function unnoticedCandidates(
  position: CharacterPosition | null | undefined,
  dgsm: DynamicGameStateManager
): { items: Item[]; connectionIds: string[] } {
  if (!position) return { items: [], connectionIds: [] };
  const topology = dgsm.getTopology();
  if (position.type === "scene") {
    const scene = dgsm.getScene(position.sceneId);
    if (!scene) return { items: [], connectionIds: [] };
    const cited = citedIds(scene.setting);
    return {
      items: (scene.items ?? []).filter((i) => !isInPlainView(i, cited)),
      connectionIds: (scene.connections ?? [])
        .filter((c) => c.concealed)
        .map((c) => c.id),
    };
  }
  const road = topology.roads.get(position.roadId);
  if (!road) return { items: [], connectionIds: [] };
  const cited = citedIds(road.setting);
  return {
    items: (road.items ?? []).filter(
      (item) =>
        !isInPlainView(item, cited) &&
        (item.position === undefined ||
          Math.abs(item.position - position.position) *
            road.travelTimeMinutes <=
            ROAD_ITEM_REACH_MINUTES)
    ),
    connectionIds: (road.connections ?? [])
      .filter((c) => c.concealed)
      .map((c) => c.id),
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
