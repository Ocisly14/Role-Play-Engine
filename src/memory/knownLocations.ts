// src/memory/knownLocations.ts
//
// Which places does this character already know about?
//
// The answer is a set of ids, resolved once at session bootstrap from the
// module's per-NPC `knownMapSeed`, and it decides exactly one thing: which
// `context` memories get written for them (see contextMemory.ts). Nothing is
// persisted in this shape — there is no snapshot of the map hanging off a
// memory row any more. What the character knows in play is what they wrote
// down themselves.
//
// A seed names starting points, not an exhaustive list. Knowing a building
// means knowing the street it stands on, the junctions that street runs
// between, and the other buildings visible from there — so each seeded id is
// expanded across its neighbourhood before the set is final.

import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { CharacterPosition } from "../state/topologyTypes.js";
import type { KnownMapSeed } from "../state/types.js";
import type { KnownMapIds } from "./types.js";

interface MutableKnownMapIds {
  sceneIds: Set<string>;
  junctionIds: Set<string>;
  roadIds: Set<string>;
  scenarioOutlineIds: Set<string>;
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

function serializeKnownMapIds(ids: MutableKnownMapIds): KnownMapIds {
  return {
    sceneIds: [...ids.sceneIds].sort(),
    junctionIds: [...ids.junctionIds].sort(),
    roadIds: [...ids.roadIds].sort(),
    scenarioOutlineIds: [...ids.scenarioOutlineIds].sort(),
  };
}

/** No seed at all means the character grew up here: they know the whole map. */
function createFullKnownMapIds(
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
  for (const sceneId of junctionSceneIds(junction)) {
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

/**
 * Resolve a module's per-NPC seed into the full set of places that character
 * starts out knowing. `position` is folded in because wherever they are when
 * the session opens is, trivially, somewhere they know.
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
    sceneIds: seed.sceneIds ?? [],
    junctionIds: seed.junctionIds ?? [],
    roadIds: seed.roadIds ?? [],
    scenarioOutlineIds: seed.scenarioOutlineIds ?? [],
  });

  const seeded = [
    ...base.sceneIds,
    ...base.junctionIds,
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
    case "junction":
      return [position.junctionId];
    case "road":
      return [position.roadId];
  }
}

export interface JunctionSceneLink {
  targetId: string;
  description?: string;
}

/**
 * A junction's `connectedSceneIds` is typed `string[]`, but modules author it
 * both ways: bare ids in the older modules, `{ targetId, description }`
 * objects in the newer ones. Read it through here — everything downstream
 * (including `buildTopology`) assumes the bare-id shape and silently sees
 * nothing when handed the object shape.
 */
export function junctionSceneLinks(junction: {
  connectedSceneIds?: unknown;
}): JunctionSceneLink[] {
  const raw = junction.connectedSceneIds;
  if (!Array.isArray(raw)) return [];
  const links: JunctionSceneLink[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      links.push({ targetId: entry });
      continue;
    }
    const candidate = entry as { targetId?: unknown; description?: unknown };
    if (typeof candidate?.targetId === "string") {
      links.push({
        targetId: candidate.targetId,
        ...(typeof candidate.description === "string"
          ? { description: candidate.description }
          : {}),
      });
    }
  }
  return links;
}

function junctionSceneIds(junction: {
  connectedSceneIds?: unknown;
}): string[] {
  return junctionSceneLinks(junction).map((link) => link.targetId);
}
