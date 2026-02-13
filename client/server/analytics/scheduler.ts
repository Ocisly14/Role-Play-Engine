import { calculateDailyStats, saveDailyStats } from "./service.js";

let schedulerInterval: NodeJS.Timeout | null = null;

/**
 * Calculate time until next midnight UTC
 */
function getMillisecondsUntilMidnight(): number {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime() - now.getTime();
}

/**
 * Save analytics for the previous day
 */
async function saveYesterdayAnalytics(): Promise<void> {
  try {
    const now = new Date();
    const yesterday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    console.log(`[Analytics Scheduler] Calculating stats for ${dateStr}...`);
    const stats = await calculateDailyStats(dateStr);
    await saveDailyStats(stats);
    console.log(`[Analytics Scheduler] Stats saved for ${dateStr}`);
  } catch (error) {
    console.error("[Analytics Scheduler] Error saving analytics:", error);
  }
}

/**
 * Start the daily analytics scheduler
 * Runs every day at midnight UTC
 */
export function startDailyScheduler(): void {
  // Don't start if already running
  if (schedulerInterval) {
    console.log("[Analytics Scheduler] Already running");
    return;
  }

  // Check environment variable
  const enabled = process.env.ENABLE_ANALYTICS_SCHEDULER !== "false"; // Default enabled
  if (!enabled) {
    console.log("[Analytics Scheduler] Disabled via ENABLE_ANALYTICS_SCHEDULER");
    return;
  }

  console.log("[Analytics Scheduler] Starting...");

  // Schedule first run at next midnight
  const msUntilMidnight = getMillisecondsUntilMidnight();
  console.log(
    `[Analytics Scheduler] First run in ${Math.round(msUntilMidnight / 1000 / 60)} minutes`
  );

  setTimeout(() => {
    saveYesterdayAnalytics();

    // Then run every 24 hours
    schedulerInterval = setInterval(() => {
      saveYesterdayAnalytics();
    }, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  console.log("[Analytics Scheduler] Started successfully");
}

/**
 * Stop the scheduler
 */
export function stopDailyScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[Analytics Scheduler] Stopped");
  }
}
