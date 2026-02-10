import { Router } from "express";
import { authenticate, requireRole } from "../auth/middleware.js";
import * as analyticsController from "./controller.js";

const router = Router();

// All analytics routes require authentication and ADMIN role
router.use(authenticate);
router.use(requireRole("ADMIN"));

// Get daily analytics with historical data
router.get("/analytics/daily", analyticsController.getDailyAnalytics);

// Manually refresh today's analytics
router.post("/analytics/refresh", analyticsController.refreshAnalytics);

export default router;
