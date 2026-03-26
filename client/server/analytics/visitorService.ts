import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";

/**
 * Create a new visitor session.
 */
export async function createVisitorSession(
  sessionId: string,
  ip: string,
  userAgent?: string
): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.visitorSession.upsert({
    where: { sessionId },
    update: {},
    create: { sessionId, ip, userAgent },
  });
}

/**
 * Update the heartbeat timestamp for an existing session.
 */
export async function updateHeartbeat(sessionId: string): Promise<boolean> {
  const prisma = getPrismaClient();
  try {
    await prisma.visitorSession.update({
      where: { sessionId },
      data: { lastHeartbeatAt: new Date() },
    });
    return true;
  } catch {
    return false;
  }
}

export interface VisitorHourlyEntry {
  hour: number;
  count: number;
}

export interface VisitorIpEntry {
  ip: string;
  visitCount: number;
  avgDurationSeconds: number;
}

export interface VisitorStats {
  today: {
    totalVisits: number;
    avgDurationSeconds: number;
  };
  hourly: VisitorHourlyEntry[];
  byIp: VisitorIpEntry[];
}

/**
 * Get visitor statistics for a given date (YYYY-MM-DD).
 */
export async function getVisitorStats(date?: string): Promise<VisitorStats> {
  const prisma = getPrismaClient();

  const dateStr = date || new Date().toISOString().split("T")[0];
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  const nextDay = new Date(dayStart);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);

  const sessions = await prisma.visitorSession.findMany({
    where: {
      startedAt: { gte: dayStart, lt: nextDay },
    },
  });

  // Today summary
  const totalVisits = sessions.length;
  const totalDuration = sessions.reduce((sum, s) => {
    return sum + (s.lastHeartbeatAt.getTime() - s.startedAt.getTime()) / 1000;
  }, 0);
  const avgDurationSeconds =
    totalVisits > 0 ? Math.round(totalDuration / totalVisits) : 0;

  // Hourly breakdown
  const hourlyCounts = new Map<number, number>();
  for (const s of sessions) {
    const hour = s.startedAt.getUTCHours();
    hourlyCounts.set(hour, (hourlyCounts.get(hour) || 0) + 1);
  }
  const hourly: VisitorHourlyEntry[] = [];
  for (let h = 0; h < 24; h++) {
    hourly.push({ hour: h, count: hourlyCounts.get(h) || 0 });
  }

  // By IP
  const ipMap = new Map<
    string,
    { visitCount: number; totalDurationSeconds: number }
  >();
  for (const s of sessions) {
    const dur = (s.lastHeartbeatAt.getTime() - s.startedAt.getTime()) / 1000;
    const entry = ipMap.get(s.ip) || { visitCount: 0, totalDurationSeconds: 0 };
    entry.visitCount++;
    entry.totalDurationSeconds += dur;
    ipMap.set(s.ip, entry);
  }
  const byIp: VisitorIpEntry[] = [...ipMap.entries()]
    .map(([ip, data]) => ({
      ip,
      visitCount: data.visitCount,
      avgDurationSeconds: Math.round(
        data.totalDurationSeconds / data.visitCount
      ),
    }))
    .sort((a, b) => b.avgDurationSeconds - a.avgDurationSeconds);

  return {
    today: { totalVisits, avgDurationSeconds },
    hourly,
    byIp,
  };
}
