/**
 * One-time topology alignment script.
 * Reads Tiled map coordinates from map.tmj and corrects ROAD_*.json
 * alongConnections positions + travelTimeMinutes, and transport_edges.json.
 *
 * Usage: npx tsx scripts/alignTopology.ts
 */

import fs from "node:fs";
import path from "node:path";

// ── Paths ──────────────────────────────────────────────────────────────────
const BASE = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "../data/Mods/casssandra"
);
const SCENARIOS = path.join(BASE, "Cassandra_Scenarios");
const TMJ_PATH = path.join(BASE, "scene/map.tmj");
const EDGES_PATH = path.join(BASE, "transport_edges.json");

// ── Building name → SCN ID mapping ─────────────────────────────────────────
const BUILDING_TO_SCN: Record<string, string> = {
  火车站: "SCN_21",
  钟表店: "SCN_12",
  珊德拉的小屋: "SCN_14",
  花店: "SCN_9",
  酒厂: "SCN_13",
  海伦的餐桌: "SCN_10",
  占星小屋: "SCN_11",
  焚化厂: "SCN_2",
  医院: "SCN_1",
  阿道夫的房子: "SCN_15",
  五金店: "SCN_18",
  广场: "SCN_4",
  墓地: "SCN_19",
  伐木场: "SCN_20",
  镇长私宅: "SCN_22",
  教堂: "SCN_17",
  驯鹿酒吧: "SCN_16",
  马赛尔家: "SCN_5",
  警察局: "SCN_3",
  菲利普家: "SCN_8",
  下水道: "SCN_7",
  二层木屋: "SCN_6",
};

// ── Road name → ROAD ID mapping ────────────────────────────────────────────
// Tiled names may differ slightly; map by substring match
const ROAD_NAME_MAP: Record<string, string> = {
  旧街: "ROAD_4",
  北新街: "ROAD_2",
  星辰: "ROAD_1", // 星辰大道 or 星晨大道
  石榴: "ROAD_POMEGRANATE", // split into 5a+5b later
  日暮: "ROAD_10",
  南新街: "ROAD_3",
  "A大道-北": "ROAD_6",
  "A大道-南": "ROAD_7",
  C大道: "ROAD_9",
  B大道: "ROAD_8",
};

// ── Which buildings sit on which road (plan spec) ──────────────────────────
const ROAD_BUILDINGS: Record<string, string[]> = {
  ROAD_1: ["SCN_1"],
  ROAD_2: ["SCN_11", "SCN_10", "SCN_9"],
  ROAD_3: ["SCN_16", "SCN_17", "SCN_18"],
  ROAD_4: ["SCN_12", "SCN_13", "SCN_14"],
  ROAD_5b: ["SCN_15", "SCN_22"],
  ROAD_6: ["SCN_4", "SCN_5"],
  ROAD_8: ["SCN_7"],
  ROAD_10: ["SCN_19", "SCN_20"],
};

// ── Junction coordinates (will be derived from polyline endpoints) ─────────
// These are the topology endpoints for each road
const ROAD_ENDPOINTS: Record<string, { a: string; b: string }> = {
  ROAD_1: { a: "JUNC_1", b: "JUNC_2" },
  ROAD_2: { a: "JUNC_2", b: "JUNC_3" },
  ROAD_3: { a: "JUNC_3", b: "JUNC_4" },
  ROAD_4: { a: "JUNC_3", b: "JUNC_7" },
  ROAD_5a: { a: "JUNC_2", b: "JUNC_6" },
  ROAD_5b: { a: "JUNC_6", b: "JUNC_4" },
  ROAD_6: { a: "JUNC_4", b: "JUNC_5" },
  ROAD_7: { a: "JUNC_5", b: "JUNC_8" },
  ROAD_8: { a: "JUNC_5", b: "JUNC_9" },
  ROAD_9: { a: "JUNC_5", b: "JUNC_10" },
  ROAD_10: { a: "JUNC_6", b: "JUNC_11" },
};

// ── Baseline: ROAD_10 (日暮大道) = 15 min ──────────────────────────────────
const BASELINE_ROAD = "ROAD_10";
const BASELINE_MINUTES = 15;

// ── Types ──────────────────────────────────────────────────────────────────
interface Point {
  x: number;
  y: number;
}

interface TiledObject {
  id: number;
  name: string;
  x: number;
  y: number;
  polyline?: Array<{ x: number; y: number }>;
  point?: boolean;
}

