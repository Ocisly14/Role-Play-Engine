import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";

type GameState = ReturnType<DynamicGameStateManager["getState"]>;

// ── Public entry points ─────────────────────────────────────────────────

export function formatSceneMap(
  dgsm: DynamicGameStateManager,
  npcId: string
): string {
  return formatTopologySceneMap(dgsm, npcId);
}

/**
 * Build a name → ID lookup map for all navigable locations.
 * Used to resolve LLM-generated location names back to IDs.
 */
export function buildLocationNameMap(
  dgsm: DynamicGameStateManager
): Map<string, string> {
  const state = dgsm.getState();
  const map = new Map<string, string>();

  // Buildings: outline name → entry scene ID
  for (const outline of state.scenarioOutlines ?? []) {
    if (outline.entrySceneId && outline.id !== "OUTDOOR") {
      map.set(outline.name, outline.entrySceneId);
    }
  }

  // Junctions: junction name → junction ID
  if (state.topology) {
    for (const [id, junction] of state.topology.junctions) {
      map.set(junction.name, id);
    }
  }

  // Individual scenes — interior sub-scenes resolve to their building's entry scene
  for (const [id, scene] of state.scenes) {
    if (map.has(scene.name)) continue; // outline/junction name takes priority
    const outline = (state.scenarioOutlines ?? []).find(
      (o) => o.id === scene.parentLocationId
    );
    if (outline?.entrySceneId && id !== outline.entrySceneId) {
      // Interior sub-scene → resolve to building entry
      map.set(scene.name, outline.entrySceneId);
    } else {
      map.set(scene.name, id);
    }
  }

  return map;
}

/**
 * Resolve a location ID to a display name.
 * Prefers outline (building) name for entry scenes.
 */
export function resolveLocationName(
  dgsm: DynamicGameStateManager,
  locationId: string
): string {
  if (!locationId) return "Unknown";
  const state = dgsm.getState();

  // Check if it's an entry scene → use outline (building) name
  for (const outline of state.scenarioOutlines ?? []) {
    if (outline.entrySceneId === locationId && outline.id !== "OUTDOOR") {
      return outline.name;
    }
  }

  // Check scenes — if inside a building sub-scene, use the outline name
  const scene = state.scenes.get(locationId);
  if (scene) {
    const outline = (state.scenarioOutlines ?? []).find(
      (o) => o.id === scene.parentLocationId && o.id !== "OUTDOOR"
    );
    if (outline) return outline.name;
    return scene.name;
  }

  // Check junctions
  if (state.topology) {
    const junction = state.topology.junctions.get(locationId);
    if (junction) return junction.name;

    const road = state.topology.roads.get(locationId);
    if (road) return road.name;
  }

  return locationId; // fallback to raw ID
}

/**
 * Resolve a location name (from LLM output) to a location ID.
 * Falls back to case-insensitive match, then returns the original string.
 */
export function resolveLocationId(
  name: string,
  nameMap: Map<string, string>
): string {
  // Exact match
  const exact = nameMap.get(name);
  if (exact) return exact;

  // Case-insensitive fallback
  const lower = name.toLowerCase();
  for (const [key, value] of nameMap) {
    if (key.toLowerCase() === lower) return value;
  }

  return name; // return as-is (may already be an ID)
}

// ── Topology-aware scene map ────────────────────────────────────────────

