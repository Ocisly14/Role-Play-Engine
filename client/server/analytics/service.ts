import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";

export interface DailyStats {
  id: string;
  stat_date: string;
  login_users_count: number;
  active_users_count: number;
  new_users_count: number;
  total_simulations_count: number;
  total_simulation_events_count: number;
  avg_simulations_per_active_user: number;
  new_mods_short_count: number;
  new_mods_medium_count: number;
  new_mods_long_count: number;
  total_new_mods_count: number;
  created_at: string;
  updated_at: string;
}

export interface WindowStats {
  window_start: string;
  window_end: string;
  login_users_count: number;
  active_users_count: number;
  new_users_count: number;
  total_simulations_count: number;
  total_simulation_events_count: number;
  avg_simulations_per_active_user: number;
  new_mods_short_count: number;
  new_mods_medium_count: number;
  new_mods_long_count: number;
  total_new_mods_count: number;
}

export interface AccumulatedStats {
  accumulated_users_count: number;
  accumulated_simulations_count: number;
}

export interface TopUserSimulations {
  email: string;
  username: string | null;
  simulations_count: number;
}

type BaseStats = Omit<DailyStats, "id" | "created_at" | "updated_at">;

type ModGenerationRow = {
  storyLength: string | null;
  count: number;
};

function dayRange(dateStr: string): { dayStart: Date; nextDay: Date } {
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  const nextDay = new Date(dayStart);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return { dayStart, nextDay };
}

async function getActiveUserEmails(start: Date, end: Date): Promise<string[]> {
  const prisma = getPrismaClient();

  const [runtimeRows, eventRows] = await Promise.all([
    prisma.simulationRuntime.findMany({
      where: {
        OR: [
          {
            createdAt: {
              gte: start,
              lt: end,
            },
          },
          {
            updatedAt: {
              gte: start,
              lt: end,
            },
          },
        ],
      },
      select: {
        session: {
          select: {
            emailId: true,
          },
        },
      },
    }),
    prisma.simulationEvent.findMany({
      where: {
        timestamp: {
          gte: start,
          lt: end,
        },
      },
      select: {
        session: {
          select: {
            emailId: true,
          },
        },
      },
    }),
  ]);

  const emails = new Set<string>();

  for (const row of runtimeRows) {
    if (row.session.emailId) {
      emails.add(row.session.emailId);
    }
  }

  for (const row of eventRows) {
    if (row.session.emailId) {
      emails.add(row.session.emailId);
    }
  }

  return [...emails];
}

async function getModuleGenerationStats(
  start: Date,
  end: Date
): Promise<{
  new_mods_short_count: number;
  new_mods_medium_count: number;
  new_mods_long_count: number;
  total_new_mods_count: number;
}> {
  const prisma = getPrismaClient();

  try {
    const rows = await prisma.$queryRaw<ModGenerationRow[]>`
      SELECT
        story_length AS "storyLength",
        COUNT(*)::int AS "count"
      FROM mod_generations
      WHERE generated_at >= ${start}
        AND generated_at < ${end}
      GROUP BY story_length
    `;

    let new_mods_short_count = 0;
    let new_mods_medium_count = 0;
    let new_mods_long_count = 0;
    let total_new_mods_count = 0;

    for (const row of rows) {
      const count = Number(row.count ?? 0);
      total_new_mods_count += count;

      switch (row.storyLength) {
        case "short":
          new_mods_short_count = count;
          break;
        case "medium":
          new_mods_medium_count = count;
          break;
        case "long":
          new_mods_long_count = count;
          break;
      }
    }

    return {
      new_mods_short_count,
      new_mods_medium_count,
      new_mods_long_count,
      total_new_mods_count,
    };
  } catch (error) {
    console.warn(
      "[Analytics] mod_generations table unavailable, falling back to module count",
      error
    );

    const total_new_mods_count = await prisma.module.count({
      where: {
        createdAt: {
          gte: start,
          lt: end,
        },
      },
    });

    return {
      new_mods_short_count: 0,
      new_mods_medium_count: 0,
      new_mods_long_count: 0,
      total_new_mods_count,
    };
  }
}

