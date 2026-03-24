import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { WebSocket } from "ws";
import { NPCPlanningAgent } from "../../../src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.js";
import {
  createDefaultRegistry,
  createExecutionContext,
} from "../../../src/dynamicworldagent/engine/index.js";
import { NpcMemoryManager } from "../../../src/dynamicworldagent/memory/NpcMemoryManager.js";
import { SimulationRunner } from "../../../src/dynamicworldagent/simulation/SimulationRunner.js";
import {
  deleteSimulationRuntime,
  listSimulationRuntimeRecords,
  loadSimulationRuntime,
  runtimeToStatus,
} from "../../../src/dynamicworldagent/simulation/runtimePersistence.js";
import type {
  SimulationConfig,
  SimulationStatus,
} from "../../../src/dynamicworldagent/simulation/types.js";
import {
  type DynamicGameState,
  DynamicGameStateManager,
} from "../../../src/dynamicworldagent/state/DynamicGameState.js";
import { initializeCompleteDynamicGameState } from "../../../src/dynamicworldagent/state/DynamicGameStateLoader.js";
import { importModule } from "../../../src/dynamicworldagent/state/moduleImporter.js";
import { ModelProviderName } from "../../../src/models/types.js";
import { EmbeddingClient } from "../../../src/rag/embedding.js";
import { resolveModuleIdByName } from "../../../src/shared/agents/memory/database/moduleScope.js";
import { resolveEmailId } from "../../../src/shared/agents/memory/database/userContext.js";
import {
  type WeatherType,
  getWeatherLabel,
  computeSkillPenalties,
} from "../../../src/dynamicworldagent/engine/features/weatherFeature.js";
import type { TownTopology } from "../../../src/dynamicworldagent/state/topologyTypes.js";
import { DatabaseManager } from "../core/DatabaseManager.js";
import { WebSocketManager } from "../websocket/WebSocketManager.js";

const runners = new Map<string, SimulationRunner>();
const WEATHER_FEATURE_ID = "weather";
const DEFAULT_WEATHER_INTENSITY = 3;
const WEATHER_BLOCKING_INTENSITY_THRESHOLD = 4;

async function ensureModuleIdForSimulation(
  prisma: PrismaClient,
  moduleName: string,
  emailId?: string
): Promise<string | null> {
  const existingModuleId = await resolveModuleIdByName(moduleName, emailId);
  if (existingModuleId) {
    return existingModuleId;
  }

  const moduleDir = path.join(process.cwd(), "data", "Mods", moduleName);
  if (!fs.existsSync(moduleDir)) {
    return null;
  }

  await importModule({
    prisma,
    moduleDir,
    moduleName,
    emailId,
  });

  return resolveModuleIdByName(moduleName, emailId);
}

function timeToMinutes(hhmm: string): number | null {
  const [hoursPart, minutesPart] = hhmm.split(":");
  const hours = Number.parseInt(hoursPart ?? "", 10);
  const minutes = Number.parseInt(minutesPart ?? "", 10);
  if (
    Number.isNaN(hours) ||
    Number.isNaN(minutes) ||
    hours < 0 ||
    hours > 23 ||
    minutes < 0 ||
    minutes > 59
  ) {
    return null;
  }
  return hours * 60 + minutes;
}

function buildTimeKey(gameDay: number, gameTime: string): number | null {
  const minutes = timeToMinutes(gameTime);
  if (minutes === null) return null;
  return gameDay * 1440 + minutes;
}

function resolveTopLevelLocationId(
  locationId: string,
  topology: TownTopology | null,
  dgsm: DynamicGameStateManager
): string | null {
  const scene = dgsm.getState().scenes.get(locationId);
  if (scene?.parentLocationId) return scene.parentLocationId;

  const junction = topology?.junctions.get(locationId);
  if (junction?.parentLocationId) return junction.parentLocationId;

  const road = topology?.roads.get(locationId);
  if (road?.parentLocationId) return road.parentLocationId;

  const outline = dgsm
    .getState()
    .scenarioOutlines.find((candidate) => candidate.id === locationId);
  if (outline?.id) return outline.id;

  if (locationId === "OUTDOOR") return locationId;
  return null;
}

/**
 * Wire WebSocket broadcast on a runner.
 * Events are persisted directly by SimulationRunner.
 */
