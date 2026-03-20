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
  prisma: PrismaClient
): Promise<(SimulationStatus & { sessionId: string; moduleName?: string })[]> {
  const runtimes = await listSimulationRuntimeRecords(prisma);

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

function applyGlobalWeather(dgsm: DynamicGameStateManager, weather: WeatherType): void {
  const topology = dgsm.getTopology();
  if (!topology) return;

  const DEFAULT_INTENSITY = 3;
  const outdoorIds = [
    ...Array.from(topology.junctions.keys()),
    ...Array.from(topology.roads.keys()),
  ];

  const label = getWeatherLabel(weather, DEFAULT_INTENSITY);
  const penalties = computeSkillPenalties(weather, DEFAULT_INTENSITY);

  for (const sceneId of outdoorIds) {
    const state = dgsm.getState();
    const conditions = state.scenarioConditions[sceneId] ?? [];
    state.scenarioConditions[sceneId] = conditions.filter(
      (c: any) => !c.description.startsWith("[Weather]")
    );

    dgsm.appendSceneCondition(sceneId, {
      description: `[Weather] ${label}`,
      mechanicalEffect: penalties.length > 0 ? { skillPenalty: penalties } : undefined,
    });
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
  const moduleId = await resolveModuleIdByName(moduleName, emailId);
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
