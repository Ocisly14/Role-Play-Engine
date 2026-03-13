import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { SimulationRunner } from "../../../src/dynamicworldagent/simulation/SimulationRunner.js";
import {
  loadSimulationRuntime,
  listSimulationRuntimeRecords,
  runtimeToStatus,
} from "../../../src/dynamicworldagent/simulation/runtimePersistence.js";
import {
  createDefaultRegistry,
  createExecutionContext,
} from "../../../src/dynamicworldagent/engine/index.js";
import { NPCPlanningAgent } from "../../../src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.js";
import { NpcMemoryManager } from "../../../src/dynamicworldagent/memory/NpcMemoryManager.js";
import { EmbeddingClient } from "../../../src/rag/embedding.js";
import { ModelProviderName } from "../../../src/models/types.js";
import {
  DynamicGameStateManager,
  type DynamicGameState,
} from "../../../src/dynamicworldagent/state/DynamicGameState.js";
import { initializeCompleteDynamicGameState } from "../../../src/dynamicworldagent/state/DynamicGameStateLoader.js";
import { resolveModuleIdByName } from "../../../src/shared/agents/memory/database/moduleScope.js";
import { resolveEmailId } from "../../../src/shared/agents/memory/database/userContext.js";
import { DatabaseManager } from "../core/DatabaseManager.js";
import type {
  SimulationConfig,
  SimulationEvent,
  SimulationStatus,
} from "../../../src/dynamicworldagent/simulation/types.js";

const runners = new Map<string, SimulationRunner>();

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
  const npcPlanningAgent = new NPCPlanningAgent(params.prisma, {}, memoryManager);

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
  sessionId: string,
): SimulationRunner | undefined {
  return runners.get(sessionId);
}

export async function getRunner(
  prisma: PrismaClient,
  sessionId: string,
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
  if (runtime.simulationState === "running") {
    await runner.saveRuntime();
  }
  runners.set(sessionId, runner);
  return runner;
}

export async function listSimulations(
  prisma: PrismaClient,
): Promise<(SimulationStatus & { sessionId: string })[]> {
  const runtimes = await listSimulationRuntimeRecords(prisma);

  return runtimes.map((runtime) => {
    const liveRunner = runners.get(runtime.sessionId);
    const effectiveRuntime =
      !liveRunner && runtime.simulationState === "running"
        ? { ...runtime, simulationState: "paused" as const }
        : runtime;
    return {
      sessionId: runtime.sessionId,
      ...(liveRunner
        ? liveRunner.getStatus()
        : runtimeToStatus(effectiveRuntime)),
    };
  });
}

export async function createSimulation(
  prisma: PrismaClient,
  moduleName: string,
  _userId: string,
  language: string = "en",
  config?: Partial<SimulationConfig>,
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
    throw new Error(`Failed to initialize game state for module "${moduleName}"`);
  }

  await prisma.session.update({
    where: { sessionId },
    data: { sessionType: "simulation" },
  });

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
    },
    language,
  });

  await npcPlanningAgent.seedLongTermIntents(dgsm, sessionId, moduleId);
  await runner.saveRuntime();

  runners.set(sessionId, runner);

  return { sessionId, status: runner.getStatus() };
}

async function requireRunner(
  prisma: PrismaClient,
  sessionId: string,
): Promise<SimulationRunner> {
  const runner = await getRunner(prisma, sessionId);
  if (!runner) throw new Error(`Simulation ${sessionId} not found`);
  return runner;
}

export async function startSimulation(
  prisma: PrismaClient,
  sessionId: string,
): Promise<void> {
  const runner = await requireRunner(prisma, sessionId);
  await runner.start();
}

export async function pauseSimulation(
  prisma: PrismaClient,
  sessionId: string,
): Promise<void> {
  const runner = await requireRunner(prisma, sessionId);
  await runner.pause();
}

export async function resumeSimulation(
  prisma: PrismaClient,
  sessionId: string,
): Promise<void> {
  const runner = await requireRunner(prisma, sessionId);
  await runner.resume();
}

export async function stepSimulation(
  prisma: PrismaClient,
  sessionId: string,
  ticks: number = 1,
): Promise<void> {
  const runner = await requireRunner(prisma, sessionId);
  await runner.step(ticks);
}

export async function stopSimulation(
  prisma: PrismaClient,
  sessionId: string,
): Promise<void> {
  const runner = await requireRunner(prisma, sessionId);
  await runner.stop();
  runners.delete(sessionId);
}

export async function getSimulationStatus(
  prisma: PrismaClient,
  sessionId: string,
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
  },
): Promise<SimulationEvent[]> {
  const where: Record<string, unknown> = { sessionId };
  if (filters?.type) where.type = filters.type;
  if (filters?.npcId) where.actorNpcId = filters.npcId;
  if (filters?.day) where.gameDay = filters.day;

  const rows = await prisma.simulationEvent.findMany({
    where,
    orderBy: [{ tick: "asc" }, { timestamp: "asc" }],
  });

  return rows as unknown as SimulationEvent[];
}
