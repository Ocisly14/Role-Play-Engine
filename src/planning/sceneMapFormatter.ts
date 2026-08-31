// src/planning/sceneMapFormatter.ts
//
// Location display names for the operator-facing surfaces (map viewer, event
// feed). What an NPC knows about the map lives in their authored `map`
// memories — nothing geographic is generated at bootstrap any more.

import type { DynamicGameStateManager } from "../state/DynamicGameState.js";

type GameState = ReturnType<DynamicGameStateManager["getState"]>;

function resolveDisplayLocationNameFromState(
  state: GameState,
  locationId: string
): string {
  if (!locationId) return "Unknown";

  // Scene names carry their own building identity ("蓝鸟餐馆·堂座") — no
  // macro-location lookup needed.
  const scene = state.scenes.get(locationId);
  if (scene) return scene.name;

  if (state.topology) {
    const road = state.topology.roads.get(locationId);
    if (road) return road.name;
  }

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
