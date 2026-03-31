import { hydrateKnownMapSnapshot } from "../memory/mapMemory.js";
import type { KnownMapSnapshot } from "../memory/types.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import {
  getBlockedConnectionReason,
  resolveBlockedConnectionNodeRef,
} from "../state/blockedConnections.js";
import type { DynamicScene } from "../state/types.js";

type GameState = ReturnType<DynamicGameStateManager["getState"]>;

function createMapState(
  dgsm: DynamicGameStateManager,
  snapshot?: KnownMapSnapshot
): GameState {
  const liveState = dgsm.getState();
  if (!snapshot) return liveState;

  const hydrated = hydrateKnownMapSnapshot(snapshot);
  return {
    ...liveState,
    scenes: hydrated.scenes,
    junctions: hydrated.junctions,
    roads: hydrated.roads,
    scenarioOutlines: hydrated.scenarioOutlines,
    transportEdges: hydrated.transportEdges,
    blockedConnections: hydrated.blockedConnections,
    topology: hydrated.topology,
  } as GameState;
}

function resolveLocationNameFromState(
  state: GameState,
  locationId: string
): string {
  if (!locationId) return "Unknown";

  for (const outline of state.scenarioOutlines ?? []) {
    if (outline.entrySceneId === locationId && outline.id !== "OUTDOOR") {
      return outline.name;
    }
  }

  const scene = state.scenes.get(locationId);
  if (scene) {
    const detailLevel = (
      scene as DynamicScene & {
        detailLevel?: "full" | "name_only";
      }
    ).detailLevel;
    if (detailLevel === "name_only") {
      return scene.name;
    }
    const outline = (state.scenarioOutlines ?? []).find(
      (o) => o.id === scene.parentLocationId && o.id !== "OUTDOOR"
    );
    if (outline) return outline.name;
    return scene.name;
  }

  if (state.topology) {
    const junction = state.topology.junctions.get(locationId);
    if (junction) return junction.name;

    const road = state.topology.roads.get(locationId);
    if (road) return road.name;
  }

  return locationId;
}

function buildLocationNameMapFromState(state: GameState): Map<string, string> {
  const map = new Map<string, string>();

  for (const outline of state.scenarioOutlines ?? []) {
    if (outline.entrySceneId && outline.id !== "OUTDOOR") {
      map.set(outline.name, outline.entrySceneId);
    }
  }

  if (state.topology) {
    for (const [id, junction] of state.topology.junctions) {
      map.set(junction.name, id);
    }
    for (const [id, road] of state.topology.roads) {
      if (!map.has(road.name)) {
        map.set(road.name, id);
      }
    }
  }

  for (const [id, scene] of state.scenes) {
    if (map.has(scene.name)) continue;
    map.set(scene.name, id);
  }

  return map;
}

function getBlockedConnectionReasonFromState(
  state: GameState,
  fromId: string,
  toId: string
): string | undefined {
  const fromRef = resolveBlockedConnectionNodeRef(fromId, state);
  const toRef = resolveBlockedConnectionNodeRef(toId, state);
  if (!fromRef || !toRef) return undefined;
  return getBlockedConnectionReason(state.blockedConnections, fromRef, toRef);
}

// ── Public entry points ─────────────────────────────────────────────────

/**
 * Format a scene's connections as human-readable lines for the planning prompt.
 * e.g. "- 正门，面朝街道 → Town Square (JUNC_1)"
 */
export function formatSceneConnections(
  dgsm: DynamicGameStateManager,
  scene: DynamicScene,
  snapshot?: KnownMapSnapshot
): string {
  const state = createMapState(dgsm, snapshot);
  const connections = scene.connections ?? [];
  if (connections.length === 0) return "";

  return connections
    .filter((c) => !c.hidden)
    .map((c) => {
      const targetName = resolveLocationNameFromState(state, c.targetId);
      const desc = c.description ? `${c.description} → ` : "";
      const blockedReason = getBlockedConnectionReasonFromState(
        state,
        scene.id,
        c.targetId
      );
      if (blockedReason) {
        return `- ${desc}${targetName} [BLOCKED: ${blockedReason}]`;
      }
      return `- ${desc}${targetName}`;
    })
    .join("\n");
}

export interface SceneMapParts {
  /** NPC-specific known map snapshot — should be injected as user prompt state */
  townMap: string;
  /** Dynamic NPC position + home — belongs in user prompt */
  yourLocation: string;
}

