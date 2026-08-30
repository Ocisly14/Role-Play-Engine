import * as fs from "node:fs";
import * as path from "node:path";
import { resolveDisplayLocationName } from "../../../src/planning/sceneMapFormatter.js";
import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import type { SimulationRunner } from "../../../src/simulation/SimulationRunner.js";
import type {
  MapLayout,
  NpcStatusInfo,
  TopologyResponse,
} from "../../../src/simulation/mapViewerTypes.js";
import type { DynamicGameStateManager } from "../../../src/state/DynamicGameState.js";
import type { CharacterPosition } from "../../../src/state/topologyTypes.js";
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

export async function getTopology(
  sessionId: string
): Promise<TopologyResponse | null> {
  const runner = await requireRunner(sessionId);
  if (!runner) return null;
  const dgsm = runner.getDgsm();
  const topology = dgsm.getTopology();
  if (!topology) return null;

  const stateForNodes = dgsm.getState();
  // Wire compat: the viewer still calls the geography nodes "junctions".
  // They are top-level scenes now; synthesize the same shape.
  const junctions = Array.from(topology.nodeSceneIds)
    .map((id) => stateForNodes.scenes.get(id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => ({
      id: s.id,
      name: s.name,
      parentLocationId: s.parentLocationId ?? "OUTDOOR",
      connectedSceneIds: (s.connections ?? []).map((c) => c.targetId),
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
    return {
      id: s.id,
      name: s.name,
      description: s.description,
      parentLocationId: s.parentLocationId,
      conditions: s.conditions ?? [],
      connections: (s.connections ?? []).map((c) => ({
        targetId: typeof c === "string" ? c : c.targetId,
        description: typeof c === "string" ? undefined : c.description,
      })),
    };
  });
  // Viewer-only building groups, derived from the parentLocationId labels
  // scenes still carry. Scenario outlines are gone as a runtime concept; the
  // town map just needs "which rooms are one building" and a display name.
  const groups = new Map<string, { names: string[]; count: number }>();
  for (const s of state.scenes.values()) {
    const label = s.parentLocationId;
    if (!label || label === "OUTDOOR") continue;
    const g = groups.get(label) ?? { names: [], count: 0 };
    g.names.push(s.name);
    g.count += 1;
    groups.set(label, g);
  }
  const scenarioOutlines = [...groups.entries()].map(([id, g]) => {
    const prefixes = new Set(g.names.map((n) => n.split("·")[0]));
    return {
      id,
      name: prefixes.size === 1 ? [...prefixes][0] : id,
      description: "",
      subSceneCount: g.count,
    };
  });
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
      san: stats?.san ?? 0,
      maxSan: npc.status?.maxSan ?? 0,
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
  // Residence names a scene or road directly.
  const scene = state.scenes.get(residenceId);
  if (scene) return scene.name;
  const road = state.roads?.get?.(residenceId);
  if (road) return road.name;
  return residenceId;
}

function resolveLocationName(
  position: CharacterPosition,
  dgsm: DynamicGameStateManager
): string {
  return resolveDisplayLocationName(dgsm, dgsm.resolveLocationId(position));
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