function wireEventListener(runner: SimulationRunner, sessionId: string): void {
  runner.setBroadcastCallback((events) => {
    const wsManager = WebSocketManager.getInstance();
    if (!wsManager) return;
    const clients = wsManager.getSimulationClients(sessionId);
    for (const event of events) {
      const message = JSON.stringify({ type: "simulation_event", event });
      for (const [, client] of clients) {
        if (client.ws.readyState === WebSocket.OPEN) {
          try {
            client.ws.send(message);
          } catch {
            // ignore send errors
          }
        }
      }
    }
  });
}

function buildSimulationBundle(params: {
  prisma: PrismaClient;
  gameState: DynamicGameState;
  config: SimulationConfig;
  language: string;
}): {
  runner: SimulationRunner;
  dgsm: DynamicGameStateManager;
  npcPlanningAgent: NPCPlanningAgent;
} {
  const db = DatabaseManager.getInstance().getDatabase();
  const dgsm = new DynamicGameStateManager(params.gameState, db);
  const registry = createDefaultRegistry();
  const ctx = createExecutionContext(registry);
  const provider =
    (process.env.MODEL_PROVIDER as ModelProviderName) ??
    ModelProviderName.OPENAI;
  const embedClient = new EmbeddingClient(provider);
  const memoryManager = new NpcMemoryManager(params.prisma, embedClient);
  const npcPlanningAgent = new NPCPlanningAgent(
    params.prisma,
    {},
    memoryManager
  );

  const runner = new SimulationRunner({
    config: params.config,
    dgsm,
    npcPlanningAgent,
    registry,
    ctx,
    language: params.language,
    memoryManager,
    prisma: params.prisma,
  });

  return { runner, dgsm, npcPlanningAgent };
}

export function getRunnerFromMemory(
  sessionId: string
): SimulationRunner | undefined {
  return runners.get(sessionId);
}

export async function getRunner(
  prisma: PrismaClient,
  sessionId: string
): Promise<SimulationRunner | undefined> {
  const existing = runners.get(sessionId);
  if (existing) return existing;

  const runtime = await loadSimulationRuntime(prisma, sessionId);
  if (!runtime) return undefined;

  const gameState = DynamicGameStateManager.deserialize(runtime.gameState);
  const { runner } = buildSimulationBundle({
    prisma,
    gameState,
    config: runtime.config,
    language: runtime.language,
  });
  runner.hydrateFromRuntime({
    state: runtime.simulationState,
    ticksExecuted: runtime.tick,
    stopReason: runtime.stopReason,
  });
  runner.setModuleName(runtime.moduleName ?? "");
  if (runtime.simulationState === "running") {
    await runner.saveRuntime();
  }
  wireEventListener(runner, sessionId);
  runners.set(sessionId, runner);
  return runner;
}

export async function listSimulations(
  prisma: PrismaClient,
  emailId?: string
): Promise<(SimulationStatus & { sessionId: string; moduleName?: string })[]> {
  const runtimes = await listSimulationRuntimeRecords(prisma, emailId);

  return runtimes.map((runtime) => {
    const liveRunner = runners.get(runtime.sessionId);
    const effectiveRuntime =
      !liveRunner && runtime.simulationState === "running"
        ? { ...runtime, simulationState: "paused" as const }
        : runtime;
    return {
      sessionId: runtime.sessionId,
      moduleName: liveRunner?.getModuleName() ?? runtime.moduleName,
      ...(liveRunner
        ? liveRunner.getStatus()
        : runtimeToStatus(effectiveRuntime)),
    };
  });
}

function getOutdoorWeatherRegionIds(dgsm: DynamicGameStateManager): string[] {
  const regionIds = new Set<string>();
  const state = dgsm.getState();

  state.scenes.forEach((scene) => {
    if (!scene.indoor) {
      regionIds.add(scene.parentLocationId);
    }
  });
  for (const [, junction] of state.junctions) {
    regionIds.add(junction.parentLocationId);
  }
  for (const [, road] of state.roads) {
    regionIds.add(road.parentLocationId);
  }

  return Array.from(regionIds);
}

function getOutdoorLocationIdsForRegion(
  dgsm: DynamicGameStateManager,
  regionId: string
): string[] {
  const state = dgsm.getState();
  const locationIds: string[] = [];

  state.scenes.forEach((scene, sceneId) => {
    if (scene.parentLocationId === regionId && !scene.indoor) {
      locationIds.push(sceneId);
    }
  });
  for (const [junctionId, junction] of state.junctions) {
    if (junction.parentLocationId === regionId) {
      locationIds.push(junctionId);
    }
  }
  for (const [roadId, road] of state.roads) {
    if (road.parentLocationId === regionId) {
      locationIds.push(roadId);
    }
  }

  return locationIds;
}