interface TiledLayer {
  name: string;
  objects?: TiledObject[];
  type: string;
}

// ── Geometry helpers ───────────────────────────────────────────────────────
function dist(a: Point, b: Point): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

/** Compute cumulative arc lengths for a polyline. Returns array of length N. */
function cumulativeArcLengths(poly: Point[]): number[] {
  const lengths = [0];
  for (let i = 1; i < poly.length; i++) {
    lengths.push(lengths[i - 1] + dist(poly[i - 1], poly[i]));
  }
  return lengths;
}

/** Project a point onto a polyline, return 0-1 position and perpendicular distance. */
function projectOntoPolyline(
  pt: Point,
  poly: Point[]
): { position: number; distance: number } {
  const arcLengths = cumulativeArcLengths(poly);
  const totalLength = arcLengths[arcLengths.length - 1];

  let bestDist = Number.POSITIVE_INFINITY;
  let bestArcPos = 0;

  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    const segLen = dist(a, b);
    if (segLen < 1e-9) continue;

    // Project pt onto segment a→b, clamped to [0,1]
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    let t = ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));

    const proj = { x: a.x + t * dx, y: a.y + t * dy };
    const d = dist(pt, proj);

    if (d < bestDist) {
      bestDist = d;
      bestArcPos = arcLengths[i] + t * segLen;
    }
  }

  return {
    position: totalLength > 0 ? bestArcPos / totalLength : 0,
    distance: bestDist,
  };
}

function polylineLength(poly: Point[]): number {
  const arcs = cumulativeArcLengths(poly);
  return arcs[arcs.length - 1];
}

// ── Step 1: Parse TMJ ─────────────────────────────────────────────────────
console.log("=== Step 1: Parse TMJ ===\n");

const tmj = JSON.parse(fs.readFileSync(TMJ_PATH, "utf-8"));
const layers = tmj.layers as TiledLayer[];

const buildingLayer = layers.find((l) => l.name === "building")!;
const roadLayer = layers.find((l) => l.name === "road")!;

// Parse buildings
const buildingPositions: Map<string, Point> = new Map();
for (const obj of buildingLayer.objects!) {
  const scnId = BUILDING_TO_SCN[obj.name];
  if (scnId) {
    buildingPositions.set(scnId, { x: obj.x, y: obj.y });
    console.log(
      `  ${obj.name} → ${scnId} @ (${obj.x.toFixed(1)}, ${obj.y.toFixed(1)})`
    );
  } else {
    console.log(`  WARNING: Unknown building "${obj.name}"`);
  }
}

// Parse road polylines → absolute coordinates
interface RoadPolyline {
  tiledName: string;
  roadId: string;
  points: Point[];
}

function matchRoadId(name: string): string {
  for (const [key, id] of Object.entries(ROAD_NAME_MAP)) {
    if (name.includes(key)) return id;
  }
  return "UNKNOWN";
}

const rawRoadPolylines: RoadPolyline[] = [];
for (const obj of roadLayer.objects!) {
  const absPoints = obj.polyline!.map((p) => ({
    x: obj.x + p.x,
    y: obj.y + p.y,
  }));
  const roadId = matchRoadId(obj.name);
  rawRoadPolylines.push({ tiledName: obj.name, roadId, points: absPoints });
  console.log(
    `  Road: "${obj.name}" → ${roadId}, ${absPoints.length} vertices, length=${polylineLength(absPoints).toFixed(0)}px`
  );
}

// ── Step 2: Infer junction positions from polyline endpoints ──────────────
console.log("\n=== Step 2: Infer junction positions ===\n");

// Junction coordinates are derived from known road endpoint pairs
const junctionCoords: Map<string, Point> = new Map();

// Manual junction assignment based on known road endpoint relationships
// (from the plan: which road start/end = which junction)
function findRoad(id: string): RoadPolyline | undefined {
  return rawRoadPolylines.find((r) => r.roadId === id);
}

function startPt(r: RoadPolyline): Point {
  return r.points[0];
}
function endPt(r: RoadPolyline): Point {
  return r.points[r.points.length - 1];
}

// JUNC_1 = 星辰大道 start
const road1 = findRoad("ROAD_1")!;
junctionCoords.set("JUNC_1", startPt(road1));

// JUNC_2 = 星辰大道 end ≈ 石榴巷 start ≈ 北新街 end
junctionCoords.set("JUNC_2", endPt(road1));

