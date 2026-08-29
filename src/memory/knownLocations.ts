// src/memory/knownLocations.ts
//
// Which places does this character already know about?
//
// The answer is a set of ids, resolved once at session bootstrap from the
// module's per-NPC `knownMapSeed`, and it decides exactly one thing: which
// generated `map` memories get written for them (see contextMemory.ts). Nothing is
// persisted in this shape — there is no snapshot of the map hanging off a
// memory row any more. What the character knows in play is what they wrote
// down themselves.
//
// A seed names starting points, not an exhaustive list. Knowing a building
// means knowing the street it stands on (a top-level node scene), the roads
// that street runs between, and the other buildings visible from there — so
// each seeded id is expanded across its neighbourhood before the set is
// final.

import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { CharacterPosition } from "../state/topologyTypes.js";
import type { KnownMapSeed, SceneConnection } from "../state/types.js";
import type { KnownMapIds } from "./types.js";

interface MutableKnownMapIds {
  sceneIds: Set<string>;
  roadIds: Set<string>;
  scenarioOutlineIds: Set<string>;
}

function emptyKnownMapIds(): MutableKnownMapIds {
  return {
    sceneIds: new Set<string>(),
    roadIds: new Set<string>(),
    scenarioOutlineIds: new Set<string>(),
  };
}

function toMutable(ids?: Partial<KnownMapIds>): MutableKnownMapIds {
  return {
    sceneIds: new Set(ids?.sceneIds ?? []),
    roadIds: new Set(ids?.roadIds ?? []),
    scenarioOutlineIds: new Set(ids?.scenarioOutlineIds ?? []),
  };
}

function serializeKnownMapIds(ids: MutableKnownMapIds): KnownMapIds {
  return {
    sceneIds: [...ids.sceneIds].sort(),
    roadIds: [...ids.roadIds].sort(),
    scenarioOutlineIds: [...ids.scenarioOutlineIds].sort(),
  };
}

/** No seed at all means the character grew up here: they know the whole map. */
function createFullKnownMapIds(dgsm: DynamicGameStateManager): KnownMapIds {
  const state = dgsm.getState();
  return {
    sceneIds: [...state.scenes.keys()].sort(),
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

function addRoadBase(
  dgsm: DynamicGameStateManager,
  knownIds: MutableKnownMapIds,
  roadId: string
): void {
  if (dgsm.getState().roads.has(roadId)) {
    knownIds.roadIds.add(roadId);
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
  addSceneBase(dgsm, knownIds, road.endpointA);
  addSceneBase(dgsm, knownIds, road.endpointB);
  for (const along of road.alongConnections ?? []) {
    addSceneBase(dgsm, knownIds, along.sceneId);
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
    } else if (state.roads.has(targetId)) {
      addRoadBase(dgsm, knownIds, targetId);
    }
  }

  // A node scene (street, yard) also knows the roads that meet there.
  for (const road of topology.sceneToRoads.get(sceneId) ?? []) {
    revealRoadNeighborhood(dgsm, knownIds, road.id);
  }

  const parent = topology.sceneToParent.get(sceneId);
  if (!parent) return;

  if (parent.type === "scene") {
    revealSceneNeighborhood(dgsm, knownIds, parent.sceneId);
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

/** Expand a set of starting points across their neighbourhoods. */
function revealKnownMapLocations(
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
    if (state.roads.has(locationId)) {
      revealRoadNeighborhood(dgsm, knownIds, locationId);
      continue;
    }
    revealOutlineNeighborhood(dgsm, knownIds, locationId);
  }

  return normalizeKnownMapIds(dgsm, serializeKnownMapIds(knownIds));
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
    const parentId = state.scenes.get(sceneId)?.parentLocationId;
    const outline = parentId ? outlinesById.get(parentId) : undefined;
    if (outline) normalized.scenarioOutlineIds.add(outline.id);
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

/**
 * Resolve a module's per-NPC seed into the full set of places that character
 * starts out knowing. `position` is folded in because wherever they are when
 * the session opens is, trivially, somewhere they know. A seed's legacy
 * `junctionIds` are treated as scene ids (former junctions are top-level
 * scenes now).
 */
export function resolveKnownLocationIds(
  dgsm: DynamicGameStateManager,
  seed: KnownMapSeed | undefined,
  position?: CharacterPosition | null
): KnownMapIds {
  const currentIds = getKnownMapLocationIdsFromPosition(position ?? null);

  if (!seed) {
    return createFullKnownMapIds(dgsm);
  }

  const base = normalizeKnownMapIds(dgsm, {
    sceneIds: [...(seed.sceneIds ?? []), ...(seed.junctionIds ?? [])],
    roadIds: seed.roadIds ?? [],
    scenarioOutlineIds: seed.scenarioOutlineIds ?? [],
  });

  const seeded = [
    ...base.sceneIds,
    ...base.roadIds,
    ...base.scenarioOutlineIds,
    ...currentIds,
  ];

  return revealKnownMapLocations(dgsm, base, seeded);
}

function getKnownMapLocationIdsFromPosition(
  position: CharacterPosition | null
): string[] {
  if (!position) return [];
  switch (position.type) {
    case "scene":
      return [position.sceneId];
    case "road":
      return [position.roadId];
  }
}

export interface NodeSceneLink {
  targetId: string;
  description?: string;
}

/**
 * A node scene's attached scenes, read from the authored `connections`.
 * Hidden connections are skipped here for the same reason the scene side
 * skips them: an exit nobody has found yet is not part of what a character
 * knows about the corner.
 */
export function nodeSceneLinks(node: {
  connections?: SceneConnection[];
}): NodeSceneLink[] {
  return (node.connections ?? [])
    .filter((connection) => !connection.hidden)
    .map((connection) => ({
      targetId: connection.targetId,
      ...(connection.description !== undefined
        ? { description: connection.description }
        : {}),
    }));
}