function clearWeatherConditions(
  dgsm: DynamicGameStateManager,
  locationId: string
): void {
  const state = dgsm.getState();
  const conditions = state.scenarioConditions[locationId];
  if (!conditions) return;
  state.scenarioConditions[locationId] = conditions.filter(
    (condition: any) => !condition.description.startsWith("[Weather]")
  );
}

function updateWeatherBlocking(
  dgsm: DynamicGameStateManager,
  locationIds: string[],
  weather: WeatherType,
  intensity: number
): void {
  const shouldBlock =
    (weather === "storm" || weather === "snow") &&
    intensity >= WEATHER_BLOCKING_INTENSITY_THRESHOLD;

  for (const locationId of locationIds) {
    const scene = dgsm.getScene(locationId);
    if (!scene) continue;

    for (const connection of scene.connections ?? []) {
      const connectedScene = dgsm.getScene(connection.targetId);
      if (!connectedScene || (connectedScene as any).indoor) continue;

      if (shouldBlock) {
        dgsm.setConnectionBlocked(
          connection.targetId,
          locationId,
          true,
          `Blocked by ${weather} (intensity ${intensity})`
        );
        continue;
      }

      const reason = dgsm.getConnectionBlockReason(connection.targetId, locationId);
      if (
        reason &&
        (reason.startsWith("Blocked by storm") ||
          reason.startsWith("Blocked by snow"))
      ) {
        dgsm.setConnectionBlocked(locationId, connection.targetId, false, "");
      }
    }
  }
}

export function applyGlobalWeather(
  dgsm: DynamicGameStateManager,
  weather: WeatherType
): void {
  const regionIds = getOutdoorWeatherRegionIds(dgsm);
  const intensity =
    weather === "clear" ? 0 : DEFAULT_WEATHER_INTENSITY;

  for (const regionId of regionIds) {
    const locationIds = getOutdoorLocationIdsForRegion(dgsm, regionId);

    dgsm.setFeatureSceneState(WEATHER_FEATURE_ID, regionId, {
      weatherType: weather,
      intensity,
      minutesInState: 0,
      affectedSceneIds: locationIds,
    });

    for (const locationId of locationIds) {
      clearWeatherConditions(dgsm, locationId);
    }

    if (weather !== "clear" && intensity > 0) {
      const label = getWeatherLabel(weather, intensity);
      const penalties = computeSkillPenalties(weather, intensity);
      for (const locationId of locationIds) {
        dgsm.appendSceneCondition(locationId, {
          description: `[Weather] ${label}`,
          mechanicalEffect:
            penalties.length > 0 ? { skillPenalty: penalties } : undefined,
        });
      }
    }

    updateWeatherBlocking(dgsm, locationIds, weather, intensity);
  }
}

export async function createSimulation(
  prisma: PrismaClient,
  moduleName: string,
  _userId: string,
  language = "en",
  config?: Partial<SimulationConfig> & { weather?: WeatherType }
): Promise<{ sessionId: string; status: SimulationStatus }> {
  const sessionId = randomUUID();
  const db = DatabaseManager.getInstance().getDatabase();
  const emailId = resolveEmailId();
  const moduleId = await ensureModuleIdForSimulation(
    prisma,
    moduleName,
    emailId
  );
  if (!moduleId) {
    throw new Error(`Module "${moduleName}" not found`);
  }

  const gameState = await initializeCompleteDynamicGameState(db, {
    sessionId,
    moduleName,
    emailId,
  });
  if (!gameState) {
    throw new Error(
      `Failed to initialize game state for module "${moduleName}"`
    );
  }

  const { runner, dgsm, npcPlanningAgent } = buildSimulationBundle({
    prisma,
    gameState,
    config: {
      sessionId,
      moduleId,
      mode: config?.mode ?? "paused",
      tickIntervalMs: config?.tickIntervalMs,
      maxDays: config?.maxDays,
      stopEvents: config?.stopEvents,
      syncRealTime: config?.syncRealTime,
      realTimeBufferMinutes: config?.realTimeBufferMinutes,
    },
    language,
  });

  // Apply initial weather if specified
  if (config?.weather && config.weather !== "clear") {
    applyGlobalWeather(dgsm, config.weather);
  }

  await npcPlanningAgent.seedLongTermIntents(dgsm, sessionId, moduleId);
  if (config?.syncRealTime) {
    runner.enableRealTimeSync(config.realTimeBufferMinutes ?? 0);
  }
  runner.setModuleName(moduleName);
  await runner.saveRuntime();

  wireEventListener(runner, sessionId);
  runners.set(sessionId, runner);

  return { sessionId, status: runner.getStatus() };
}

