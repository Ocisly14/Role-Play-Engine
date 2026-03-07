/**
 * Graph Assembly — pure-code module (no LLM calls).
 *
 * Merges all generated scenes into a single scene graph, wires
 * transport-edge connections between entry scenes and outdoor street
 * scenes, and validates that the resulting graph is fully connected.
 */

import type { DynamicScene, ScenarioOutline, TransportEdge } from "./types.js";

// ─── Public result type ──────────────────────────────────────────────

export interface GraphAssemblyResult {
  allScenes: Map<string, DynamicScene>;
  scenarioOutlines: ScenarioOutline[];
  transportEdges: TransportEdge[];
  errors: string[];
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Add a connection to `scene.connections` if not already present.
 */
function addConnection(scene: DynamicScene, targetId: string): void {
  if (!scene.connections.includes(targetId)) {
    scene.connections.push(targetId);
  }
}

// ─── Main assembly function ──────────────────────────────────────────

/**
 * Assemble the complete scene graph.
 *
 * 1. Collect sub-scenes from every macro location.
 * 2. Collect outdoor scenes.
 * 3. Wire entry-scene <-> street-scene connections via transport edges.
 * 4. Validate connectivity (BFS) and report orphaned scenes as errors.
 */
export function assembleSceneGraph(
  macroLocations: ScenarioOutline[],
  subScenesByLocation: Map<
    string,
    { scenes: DynamicScene[]; entrySceneId: string }
  >,
  outdoorScenes: DynamicScene[],
  outdoorMacroLocation: ScenarioOutline,
  transportEdges: TransportEdge[],
): GraphAssemblyResult {
  const allScenes = new Map<string, DynamicScene>();
  const errors: string[] = [];

  // ------------------------------------------------------------------
  // 1. Add all sub-scenes to the map and set entrySceneId on outlines
  // ------------------------------------------------------------------
  for (const outline of macroLocations) {
    const locationData = subScenesByLocation.get(outline.id);
    if (!locationData) {
      errors.push(
        `No sub-scenes found for macro location "${outline.name}" (${outline.id})`,
      );
      continue;
    }

    // Stamp the entry scene onto the outline
    outline.entrySceneId = locationData.entrySceneId;

    for (const scene of locationData.scenes) {
      allScenes.set(scene.id, scene);
    }
  }

  // ------------------------------------------------------------------
  // 2. Add outdoor scenes
  // ------------------------------------------------------------------
  for (const scene of outdoorScenes) {
    allScenes.set(scene.id, scene);
  }

  // ------------------------------------------------------------------
  // 3. Wire entry scenes to outdoor connectors via transport edges
  // ------------------------------------------------------------------
  // Build a quick lookup: locationId -> entrySceneId
  const entrySceneByLocation = new Map<string, string>();
  for (const outline of macroLocations) {
    if (outline.entrySceneId) {
      entrySceneByLocation.set(outline.id, outline.entrySceneId);
    }
  }
  // Include the outdoor macro location itself (its entry scene, if any)
  if (outdoorMacroLocation.entrySceneId) {
    entrySceneByLocation.set(
      outdoorMacroLocation.id,
      outdoorMacroLocation.entrySceneId,
    );
  }

  for (const edge of transportEdges) {
    const fromEntryId = entrySceneByLocation.get(edge.fromLocationId);
    const toEntryId = entrySceneByLocation.get(edge.toLocationId);
    const streetScene = allScenes.get(edge.streetSceneId);

    // Validate all three scenes exist
    if (!fromEntryId) {
      errors.push(
        `Transport edge references unknown fromLocationId "${edge.fromLocationId}" (no entry scene)`,
      );
      continue;
    }
    if (!toEntryId) {
      errors.push(
        `Transport edge references unknown toLocationId "${edge.toLocationId}" (no entry scene)`,
      );
      continue;
    }
    if (!streetScene) {
      errors.push(
        `Transport edge references unknown streetSceneId "${edge.streetSceneId}"`,
      );
      continue;
    }

    const fromEntry = allScenes.get(fromEntryId);
    const toEntry = allScenes.get(toEntryId);

    if (!fromEntry) {
      errors.push(
        `Entry scene "${fromEntryId}" for location "${edge.fromLocationId}" not found in scene map`,
      );
      continue;
    }
    if (!toEntry) {
      errors.push(
        `Entry scene "${toEntryId}" for location "${edge.toLocationId}" not found in scene map`,
      );
      continue;
    }

    // Bidirectional: fromEntry <-> streetScene
    addConnection(fromEntry, edge.streetSceneId);
    addConnection(streetScene, fromEntryId);

    // Bidirectional: toEntry <-> streetScene
    addConnection(toEntry, edge.streetSceneId);
    addConnection(streetScene, toEntryId);
  }

  // ------------------------------------------------------------------
  // 4. Validate connectivity — BFS from an arbitrary scene
  // ------------------------------------------------------------------
  if (allScenes.size > 0) {
    const startId = allScenes.keys().next().value as string;
    const visited = new Set<string>();
    const queue: string[] = [startId];
    visited.add(startId);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      const current = allScenes.get(currentId);
      if (!current) continue;

      for (const neighborId of current.connections) {
        if (!visited.has(neighborId) && allScenes.has(neighborId)) {
          visited.add(neighborId);
          queue.push(neighborId);
        }
      }
    }

    // Report orphans
    for (const [sceneId, scene] of allScenes) {
      if (!visited.has(sceneId)) {
        errors.push(
          `Scene "${scene.name}" (${sceneId}) is not reachable from the rest of the graph`,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // 5. Return assembled result
  // ------------------------------------------------------------------
  return {
    allScenes,
    scenarioOutlines: [...macroLocations, outdoorMacroLocation],
    transportEdges,
    errors,
  };
}
