/**
 * Module generation quota manager
 *
 * Quota rules:
 * - New accounts get a one-time initial grant of 3 generations (medium ≤ 2, large ≤ 1).
 * - After the initial 3 are exhausted, a weekly quota of 3 kicks in
 *   (rolling 7-day window, same sub-caps).
 * - Short-story generations have no sub-cap within the total.
 * - Library downloads (addSharedMod) are never quota-gated.
 */

import type { CoCDatabase } from "../../../src/coc_multiagents_system/agents/memory/database/index.js";
import { randomUUID } from "crypto";

const INITIAL_QUOTA_TOTAL = 3;
const WEEKLY_QUOTA_TOTAL = 4;
const MEDIUM_LIMIT = 2;
const LARGE_LIMIT = 1;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
}

export interface QuotaStatus {
  phase: "initial" | "weekly";
  totalUsed: number;
  totalLimit: number;
  mediumUsed: number;
  mediumLimit: number;
  largeUsed: number;
  largeLimit: number;
}

/**
 * Check whether the user may generate a module of the given story length.
 * Returns immediately — no side effects.
 */
export function checkGenerationQuota(
  db: CoCDatabase,
  email: string,
  storyLength: string
): QuotaCheckResult {
  const database = db.getDatabase();

  const totalAllTime = (database
    .prepare("SELECT COUNT(*) as cnt FROM mod_generations WHERE email_id = ?")
    .get(email) as { cnt: number }).cnt;

  if (totalAllTime < INITIAL_QUOTA_TOTAL) {
    // Still consuming the one-time initial grant — sub-caps counted all-time
    return checkSubCaps(db, email, storyLength, null);
  }

  // Initial grant exhausted → enforce rolling weekly quota
  const weekAgo = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();

  const weeklyTotal = (database
    .prepare(
      "SELECT COUNT(*) as cnt FROM mod_generations WHERE email_id = ? AND generated_at >= ?"
    )
    .get(email, weekAgo) as { cnt: number }).cnt;

  if (weeklyTotal >= WEEKLY_QUOTA_TOTAL) {
    return {
      allowed: false,
      reason: "Weekly generation quota reached (max 4 per week). Please try again later.",
    };
  }

  return checkSubCaps(db, email, storyLength, weekAgo);
}

/**
 * Check medium / large sub-caps within a period.
 * @param sinceIso  null = all-time (initial-grant phase); otherwise the start of the weekly window.
 */
function checkSubCaps(
  db: CoCDatabase,
  email: string,
  storyLength: string,
  sinceIso: string | null
): QuotaCheckResult {
  const database = db.getDatabase();
  const timeClause = sinceIso ? " AND generated_at >= ?" : "";
  const params: unknown[] = sinceIso ? [email, sinceIso] : [email];

  if (storyLength === "medium") {
    const count = (database
      .prepare(
        `SELECT COUNT(*) as cnt FROM mod_generations WHERE email_id = ? AND story_length = 'medium'${timeClause}`
      )
      .get(...params) as { cnt: number }).cnt;

    if (count >= MEDIUM_LIMIT) {
      return {
        allowed: false,
        reason: sinceIso
          ? "Weekly medium-story limit reached (max 2). You can still generate a short story this week."
          : "Medium-story limit reached (max 2). You can still generate a short story.",
      };
    }
  }

  if (storyLength === "long") {
    const count = (database
      .prepare(
        `SELECT COUNT(*) as cnt FROM mod_generations WHERE email_id = ? AND story_length = 'long'${timeClause}`
      )
      .get(...params) as { cnt: number }).cnt;

    if (count >= LARGE_LIMIT) {
      return {
        allowed: false,
        reason: sinceIso
          ? "Weekly long-story limit reached (max 1). You can still generate a short or medium story this week."
          : "Long-story limit reached (max 1). You can still generate a short or medium story.",
      };
    }
  }

  return { allowed: true };
}

/**
 * Return the current quota snapshot for the given user (read-only).
 */
export function getQuotaStatus(db: CoCDatabase, email: string): QuotaStatus {
  const database = db.getDatabase();

  const totalAllTime = (database
    .prepare("SELECT COUNT(*) as cnt FROM mod_generations WHERE email_id = ?")
    .get(email) as { cnt: number }).cnt;

  if (totalAllTime < INITIAL_QUOTA_TOTAL) {
    // Initial-grant phase — sub-caps counted across all time
    const mediumUsed = (database
      .prepare("SELECT COUNT(*) as cnt FROM mod_generations WHERE email_id = ? AND story_length = 'medium'")
      .get(email) as { cnt: number }).cnt;
    const largeUsed = (database
      .prepare("SELECT COUNT(*) as cnt FROM mod_generations WHERE email_id = ? AND story_length = 'long'")
      .get(email) as { cnt: number }).cnt;

    return {
      phase: "initial",
      totalUsed: totalAllTime,
      totalLimit: INITIAL_QUOTA_TOTAL,
      mediumUsed,
      mediumLimit: MEDIUM_LIMIT,
      largeUsed,
      largeLimit: LARGE_LIMIT,
    };
  }

  // Weekly phase — rolling 7-day window
  const weekAgo = new Date(Date.now() - SEVEN_DAYS_MS).toISOString();

  const weeklyTotal = (database
    .prepare("SELECT COUNT(*) as cnt FROM mod_generations WHERE email_id = ? AND generated_at >= ?")
    .get(email, weekAgo) as { cnt: number }).cnt;
  const weeklyMedium = (database
    .prepare("SELECT COUNT(*) as cnt FROM mod_generations WHERE email_id = ? AND story_length = 'medium' AND generated_at >= ?")
    .get(email, weekAgo) as { cnt: number }).cnt;
  const weeklyLarge = (database
    .prepare("SELECT COUNT(*) as cnt FROM mod_generations WHERE email_id = ? AND story_length = 'long' AND generated_at >= ?")
    .get(email, weekAgo) as { cnt: number }).cnt;

  return {
    phase: "weekly",
    totalUsed: weeklyTotal,
    totalLimit: WEEKLY_QUOTA_TOTAL,
    mediumUsed: weeklyMedium,
    mediumLimit: MEDIUM_LIMIT,
    largeUsed: weeklyLarge,
    largeLimit: LARGE_LIMIT,
  };
}

/**
 * Persist a successful module-generation event.  Call only after the module
 * has been registered to the user's library.
 */
export function recordGeneration(
  db: CoCDatabase,
  email: string,
  moduleName: string,
  storyLength: string
): void {
  db.getDatabase()
    .prepare(
      "INSERT INTO mod_generations (id, email_id, module_name, story_length) VALUES (?, ?, ?, ?)"
    )
    .run(randomUUID(), email, moduleName, storyLength);
}
