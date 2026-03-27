import {
  buildTopology,
  type CharacterPosition,
} from "../state/topologyTypes.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { KnownMapSeed, ScenarioOutline } from "../state/types.js";
import type { KnownMapIds, KnownMapScene, KnownMapSnapshot } from "./types.js";

const MAP_SCHEMA_VERSION = 1;

interface MutableKnownMapIds {
  sceneIds: Set<string>;
  junctionIds: Set<string>;
  roadIds: Set<string>;
  scenarioOutlineIds: Set<string>;
}

interface BlockedConnectionRef {
  type: "scene" | "junction" | "road";
  id: string;
}

interface BuildKnownMapSnapshotOptions {
  revealedHiddenConnections?: string[];
  nameOnlySceneIds?: string[];
  currentLocationId?: string;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function emptyKnownMapIds(): MutableKnownMapIds {
  return {
    sceneIds: new Set<string>(),
    junctionIds: new Set<string>(),
    roadIds: new Set<string>(),
    scenarioOutlineIds: new Set<string>(),
  };
}

function toMutable(ids?: Partial<KnownMapIds>): MutableKnownMapIds {
  return {
    sceneIds: new Set(ids?.sceneIds ?? []),
    junctionIds: new Set(ids?.junctionIds ?? []),
    roadIds: new Set(ids?.roadIds ?? []),
    scenarioOutlineIds: new Set(ids?.scenarioOutlineIds ?? []),
  };
}

export function serializeKnownMapIds(ids: MutableKnownMapIds): KnownMapIds {
  return {
    sceneIds: [...ids.sceneIds].sort(),
    junctionIds: [...ids.junctionIds].sort(),
    roadIds: [...ids.roadIds].sort(),
    scenarioOutlineIds: [...ids.scenarioOutlineIds].sort(),
  };
}

export function mergeKnownMapIds(
  base: KnownMapIds,
  extra: KnownMapIds
): KnownMapIds {
  const merged = toMutable(base);
  for (const id of extra.sceneIds) merged.sceneIds.add(id);
  for (const id of extra.junctionIds) merged.junctionIds.add(id);
  for (const id of extra.roadIds) merged.roadIds.add(id);
  for (const id of extra.scenarioOutlineIds) {
    merged.scenarioOutlineIds.add(id);
  }
  return serializeKnownMapIds(merged);
}

function areSortedStringArraysEqual(
  left: string[] | undefined,
  right: string[] | undefined
): boolean {
  const a = left ?? [];
  const b = right ?? [];
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

export function areKnownMapIdsEqual(
  left: KnownMapIds,
  right: KnownMapIds
): boolean {
  return (
    areSortedStringArraysEqual(left.sceneIds, right.sceneIds) &&
    areSortedStringArraysEqual(left.junctionIds, right.junctionIds) &&
    areSortedStringArraysEqual(left.roadIds, right.roadIds) &&
    areSortedStringArraysEqual(
      left.scenarioOutlineIds,
      right.scenarioOutlineIds
    )
  );
}

export function areKnownMapConnectionKeysEqual(
  left: string[] | undefined,
  right: string[] | undefined
): boolean {
  return areSortedStringArraysEqual(left, right);
}

export function knownMapIdsContainLocation(
  knownIds: KnownMapIds,
  locationId: string
): boolean {
  return (
    knownIds.sceneIds.includes(locationId) ||
    knownIds.junctionIds.includes(locationId) ||
    knownIds.roadIds.includes(locationId)
  );
}

export function makeKnownMapConnectionKey(
  sceneId: string,
  targetId: string
): string {
  return `${sceneId}::${targetId}`;
}

export function normalizeKnownMapConnectionKeys(
  dgsm: DynamicGameStateManager,
  keys: string[] | undefined
): string[] {
  if (!keys?.length) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const key of keys) {
    const [sceneId, targetId] = key.split("::");
    if (!sceneId || !targetId || seen.has(key)) continue;

    const scene = dgsm.getState().scenes.get(sceneId);
    const connection = scene?.connections?.find(
      (candidate) => candidate.targetId === targetId
    );
    if (!scene || !connection?.hidden) continue;

    seen.add(key);
    normalized.push(key);
  }

  return normalized.sort();
}

export function createFullKnownMapIds(
  dgsm: DynamicGameStateManager
): KnownMapIds {
  const state = dgsm.getState();
  return {
    sceneIds: [...state.scenes.keys()].sort(),
    junctionIds: [...state.junctions.keys()].sort(),
    roadIds: [...state.roads.keys()].sort(),
    scenarioOutlineIds: (state.scenarioOutlines ?? [])
      .map((outline) => outline.id)
      .sort(),
  };
}

function addSceneBase(
  dgsm: DynamicGameStateManager,
  knownIds: MutableKnownMapIds,
  sceneId: string
): void {
  const scene = dgsm.getState().scenes.get(sceneId);
  if (!scene) return;
  knownIds.sceneIds.add(sceneId);
  const outline = (dgsm.getState().scenarioOutlines ?? []).find(
    (candidate) => candidate.id === scene.parentLocationId
  );
  if (outline) knownIds.scenarioOutlineIds.add(outline.id);
}

function addJunctionBase(
  dgsm: DynamicGameStateManager,
  knownIds: MutableKnownMapIds,
  junctionId: string
): void {
  if (dgsm.getState().junctions.has(junctionId)) {
    knownIds.junctionIds.add(junctionId);
  }
}

function addRoadBase(
  dgsm: DynamicGameStateManager,
  knownIds: MutableKnownMapIds,
  roadId: string
): void {
  if (dgsm.getState().roads.has(roadId)) {
    knownIds.roadIds.add(roadId);
  }
}

function addOutlineBase(
  dgsm: DynamicGameStateManager,
  knownIds: MutableKnownMapIds,
  outlineId: string
): void {
  const outline = (dgsm.getState().scenarioOutlines ?? []).find(
    (candidate) => candidate.id === outlineId
  );
  if (!outline) return;

  knownIds.scenarioOutlineIds.add(outlineId);
  if (outline.entrySceneId) {
    addSceneBase(dgsm, knownIds, outline.entrySceneId);
  }
}

function revealRoadNeighborhood(
  dgsm: DynamicGameStateManager,
  knownIds: MutableKnownMapIds,
  roadId: string
): void {
  const road = dgsm.getState().roads.get(roadId);
  if (!road) return;

  addRoadBase(dgsm, knownIds, roadId);
  addJunctionBase(dgsm, knownIds, road.endpointA);
  addJunctionBase(dgsm, knownIds, road.endpointB);
  for (const along of road.alongConnections ?? []) {
    addSceneBase(dgsm, knownIds, along.sceneId);
  }
}

function revealJunctionNeighborhood(
  dgsm: DynamicGameStateManager,
  knownIds: MutableKnownMapIds,
  junctionId: string
): void {
  const topology = dgsm.getTopology();
  const junction = topology.junctions.get(junctionId);
  if (!junction) return;

  addJunctionBase(dgsm, knownIds, junctionId);
  for (const sceneId of junction.connectedSceneIds ?? []) {
    addSceneBase(dgsm, knownIds, sceneId);
  }

  for (const road of topology.junctionToRoads.get(junctionId) ?? []) {
    revealRoadNeighborhood(dgsm, knownIds, road.id);
  }
}

function revealSceneNeighborhood(
  dgsm: DynamicGameStateManager,
  knownIds: MutableKnownMapIds,
  sceneId: string
): void {
  const state = dgsm.getState();
  const topology = dgsm.getTopology();
  const scene = state.scenes.get(sceneId);
  if (!scene) return;

  addSceneBase(dgsm, knownIds, sceneId);

  for (const connection of scene.connections ?? []) {
    if (connection.hidden) continue;
    const targetId = connection.targetId;
    if (state.scenes.has(targetId)) {
      addSceneBase(dgsm, knownIds, targetId);
    } else if (state.junctions.has(targetId)) {
      addJunctionBase(dgsm, knownIds, targetId);
    } else if (state.roads.has(targetId)) {
      addRoadBase(dgsm, knownIds, targetId);
    }
  }

  const parent = topology.sceneToParent.get(sceneId);
  if (!parent) return;

  if (parent.type === "junction") {
    revealJunctionNeighborhood(dgsm, knownIds, parent.junctionId);
    return;
  }

  revealRoadNeighborhood(dgsm, knownIds, parent.roadId);
}

function revealOutlineNeighborhood(
  dgsm: DynamicGameStateManager,
  knownIds: MutableKnownMapIds,
  outlineId: string
): void {
  const outline = (dgsm.getState().scenarioOutlines ?? []).find(
    (candidate) => candidate.id === outlineId
  );
  if (!outline) return;

  knownIds.scenarioOutlineIds.add(outlineId);
  if (outline.entrySceneId) {
    revealSceneNeighborhood(dgsm, knownIds, outline.entrySceneId);
  }
}

export function revealKnownMapLocations(
  dgsm: DynamicGameStateManager,
  base: KnownMapIds,
  locationIds: string[]
): KnownMapIds {
  const knownIds = toMutable(base);
  const state = dgsm.getState();

  for (const locationId of locationIds) {
    if (state.scenes.has(locationId)) {
      revealSceneNeighborhood(dgsm, knownIds, locationId);
      continue;
    }
    if (state.junctions.has(locationId)) {
      revealJunctionNeighborhood(dgsm, knownIds, locationId);
      continue;
    }
    if (state.roads.has(locationId)) {
      revealRoadNeighborhood(dgsm, knownIds, locationId);
      continue;
    }
    revealOutlineNeighborhood(dgsm, knownIds, locationId);
  }

  return normalizeKnownMapIds(dgsm, serializeKnownMapIds(knownIds));
}

export function revealKnownMapLocationsDirect(
  dgsm: DynamicGameStateManager,
  base: KnownMapIds,
  locationIds: string[]
): KnownMapIds {
  const knownIds = toMutable(base);
  const state = dgsm.getState();

  for (const locationId of locationIds) {
    if (state.scenes.has(locationId)) {
      addSceneBase(dgsm, knownIds, locationId);
      continue;
    }
    if (state.junctions.has(locationId)) {
      addJunctionBase(dgsm, knownIds, locationId);
      continue;
    }
    if (state.roads.has(locationId)) {
      addRoadBase(dgsm, knownIds, locationId);
      continue;
    }
    addOutlineBase(dgsm, knownIds, locationId);
  }

  return normalizeKnownMapIds(dgsm, serializeKnownMapIds(knownIds));
}

export function createKnownMapIdsFromSeed(
  dgsm: DynamicGameStateManager,
  seed?: KnownMapSeed
): KnownMapIds {
  if (!seed) {
    return createFullKnownMapIds(dgsm);
  }

  return normalizeKnownMapIds(dgsm, {
    sceneIds: seed.sceneIds ?? [],
    junctionIds: seed.junctionIds ?? [],
    roadIds: seed.roadIds ?? [],
    scenarioOutlineIds: seed.scenarioOutlineIds ?? [],
  });
}

function normalizeKnownMapIds(
  dgsm: DynamicGameStateManager,
  ids: KnownMapIds
): KnownMapIds {
  const state = dgsm.getState();
  const normalized = emptyKnownMapIds();
  const outlinesById = new Map(
    (state.scenarioOutlines ?? []).map((outline) => [outline.id, outline])
  );

  for (const sceneId of ids.sceneIds) {
    if (!state.scenes.has(sceneId)) continue;
    normalized.sceneIds.add(sceneId);
    const scene = state.scenes.get(sceneId);
    const outline = scene
      ? outlinesById.get(scene.parentLocationId)
      : undefined;
    if (outline) normalized.scenarioOutlineIds.add(outline.id);
  }

  for (const junctionId of ids.junctionIds) {
    if (state.junctions.has(junctionId)) {
      normalized.junctionIds.add(junctionId);
    }
  }

  for (const roadId of ids.roadIds) {
    if (state.roads.has(roadId)) {
      normalized.roadIds.add(roadId);
    }
  }

  for (const outlineId of ids.scenarioOutlineIds) {
    const outline = outlinesById.get(outlineId);
    if (!outline) continue;
    normalized.scenarioOutlineIds.add(outline.id);
    if (outline.entrySceneId && state.scenes.has(outline.entrySceneId)) {
      normalized.sceneIds.add(outline.entrySceneId);
    }
  }

  return serializeKnownMapIds(normalized);
}

function parseBlockedConnectionKey(
  key: string
): [BlockedConnectionRef, BlockedConnectionRef] | null {
  const [left, right] = key.split("::");
  if (!left || !right) return null;

  const parseRef = (value: string): BlockedConnectionRef | null => {
    const separatorIndex = value.indexOf(":");
    if (separatorIndex === -1) return null;
    const type = value.slice(0, separatorIndex);
    const id = value.slice(separatorIndex + 1);
    if (
      (type !== "scene" && type !== "junction" && type !== "road") ||
      id.length === 0
    ) {
      return null;
    }
    return { type, id };
  };

  const leftRef = parseRef(left);
  const rightRef = parseRef(right);
  if (!leftRef || !rightRef) return null;
  return [leftRef, rightRef];
}

function isKnownBlockedConnectionRef(
  knownIds: KnownMapIds,
  ref: BlockedConnectionRef
): boolean {
  switch (ref.type) {
    case "scene":
      return knownIds.sceneIds.includes(ref.id);
    case "junction":
      return knownIds.junctionIds.includes(ref.id);
    case "road":
      return knownIds.roadIds.includes(ref.id);
  }
}

function isKnownLocationId(knownIds: KnownMapIds, locationId: string): boolean {
  return (
    knownIds.sceneIds.includes(locationId) ||
    knownIds.junctionIds.includes(locationId) ||
    knownIds.roadIds.includes(locationId)
  );
}

function cloneRuntimeScene(
  dgsm: DynamicGameStateManager,
  sceneId: string,
  knownIds: KnownMapIds,
  revealedHiddenConnections: ReadonlySet<string>
): KnownMapScene | null {
  const state = dgsm.getState();
  const scene = state.scenes.get(sceneId);
  if (!scene) return null;

  const nextScene: KnownMapScene = cloneJson(scene);
  nextScene.conditions = cloneJson(
    state.scenarioConditions[sceneId] ?? scene.conditions ?? []
  );
  nextScene.connections = (scene.connections ?? [])
    .filter((connection) => isKnownLocationId(knownIds, connection.targetId))
    .map((connection) => {
      const nextConnection = cloneJson(connection);
      if (
        nextConnection.hidden &&
        revealedHiddenConnections.has(
          makeKnownMapConnectionKey(sceneId, nextConnection.targetId)
        )
      ) {
        nextConnection.hidden = false;
      }
      return nextConnection;
    });
  nextScene.detailLevel = "full";
  return nextScene;
}

function cloneNameOnlyScene(
  dgsm: DynamicGameStateManager,
  sceneId: string
): KnownMapScene | null {
  const scene = dgsm.getState().scenes.get(sceneId);
  if (!scene) return null;

  return {
    id: scene.id,
    name: scene.name,
    description: "",
    parentLocationId: scene.parentLocationId,
    items: [],
    conditions: [],
    connections: [],
    sceneImage: scene.sceneImage,
    indoor: scene.indoor,
    detailLevel: "name_only",
  };
}

function cloneRuntimeJunction(
  dgsm: DynamicGameStateManager,
  junctionId: string,
  knownIds: KnownMapIds
) {
  const state = dgsm.getState();
  const junction = state.junctions.get(junctionId);
  if (!junction) return null;

  const nextJunction = cloneJson(junction);
  nextJunction.conditions = cloneJson(
    state.scenarioConditions[junctionId] ?? junction.conditions ?? []
  );
  nextJunction.connectedSceneIds = (junction.connectedSceneIds ?? []).filter(
    (sceneId) => knownIds.sceneIds.includes(sceneId)
  );
  return nextJunction;
}

function cloneRuntimeRoad(
  dgsm: DynamicGameStateManager,
  roadId: string,
  knownIds: KnownMapIds
) {
  const state = dgsm.getState();
  const road = state.roads.get(roadId);
  if (!road) return null;

  const nextRoad = cloneJson(road);
  nextRoad.conditions = cloneJson(
    state.scenarioConditions[roadId] ?? road.conditions ?? []
  );
  nextRoad.alongConnections = (road.alongConnections ?? [])
    .filter((connection) => knownIds.sceneIds.includes(connection.sceneId))
    .map((connection) => cloneJson(connection));
  return nextRoad;
}

export function buildKnownMapSnapshot(
  dgsm: DynamicGameStateManager,
  knownIdsInput: KnownMapIds,
  options: BuildKnownMapSnapshotOptions = {}
): KnownMapSnapshot {
  const state = dgsm.getState();
  const knownIds = normalizeKnownMapIds(dgsm, knownIdsInput);
  const revealedHiddenConnections = normalizeKnownMapConnectionKeys(
    dgsm,
    options.revealedHiddenConnections
  );
  const revealedHiddenConnectionSet = new Set(revealedHiddenConnections);
  const nameOnlySceneIds = new Set(
    (options.nameOnlySceneIds ?? []).filter(
      (sceneId) =>
        knownIds.sceneIds.includes(sceneId) &&
        sceneId !== options.currentLocationId
    )
  );
  const scenes: KnownMapSnapshot["scenes"] = {};
  const junctions: KnownMapSnapshot["junctions"] = {};
  const roads: KnownMapSnapshot["roads"] = {};
  const blockedConnections: Record<string, string> = {};

  for (const sceneId of knownIds.sceneIds) {
    const scene = nameOnlySceneIds.has(sceneId)
      ? cloneNameOnlyScene(dgsm, sceneId)
      : cloneRuntimeScene(dgsm, sceneId, knownIds, revealedHiddenConnectionSet);
    if (scene) scenes[sceneId] = scene;
  }

  for (const junctionId of knownIds.junctionIds) {
    const junction = cloneRuntimeJunction(dgsm, junctionId, knownIds);
    if (junction) junctions[junctionId] = junction;
  }

  for (const roadId of knownIds.roadIds) {
    const road = cloneRuntimeRoad(dgsm, roadId, knownIds);
    if (road) roads[roadId] = road;
  }

  for (const [key, reason] of state.blockedConnections.entries()) {
    const refs = parseBlockedConnectionKey(key);
    if (!refs) continue;
    const [fromRef, toRef] = refs;
    if (
      !isKnownBlockedConnectionRef(knownIds, fromRef) ||
      !isKnownBlockedConnectionRef(knownIds, toRef)
    ) {
      continue;
    }
    blockedConnections[key] = reason;
  }

  const scenarioOutlines = (state.scenarioOutlines ?? [])
    .filter((outline) => knownIds.scenarioOutlineIds.includes(outline.id))
    .map((outline) => cloneJson(outline));

  const transportEdges = (state.transportEdges ?? [])
    .filter(
      (edge) =>
        knownIds.scenarioOutlineIds.includes(edge.fromLocationId) &&
        knownIds.scenarioOutlineIds.includes(edge.toLocationId) &&
        knownIds.sceneIds.includes(edge.streetSceneId)
    )
    .map((edge) => cloneJson(edge));

  return {
    schemaVersion: MAP_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    knownIds,
    revealedHiddenConnections,
    scenes,
    junctions,
    roads,
    scenarioOutlines,
    transportEdges,
    blockedConnections,
  };
}

export function areKnownMapSnapshotsEquivalent(
  left: KnownMapSnapshot,
  right: KnownMapSnapshot
): boolean {
  return (
    JSON.stringify({ ...left, updatedAt: "" }) ===
    JSON.stringify({ ...right, updatedAt: "" })
  );
}

export function extractNameOnlySceneIds(
  snapshot: KnownMapSnapshot | null | undefined
): string[] {
  if (!snapshot) return [];

  return Object.values(snapshot.scenes)
    .filter((scene) => scene.detailLevel === "name_only")
    .map((scene) => scene.id)
    .sort();
}

export function snapshotSummary(snapshot: KnownMapSnapshot): string {
  const sceneCount = Object.keys(snapshot.scenes).length;
  const junctionCount = Object.keys(snapshot.junctions).length;
  const roadCount = Object.keys(snapshot.roads).length;
  return `Known map snapshot with ${sceneCount} scenes, ${junctionCount} junctions, and ${roadCount} roads.`;
}

export function hydrateKnownMapSnapshot(snapshot: KnownMapSnapshot): {
  scenes: Map<string, (typeof snapshot.scenes)[string]>;
  junctions: Map<string, (typeof snapshot.junctions)[string]>;
  roads: Map<string, (typeof snapshot.roads)[string]>;
  scenarioOutlines: ScenarioOutline[];
  transportEdges: typeof snapshot.transportEdges;
  blockedConnections: Map<string, string>;
  topology: ReturnType<typeof buildTopology>;
} {
  const scenes = new Map(Object.entries(snapshot.scenes));
  const junctions = new Map(Object.entries(snapshot.junctions));
  const roads = new Map(Object.entries(snapshot.roads));

  return {
    scenes,
    junctions,
    roads,
    scenarioOutlines: snapshot.scenarioOutlines.map((outline) =>
      cloneJson(outline)
    ),
    transportEdges: snapshot.transportEdges.map((edge) => cloneJson(edge)),
    blockedConnections: new Map(Object.entries(snapshot.blockedConnections)),
    topology: buildTopology(junctions, roads),
  };
}

export function getKnownMapLocationIdsFromPosition(
  position: CharacterPosition | null
): string[] {
  if (!position) return [];
  switch (position.type) {
    case "scene":
      return [position.sceneId];
    case "junction":
      return [position.junctionId];
    case "road":
      return [position.roadId];
  }
}