// JUNC_3 = 北新街 start ≈ 南新街 start ≈ 旧街 start
const road2 = findRoad("ROAD_2")!;
junctionCoords.set("JUNC_3", startPt(road2));

// JUNC_7 = the end of 旧街 that is NOT JUNC_3
// 旧街 (ROAD_4) goes JUNC_3↔JUNC_7. We already know JUNC_3, so pick the far end.
const road4 = findRoad("ROAD_4")!;
const road4Start = startPt(road4);
const road4End = endPt(road4);
const road4StartToJ3 = dist(road4Start, junctionCoords.get("JUNC_3")!);
const road4EndToJ3 = dist(road4End, junctionCoords.get("JUNC_3")!);
junctionCoords.set(
  "JUNC_7",
  road4StartToJ3 > road4EndToJ3 ? road4Start : road4End
);

// JUNC_4 = 南新街 end ≈ A大道北 start
const road3 = findRoad("ROAD_3")!;
junctionCoords.set("JUNC_4", endPt(road3));

// JUNC_5 = A大道北 end ≈ A大道南/B大道/C大道 start
const road6 = findRoad("ROAD_6")!;
junctionCoords.set("JUNC_5", endPt(road6));

// JUNC_8 = A大道南 end
const road7 = findRoad("ROAD_7")!;
junctionCoords.set("JUNC_8", endPt(road7));

// JUNC_9 = B大道 end
const road8 = findRoad("ROAD_8")!;
junctionCoords.set("JUNC_9", endPt(road8));

// JUNC_10 = C大道 end
const road9 = findRoad("ROAD_9")!;
junctionCoords.set("JUNC_10", endPt(road9));

// JUNC_11 = 日暮大道 end
const road10 = findRoad("ROAD_10")!;
junctionCoords.set("JUNC_11", endPt(road10));

// JUNC_6 = 日暮大道 start (which is also 石榴巷 split point)
junctionCoords.set("JUNC_6", startPt(road10));

for (const [jid, pt] of junctionCoords) {
  console.log(`  ${jid} → (${pt.x.toFixed(1)}, ${pt.y.toFixed(1)})`);
}

// ── Step 3: Determine polyline direction vs topology ──────────────────────
console.log("\n=== Step 3: Determine polyline direction ===\n");

// For each road, check if the polyline start is closer to endpointA or endpointB
// Build final polylines aligned A→B for each ROAD_ID
interface AlignedRoad {
  roadId: string;
  points: Point[]; // oriented A→B
  flipped: boolean;
}

const alignedRoads: Map<string, AlignedRoad> = new Map();

function alignRoad(roadId: string, poly: RoadPolyline): AlignedRoad {
  const ep = ROAD_ENDPOINTS[roadId];
  const juncA = junctionCoords.get(ep.a)!;
  const juncB = junctionCoords.get(ep.b)!;
  const start = startPt(poly);

  const distToA = dist(start, juncA);
  const distToB = dist(start, juncB);
  const flipped = distToB < distToA;

  const pts = flipped ? [...poly.points].reverse() : poly.points;
  console.log(
    `  ${roadId}: polyline start→${ep.a}=${distToA.toFixed(0)}px, start→${ep.b}=${distToB.toFixed(0)}px → ${flipped ? "FLIPPED" : "ok"}`
  );
  return { roadId, points: pts, flipped };
}

// Handle all non-pomegranate roads
for (const poly of rawRoadPolylines) {
  if (poly.roadId === "ROAD_POMEGRANATE") continue;
  if (poly.roadId === "UNKNOWN") continue;
  const aligned = alignRoad(poly.roadId, poly);
  alignedRoads.set(poly.roadId, aligned);
}

// ── Step 4: Split 石榴巷 (pomegranate lane) at JUNC_6 ─────────────────────
console.log("\n=== Step 4: Split pomegranate lane at JUNC_6 ===\n");

const pomegranate = rawRoadPolylines.find(
  (r) => r.roadId === "ROAD_POMEGRANATE"
)!;
const junc6 = junctionCoords.get("JUNC_6")!;

// Project JUNC_6 onto the full pomegranate polyline to find the split point
const projJ6 = projectOntoPolyline(junc6, pomegranate.points);
console.log(
  `  JUNC_6 projects onto pomegranate at position=${projJ6.position.toFixed(3)}, dist=${projJ6.distance.toFixed(1)}px`
);

