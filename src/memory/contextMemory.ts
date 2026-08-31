// src/memory/contextMemory.ts
//
// 地理常识 — the world as a character already knows it before the first tick.
//
// One memory per macro location (the building and what it is), one per scene
// inside it (the room and what leads where), and finally a single memory for
// how the town is laid out: which building stands on which street, and which
// streets meet where. That last one is written after the others because it is
// the layer that only makes sense once the places have names.
//
// All of it is assembled from module data — no LLM. The descriptions are the
// module author's own; the glue between them is `src/i18n`. That makes the
// bootstrap free, deterministic, and replayable: the same module and the same
// seed produce byte-identical memories every run.
//
// What a character does NOT know is simply absent. `knownIds` is the filter —
// an unknown building is not named, and an exit into an unknown place is not
// listed, so a seeded newcomer's memories describe a smaller town than a
// lifelong resident's.

import { t } from "../i18n/t.js";
import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { DynamicScene, ScenarioOutline } from "../state/types.js";
import { junctionSceneLinks } from "./knownLocations.js";
import type { KnownMapIds } from "./types.js";

export type ContextMemoryScope = "macro" | "interior" | "topology";

export interface ContextMemoryEntry {
  scope: ContextMemoryScope;
  /** Outline id for `macro`, scene id for `interior`, absent for `topology`. */
  locationId?: string;
  content: string;
}

/** Macro location every module uses for "not inside anything" — streets, and
 *  the open air. It is a bucket, not a place, so it gets no macro memory. */
const OUTDOOR = "OUTDOOR";

