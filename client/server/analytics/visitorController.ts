import type { Request, Response } from "express";
import {
  createVisitorSession,
  getVisitorStats,
  updateHeartbeat,
} from "./visitorService.js";

function extractIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "unknown";
}

/**
 * POST /api/analytics/visitor/session
 */
export async function startSession(req: Request, res: Response) {
  try {
    const { sessionId } = req.body;
    if (!sessionId || typeof sessionId !== "string") {
      return res
        .status(400)
        .json({ success: false, error: "Missing sessionId" });
    }
    const ip = extractIp(req);
    const userAgent = req.headers["user-agent"];
    await createVisitorSession(sessionId, ip, userAgent);
    return res.json({ success: true });
  } catch (error) {
    console.error("Visitor session create error:", error);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
}

/**
 * POST /api/analytics/visitor/heartbeat
 */
export async function heartbeat(req: Request, res: Response) {
  try {
    const { sessionId } = req.body;
    if (!sessionId || typeof sessionId !== "string") {
      return res
        .status(400)
        .json({ success: false, error: "Missing sessionId" });
    }
    const ok = await updateHeartbeat(sessionId);
    if (!ok) {
      return res
        .status(404)
        .json({ success: false, error: "Session not found" });
    }
    return res.json({ success: true });
  } catch (error) {
    console.error("Visitor heartbeat error:", error);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
}

/**
 * GET /api/analytics/visitor/stats?date=YYYY-MM-DD
 */
export async function stats(req: Request, res: Response) {
  try {
    const date =
      typeof req.query.date === "string" ? req.query.date : undefined;
    const data = await getVisitorStats(date);
    return res.json({ success: true, data });
  } catch (error) {
    console.error("Visitor stats error:", error);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
}
