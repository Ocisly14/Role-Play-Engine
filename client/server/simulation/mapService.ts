import * as fs from "node:fs";
import * as path from "node:path";
import type { SceneCondition } from "../../../src/dynamicworldagent/dynamicBasicAgent/npcPlanning/types.js";
import type { SimulationRunner } from "../../../src/dynamicworldagent/simulation/SimulationRunner.js";
import type {
  MapLayout,
  NpcStatusInfo,
  TopologyResponse,
} from "../../../src/dynamicworldagent/simulation/mapViewerTypes.js";
import type { DynamicGameStateManager } from "../../../src/dynamicworldagent/state/DynamicGameState.js";
import type { CharacterPosition } from "../../../src/dynamicworldagent/state/topologyTypes.js";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import { getRunner, getRunnerFromMemory } from "./service.js";

async function requireRunner(
  sessionId: string
): Promise<SimulationRunner | undefined> {
  return (
    getRunnerFromMemory(sessionId) ??
    (await getRunner(getPrismaClient(), sessionId))
  );
}

export function getRunnerById(sessionId: string): SimulationRunner | undefined {
  return getRunnerFromMemory(sessionId);
}

export function mergeSceneConditions(
  staticConditions: ReadonlyArray<SceneCondition> = [],
  runtimeConditions: ReadonlyArray<SceneCondition> = []
): SceneCondition[] {
  const merged: SceneCondition[] = [];
  const seen = new Set<string>();

  for (const condition of [...staticConditions, ...runtimeConditions]) {
    const key = JSON.stringify({
      description: condition.description.trim(),
      mechanicalEffect: condition.mechanicalEffect ?? null,
    });
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(condition);
  }

  return merged;
}

export async function getTopology(
  sessionId: string
): Promise<TopologyResponse | null> {
  const runner = await requireRunner(sessionId);
  if (!runner) return null;
  const dgsm = runner.getDgsm();
  const topology = dgsm.getTopology();
  if (!topology) return null;

  const junctions = Array.from(topology.junctions.values()).map((j) => ({
    id: j.id,
    name: j.name,
    parentLocationId: j.parentLocationId,
    connectedSceneIds: j.connectedSceneIds,
  }));
  const roads = Array.from(topology.roads.values()).map((r) => ({
    id: r.id,
    name: r.name,
    parentLocationId: r.parentLocationId,
    endpointA: r.endpointA,
    endpointB: r.endpointB,
    travelTimeMinutes: r.travelTimeMinutes,
    alongConnections: r.alongConnections,
  }));
  const state = dgsm.getState();
  const scenes = Array.from(state.scenes.values()).map((s) => {
    const dynamicConditions = state.scenarioConditions?.[s.id] ?? [];
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      parentLocationId: s.parentLocationId,
      conditions: mergeSceneConditions(s.conditions ?? [], dynamicConditions),
      connections: (s.connections ?? []).map((c) => ({
        targetId: typeof c === "string" ? c : c.targetId,
        description: typeof c === "string" ? undefined : c.description,
      })),
    };
  });
  const scenarioOutlines = (state.scenarioOutlines ?? [])
    .filter((o) => o.id !== "OUTDOOR")
    .map((o) => ({
      id: o.id,
      name: o.name,
      description: o.description,
      entrySceneId: o.entrySceneId,
      residents: o.residents,
      subSceneCount: o.subSceneCount,
    }));
  const transportEdges = (state.transportEdges ?? []).map((e) => ({
    fromLocationId: e.fromLocationId,
    toLocationId: e.toLocationId,
    streetSceneId: e.streetSceneId,
    travelTimeMinutes: e.travelTimeMinutes,
  }));
  return { junctions, roads, scenes, scenarioOutlines, transportEdges };
}

export async function getMapLayout(
  sessionId: string
): Promise<MapLayout | null> {
  const runner = await requireRunner(sessionId);
  if (!runner) return null;
  const modulePath = runner.getModulePath();
  if (!modulePath) return null;

  // Prefer scene/ directory first, then fallback to *_Maps
  const sceneDir = findSceneDirectory(modulePath);
  if (sceneDir) {
    const layoutPath = path.join(sceneDir, "map_layout.json");
    if (fs.existsSync(layoutPath)) {
      return JSON.parse(fs.readFileSync(layoutPath, "utf-8")) as MapLayout;
    }
  }

  const mapsDir = findMapsDirectory(modulePath);
  if (!mapsDir) return null;
  const layoutPath = path.join(mapsDir, "map_layout.json");
  if (!fs.existsSync(layoutPath)) return null;
  return JSON.parse(fs.readFileSync(layoutPath, "utf-8")) as MapLayout;
}

export async function getPositions(
  sessionId: string
): Promise<Record<string, CharacterPosition> | null> {
  const runner = await requireRunner(sessionId);
  if (!runner) return null;
  return runner.getDgsm().getState().characterPositions;
}

export async function getNpcStatuses(
  sessionId: string
): Promise<NpcStatusInfo[] | null> {
  const runner = await requireRunner(sessionId);
  if (!runner) return null;
  const dgsm = runner.getDgsm();
  const state = dgsm.getState();
  const currentActions = await runner.getCurrentNpcActions();
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
      currentAction: currentActions[npc.id] ?? null,
      location: locationName,
      inventory,
      isAlive: (stats?.hp ?? 0) > 0,
      occupation: npc.occupation,
      age: npc.age,
      gender: npc.gender,
      appearance: npc.appearance,
      personality: npc.personality,
      background: npc.background,
      backstory: npc.backstory,
      residence: resolveResidenceName(npc.residence, dgsm),
      longTermIntent: npc.longTermIntent,
    });
  }
  return statuses;
}

function resolveResidenceName(
  residenceId: string | undefined,
  dgsm: DynamicGameStateManager
): string | undefined {
  if (!residenceId) return undefined;
  const state = dgsm.getState();
  // Check scenarioOutlines first (macro locations like buildings)
  const outline = (state.scenarioOutlines ?? []).find(
    (o) => o.id === residenceId
  );
  if (outline) return outline.name;
  // Check scenes
  const scene = state.scenes.get(residenceId);
  if (scene) return scene.name;
  return residenceId;
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

export function findSceneDirectory(modulePath: string): string | null {
  const sceneDir = path.join(modulePath, "scene");
  if (fs.existsSync(sceneDir) && fs.statSync(sceneDir).isDirectory()) {
    return sceneDir;
  }
  return null;
}

export function findMapsDirectory(modulePath: string): string | null {
  if (!fs.existsSync(modulePath)) return null;
  const entries = fs.readdirSync(modulePath);
  const mapsDir = entries.find((e) => e.endsWith("_Maps"));
  if (!mapsDir) return null;
  return path.join(modulePath, mapsDir);
}
