import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
import { randomUUID } from "node:crypto";

export interface DailyStats {
  id: string;
  stat_date: string;
  login_users_count: number;
  active_users_count: number;
  new_users_count: number;
  total_messages_count: number;
  avg_messages_per_active_user: number;
  new_mods_short_count: number;
  new_mods_medium_count: number;
  new_mods_long_count: number;
  total_new_mods_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * Build start-of-day and start-of-next-day Date objects for a date string (YYYY-MM-DD).
 */
function dayRange(dateStr: string): { dayStart: Date; nextDay: Date } {
  const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
  const nextDay = new Date(dayStart);
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return { dayStart, nextDay };
}

/**
 * Convert a Prisma DailyAnalytics row into the legacy DailyStats shape.
 */
function toDailyStats(row: {
  id: string;
  statDate: Date;
  loginUsersCount: number;
  activeUsersCount: number;
  newUsersCount: number;
  totalMessagesCount: number;
  avgMessagesPerActiveUser: number;
  newModsShortCount: number;
  newModsMediumCount: number;
  newModsLongCount: number;
  totalNewModsCount: number;
  createdAt: Date;
  updatedAt: Date;
}): DailyStats {
  return {
    id: row.id,
    stat_date: row.statDate.toISOString().split("T")[0],
    login_users_count: row.loginUsersCount,
    active_users_count: row.activeUsersCount,
    new_users_count: row.newUsersCount,
    total_messages_count: row.totalMessagesCount,
    avg_messages_per_active_user: row.avgMessagesPerActiveUser,
    new_mods_short_count: row.newModsShortCount,
    new_mods_medium_count: row.newModsMediumCount,
    new_mods_long_count: row.newModsLongCount,
    total_new_mods_count: row.totalNewModsCount,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Calculate daily statistics for a specific date
 */
export async function calculateDailyStats(
  date: string
): Promise<Omit<DailyStats, "id" | "created_at" | "updated_at">> {
  const prisma = getPrismaClient();
  const { dayStart, nextDay } = dayRange(date);

  // Login users: users who logged in on this date
  const login_users_count = await prisma.user.count({
    where: {
      lastLoginAt: {
        gte: dayStart,
        lt: nextDay,
      },
    },
  });

  // Active users: users who sent messages on this date
  // Join users -> characters -> game_turns
  const activeUsersRows = await prisma.gameTurn.findMany({
    where: {
      startedAt: {
        gte: dayStart,
        lt: nextDay,
      },
      isSimulated: false,
      characterId: { not: null },
    },
    select: {
      characterId: true,
    },
  });

  // Collect distinct character IDs from turns
  const activeCharacterIds = [
    ...new Set(
      activeUsersRows
        .map((r) => r.characterId)
        .filter((id): id is string => id !== null)
    ),
  ];

  // Find distinct users (via email) for those characters
  let active_users_count = 0;
  if (activeCharacterIds.length > 0) {
    const characters = await prisma.character.findMany({
      where: {
        characterId: { in: activeCharacterIds },
        emailId: { not: null },
      },
      select: { emailId: true },
    });

    const activeEmails = new Set(characters.map((c) => c.emailId));

    const activeUsers = await prisma.user.count({
      where: {
        email: { in: [...activeEmails].filter((e): e is string => e !== null) },
      },
    });

    active_users_count = activeUsers;
  }

  // New users: users created on this date
  const new_users_count = await prisma.user.count({
    where: {
      createdAt: {
        gte: dayStart,
        lt: nextDay,
      },
    },
  });

  // Total messages: non-simulated turns on this date
  const total_messages_count = await prisma.gameTurn.count({
    where: {
      startedAt: {
        gte: dayStart,
        lt: nextDay,
      },
      isSimulated: false,
    },
  });

  // Average messages per active user
  const avg_messages_per_active_user =
    active_users_count > 0 ? total_messages_count / active_users_count : 0;

  // Module generation statistics
  let new_mods_short_count = 0;
  let new_mods_medium_count = 0;
  let new_mods_long_count = 0;
  let total_new_mods_count = 0;

  try {
    const modStats = await prisma.modGeneration.groupBy({
      by: ["storyLength"],
      where: {
        generatedAt: {
          gte: dayStart,
          lt: nextDay,
        },
      },
      _count: {
        id: true,
      },
    });

    for (const stat of modStats) {
      const count = stat._count.id;
      total_new_mods_count += count;

      switch (stat.storyLength) {
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
  } catch (error) {
    // Query failed - keep zeros
    console.warn("Module generation stats unavailable:", error);
  }

  return {
    stat_date: date,
    login_users_count,
    active_users_count,
    new_users_count,
    total_messages_count,
    avg_messages_per_active_user,
    new_mods_short_count,
    new_mods_medium_count,
    new_mods_long_count,
    total_new_mods_count,
  };
}

/**
 * Save or update daily statistics to database
 */
export async function saveDailyStats(
  stats: Omit<DailyStats, "id" | "created_at" | "updated_at">
): Promise<void> {
  const prisma = getPrismaClient();
  const statDate = new Date(`${stats.stat_date}T00:00:00.000Z`);

  await prisma.dailyAnalytics.upsert({
    where: { statDate },
    update: {
      loginUsersCount: stats.login_users_count,
      activeUsersCount: stats.active_users_count,
      newUsersCount: stats.new_users_count,
      totalMessagesCount: stats.total_messages_count,
      avgMessagesPerActiveUser: stats.avg_messages_per_active_user,
      newModsShortCount: stats.new_mods_short_count,
      newModsMediumCount: stats.new_mods_medium_count,
      newModsLongCount: stats.new_mods_long_count,
      totalNewModsCount: stats.total_new_mods_count,
      updatedAt: new Date(),
    },
    create: {
      id: randomUUID(),
      statDate,
      loginUsersCount: stats.login_users_count,
      activeUsersCount: stats.active_users_count,
      newUsersCount: stats.new_users_count,
      totalMessagesCount: stats.total_messages_count,
      avgMessagesPerActiveUser: stats.avg_messages_per_active_user,
      newModsShortCount: stats.new_mods_short_count,
      newModsMediumCount: stats.new_mods_medium_count,
      newModsLongCount: stats.new_mods_long_count,
      totalNewModsCount: stats.total_new_mods_count,
    },
  });
}

/**
 * Get historical statistics for the last N days
 * Returns data for the past N days, filling in missing days with calculated stats
 */
export async function getHistoricalStats(days: number): Promise<DailyStats[]> {
  const prisma = getPrismaClient();

  // Calculate the cutoff date: N days ago from now
  const cutoffDate = new Date();
  cutoffDate.setUTCDate(cutoffDate.getUTCDate() - days);
  cutoffDate.setUTCHours(0, 0, 0, 0);

  // Get stats for the past N days
  const rows = await prisma.dailyAnalytics.findMany({
    where: {
      statDate: { gte: cutoffDate },
    },
    orderBy: { statDate: "desc" },
  });

  const stats: DailyStats[] = rows.map(toDailyStats);

  // If we have fewer records than requested days, fill in missing days
  if (stats.length < days) {
    const existingDates = new Set(stats.map((s) => s.stat_date));
    const today = new Date();

    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateString = date.toISOString().split("T")[0];

      if (!existingDates.has(dateString)) {
        // Calculate stats for this missing day
        const calculatedStats = await calculateDailyStats(dateString);
        await saveDailyStats(calculatedStats);

        // Retrieve the saved record
        const statDate = new Date(`${dateString}T00:00:00.000Z`);
        const saved = await prisma.dailyAnalytics.findUnique({
          where: { statDate },
        });

        if (saved) {
          stats.push(toDailyStats(saved));
        }
      }
    }

    // Re-sort after adding missing days
    stats.sort((a, b) => b.stat_date.localeCompare(a.stat_date));
  }

  return stats;
}

/**
 * Get or calculate today's statistics
 */
export async function getTodayStats(): Promise<DailyStats> {
  const prisma = getPrismaClient();
  const today = new Date().toISOString().split("T")[0];
  const statDate = new Date(`${today}T00:00:00.000Z`);

  // Try to get existing stats
  const existing = await prisma.dailyAnalytics.findUnique({
    where: { statDate },
  });

  if (existing) {
    return toDailyStats(existing);
  }

  // Calculate and save new stats
  const stats = await calculateDailyStats(today);
  await saveDailyStats(stats);

  // Retrieve the saved record
  const saved = await prisma.dailyAnalytics.findUnique({
    where: { statDate },
  });

  return toDailyStats(saved!);
}
