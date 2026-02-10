import Database from "better-sqlite3";
import { CoCDatabase } from "../../../src/shared/agents/memory/database/schema.js";
import { randomUUID } from "node:crypto";

let dbInstance: CoCDatabase | null = null;

function getDB(): Database.Database {
  if (!dbInstance) {
    dbInstance = new CoCDatabase();
  }
  return dbInstance.getDatabase();
}

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
 * Calculate daily statistics for a specific date
 */
export function calculateDailyStats(date: string): Omit<DailyStats, 'id' | 'created_at' | 'updated_at'> {
  const db = getDB();

  // Login users: users who logged in on this date
  const loginUsersResult = db
    .prepare(
      `SELECT COUNT(DISTINCT id) as count
       FROM users
       WHERE DATE(last_login_at) = ?`
    )
    .get(date) as { count: number };

  const login_users_count = loginUsersResult.count;

  // Active users: users who sent messages on this date
  // Join users -> characters -> game_turns
  const activeUsersResult = db
    .prepare(
      `SELECT COUNT(DISTINCT u.id) as count
       FROM users u
       INNER JOIN characters c ON c.email_id = u.email
       INNER JOIN game_turns gt ON gt.character_id = c.character_id
       WHERE DATE(gt.started_at) = ? AND gt.is_simulated = 0`
    )
    .get(date) as { count: number };

  const active_users_count = activeUsersResult.count;

  // New users: users created on this date
  const newUsersResult = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM users
       WHERE DATE(created_at) = ?`
    )
    .get(date) as { count: number };

  const new_users_count = newUsersResult.count;

  // Total messages: non-simulated turns on this date
  const messagesResult = db
    .prepare(
      `SELECT COUNT(*) as count
       FROM game_turns
       WHERE DATE(started_at) = ? AND is_simulated = 0`
    )
    .get(date) as { count: number };

  const total_messages_count = messagesResult.count;

  // Average messages per active user
  const avg_messages_per_active_user =
    active_users_count > 0 ? total_messages_count / active_users_count : 0;

  // Module generation statistics
  // Check if mod_generations table exists first
  let new_mods_short_count = 0;
  let new_mods_medium_count = 0;
  let new_mods_long_count = 0;
  let total_new_mods_count = 0;

  try {
    const tableExists = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='mod_generations'`
      )
      .get() as { name: string } | undefined;

    if (tableExists) {
      const modStats = db
        .prepare(
          `SELECT story_length, COUNT(*) as count
           FROM mod_generations
           WHERE DATE(generated_at) = ?
           GROUP BY story_length`
        )
        .all(date) as Array<{ story_length: string; count: number }>;

      for (const stat of modStats) {
        const count = stat.count;
        total_new_mods_count += count;

        switch (stat.story_length) {
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
    }
  } catch (error) {
    // Table doesn't exist or query failed - keep zeros
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
export function saveDailyStats(stats: Omit<DailyStats, 'id' | 'created_at' | 'updated_at'>): void {
  const db = getDB();

  // Check if record exists for this date
  const existing = db
    .prepare(`SELECT id FROM daily_analytics WHERE stat_date = ?`)
    .get(stats.stat_date) as { id: string } | undefined;

  if (existing) {
    // Update existing record
    db.prepare(
      `UPDATE daily_analytics SET
        login_users_count = ?,
        active_users_count = ?,
        new_users_count = ?,
        total_messages_count = ?,
        avg_messages_per_active_user = ?,
        new_mods_short_count = ?,
        new_mods_medium_count = ?,
        new_mods_long_count = ?,
        total_new_mods_count = ?,
        updated_at = CURRENT_TIMESTAMP
       WHERE stat_date = ?`
    ).run(
      stats.login_users_count,
      stats.active_users_count,
      stats.new_users_count,
      stats.total_messages_count,
      stats.avg_messages_per_active_user,
      stats.new_mods_short_count,
      stats.new_mods_medium_count,
      stats.new_mods_long_count,
      stats.total_new_mods_count,
      stats.stat_date
    );
  } else {
    // Insert new record
    db.prepare(
      `INSERT INTO daily_analytics (
        id, stat_date, login_users_count, active_users_count, new_users_count,
        total_messages_count, avg_messages_per_active_user,
        new_mods_short_count, new_mods_medium_count, new_mods_long_count, total_new_mods_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(),
      stats.stat_date,
      stats.login_users_count,
      stats.active_users_count,
      stats.new_users_count,
      stats.total_messages_count,
      stats.avg_messages_per_active_user,
      stats.new_mods_short_count,
      stats.new_mods_medium_count,
      stats.new_mods_long_count,
      stats.total_new_mods_count
    );
  }
}

/**
 * Get historical statistics for the last N days
 */
export function getHistoricalStats(days: number): DailyStats[] {
  const db = getDB();

  const stats = db
    .prepare(
      `SELECT * FROM daily_analytics
       ORDER BY stat_date DESC
       LIMIT ?`
    )
    .all(days) as DailyStats[];

  return stats;
}

/**
 * Get or calculate today's statistics
 */
export function getTodayStats(): DailyStats {
  const db = getDB();
  const today = new Date().toISOString().split('T')[0];

  // Try to get existing stats
  const existing = db
    .prepare(`SELECT * FROM daily_analytics WHERE stat_date = ?`)
    .get(today) as DailyStats | undefined;

  if (existing) {
    return existing;
  }

  // Calculate and save new stats
  const stats = calculateDailyStats(today);
  saveDailyStats(stats);

  // Retrieve the saved record
  const saved = db
    .prepare(`SELECT * FROM daily_analytics WHERE stat_date = ?`)
    .get(today) as DailyStats;

  return saved;
}
