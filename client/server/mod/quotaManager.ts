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

import { getPrismaClient } from "../../../src/shared/agents/memory/database/prismaClient.js";
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
export async function checkGenerationQuota(
  email: string,
  storyLength: string
): Promise<QuotaCheckResult> {
  const prisma = getPrismaClient();

  const totalAllTime = await prisma.modGeneration.count({
    where: { emailId: email },
  });

  if (totalAllTime < INITIAL_QUOTA_TOTAL) {
    // Still consuming the one-time initial grant — sub-caps counted all-time
    return checkSubCaps(email, storyLength, null);
  }

  // Initial grant exhausted → enforce rolling weekly quota
  const weekAgo = new Date(Date.now() - SEVEN_DAYS_MS);

  const weeklyTotal = await prisma.modGeneration.count({
    where: { emailId: email, generatedAt: { gte: weekAgo } },
  });

  if (weeklyTotal >= WEEKLY_QUOTA_TOTAL) {
    return {
      allowed: false,
      reason:
        "Weekly generation quota reached (max 4 per week). Please try again later.",
    };
  }

  return checkSubCaps(email, storyLength, weekAgo);
}

/**
 * Check medium / large sub-caps within a period.
 * @param since  null = all-time (initial-grant phase); otherwise the start of the weekly window.
 */
async function checkSubCaps(
  email: string,
  storyLength: string,
  since: Date | null
): Promise<QuotaCheckResult> {
  const prisma = getPrismaClient();
  const timeFilter = since ? { gte: since } : undefined;

  if (storyLength === "medium") {
    const count = await prisma.modGeneration.count({
      where: {
        emailId: email,
        storyLength: "medium",
        ...(timeFilter ? { generatedAt: timeFilter } : {}),
      },
    });

    if (count >= MEDIUM_LIMIT) {
      return {
        allowed: false,
        reason: since
          ? "Weekly medium-story limit reached (max 2). You can still generate a short story this week."
          : "Medium-story limit reached (max 2). You can still generate a short story.",
      };
    }
  }

  if (storyLength === "long") {
    const count = await prisma.modGeneration.count({
      where: {
        emailId: email,
        storyLength: "long",
        ...(timeFilter ? { generatedAt: timeFilter } : {}),
      },
    });

    if (count >= LARGE_LIMIT) {
      return {
        allowed: false,
        reason: since
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
export async function getQuotaStatus(email: string): Promise<QuotaStatus> {
  const prisma = getPrismaClient();

  const totalAllTime = await prisma.modGeneration.count({
    where: { emailId: email },
  });

  if (totalAllTime < INITIAL_QUOTA_TOTAL) {
    // Initial-grant phase — sub-caps counted across all time
    const mediumUsed = await prisma.modGeneration.count({
      where: { emailId: email, storyLength: "medium" },
    });
    const largeUsed = await prisma.modGeneration.count({
      where: { emailId: email, storyLength: "long" },
    });

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
  const weekAgo = new Date(Date.now() - SEVEN_DAYS_MS);

  const weeklyTotal = await prisma.modGeneration.count({
    where: { emailId: email, generatedAt: { gte: weekAgo } },
  });
  const weeklyMedium = await prisma.modGeneration.count({
    where: { emailId: email, storyLength: "medium", generatedAt: { gte: weekAgo } },
  });
  const weeklyLarge = await prisma.modGeneration.count({
    where: { emailId: email, storyLength: "long", generatedAt: { gte: weekAgo } },
  });

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
export async function recordGeneration(
  email: string,
  moduleName: string,
  storyLength: string
): Promise<void> {
  const prisma = getPrismaClient();
  await prisma.modGeneration.create({
    data: {
      id: randomUUID(),
      emailId: email,
      moduleName,
      storyLength,
    },
  });
}
