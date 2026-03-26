import { Router } from "express";
import { authenticate, requireRole } from "../auth/middleware.js";
import * as analyticsController from "./controller.js";
import * as visitorController from "./visitorController.js";

const router = Router();

// Visitor tracking — public (no auth)
router.post("/analytics/visitor/session", visitorController.startSession);
router.post("/analytics/visitor/heartbeat", visitorController.heartbeat);

// Admin-only routes
router.use(authenticate);
router.use(requireRole("ADMIN"));

// Get daily analytics with historical data
router.get("/analytics/daily", analyticsController.getDailyAnalytics);

// Manually refresh today's analytics
router.post("/analytics/refresh", analyticsController.refreshAnalytics);

// Visitor stats (admin only)
router.get("/analytics/visitor/stats", visitorController.stats);

export default router;
