import type { Request, Response } from "express";
import {
  calculateDailyStats,
  getHistoricalStats,
  getRecentWindowStats,
  getTodayStats,
  saveDailyStats,
} from "./service.js";

/**
 * GET /api/analytics/daily?days=30
 * Get today's stats and historical data
 */
export async function getDailyAnalytics(req: Request, res: Response) {
  try {
    const days = Math.min(Number(req.query.days) || 30, 365); // Cap at 1 year

    // Get today's stats (calculates if not exists)
    const todayStats = await getTodayStats();

    // Get historical stats
    const historicalStats = await getHistoricalStats(days);
    const recent48h = await getRecentWindowStats(48);

    return res.json({
      today: todayStats,
      history: historicalStats,
      recent48h,
    });
  } catch (error) {
    console.error("Error fetching daily analytics:", error);
    return res.status(500).json({
      error: "Failed to fetch analytics",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * POST /api/analytics/refresh
 * Manually refresh today's statistics
 */
export async function refreshAnalytics(req: Request, res: Response) {
  try {
    const today = new Date().toISOString().split("T")[0];

    // Calculate fresh stats
    const stats = await calculateDailyStats(today);

    // Save to database
    await saveDailyStats(stats);

    // Get the saved record
    const todayStats = await getTodayStats();

    return res.json({
      success: true,
      stats: todayStats,
    });
  } catch (error) {
    console.error("Error refreshing analytics:", error);
    return res.status(500).json({
      error: "Failed to refresh analytics",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}