async function requireRunner(
  prisma: PrismaClient,
  sessionId: string
): Promise<SimulationRunner> {
  const runner = await getRunner(prisma, sessionId);
  if (!runner) throw new Error(`Simulation ${sessionId} not found`);
  return runner;
}

export async function startSimulation(
  prisma: PrismaClient,
  sessionId: string
): Promise<void> {
  const runner = await requireRunner(prisma, sessionId);
  await runner.start();
}

export async function pauseSimulation(
  prisma: PrismaClient,
  sessionId: string
): Promise<void> {
  const runner = await requireRunner(prisma, sessionId);
  await runner.pause();
}

export async function resumeSimulation(
  prisma: PrismaClient,
  sessionId: string
): Promise<void> {
  const runner = await requireRunner(prisma, sessionId);
  await runner.resume();
}

export async function stepSimulation(
  prisma: PrismaClient,
  sessionId: string,
  ticks = 1
): Promise<void> {
  const runner = await requireRunner(prisma, sessionId);
  await runner.step(ticks);
}

export async function stopSimulation(
  prisma: PrismaClient,
  sessionId: string
): Promise<void> {
  const runner = await requireRunner(prisma, sessionId);
  await runner.stop();
  runners.delete(sessionId);
}

export async function deleteSimulation(
  prisma: PrismaClient,
  sessionId: string
): Promise<void> {
  // Stop the runner if it's active in memory
  const runner = runners.get(sessionId);
  if (runner) {
    try {
      await runner.stop();
    } catch {
      // Ignore stop errors — we're deleting anyway
    }
    runners.delete(sessionId);
  }
  // Delete session record (cascades to all related tables)
  await deleteSimulationRuntime(prisma, sessionId);
}

export async function getSimulationStatus(
  prisma: PrismaClient,
  sessionId: string
): Promise<SimulationStatus> {
  const runner = await requireRunner(prisma, sessionId);
  return runner.getStatus();
}

export async function getSimulationEvents(
  prisma: PrismaClient,
  sessionId: string,
  filters?: {
    type?: string;
    npcId?: string;
    day?: number;
    startDay?: number;
    startTime?: string;
    endDay?: number;
    endTime?: string;
    maxTick?: number;
    parentLocationId?: string;
  }
): Promise<SimulationEvent[]> {
  const where: Record<string, unknown> = { sessionId };
  if (filters?.type) where.type = filters.type;
  if (filters?.npcId) where.actorNpcId = filters.npcId;
  if (typeof filters?.maxTick === "number") {
    where.tick = { lte: filters.maxTick };
  }
  if (filters?.day) {
    where.gameDay = filters.day;
  } else if (
    typeof filters?.startDay === "number" ||
    typeof filters?.endDay === "number"
  ) {
    const gameDayRange: Record<string, number> = {};
    if (typeof filters?.startDay === "number") gameDayRange.gte = filters.startDay;
    if (typeof filters?.endDay === "number") gameDayRange.lte = filters.endDay;
    where.gameDay = gameDayRange;
  }

  const rows = await prisma.simulationEvent.findMany({
    where,
    orderBy: [{ tick: "asc" }, { timestamp: "asc" }],
  });

  let filteredRows = rows;

  const startKey =
    typeof filters?.startDay === "number"
      ? buildTimeKey(filters.startDay, filters.startTime ?? "00:00")
      : null;
  const endKey =
    typeof filters?.endDay === "number"
      ? buildTimeKey(filters.endDay, filters.endTime ?? "23:59")
      : null;

  if (startKey !== null || endKey !== null) {
    filteredRows = filteredRows.filter((row) => {
      const rowKey = buildTimeKey(row.gameDay, row.gameTime);
      if (rowKey === null) return false;
      if (startKey !== null && rowKey < startKey) return false;
      if (endKey !== null && rowKey > endKey) return false;
      return true;
    });
  }

  if (filters?.parentLocationId) {
    const runner = await requireRunner(prisma, sessionId);
    const dgsm = runner.getDgsm();
    const topology = dgsm.getTopology();

    filteredRows = filteredRows.filter((row) => {
      const parentLocationId = resolveTopLevelLocationId(
        row.location,
        topology,
        dgsm
      );
      return parentLocationId === filters.parentLocationId;
    });
  }

  return filteredRows as unknown as SimulationEvent[];
}