// Split the polyline at projJ6.position
function splitPolylineAt(
  poly: Point[],
  position: number
): { before: Point[]; after: Point[] } {
  const arcs = cumulativeArcLengths(poly);
  const totalLen = arcs[arcs.length - 1];
  const targetArc = position * totalLen;

  for (let i = 0; i < poly.length - 1; i++) {
    if (arcs[i + 1] >= targetArc - 1e-9) {
      const segLen = arcs[i + 1] - arcs[i];
      const t = segLen > 0 ? (targetArc - arcs[i]) / segLen : 0;
      const splitPt: Point = {
        x: poly[i].x + t * (poly[i + 1].x - poly[i].x),
        y: poly[i].y + t * (poly[i + 1].y - poly[i].y),
      };
      return {
        before: [...poly.slice(0, i + 1), splitPt],
        after: [splitPt, ...poly.slice(i + 1)],
      };
    }
  }
  return { before: poly, after: [poly[poly.length - 1]] };
}

const { before: pomBefore, after: pomAfter } = splitPolylineAt(
  pomegranate.points,
  projJ6.position
);

// Now determine direction: pomegranate start → is it JUNC_2 or JUNC_4?
const pomStart = startPt(pomegranate);
const junc2 = junctionCoords.get("JUNC_2")!;
const junc4 = junctionCoords.get("JUNC_4")!;

const pomStartToJ2 = dist(pomStart, junc2);
const pomStartToJ4 = dist(pomStart, junc4);
const pomStartsAtJ2 = pomStartToJ2 < pomStartToJ4;

console.log(
  `  Pomegranate start→JUNC_2=${pomStartToJ2.toFixed(0)}px, →JUNC_4=${pomStartToJ4.toFixed(0)}px → starts at ${pomStartsAtJ2 ? "JUNC_2" : "JUNC_4"}`
);

// ROAD_5a: JUNC_2 → JUNC_6, ROAD_5b: JUNC_6 → JUNC_4
let road5aPoints: Point[];
let road5bPoints: Point[];

if (pomStartsAtJ2) {
  // polyline goes J2→J4, so before=5a, after=5b
  road5aPoints = pomBefore;
  road5bPoints = pomAfter;
} else {
  // polyline goes J4→J2, so before=5b(reversed), after=5a(reversed)
  road5aPoints = [...pomAfter].reverse();
  road5bPoints = [...pomBefore].reverse();
}

console.log(
  `  ROAD_5a: ${road5aPoints.length} pts, length=${polylineLength(road5aPoints).toFixed(0)}px`
);
console.log(
  `  ROAD_5b: ${road5bPoints.length} pts, length=${polylineLength(road5bPoints).toFixed(0)}px`
);

alignedRoads.set("ROAD_5a", {
  roadId: "ROAD_5a",
  points: road5aPoints,
  flipped: false,
});
alignedRoads.set("ROAD_5b", {
  roadId: "ROAD_5b",
  points: road5bPoints,
  flipped: false,
});

// ── Step 5: Project buildings onto roads ───────────────────────────────────
console.log("\n=== Step 5: Project buildings onto roads ===\n");

interface ProjectionResult {
  scnId: string;
  roadId: string;
  position: number;
  distance: number;
  oldPosition: number;
}

const projections: ProjectionResult[] = [];

for (const [roadId, scnIds] of Object.entries(ROAD_BUILDINGS)) {
  const aligned = alignedRoads.get(roadId);
  if (!aligned) {
    console.log(`  WARNING: No polyline for ${roadId}`);
    continue;
  }

  for (const scnId of scnIds) {
    const bldgPt = buildingPositions.get(scnId);
    if (!bldgPt) {
      console.log(`  WARNING: No building position for ${scnId}`);
      continue;
    }

    const proj = projectOntoPolyline(bldgPt, aligned.points);
    const rounded = Math.round(proj.position * 100) / 100;

    projections.push({
      scnId,
      roadId,
      position: rounded,
      distance: proj.distance,
      oldPosition: -1, // filled in Step 8
    });

    const warn = proj.distance > 300 ? " ⚠️ FAR!" : "";
    console.log(
      `  ${scnId} on ${roadId}: position=${rounded.toFixed(2)}, perpDist=${proj.distance.toFixed(0)}px${warn}`
    );
  }
}

