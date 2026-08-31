// src/planning/sceneMapFormatter.ts
//
// Location display names for the operator-facing surfaces (map viewer, event
// feed). What an NPC knows about the map is no longer rendered here: it is
// written into their `context` memories at session bootstrap
// (src/memory/contextMemory.ts), so the snapshot-driven town map, the
// name→id resolver and the connection formatter that fed the removed
// planning agent are gone with it.

import type { DynamicGameStateManager } from "../state/DynamicGameState.js";

type GameState = ReturnType<DynamicGameStateManager["getState"]>;

function stripParentLocationPrefix(
  parentName: string,
  childName: string
): string {
  const normalizedParent = parentName.trim();
  const normalizedChild = childName.trim();
  if (!normalizedParent || !normalizedChild) return normalizedChild;
  if (normalizedChild === normalizedParent) return "";
  if (!normalizedChild.startsWith(normalizedParent)) return normalizedChild;

  return normalizedChild.slice(normalizedParent.length).trim();
}

function resolveDisplayLocationNameFromState(
  state: GameState,
  locationId: string
): string {
  if (!locationId) return "Unknown";

  const scene = state.scenes.get(locationId);
  if (scene) {
    const outline = (state.scenarioOutlines ?? []).find(
      (candidate) =>
        candidate.id === scene.parentLocationId && candidate.id !== "OUTDOOR"
    );
    if (!outline) return scene.name;

    const childSegment = stripParentLocationPrefix(outline.name, scene.name);
    return childSegment ? `${outline.name}·${childSegment}` : outline.name;
  }

  if (state.topology) {
    const junction = state.topology.junctions.get(locationId);
    if (junction) return junction.name;

    const road = state.topology.roads.get(locationId);
    if (road) return road.name;
  }

  const outline = (state.scenarioOutlines ?? []).find(
    (candidate) => candidate.id === locationId
  );
  if (outline) return outline.name;

  return locationId;
}

/**
 * Resolve a location ID to a user-facing display name.
 * Child scenes are shown as "Parent·Child" to avoid collapsing distinct sub-scenes.
 */
export function resolveDisplayLocationName(
  dgsm: DynamicGameStateManager,
  locationId: string
): string {
  return resolveDisplayLocationNameFromState(dgsm.getState(), locationId);
}