export function buildContextMemoryEntries(
  dgsm: DynamicGameStateManager,
  knownIds: KnownMapIds,
  language = "en"
): ContextMemoryEntry[] {
  const state = dgsm.getState();
  const topology = dgsm.getTopology();

  const knownScenes = new Set(knownIds.sceneIds);
  const knownJunctions = new Set(knownIds.junctionIds);
  const knownRoads = new Set(knownIds.roadIds);
  const knownOutlines = new Set(knownIds.scenarioOutlineIds);

  const listSep = t("context_list_sep", language);
  const clauseSep = t("context_clause_sep", language);

  const outlinesById = new Map<string, ScenarioOutline>(
    (state.scenarioOutlines ?? []).map((outline) => [outline.id, outline])
  );
  const outlineByEntryScene = new Map<string, ScenarioOutline>();
  for (const outline of state.scenarioOutlines ?? []) {
    if (outline.entrySceneId) {
      outlineByEntryScene.set(outline.entrySceneId, outline);
    }
  }

  /** A scene the character can see from the street reads as the building it
   *  belongs to — you notice the hospital, not its lobby. Only the entry
   *  scene stands in for the building that way: a room reached from another
   *  room is that room, or the exit out of the ward would read as an exit
   *  into the hospital you are already standing in. */
  const buildingName = (sceneId: string): string | null => {
    const outline = outlineByEntryScene.get(sceneId);
    if (outline && outline.id !== OUTDOOR && knownOutlines.has(outline.id)) {
      return outline.name;
    }
    return state.scenes.get(sceneId)?.name ?? null;
  };

  /** Where an exit leads, named as the character would name it. */
  const exitTargetName = (targetId: string): string | null => {
    if (knownScenes.has(targetId)) return buildingName(targetId);
    if (knownJunctions.has(targetId)) {
      return state.junctions.get(targetId)?.name ?? null;
    }
    if (knownRoads.has(targetId)) {
      return state.roads.get(targetId)?.name ?? null;
    }
    return null;
  };

  const describeScene = (scene: DynamicScene): string => {
    const parent = outlinesById.get(scene.parentLocationId);
    const macroName =
      parent && parent.id !== OUTDOOR && knownOutlines.has(parent.id)
        ? parent.name
        : null;
    const lines = [
      macroName
        ? t("context_interior", language, {
            name: scene.name,
            macro: macroName,
            description: scene.description,
          })
        : t("context_interior_outdoor", language, {
            name: scene.name,
            description: scene.description,
          }),
    ];

    const exits: string[] = [];
    for (const connection of scene.connections ?? []) {
      if (connection.hidden) continue;
      const target = exitTargetName(connection.targetId);
      if (!target) continue;
      exits.push(
        connection.description
          ? t("context_exit", language, {
              description: connection.description,
              target,
            })
          : t("context_exit_plain", language, { target })
      );
    }
    if (exits.length > 0) {
      lines.push(
        t("context_interior_exits", language, { exits: exits.join(clauseSep) })
      );
    }
    return lines.join("\n");
  };

  const entries: ContextMemoryEntry[] = [];
  const placedScenes = new Set<string>();

  // ── Macro location, then the scenes inside it ──
  for (const outline of state.scenarioOutlines ?? []) {
    if (outline.id === OUTDOOR || !knownOutlines.has(outline.id)) continue;

    const inside = knownIds.sceneIds.filter(
      (sceneId) => state.scenes.get(sceneId)?.parentLocationId === outline.id
    );

    const macroLines = [
      t("context_macro", language, {
        name: outline.name,
        description: outline.description,
      }),
    ];
    const insideNames = inside
      .map((sceneId) => state.scenes.get(sceneId)?.name)
      .filter((name): name is string => Boolean(name));
    if (insideNames.length > 0) {
      macroLines.push(
        t("context_macro_inside", language, {
          scenes: insideNames.join(listSep),
        })
      );
    }
    entries.push({
      scope: "macro",
      locationId: outline.id,
      content: macroLines.join("\n"),
    });

    for (const sceneId of inside) {
      const scene = state.scenes.get(sceneId);
      if (!scene) continue;
      placedScenes.add(sceneId);
      entries.push({
        scope: "interior",
        locationId: sceneId,
        content: describeScene(scene),
      });
    }
  }

  // ── Scenes belonging to no known macro location (streets, open ground) ──
  for (const sceneId of knownIds.sceneIds) {
    if (placedScenes.has(sceneId)) continue;
    const scene = state.scenes.get(sceneId);
    if (!scene) continue;
    entries.push({
      scope: "interior",
      locationId: sceneId,
      content: describeScene(scene),
    });
  }

  // ── One last memory: how the streets fit together ──
  const topologyLines: string[] = [];

  for (const roadId of knownIds.roadIds) {
    const road = state.roads.get(roadId);
    if (!road) continue;

    const from = knownJunctions.has(road.endpointA)
      ? state.junctions.get(road.endpointA)?.name
      : undefined;
    const to = knownJunctions.has(road.endpointB)
      ? state.junctions.get(road.endpointB)?.name
      : undefined;

    const line =
      from && to
        ? t("context_topology_road", language, {
            road: road.name,
            from,
            to,
            minutes: road.travelTimeMinutes,
          })
        : t("context_topology_road_only", language, {
            road: road.name,
            minutes: road.travelTimeMinutes,
          });

    const along = (road.alongConnections ?? [])
      .filter((connection) => knownScenes.has(connection.sceneId))
      .map((connection) => buildingName(connection.sceneId))
      .filter((name): name is string => Boolean(name));

    topologyLines.push(
      along.length > 0
        ? `${line} ${t("context_topology_road_along", language, { buildings: along.join(listSep) })}`
        : line
    );
  }

  for (const junctionId of knownIds.junctionIds) {
    const junction = state.junctions.get(junctionId);
    if (!junction) continue;

    const roadNames = (topology.junctionToRoads.get(junctionId) ?? [])
      .filter((road) => knownRoads.has(road.id))
      .map((road) => road.name);
    if (roadNames.length === 0) continue;

    const line = t("context_topology_junction", language, {
      junction: junction.name,
      roads: roadNames.join(listSep),
    });

    const buildings = junctionSceneLinks(junction)
      .filter((link) => knownScenes.has(link.targetId))
      .map((link) => buildingName(link.targetId))
      .filter((name): name is string => Boolean(name));

    topologyLines.push(
      buildings.length > 0
        ? `${line} ${t("context_topology_junction_buildings", language, { buildings: buildings.join(listSep) })}`
        : line
    );
  }

  if (topologyLines.length > 0) {
    entries.push({
      scope: "topology",
      content: [t("context_topology_header", language), ...topologyLines].join(
        "\n"
      ),
    });
  }

  return entries;
}