// ── Step 6: Recalculate travel times by polyline length ───────────────────
console.log("\n=== Step 6: Recalculate travel times ===\n");

const roadLengths: Map<string, number> = new Map();
for (const [roadId, aligned] of alignedRoads) {
  const len = polylineLength(aligned.points);
  roadLengths.set(roadId, len);
}

const baselineLength = roadLengths.get(BASELINE_ROAD)!;
const pxPerMin = baselineLength / BASELINE_MINUTES;
console.log(
  `  Baseline: ${BASELINE_ROAD} = ${baselineLength.toFixed(0)}px / ${BASELINE_MINUTES}min = ${pxPerMin.toFixed(1)} px/min`
);

const newTravelTimes: Map<string, number> = new Map();
for (const [roadId, len] of roadLengths) {
  const mins = Math.max(1, Math.round(len / pxPerMin));
  newTravelTimes.set(roadId, mins);
  console.log(`  ${roadId}: ${len.toFixed(0)}px → ${mins} min`);
}

// ── Step 7: Recalculate transport_edges travel times ──────────────────────
console.log("\n=== Step 7: Recalculate transport edge times ===\n");

const edgesData = JSON.parse(fs.readFileSync(EDGES_PATH, "utf-8"));

// Build a lookup: scnId → { roadId, position } from projections
const scnRoadPos: Map<string, { roadId: string; position: number }> = new Map();
for (const p of projections) {
  scnRoadPos.set(p.scnId, { roadId: p.roadId, position: p.position });
}

// Also need junction-connected scenes (they are at position 0.0 or 1.0 of their roads)
// JUNC_1→SCN_2, JUNC_7→SCN_21, JUNC_8→SCN_3, JUNC_9→SCN_6, JUNC_10→SCN_8
const junctionScenes: Record<string, string> = {
  JUNC_1: "SCN_2",
  JUNC_7: "SCN_21",
  JUNC_8: "SCN_3",
  JUNC_9: "SCN_6",
  JUNC_10: "SCN_8",
};

// Build scnId → junctionId for junction-attached scenes
const scnToJunction: Map<string, string> = new Map();
for (const [juncId, scnId] of Object.entries(junctionScenes)) {
  scnToJunction.set(scnId, juncId);
}

/** Find the position of a scene on a given road. Returns null if not on that road. */
function findScenePositionOnRoad(scnId: string, roadId: string): number | null {
  // Check projections first
  const proj = scnRoadPos.get(scnId);
  if (proj && proj.roadId === roadId) return proj.position;

  // Check if scene is at a junction endpoint of this road
  const ep = ROAD_ENDPOINTS[roadId];
  if (!ep) return null;

  const juncId = scnToJunction.get(scnId);
  if (!juncId) return null;

  if (juncId === ep.a) return 0.0;
  if (juncId === ep.b) return 1.0;
  return null;
}

// ── Build a junction graph for shortest-path calculation ────────────────
// Each edge in the graph is a road segment between two junctions with a time cost.
interface JuncEdge {
  to: string;
  roadId: string;
  time: number;
}
const juncGraph: Map<string, JuncEdge[]> = new Map();

for (const [roadId, ep] of Object.entries(ROAD_ENDPOINTS)) {
  const time = newTravelTimes.get(roadId) ?? 5;
  if (!juncGraph.has(ep.a)) juncGraph.set(ep.a, []);
  if (!juncGraph.has(ep.b)) juncGraph.set(ep.b, []);
  juncGraph.get(ep.a)!.push({ to: ep.b, roadId, time });
  juncGraph.get(ep.b)!.push({ to: ep.a, roadId, time });
}

