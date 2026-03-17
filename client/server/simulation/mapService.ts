import * as fs from "node:fs";
import * as path from "node:path";
import type { SimulationRunner } from "../../../src/dynamicworldagent/simulation/SimulationRunner.js";
import type {
  MapLayout,
  NpcStatusInfo,
  TopologyResponse,
} from "../../../src/dynamicworldagent/simulation/mapViewerTypes.js";
import type { DynamicGameStateManager } from "../../../src/dynamicworldagent/state/DynamicGameState.js";
import type { CharacterPosition } from "../../../src/dynamicworldagent/state/topologyTypes.js";
import { getRunnerFromMemory } from "./service.js";

export function getRunnerById(sessionId: string): SimulationRunner | undefined {
  return getRunnerFromMemory(sessionId);
}

export function getTopology(sessionId: string): TopologyResponse | null {
  const runner = getRunnerFromMemory(sessionId);
  if (!runner) return null;
  const dgsm = runner.getDgsm();
  const topology = dgsm.getTopology();
  if (!topology) return null;

  const junctions = Array.from(topology.junctions.values()).map((j) => ({
    id: j.id,
    name: j.name,
    connectedSceneIds: j.connectedSceneIds,
  }));
  const roads = Array.from(topology.roads.values()).map((r) => ({
    id: r.id,
    name: r.name,
    endpointA: r.endpointA,
    endpointB: r.endpointB,
    travelTimeMinutes: r.travelTimeMinutes,
    alongConnections: r.alongConnections,
  }));
  const scenes = Array.from(dgsm.getState().scenes.values()).map((s) => ({
    id: s.id,
    name: s.name,
    parentLocationId: s.parentLocationId,
    connections: s.connections ?? [],
  }));
  return { junctions, roads, scenes };
}

export function getMapLayout(sessionId: string): MapLayout | null {
  const runner = getRunnerFromMemory(sessionId);
  if (!runner) return null;
  const modulePath = runner.getModulePath();
  if (!modulePath) return null;
  const mapsDir = findMapsDirectory(modulePath);
  if (!mapsDir) return null;
  const layoutPath = path.join(mapsDir, "map_layout.json");
  if (!fs.existsSync(layoutPath)) return null;
  return JSON.parse(fs.readFileSync(layoutPath, "utf-8")) as MapLayout;
}

export function getPositions(
  sessionId: string
): Record<string, CharacterPosition> | null {
  const runner = getRunnerFromMemory(sessionId);
  if (!runner) return null;
  return runner.getDgsm().getState().characterPositions;
}

export function getNpcStatuses(sessionId: string): NpcStatusInfo[] | null {
  const runner = getRunnerFromMemory(sessionId);
  if (!runner) return null;
  const dgsm = runner.getDgsm();
  const state = dgsm.getState();
  const statuses: NpcStatusInfo[] = [];

  for (const npc of state.npcCharacters ?? []) {
    const stats = state.npcStats?.[npc.id];
    const inventory = state.npcInventories?.[npc.id] ?? [];
    const position = state.characterPositions?.[npc.id];
    let locationName = "Unknown";
    if (position) locationName = resolveLocationName(position, dgsm);

    statuses.push({
      npcId: npc.id,
      name: npc.name,
      hp: stats?.hp ?? 0,
      maxHp: npc.status?.maxHp ?? 0,
      sanity: stats?.san ?? 0,
      maxSanity: npc.status?.maxSanity ?? 0,
      currentAction: null,
      location: locationName,
      inventory,
      isAlive: (stats?.hp ?? 0) > 0,
    });
  }
  return statuses;
}

function resolveLocationName(
  position: CharacterPosition,
  dgsm: DynamicGameStateManager
): string {
  const topology = dgsm.getTopology();
  if (!topology) return "Unknown";

  switch (position.type) {
    case "junction": {
      const j = topology.junctions.get(position.junctionId);
      return j?.name ?? position.junctionId;
    }
    case "road": {
      const r = topology.roads.get(position.roadId);
      return r?.name ?? position.roadId;
    }
    case "scene": {
      const s = dgsm.getState().scenes.get(position.sceneId);
      return s?.name ?? position.sceneId;
    }
  }
}

export function findMapsDirectory(modulePath: string): string | null {
  if (!fs.existsSync(modulePath)) return null;
  const entries = fs.readdirSync(modulePath);
  const mapsDir = entries.find((e) => e.endsWith("_Maps"));
  if (!mapsDir) return null;
  return path.join(modulePath, mapsDir);
}
