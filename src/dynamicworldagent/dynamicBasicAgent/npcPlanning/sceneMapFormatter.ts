import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";

type GameState = ReturnType<DynamicGameStateManager["getState"]>;

// ── Public entry point ──────────────────────────────────────────────────

export function formatSceneMap(dgsm: DynamicGameStateManager, npcId: string): string {
  const state = dgsm.getState();
  const topology = state.topology;

  // If topology exists, use structured junction-centric graph format
  if (topology && topology.junctions.size > 0) {
    return formatTopologySceneMap(dgsm, npcId);
  }

  // Fallback: flat format (no topology)
  return formatFlatSceneMap(dgsm, npcId);
}

// ── Topology-aware scene map ────────────────────────────────────────────

function formatTopologySceneMap(dgsm: DynamicGameStateManager, npcId: string): string {
  const state = dgsm.getState();
  const topology = state.topology!;
  const entryToOutline = buildEntrySceneToOutlineMap(state);
  const residentsMap = buildLocationResidentsMap(state, npcId);
  const outlines = state.scenarioOutlines ?? [];

  // Helper: resolve a connected scene ID to a macro location label
  const buildingLabel = (sceneId: string): string | null => {
    // Try entryScene → outline mapping first
    const outline = entryToOutline.get(sceneId);
    if (outline) {
      const residents = residentsMap.get(outline.id);
      let label = `${outline.id} "${outline.name}" (entry: ${sceneId})`;
      if (residents && residents.length > 0) label += ` | Residents: ${residents.join(", ")}`;
      return label;
    }
    // Fall back: look up scene's parentLocationId
    const scene = state.scenes.get(sceneId);
    if (scene) {
      const parent = outlines.find((o) => o.id === scene.parentLocationId);
      if (parent) {
        const residents = residentsMap.get(parent.id);
        let label = `${parent.id} "${parent.name}" (entry: ${sceneId})`;
        if (residents && residents.length > 0) label += ` | Residents: ${residents.join(", ")}`;
        return label;
      }
    }
    return null;
  };

  // ── Determine NPC's current position ──
  const npcLocation = state.npcLocations[npcId];
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
        currentPositionLabel = `at ${topoParent.junctionId} "${junc?.name ?? topoParent.junctionId}"`;
      } else {
        const road = topology.roads.get(topoParent.roadId);
        currentPositionLabel = `along ${topoParent.roadId} "${road?.name ?? topoParent.roadId}"`;
      }
    } else if (currentScene) {
      // NPC is inside a building — find which junction/road the entry scene is at
      const entryId = currentMacro?.entrySceneId;
      const entryParent = entryId ? topology.sceneToParent.get(entryId) : null;
      if (entryParent?.type === "junction") {
        const junc = topology.junctions.get(entryParent.junctionId);
        currentPositionLabel = `at ${entryParent.junctionId} "${junc?.name ?? entryParent.junctionId}"`;
      } else if (entryParent?.type === "road") {
        const road = topology.roads.get(entryParent.roadId);
        currentPositionLabel = `along ${entryParent.roadId} "${road?.name ?? entryParent.roadId}"`;
      }
    }
  }

  const parts: string[] = [];

  // ── Your Current Location ──
  if (currentMacro) {
    const entryId = currentMacro.entrySceneId ?? npcLocation ?? currentMacro.id;
    parts.push(`Your Current Location:\n  ${currentMacro.id} "${currentMacro.name}" (entry: ${entryId})${currentPositionLabel ? ` — ${currentPositionLabel}` : ""}`);
  } else if (npcLocation) {
    parts.push(`Your Current Location:\n  ${npcLocation}${currentPositionLabel ? ` — ${currentPositionLabel}` : ""}`);
  }

  // ── Your Home ──
  const residence = state.npcResidences[npcId];
  if (residence) {
    const residenceMacro = outlines.find((o) => o.id === residence);
    if (residenceMacro) {
      const homeEntryId = residenceMacro.entrySceneId ?? residence;
      // Find where home is in topology
      let homePositionLabel = "";
      const homeTopoParent = residenceMacro.entrySceneId
        ? topology.sceneToParent.get(residenceMacro.entrySceneId)
        : null;
      if (homeTopoParent?.type === "junction") {
        const junc = topology.junctions.get(homeTopoParent.junctionId);
        homePositionLabel = ` — at ${homeTopoParent.junctionId} "${junc?.name ?? homeTopoParent.junctionId}"`;
      } else if (homeTopoParent?.type === "road") {
        const road = topology.roads.get(homeTopoParent.roadId);
        homePositionLabel = ` — along ${homeTopoParent.roadId} "${road?.name ?? homeTopoParent.roadId}"`;
      }
      parts.push(`Your Home:\n  ${residenceMacro.id} "${residenceMacro.name}" (entry: ${homeEntryId})${homePositionLabel}`);
    } else {
      parts.push(`Your Home:\n  ${residence}`);
    }
  }

  // ── Town Map ──
  const mapLines: string[] = [];
  for (const [juncId, junction] of topology.junctions) {
    mapLines.push(`  ${juncId} "${junction.name}"`);

    // Roads out from this junction
    const roads = topology.junctionToRoads.get(juncId) ?? [];
    for (const road of roads) {
      const otherJuncId = road.endpointA === juncId ? road.endpointB : road.endpointA;
      const otherJunc = topology.junctions.get(otherJuncId);
      const otherName = otherJunc ? `"${otherJunc.name}"` : "";
      mapLines.push(`    ── ${road.id} "${road.name}" (~${road.travelTimeMinutes} min) ──▸ ${otherJuncId} ${otherName}`.trimEnd());
    }

    // Buildings at this junction
    const juncBuildings: string[] = [];
    for (const sceneId of junction.connectedSceneIds) {
      const label = buildingLabel(sceneId);
      if (label) juncBuildings.push(label);
    }
    if (juncBuildings.length > 0) {
      mapLines.push(`    Buildings here: ${juncBuildings.join(" | ")}`);
    }

    // Buildings along each road leaving this junction
    for (const road of roads) {
      if (road.alongConnections.length === 0) continue;
      const alongBuildings: string[] = [];
      for (const along of road.alongConnections) {
        const label = buildingLabel(along.sceneId);
        if (label) alongBuildings.push(label);
      }
      if (alongBuildings.length > 0) {
        mapLines.push(`    Along ${road.id}: ${alongBuildings.join(" | ")}`);
      }
    }

    mapLines.push(""); // blank line between junctions
  }

  if (mapLines.length > 0) {
    parts.push("Town Map:\n\n" + mapLines.join("\n").trimEnd());
  }

  return parts.join("\n\n") || "No scene data.";
}