function formatTopologySceneMap(
  dgsm: DynamicGameStateManager,
  npcId: string
): string {
  const state = dgsm.getState();
  const topology = state.topology!;
  const entryToOutline = buildEntrySceneToOutlineMap(state);
  const residentsMap = buildLocationResidentsMap(state, npcId);
  const outlines = state.scenarioOutlines ?? [];

  // Helper: resolve a connected scene ID to a building name label
  const buildingInfo = (
    sceneId: string
  ): { name: string; residents?: string[] } | null => {
    // Try entryScene → outline mapping first
    const outline = entryToOutline.get(sceneId);
    if (outline) {
      const residents = residentsMap.get(outline.id);
      return {
        name: outline.name,
        residents: residents && residents.length > 0 ? residents : undefined,
      };
    }
    // Fall back: look up scene's parentLocationId
    const scene = state.scenes.get(sceneId);
    if (scene) {
      const parent = outlines.find((o) => o.id === scene.parentLocationId);
      if (parent) {
        const residents = residentsMap.get(parent.id);
        return {
          name: parent.name,
          residents: residents && residents.length > 0 ? residents : undefined,
        };
      }
    }
    return null;
  };

  // ── Determine NPC's current position ──
  const npcPos = state.characterPositions[npcId];
  const npcLocation = npcPos
    ? npcPos.type === "scene"
      ? npcPos.sceneId
      : npcPos.type === "junction"
        ? npcPos.junctionId
        : npcPos.roadId
    : undefined;
  const currentScene = npcLocation ? state.scenes.get(npcLocation) : null;
  const currentMacro = currentScene
    ? outlines.find((o) => o.id === currentScene.parentLocationId)
    : null;

  // Where in the topology is the NPC?
  let currentPositionLabel = "";
  if (npcLocation) {
    const topoParent = topology.sceneToParent.get(npcLocation);
    if (topoParent) {
      if (topoParent.type === "junction") {
        const junc = topology.junctions.get(topoParent.junctionId);
        currentPositionLabel = `at ${junc?.name ?? topoParent.junctionId}`;
      } else {
        const road = topology.roads.get(topoParent.roadId);
        currentPositionLabel = `along ${road?.name ?? topoParent.roadId}`;
      }
    } else if (currentScene) {
      // NPC is inside a building — find which junction/road the entry scene is at
      const entryId = currentMacro?.entrySceneId;
      const entryParent = entryId ? topology.sceneToParent.get(entryId) : null;
      if (entryParent?.type === "junction") {
        const junc = topology.junctions.get(entryParent.junctionId);
        currentPositionLabel = `at ${junc?.name ?? entryParent.junctionId}`;
      } else if (entryParent?.type === "road") {
        const road = topology.roads.get(entryParent.roadId);
        currentPositionLabel = `along ${road?.name ?? entryParent.roadId}`;
      }
    }
  }

  const parts: string[] = [];

  // ── Your Current Location ──
  if (currentMacro && currentMacro.id !== "OUTDOOR") {
    parts.push(
      `Your Current Location:\n  Exact Name: ${currentMacro.name}${currentPositionLabel ? `\n  Topology Note: ${currentPositionLabel}` : ""}`
    );
  } else if (npcLocation) {
    // NPC is outdoors — show junction/road name
    const name = resolveLocationName(dgsm, npcLocation);
    parts.push(
      `Your Current Location:\n  Exact Name: ${name}${currentPositionLabel ? `\n  Topology Note: ${currentPositionLabel}` : ""}`
    );
  }

  // ── Your Home ──
  const residence = state.npcResidences[npcId];
  if (residence) {
    const residenceMacro = outlines.find((o) => o.id === residence);
    if (residenceMacro && residenceMacro.id !== "OUTDOOR") {
      // Find where home is in topology
      let homePositionLabel = "";
      const homeTopoParent = residenceMacro.entrySceneId
        ? topology.sceneToParent.get(residenceMacro.entrySceneId)
        : null;
      if (homeTopoParent?.type === "junction") {
        const junc = topology.junctions.get(homeTopoParent.junctionId);
        homePositionLabel = `at ${junc?.name ?? homeTopoParent.junctionId}`;
      } else if (homeTopoParent?.type === "road") {
        const road = topology.roads.get(homeTopoParent.roadId);
        homePositionLabel = `along ${road?.name ?? homeTopoParent.roadId}`;
      }
      parts.push(
        `Your Home:\n  Exact Name: ${residenceMacro.name}${homePositionLabel ? `\n  Topology Note: ${homePositionLabel}` : ""}`
      );
    } else {
      parts.push(`Your Home:\n  Exact Name: ${residence}`);
    }
  }

  // ── Town Map ──
  const mapLines: string[] = [];
  for (const [juncId, junction] of topology.junctions) {
    mapLines.push(`  ${junction.name}`);

    // Roads out from this junction
    const roads = topology.junctionToRoads.get(juncId) ?? [];
    for (const road of roads) {
      const otherJuncId =
        road.endpointA === juncId ? road.endpointB : road.endpointA;
      const otherJunc = topology.junctions.get(otherJuncId);
      const otherName = otherJunc?.name ?? otherJuncId;
      mapLines.push(
        `    ── ${road.name} (~${road.travelTimeMinutes} min) ──▸ ${otherName}`
      );
    }

    // Buildings at this junction
    const juncBuildings: string[] = [];
    for (const sceneId of junction.connectedSceneIds) {
      const info = buildingInfo(sceneId);
      if (!info) continue;
      juncBuildings.push(info.name);
      if (info.residents?.length) {
        mapLines.push(
          `    Residents at ${info.name}: ${info.residents.join(", ")}`
        );
      }
    }
    if (juncBuildings.length > 0) {
      mapLines.push(`    Buildings here: ${juncBuildings.join(" | ")}`);
    }

    // Buildings along each road leaving this junction
    for (const road of roads) {
      if (road.alongConnections.length === 0) continue;
      const alongBuildings: string[] = [];
      for (const along of road.alongConnections) {
        const info = buildingInfo(along.sceneId);
        if (!info) continue;
        alongBuildings.push(info.name);
        if (info.residents?.length) {
          mapLines.push(
            `    Residents at ${info.name}: ${info.residents.join(", ")}`
          );
        }
      }
      if (alongBuildings.length > 0) {
        mapLines.push(`    Along ${road.name}: ${alongBuildings.join(" | ")}`);
      }
    }

    mapLines.push(""); // blank line between junctions
  }

  if (mapLines.length > 0) {
    parts.push("Town Map:\n\n" + mapLines.join("\n").trimEnd());
  }

  return parts.join("\n\n") || "No scene data.";
}

// ── Helper maps ─────────────────────────────────────────────────────────

function buildLocationResidentsMap(
  state: GameState,
  npcId: string
): Map<string, string[]> {
  const knownIds = new Set(
    Object.keys(state.npcRelationshipGraph[npcId] ?? {})
  );

  const map = new Map<string, string[]>();
  for (const [charId, locationId] of Object.entries(state.npcResidences)) {
    if (charId === npcId) continue;
    if (!knownIds.has(charId)) continue;
    const char = state.npcCharacters.find((n) => n.id === charId);
    if (!char) continue;
    const list = map.get(locationId) ?? [];
    list.push(char.name);
    map.set(locationId, list);
  }
  return map;
}

function buildEntrySceneToOutlineMap(
  state: GameState
): Map<string, { id: string; name: string; entrySceneId?: string }> {
  const map = new Map<
    string,
    { id: string; name: string; entrySceneId?: string }
  >();
  for (const outline of state.scenarioOutlines ?? []) {
    if (outline.entrySceneId) {
      map.set(outline.entrySceneId, outline);
    }
  }
  return map;
}
