import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { SimulationRunner } from "../../../src/dynamicworldagent/simulation/SimulationRunner.js";
import {
  createDefaultRegistry,
  createExecutionContext,
} from "../../../src/dynamicworldagent/engine/index.js";
import { NPCPlanningAgent } from "../../../src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.js";
import { NpcMemoryManager } from "../../../src/dynamicworldagent/memory/NpcMemoryManager.js";
import { EmbeddingClient } from "../../../src/rag/embedding.js";
import { DynamicGameStateManager } from "../../../src/dynamicworldagent/state/DynamicGameState.js";
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

export function getRunner(sessionId: string): SimulationRunner | undefined {
  return runners.get(sessionId);
}

export function listSimulations(): (SimulationStatus & { sessionId: string })[] {
  return Array.from(runners.entries()).map(([sessionId, runner]) => ({
    sessionId,
    ...runner.getStatus(),
  }));
}

export async function createSimulation(
  prisma: PrismaClient,
  moduleName: string,
  userId: string,
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

  // 1. Initialize full game state (scenes, NPCs, world data)
  const gameState = await initializeCompleteDynamicGameState(db, {
    sessionId,
    moduleName,
    emailId,
  });
  if (!gameState) {
    throw new Error(`Failed to initialize game state for module "${moduleName}"`);
  }

  // 2. Mark session as simulation
  await prisma.session.update({
    where: { sessionId },
    data: { sessionType: "simulation" },
  });

  // 3. Create dependencies
  const dgsm = new DynamicGameStateManager(gameState, db);
  const registry = createDefaultRegistry();
  const ctx = createExecutionContext(registry);
  const embedClient = new EmbeddingClient();
  const memoryManager = new NpcMemoryManager(prisma, embedClient);
  const npcPlanningAgent = new NPCPlanningAgent(prisma, {}, memoryManager);

  // 4. Seed long-term intents for all module NPCs
  await npcPlanningAgent.seedLongTermIntents(dgsm, sessionId, moduleId);

  // 5. Create and store runner
  const runner = new SimulationRunner({
    config: {
      sessionId,
      moduleId,
      mode: config?.mode ?? "paused",
      tickIntervalMs: config?.tickIntervalMs,
      maxDays: config?.maxDays,
      stopEvents: config?.stopEvents,
    },
    dgsm,
    npcPlanningAgent,
    registry,
    ctx,
    language,
    memoryManager,
    prisma,
  });

  runners.set(sessionId, runner);

  return { sessionId, status: runner.getStatus() };
}

export async function startSimulation(sessionId: string): Promise<void> {
  const runner = runners.get(sessionId);
  if (!runner) throw new Error(`Simulation ${sessionId} not found`);
  await runner.start();
}

export function pauseSimulation(sessionId: string): void {
  const runner = runners.get(sessionId);
  if (!runner) throw new Error(`Simulation ${sessionId} not found`);
  runner.pause();
}

export async function resumeSimulation(sessionId: string): Promise<void> {
  const runner = runners.get(sessionId);
  if (!runner) throw new Error(`Simulation ${sessionId} not found`);
  await runner.resume();
}

export async function stepSimulation(
  sessionId: string,
  ticks: number = 1,
): Promise<void> {
  const runner = runners.get(sessionId);
  if (!runner) throw new Error(`Simulation ${sessionId} not found`);
  await runner.step(ticks);
}

export function stopSimulation(sessionId: string): void {
  const runner = runners.get(sessionId);
  if (!runner) throw new Error(`Simulation ${sessionId} not found`);
  runner.stop();
  runners.delete(sessionId);
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
    orderBy: { timestamp: "asc" },
  });

  return rows as unknown as SimulationEvent[];
}