// ── Flat scene map (no topology) ────────────────────────────────────────

function formatFlatSceneMap(dgsm: DynamicGameStateManager, npcId: string): string {
  const state = dgsm.getState();
  const npcLocation = state.npcLocations[npcId];
  const currentScene = npcLocation ? state.scenes.get(npcLocation) : null;
  const residentsMap = buildLocationResidentsMap(state, npcId);

  const parts: string[] = [];

  // 1. Current scene + connections
  if (currentScene) {
    parts.push(`Current Scene: ${currentScene.id} "${currentScene.name}" — ${currentScene.description}`);

    const connScenes = currentScene.connections
      .map((id) => state.scenes.get(id))
      .filter(Boolean)
      .map((s) => `  - ${s!.id} "${s!.name}": ${s!.description}`);
    if (connScenes.length > 0) {
      parts.push("Connected Scenes:\n" + connScenes.join("\n"));
    }
  }

  // 2. Current macro location
  const currentMacro = currentScene
    ? (state.scenarioOutlines ?? []).find((o) => o.id === currentScene.parentLocationId)
    : null;
  if (currentMacro) {
    parts.push(`Current Location: ${currentMacro.id} "${currentMacro.name}"`);
  }

  // 3. Nearby macro locations via transport edges
  if (currentScene) {
    const parentId = currentScene.parentLocationId;
    const nearbyEdges = state.transportEdges.filter(
      (e) => e.fromLocationId === parentId || e.toLocationId === parentId
    );
    const nearbyLocations = nearbyEdges.map((e) => {
      const targetId = e.fromLocationId === parentId ? e.toLocationId : e.fromLocationId;
      const target = (state.scenarioOutlines ?? []).find((o) => o.id === targetId);
      const residents = residentsMap.get(targetId);
      const residentsLabel = residents && residents.length > 0 ? ` | Residents: ${residents.join(", ")}` : "";
      return `  - ${targetId} "${target?.name ?? targetId}" (~${e.travelTimeMinutes} min via ${e.streetSceneId})${residentsLabel}`;
    });
    if (nearbyLocations.length > 0) {
      parts.push("Nearby Locations:\n" + nearbyLocations.join("\n"));
    }
  }

  // 4. NPC residence
  const residence = state.npcResidences[npcId];
  if (residence) {
    const residenceMacro = (state.scenarioOutlines ?? []).find((o) => o.id === residence);
    parts.push(`Home/Residence: ${residence} "${residenceMacro?.name ?? residence}"`);
  }

  // 5. Fallback: list all macro locations if no scene graph
  if (parts.length === 0) {
    const outlines = state.scenarioOutlines ?? [];
    if (outlines.length > 0) {
      parts.push("Locations:\n" + outlines.map((s) => `- ${s.id} "${s.name}": ${s.description}`).join("\n"));
    }
  }

  return parts.join("\n\n") || "No scene data.";
}

// ── Helper maps ─────────────────────────────────────────────────────────

function buildLocationResidentsMap(
  state: GameState,
  npcId: string
): Map<string, string[]> {
  const knownIds = new Set(Object.keys(state.npcRelationshipGraph[npcId] ?? {}));

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
  const map = new Map<string, { id: string; name: string; entrySceneId?: string }>();
  for (const outline of state.scenarioOutlines ?? []) {
    if (outline.entrySceneId) {
      map.set(outline.entrySceneId, outline);
    }
  }
  return map;
}
