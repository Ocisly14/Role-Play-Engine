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
      gameDateTime: event.gameDateTime,
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
  const currentDateTime =
    typeof runtime.gameState.gameDateTime === "string"
      ? runtime.gameState.gameDateTime
      : "1900-01-01T08:00:00";

  return {
    state: runtime.simulationState,
    currentDateTime,
    ticksExecuted: runtime.tick,
    stopReason: runtime.stopReason,
  };
}

/** The rendered paragraphs a session has already produced.
 *
 *  Ordered by (actorNpcId, gameDateTime, timestamp) — character first, because
 *  this is not one timeline but one stream per character, which is the shape
 *  the caller buckets it back into. Rows arrive already grouped and already in
 *  order within each group.
 *
 *  `timestamp` is the last tiebreaker rather than the first sort key: everyone
 *  who perceives a given minute is written in a single `createMany`, so their
 *  rows can share a game time and a millisecond, and a sort with ties returns
 *  whatever order the database felt like — different between two loads of the
 *  same data. Three keys make it total. */
/** The event type carrying a character's own condensed account of their
 *  earlier paragraphs. Its `data.coversThrough` is the `gameDateTime` of the
 *  last paragraph it speaks for. */
export const PERCEPTION_COMPACTED_EVENT = "npc_perception_compacted";

export interface PerceptionHistoryRow {
  npcId: string;
  gameDateTime: string;
  location: string;
  narrative: string;
}

export async function loadPerceptionHistory(
  prisma: PrismaClient,
  sessionId: string
): Promise<PerceptionHistoryRow[]> {
  const rows = await prisma.simulationEvent.findMany({
    where: {
      sessionId,
      type: { in: ["npc_perceived", PERCEPTION_COMPACTED_EVENT] },
    },
    orderBy: [
      { actorNpcId: "asc" },
      { gameDateTime: "asc" },
      { timestamp: "asc" },
    ],
    select: {
      actorNpcId: true,
      type: true,
      gameDateTime: true,
      location: true,
      data: true,
    },
  });

  // Nothing is deleted when a character condenses their stream — the event log
  // stays the whole record, for the client and for anyone reading the session
  // back. What compaction changes is only the view handed to the prompts: the
  // newest summary, then the paragraphs it does not already speak for.
  const perceived = new Map<string, PerceptionHistoryRow[]>();
  const summaries = new Map<
    string,
    { row: PerceptionHistoryRow; coversThrough: string }
  >();

  for (const r of rows) {
    const data = r.data as {
      narrative?: unknown;
      coversThrough?: unknown;
    } | null;
    const narrative = data?.narrative;
    if (typeof narrative !== "string" || narrative.length === 0) continue;
    const entry: PerceptionHistoryRow = {
      npcId: r.actorNpcId,
      gameDateTime: r.gameDateTime,
      location: r.location,
      narrative,
    };
    if (r.type === PERCEPTION_COMPACTED_EVENT) {
      const coversThrough =
        typeof data?.coversThrough === "string"
          ? data.coversThrough
          : r.gameDateTime;
      // Rows arrive oldest-first, so the last one seen is the newest — and a
      // newer summary already contains the older one's account.
      summaries.set(r.actorNpcId, { row: entry, coversThrough });
      continue;
    }
    const list = perceived.get(r.actorNpcId);
    if (list) list.push(entry);
    else perceived.set(r.actorNpcId, [entry]);
  }

  const out: PerceptionHistoryRow[] = [];
  for (const npcId of new Set([...perceived.keys(), ...summaries.keys()])) {
    const summary = summaries.get(npcId);
    const paragraphs = perceived.get(npcId) ?? [];
    if (!summary) {
      out.push(...paragraphs);
      continue;
    }
    out.push(summary.row);
    out.push(
      ...paragraphs.filter((p) => p.gameDateTime > summary.coversThrough)
    );
  }
  return out;
}