/** Dijkstra shortest path between two junctions. Returns total time in minutes. */
function shortestJunctionPath(from: string, to: string): number {
  if (from === to) return 0;
  const best = new Map<string, number>();
  const queue: Array<{ junc: string; cost: number }> = [
    { junc: from, cost: 0 },
  ];
  best.set(from, 0);

  while (queue.length > 0) {
    queue.sort((a, b) => a.cost - b.cost);
    const { junc, cost } = queue.shift()!;
    if (junc === to) return cost;
    if (cost > (best.get(junc) ?? Number.POSITIVE_INFINITY)) continue;

    for (const edge of juncGraph.get(junc) ?? []) {
      const newCost = cost + edge.time;
      if (newCost < (best.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
        best.set(edge.to, newCost);
        queue.push({ junc: edge.to, cost: newCost });
      }
    }
  }
  return Number.POSITIVE_INFINITY;
}

/** Get the time from a scene to a specific junction, via its road. */
function sceneToJunctionTime(scnId: string, targetJunc: string): number | null {
  // Scene on a road
  const info = scnRoadPos.get(scnId);
  if (info) {
    const ep = ROAD_ENDPOINTS[info.roadId];
    const roadTime = newTravelTimes.get(info.roadId) ?? 5;
    // Time to endpointA and endpointB
    const timeToA = info.position * roadTime;
    const timeToB = (1 - info.position) * roadTime;
    // If target is one of this road's endpoints, return directly
    if (targetJunc === ep.a) return timeToA;
    if (targetJunc === ep.b) return timeToB;
    // Otherwise, go to nearest endpoint then Dijkstra to target
    const viaA = timeToA + shortestJunctionPath(ep.a, targetJunc);
    const viaB = timeToB + shortestJunctionPath(ep.b, targetJunc);
    return Math.min(viaA, viaB);
  }
  // Scene at a junction
  const junc = scnToJunction.get(scnId);
  if (junc) {
    if (junc === targetJunc) return 0;
    return shortestJunctionPath(junc, targetJunc);
  }
  return null;
}

/** Compute travel time between two scenes via the road graph. */
function computeEdgeTravelTime(
  fromScnId: string,
  toScnId: string,
  _streetSceneId: string
): number {
  const fromInfo = scnRoadPos.get(fromScnId);
  const toInfo = scnRoadPos.get(toScnId);
  const fromJunc = scnToJunction.get(fromScnId);
  const toJunc = scnToJunction.get(toScnId);

  // Case 1: Both on the same road
  if (fromInfo && toInfo && fromInfo.roadId === toInfo.roadId) {
    const roadTime = newTravelTimes.get(fromInfo.roadId) ?? 5;
    return Math.max(
      1,
      Math.ceil(Math.abs(fromInfo.position - toInfo.position) * roadTime)
    );
  }

  // Case 2: Both at junctions
  if (fromJunc && toJunc) {
    const t = shortestJunctionPath(fromJunc, toJunc);
    return Math.max(1, Math.ceil(t));
  }

  // Case 3: One on a road, one at a junction (or on a different road)
  // Strategy: try all junction connections and find the shortest total path
  let bestTime = Number.POSITIVE_INFINITY;

  // Get "anchor points" for from: junctions it can reach directly
  const fromAnchors: Array<{ junc: string; time: number }> = [];
  if (fromInfo) {
    const ep = ROAD_ENDPOINTS[fromInfo.roadId];
    const roadTime = newTravelTimes.get(fromInfo.roadId) ?? 5;
    fromAnchors.push({ junc: ep.a, time: fromInfo.position * roadTime });
    fromAnchors.push({ junc: ep.b, time: (1 - fromInfo.position) * roadTime });
  } else if (fromJunc) {
    fromAnchors.push({ junc: fromJunc, time: 0 });
  }

  const toAnchors: Array<{ junc: string; time: number }> = [];
  if (toInfo) {
    const ep = ROAD_ENDPOINTS[toInfo.roadId];
    const roadTime = newTravelTimes.get(toInfo.roadId) ?? 5;
    toAnchors.push({ junc: ep.a, time: toInfo.position * roadTime });
    toAnchors.push({ junc: ep.b, time: (1 - toInfo.position) * roadTime });
  } else if (toJunc) {
    toAnchors.push({ junc: toJunc, time: 0 });
  }

  for (const fa of fromAnchors) {
    for (const ta of toAnchors) {
      const mid = shortestJunctionPath(fa.junc, ta.junc);
      const total = fa.time + mid + ta.time;
      if (total < bestTime) bestTime = total;
    }
  }

  if (bestTime < Number.POSITIVE_INFINITY) {
    return Math.max(1, Math.ceil(bestTime));
  }

  console.log(
    `  WARNING: Could not compute time for ${fromScnId} → ${toScnId}, using 5min default`
  );
  return 5;
}

for (const edge of edgesData.transportEdges) {
  const oldTime = edge.travelTimeMinutes;
  const newTime = computeEdgeTravelTime(
    edge.fromLocationId,
    edge.toLocationId,
    edge.streetSceneId
  );
  edge.travelTimeMinutes = newTime;
  const changed = oldTime !== newTime ? " ← CHANGED" : "";
  console.log(
    `  ${edge.fromLocationId} → ${edge.toLocationId} (${edge.streetSceneId}): ${oldTime}min → ${newTime}min${changed}`
  );
}

// ── Step 8: Write updated files ───────────────────────────────────────────
console.log("\n=== Step 8: Write updated files ===\n");

// Group projections by road
const projByRoad: Map<string, ProjectionResult[]> = new Map();
for (const p of projections) {
  if (!projByRoad.has(p.roadId)) projByRoad.set(p.roadId, []);
  projByRoad.get(p.roadId)!.push(p);
}

// Update each ROAD file
const allRoadIds = [
  "ROAD_1",
  "ROAD_2",
  "ROAD_3",
  "ROAD_4",
  "ROAD_5a",
  "ROAD_5b",
  "ROAD_6",
  "ROAD_7",
  "ROAD_8",
  "ROAD_9",
  "ROAD_10",
];

for (const roadId of allRoadIds) {
  const filePath = path.join(SCENARIOS, `${roadId}.json`);
  if (!fs.existsSync(filePath)) {
    console.log(`  WARNING: ${filePath} not found, skipping`);
    continue;
  }

  const roadData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  const oldTime = roadData.travelTimeMinutes;
  const newTime = newTravelTimes.get(roadId) ?? oldTime;

  // Update travel time
  roadData.travelTimeMinutes = newTime;

  // Update alongConnections positions
  const roadProjections = projByRoad.get(roadId) ?? [];
  for (const conn of roadData.alongConnections) {
    // Match by SCN prefix (conn.sceneId is like "SCN_11_SUB_1", we match on "SCN_11")
    const scnPrefix = conn.sceneId.replace(/_SUB_\d+$/, "");
    const proj = roadProjections.find((p) => p.scnId === scnPrefix);
    if (proj) {
      proj.oldPosition = conn.position;
      const oldPos = conn.position;
      conn.position = proj.position;
      console.log(
        `  ${roadId}: ${conn.sceneId} position ${oldPos} → ${proj.position}${oldPos !== proj.position ? " ← CHANGED" : ""}`
      );
    }
  }

  const timeChanged = oldTime !== newTime ? " ← CHANGED" : "";
  console.log(`  ${roadId}: travelTime ${oldTime} → ${newTime}${timeChanged}`);

  fs.writeFileSync(filePath, JSON.stringify(roadData, null, 2) + "\n");
}

// Write transport_edges
fs.writeFileSync(EDGES_PATH, JSON.stringify(edgesData, null, 2) + "\n");
console.log(`  Wrote ${EDGES_PATH}`);

// ── Verification summary ──────────────────────────────────────────────────
console.log("\n=== Verification Summary ===\n");

// Check perpendicular distances
const farBuildings = projections.filter((p) => p.distance > 300);
if (farBuildings.length > 0) {
  console.log("⚠️  Buildings far from their road (>300px):");
  for (const p of farBuildings) {
    console.log(
      `  ${p.scnId} on ${p.roadId}: ${p.distance.toFixed(0)}px perpendicular distance`
    );
  }
} else {
  console.log("✓ All buildings within 300px of their road");
}

// Check travel times range
const badTimes = [...newTravelTimes.entries()].filter(
  ([_, t]) => t < 1 || t > 20
);
if (badTimes.length > 0) {
  console.log("⚠️  Travel times outside 1-20min range:");
  for (const [id, t] of badTimes) {
    console.log(`  ${id}: ${t}min`);
  }
} else {
  console.log("✓ All travel times in 1-20min range");
}

// Print full comparison table
console.log("\n=== Full Position Comparison ===\n");
console.log(
  "Road         | Scene      | Old Pos | New Pos | Perp Dist | Status"
);
console.log(
  "-------------|------------|---------|---------|-----------|-------"
);
for (const p of projections) {
  const status =
    p.oldPosition === p.position
      ? "same"
      : p.oldPosition === -1
        ? "NEW"
        : "changed";
  console.log(
    `${p.roadId.padEnd(12)} | ${p.scnId.padEnd(10)} | ${p.oldPosition.toFixed(2).padStart(7)} | ${p.position.toFixed(2).padStart(7)} | ${p.distance.toFixed(0).padStart(7)}px | ${status}`
  );
}

console.log("\nDone! Files updated in place.");
