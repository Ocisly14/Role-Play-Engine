import type { PrismaClient } from "@prisma/client";
import type {
  SimulationConfig,
  SimulationEvent,
  SimulationRuntimeRecord,
  SimulationState,
  SimulationStatus,
  StopReason,
} from "./types.js";

const SKIP_PERSIST_TYPES = new Set([
  "npc_position_snapshot",
  "playback_buffering",
  "playback_resumed",
]);

export async function persistSimulationRuntime(params: {
  prisma: PrismaClient;
  sessionId: string;
  tick: number;
  simulationState: SimulationState;
  stopReason?: StopReason;
  language: string;
  moduleName?: string;
  config: SimulationConfig;
  gameState: Record<string, unknown>;
}): Promise<void> {
  await (params.prisma as any).simulationRuntime.upsert({
    where: { sessionId: params.sessionId },
    create: {
      sessionId: params.sessionId,
      tick: params.tick,
      simulationState: params.simulationState,
      stopReason: params.stopReason,
      language: params.language,
      moduleName: params.moduleName,
      config: params.config,
      gameState: params.gameState,
    },
    update: {
      tick: params.tick,
      simulationState: params.simulationState,
      stopReason: params.stopReason,
      language: params.language,
      moduleName: params.moduleName,
      config: params.config,
      gameState: params.gameState,
    },
  });
}

export async function persistSimulationEvents(
  prisma: PrismaClient,
  events: SimulationEvent[]
): Promise<void> {
  const persistedEvents = events.filter(
    (event) => !SKIP_PERSIST_TYPES.has(event.type)
  );
  if (persistedEvents.length === 0) return;

  await prisma.simulationEvent.createMany({
    data: persistedEvents.map((event) => ({
      id: event.id,
      sessionId: event.sessionId,
      tick: event.tick,
      gameDay: event.gameDay,
      gameTime: event.gameTime,
      type: event.type,
      actorNpcId: event.actorNpcId,
      targetNpcId: event.targetNpcId,
      location: event.location,
      data: event.data,
      timestamp: event.timestamp,
    })) as any,
    skipDuplicates: true,
  });
}

export async function loadSimulationRuntime(
  prisma: PrismaClient,
  sessionId: string
): Promise<SimulationRuntimeRecord | null> {
  const row = await (prisma as any).simulationRuntime.findUnique({
    where: { sessionId },
  });
  if (!row) return null;

  return {
    sessionId: row.sessionId,
    tick: row.tick,
    simulationState: row.simulationState as SimulationState,
    stopReason: (row.stopReason ?? undefined) as StopReason | undefined,
    language: row.language,
    moduleName: row.moduleName ?? undefined,
    config: row.config as unknown as SimulationConfig,
    gameState: row.gameState as Record<string, unknown>,
  };
}

export async function listSimulationRuntimeRecords(
  prisma: PrismaClient,
  emailId?: string
): Promise<SimulationRuntimeRecord[]> {
  const rows = await (prisma as any).simulationRuntime.findMany({
    where: emailId
      ? {
          session: {
            emailId,
          },
        }
      : undefined,
    orderBy: { updatedAt: "desc" },
  });

  return rows.map((row: any) => ({
    sessionId: row.sessionId,
    tick: row.tick,
    simulationState: row.simulationState as SimulationState,
    stopReason: (row.stopReason ?? undefined) as StopReason | undefined,
    language: row.language,
    moduleName: row.moduleName ?? undefined,
    config: row.config as SimulationConfig,
    gameState: row.gameState as Record<string, unknown>,
  }));
}

export async function deleteSimulationRuntime(
  prisma: PrismaClient,
  sessionId: string
): Promise<void> {
  // Cascade: Session → SimulationRuntime, NpcDailyPlan, NpcLongTermIntent, NpcMemory, SimulationEvent
  await (prisma as any).session.delete({
    where: { sessionId },
  });
}

export function runtimeToStatus(
  runtime: SimulationRuntimeRecord
): SimulationStatus {
  const gameDay =
    typeof runtime.gameState.gameDay === "number"
      ? runtime.gameState.gameDay
      : 1;
  const currentTime =
    typeof runtime.gameState.timeOfDay === "string"
      ? runtime.gameState.timeOfDay
      : "08:00";

  return {
    state: runtime.simulationState,
    currentDay: gameDay,
    currentTime,
    ticksExecuted: runtime.tick,
    stopReason: runtime.stopReason,
  };
}