export function formatSceneMap(
  dgsm: DynamicGameStateManager,
  npcId: string,
  snapshot?: KnownMapSnapshot
): SceneMapParts {
  return formatTopologySceneMap(createMapState(dgsm, snapshot), npcId);
}

/**
 * Build a name → ID lookup map for all navigable locations.
 * Used to resolve LLM-generated location names back to IDs.
 */
export function buildLocationNameMap(
  dgsm: DynamicGameStateManager,
  snapshot?: KnownMapSnapshot
): Map<string, string> {
  return buildLocationNameMapFromState(createMapState(dgsm, snapshot));
}

/**
 * Resolve a location ID to a display name.
 * Prefers outline (building) name for entry scenes.
 */
export function resolveLocationName(
  dgsm: DynamicGameStateManager,
  locationId: string,
  snapshot?: KnownMapSnapshot
): string {
  return resolveLocationNameFromState(
    createMapState(dgsm, snapshot),
    locationId
  );
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function stringSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

const FUZZY_THRESHOLD = 0.8;

/**
 * Resolve a location name (from LLM output) to a location ID.
 * Falls back to case-insensitive match, then fuzzy match (≥80% similarity),
 * then returns the original string.
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

  // Fuzzy match — find the best candidate above threshold
  let bestScore = 0;
  let bestValue: string | undefined;
  for (const [key, value] of nameMap) {
    const score = stringSimilarity(lower, key.toLowerCase());
    if (score >= FUZZY_THRESHOLD && score > bestScore) {
      bestScore = score;
      bestValue = value;
    }
  }
  if (bestValue) return bestValue;

  return name; // return as-is (may already be an ID)
}

// ── Topology-aware scene map ────────────────────────────────────────────

function formatTopologySceneMap(
  state: GameState,
  npcId: string
): SceneMapParts {
  const topology = state.topology!;
  const entryToOutline = buildEntrySceneToOutlineMap(state);
  const residentsMap = buildLocationResidentsMap(state, npcId);
  const outlines = state.scenarioOutlines ?? [];

  // Helper: resolve a connected scene ID to a building name label
  const buildingInfo = (
    sceneId: string
  ): { name: string; description?: string; residents?: string[] } | null => {
    // Try entryScene → outline mapping first
    const outline = entryToOutline.get(sceneId);
    if (outline) {
      const residents = residentsMap.get(outline.id);
      return {
        name: outline.name,
        description: outline.description || undefined,
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
          description: parent.description || undefined,
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

  const locationParts: string[] = [];

  // ── Your Current Location ──
  if (currentMacro && currentMacro.id !== "OUTDOOR") {
    const sceneName = currentScene?.name ?? currentMacro.name;
    locationParts.push(
      `Exact Name: ${sceneName}\nBuilding: ${currentMacro.name}${currentPositionLabel ? `\nTopology Note: ${currentPositionLabel}` : ""}`
    );
  } else if (npcLocation) {
    // NPC is outdoors — show junction/road name
    const name = resolveLocationNameFromState(state, npcLocation);
    locationParts.push(
      `Exact Name: ${name}${currentPositionLabel ? `\nTopology Note: ${currentPositionLabel}` : ""}`
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
      locationParts.push(
        `Your Home: ${residenceMacro.name}${homePositionLabel ? ` (${homePositionLabel})` : ""}`
      );
    } else {
      locationParts.push(`Your Home: ${residence}`);
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
      if (info.description) {
        mapLines.push(`    ${info.name}: ${info.description}`);
      }
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
        if (info.description) {
          mapLines.push(`    ${info.name}: ${info.description}`);
        }
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

  const townMap =
    mapLines.length > 0
      ? "Town Map:\n\n" + mapLines.join("\n").trimEnd()
      : "No map data.";

  return {
    townMap,
    yourLocation: locationParts.join("\n") || "Unknown",
  };
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
): Map<
  string,
  { id: string; name: string; description: string; entrySceneId?: string }
> {
  const map = new Map<
    string,
    { id: string; name: string; description: string; entrySceneId?: string }
  >();
  for (const outline of state.scenarioOutlines ?? []) {
    if (outline.entrySceneId) {
      map.set(outline.entrySceneId, outline);
    }
  }
  return map;
}
