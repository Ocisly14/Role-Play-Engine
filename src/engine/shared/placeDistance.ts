// src/engine/shared/placeDistance.ts
//
// How far apart two people stand, for perception. Sound and sight cross walls,
// floors and open ground directly; they do not walk the roads. So the measure
// is the straight line between two places' points (module `coordinates`), and
// only where a place has no point does this fall back to the walking time by
// the ways that join them — the next best thing, wrong where the way winds
// (two rooms sharing a wall without a door, the cliff top over the beach).
//
// Movement never reads this: travel time is the movement runtime's.

import type {
  CharacterPosition,
  RoadNode,
  VehicleState,
} from "../../state/topologyTypes.js";
import type { DynamicScene, PlaceCoordinates } from "../../state/types.js";

export interface PlaceLookup {
  scene(id: string): DynamicScene | null | undefined;
  road(id: string): RoadNode | null | undefined;
  vehicleByInterior(sceneId: string): VehicleState | null | undefined;
}

/** The point a position stands at, or null when its place has none. A road
 *  point lies on the straight line between its endpoint scenes; a vehicle's
 *  interior is wherever the vehicle is. */
export function pointOf(
  position: CharacterPosition,
  lookup: PlaceLookup,
  depth = 0
): PlaceCoordinates | null {
  if (depth > 3) return null;
  if (position.type === "road") {
    const road = lookup.road(position.roadId);
    const a = road ? lookup.scene(road.endpointA)?.coordinates : undefined;
    const b = road ? lookup.scene(road.endpointB)?.coordinates : undefined;
    if (!a || !b) return null;
    const t = Math.max(0, Math.min(1, position.position));
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
  }
  const own = lookup.scene(position.sceneId)?.coordinates;
  if (own) return own;
  const vehicle = lookup.vehicleByInterior(position.sceneId);
  return vehicle ? pointOf(vehicle.position, lookup, depth + 1) : null;
}

export function straightLineMeters(
  a: PlaceCoordinates,
  b: PlaceCoordinates
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Minutes for each passage between two scenes, and for stepping between a
 *  scene and the road outside its door. */
const DOOR_MINUTES = 1;

type Edge = { to: string; minutes: number };

/**
 * The places as a weighted graph: every scene, plus a point on each road
 * wherever something joins it. Scene↔scene passages and scene↔road doors
 * cost a minute; a road's stretches cost their share of its walking time.
 * Blocked passages are kept — this is distance, not access.
 */
export class WalkGraph {
  private readonly edges = new Map<string, Edge[]>();

  constructor(
    scenes: Iterable<DynamicScene>,
    roads: Iterable<RoadNode>,
    private readonly lookup: PlaceLookup
  ) {
    for (const scene of scenes) {
      for (const c of scene.connections) {
        if (lookup.scene(c.targetId)) {
          this.link(`s:${scene.id}`, `s:${c.targetId}`, DOOR_MINUTES);
        }
      }
    }
    for (const road of roads) {
      const stops: Array<{ at: number; node: string; cost: number }> = [
        { at: 0, node: `s:${road.endpointA}`, cost: 0 },
        { at: 1, node: `s:${road.endpointB}`, cost: 0 },
        ...road.alongConnections.map((a) => ({
          at: a.position,
          node: `s:${a.sceneId}`,
          cost: DOOR_MINUTES,
        })),
      ].sort((x, y) => x.at - y.at);
      let previous: string | null = null;
      let previousAt = 0;
      for (const stop of stops) {
        const point = WalkGraph.roadPoint(road.id, stop.at);
        this.link(point, stop.node, stop.cost);
        if (previous) {
          this.link(
            previous,
            point,
            (stop.at - previousAt) * road.travelTimeMinutes
          );
        }
        previous = point;
        previousAt = stop.at;
      }
    }
  }

  private static roadPoint(roadId: string, at: number): string {
    return `r:${roadId}@${at}`;
  }

  private link(a: string, b: string, minutes: number): void {
    if (a === b) return;
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      const list = this.edges.get(from) ?? [];
      list.push({ to, minutes });
      this.edges.set(from, list);
    }
  }

  /** Nodes a position starts from, with the minutes to reach each. */
  private entry(position: CharacterPosition): Edge[] {
    if (position.type === "scene") {
      const vehicle = this.lookup.vehicleByInterior(position.sceneId);
      if (vehicle && !this.edges.has(`s:${position.sceneId}`)) {
        return this.entry(vehicle.position);
      }
      return [{ to: `s:${position.sceneId}`, minutes: 0 }];
    }
    const road = this.lookup.road(position.roadId);
    if (!road) return [];
    const ats = [0, 1, ...road.alongConnections.map((a) => a.position)];
    const p = position.position;
    const below = Math.max(...ats.filter((at) => at <= p));
    const above = Math.min(...ats.filter((at) => at >= p));
    return [
      {
        to: WalkGraph.roadPoint(road.id, below),
        minutes: (p - below) * road.travelTimeMinutes,
      },
      {
        to: WalkGraph.roadPoint(road.id, above),
        minutes: (above - p) * road.travelTimeMinutes,
      },
    ];
  }

  /** Shortest walking minutes between two positions; null = not joined. */
  minutes(from: CharacterPosition, to: CharacterPosition): number | null {
    const targets = new Map(
      this.entry(to).map((e) => [e.to, e.minutes] as const)
    );
    if (targets.size === 0) return null;
    const dist = new Map<string, number>();
    const frontier: Array<{ node: string; d: number }> = [];
    for (const e of this.entry(from)) {
      if ((dist.get(e.to) ?? Number.POSITIVE_INFINITY) > e.minutes) {
        dist.set(e.to, e.minutes);
        frontier.push({ node: e.to, d: e.minutes });
      }
    }
    let best = Number.POSITIVE_INFINITY;
    const done = new Set<string>();
    while (frontier.length > 0) {
      frontier.sort((x, y) => x.d - y.d);
      const { node, d } = frontier.shift() as { node: string; d: number };
      if (done.has(node) || d >= best) continue;
      done.add(node);
      const tail = targets.get(node);
      if (tail !== undefined) best = Math.min(best, d + tail);
      for (const e of this.edges.get(node) ?? []) {
        const nd = d + e.minutes;
        if (nd < (dist.get(e.to) ?? Number.POSITIVE_INFINITY)) {
          dist.set(e.to, nd);
          frontier.push({ node: e.to, d: nd });
        }
      }
    }
    return Number.isFinite(best) ? best : null;
  }
}