async function buildStatsForRange(
  start: Date,
  end: Date,
  label: string
): Promise<BaseStats> {
  const prisma = getPrismaClient();

  const [
    login_users_count,
    new_users_count,
    total_simulations_count,
    total_simulation_events_count,
    activeEmails,
    modStats,
  ] = await Promise.all([
    prisma.user.count({
      where: {
        lastLoginAt: {
          gte: start,
          lt: end,
        },
      },
    }),
    prisma.user.count({
      where: {
        createdAt: {
          gte: start,
          lt: end,
        },
      },
    }),
    prisma.simulationRuntime.count({
      where: {
        createdAt: {
          gte: start,
          lt: end,
        },
      },
    }),
    prisma.simulationEvent.count({
      where: {
        timestamp: {
          gte: start,
          lt: end,
        },
      },
    }),
    getActiveUserEmails(start, end),
    getModuleGenerationStats(start, end),
  ]);

  const active_users_count = activeEmails.length;
  const avg_simulations_per_active_user =
    active_users_count > 0 ? total_simulations_count / active_users_count : 0;

  return {
    stat_date: label,
    login_users_count,
    active_users_count,
    new_users_count,
    total_simulations_count,
    total_simulation_events_count,
    avg_simulations_per_active_user,
    ...modStats,
  };
}

function toDailyStats(base: BaseStats): DailyStats {
  const timestamp = new Date().toISOString();
  return {
    id: `daily:${base.stat_date}`,
    ...base,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export async function calculateDailyStats(date: string): Promise<BaseStats> {
  const { dayStart, nextDay } = dayRange(date);
  return buildStatsForRange(dayStart, nextDay, date);
}

export async function getRecentWindowStats(
  hours: number
): Promise<WindowStats> {
  const window_end = new Date();
  const window_start = new Date(window_end.getTime() - hours * 60 * 60 * 1000);
  const stats = await buildStatsForRange(
    window_start,
    window_end,
    window_start.toISOString().split("T")[0]
  );

  return {
    window_start: window_start.toISOString(),
    window_end: window_end.toISOString(),
    login_users_count: stats.login_users_count,
    active_users_count: stats.active_users_count,
    new_users_count: stats.new_users_count,
    total_simulations_count: stats.total_simulations_count,
    total_simulation_events_count: stats.total_simulation_events_count,
    avg_simulations_per_active_user: stats.avg_simulations_per_active_user,
    new_mods_short_count: stats.new_mods_short_count,
    new_mods_medium_count: stats.new_mods_medium_count,
    new_mods_long_count: stats.new_mods_long_count,
    total_new_mods_count: stats.total_new_mods_count,
  };
}

export async function saveDailyStats(_stats: BaseStats): Promise<void> {
  // Analytics are computed live from simulation tables. No snapshot persistence.
}

export async function incrementDailyModGenerationCount(
  _storyLength: string,
  _generatedAt: Date = new Date()
): Promise<void> {
  // Module generation analytics are computed live from underlying data.
}

export async function getHistoricalStats(days: number): Promise<DailyStats[]> {
  const todayUtc = new Date();
  todayUtc.setUTCHours(0, 0, 0, 0);

  const stats = await Promise.all(
    Array.from({ length: days }, async (_, index) => {
      const date = new Date(todayUtc);
      date.setUTCDate(date.getUTCDate() - index);
      const dateString = date.toISOString().split("T")[0];
      return toDailyStats(await calculateDailyStats(dateString));
    })
  );

  return stats.sort((a, b) => b.stat_date.localeCompare(a.stat_date));
}

export async function getTodayStats(): Promise<DailyStats> {
  const today = new Date().toISOString().split("T")[0];
  return toDailyStats(await calculateDailyStats(today));
}

export async function getAccumulatedStats(): Promise<AccumulatedStats> {
  const prisma = getPrismaClient();

  const [accumulated_users_count, accumulated_simulations_count] =
    await Promise.all([prisma.user.count(), prisma.simulationRuntime.count()]);

  return {
    accumulated_users_count,
    accumulated_simulations_count,
  };
}

export async function getTopUsersBySimulationsForDate(
  date: string,
  limit = 5
): Promise<TopUserSimulations[]> {
  const prisma = getPrismaClient();
  const { dayStart, nextDay } = dayRange(date);

  const runtimeRows = await prisma.simulationRuntime.findMany({
    where: {
      createdAt: {
        gte: dayStart,
        lt: nextDay,
      },
    },
    select: {
      session: {
        select: {
          emailId: true,
        },
      },
    },
  });

  const counts = new Map<string, number>();
  for (const row of runtimeRows) {
    const email = row.session.emailId;
    if (!email) continue;
    counts.set(email, (counts.get(email) ?? 0) + 1);
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit);

  if (ranked.length === 0) {
    return [];
  }

  const emails = ranked.map(([email]) => email);
  const users = await prisma.user.findMany({
    where: {
      email: {
        in: emails,
      },
    },
    select: {
      email: true,
      username: true,
    },
  });

  const usernameByEmail = new Map(
    users.map((user) => [user.email, user.username])
  );

  return ranked.map(([email, simulations_count]) => ({
    email,
    username: usernameByEmail.get(email) ?? null,
    simulations_count,
  }));
}
