import "dotenv/config";
import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";

import analyticsRoutes from "./server/analytics/routes.js";
// Import all route modules
import authRoutes from "./server/auth/routes.js";
import characterRoutes from "./server/character/routes.js";
import dataRoutes from "./server/data/routes.js";
import mapRoutes from "./server/maps/routes.js";
import memoRoutes from "./server/memos/routes.js";
import modRoutes from "./server/mod/routes.js";
import ragRoutes from "./server/rag/routes.js";
import simulationMapRoutes from "./server/simulation/mapRoutes.js";
import simulationRoutes from "./server/simulation/routes.js";
import skillRoutes from "./server/skills/routes.js";

import { LocalEmbeddingManager } from "../src/rag/localEmbeddingManager.js";
import {
  startDailyScheduler,
  stopDailyScheduler,
} from "./server/analytics/scheduler.js";
import { syncReferralCodes } from "./server/auth/referral-sync.js";
// Import managers
import { DatabaseManager } from "./server/core/DatabaseManager.js";
import { WebSocketManager } from "./server/websocket/WebSocketManager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const portFromApiUrl = (() => {
  if (!process.env.API_URL) return undefined;
  try {
    const apiUrl = new URL(process.env.API_URL);
    return apiUrl.port
      ? Number(apiUrl.port)
      : apiUrl.protocol === "https:"
        ? 443
        : 80;
  } catch {
    return undefined;
  }
})();
const PORT = Number(process.env.PORT) || portFromApiUrl || 3000;

// Middleware
app.use(
  cors({
    origin: true,
    credentials: true,
    exposedHeaders: ["x-access-token"],
  })
);
app.use(express.json());
app.use(cookieParser());

// Serve frontend build
const distDir = path.join(__dirname, "dist");
const staticDir = fs.existsSync(path.join(distDir, "index.html"))
  ? distDir
  : __dirname;
app.use(express.static(staticDir));

// Mount API routes
app.use("/api/maps", mapRoutes); // /api/maps/* - Map image serving (MUST be first, no auth)
app.use("/api/auth", authRoutes); // /api/auth/* - Authentication routes
app.use("/api", dataRoutes); // /api/occupations, /api/weapons, /api/mods
app.use("/api", characterRoutes); // /api/character*, /api/characters
app.use("/api", modRoutes); // /api/mod/*, /api/module/*
app.use("/api", memoRoutes); // /api/memos
app.use("/api", skillRoutes); // /api/skills/*
app.use("/api", analyticsRoutes); // /api/analytics/*
app.use("/api", ragRoutes); // /api/rag/*
app.use("/api", simulationMapRoutes); // /api/simulation/:id/* public viewer reads (no auth)
app.use("/api", simulationRoutes); // /api/simulation*, /api/simulations

// SPA fallback (must be after API routes)
app.get("*", (_req, res) => {
  const indexPath = path.join(staticDir, "index.html");
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res
      .status(500)
      .send(
        "Frontend not built. Run `pnpm --filter coc-investigator-sheet build` to generate dist/."
      );
  }
});

// Create HTTP server
const server = http.createServer(app);

// Set timeout to 10 minutes for long-running operations (e.g., module generation)
server.timeout = 600000; // 10 minutes (600 seconds)
server.keepAliveTimeout = 610000; // Slightly longer than timeout

// Create WebSocket server
const wsManager = new WebSocketManager(server);

// Start server
server.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket server ready on ws://localhost:${PORT}/ws`);
  console.log("✅ Frontend server ready (lazy initialization)");

  // Update admin user roles on startup
  try {
    const adminEmails = (process.env.ADMIN_EMAIL || "")
      .split(",")
      .map((email: string) => email.trim().toLowerCase())
      .filter((email: string) => email.length > 0);
    if (adminEmails.length > 0) {
      const prisma = DatabaseManager.getInstance().getPrisma();
      for (const email of adminEmails) {
        const result = await prisma.user.updateMany({
          where: {
            email: { equals: email, mode: "insensitive" },
            role: { not: "ADMIN" },
          },
          data: { role: "ADMIN" },
        });
        if (result.count > 0) {
          console.log(`✅ Updated user ${email} to ADMIN role`);
        }
      }
    }
  } catch (error) {
    console.error("❌ Failed to update admin user roles:", error);
  }

  // Sync referral codes from environment variables
  try {
    await syncReferralCodes();
  } catch (error) {
    console.error("❌ Failed to sync referral codes:", error);
  }

  // Start analytics scheduler
  startDailyScheduler();

  if (process.env.SKIP_EMBEDDING_WARMUP !== "true") {
    LocalEmbeddingManager.getInstance()
      .warmup(["en", "zh"])
      .then(async () => {
        console.log("✅ Local embedding model warmed up");
      })
      .catch((error) => {
        console.warn("⚠️  Local embedding warmup failed:", error);
        console.warn(
          "⚠️  Skill embedding warmup skipped (local embedding unavailable)"
        );
      });
  }
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down gracefully...");

  stopDailyScheduler();
  wsManager.close();
  DatabaseManager.getInstance().close();

  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});
