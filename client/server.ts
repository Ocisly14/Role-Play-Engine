import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import cors from "cors";
import express from "express";
import cookieParser from "cookie-parser";
import http from "http";
import fs from "fs";

// Import all route modules
import authRoutes from "./server/auth/routes.js";
import dataRoutes from "./server/data/routes.js";
import characterRoutes from "./server/character/routes.js";
import gameRoutes from "./server/game/routes.js";
import modRoutes from "./server/mod/routes.js";
import turnRoutes from "./server/turn/routes.js";
import checkpointRoutes from "./server/checkpoint/routes.js";
import mapRoutes from "./server/maps/routes.js";
import memoRoutes from "./server/memos/routes.js";
import skillRoutes from "./server/skills/routes.js";

// Import managers
import { DatabaseManager } from "./server/core/DatabaseManager.js";
import { WebSocketManager } from "./server/websocket/WebSocketManager.js";
import { LocalEmbeddingManager } from "../src/rag/localEmbeddingManager.js";
import { warmupSkillEmbeddings } from "./server/skills/skillMatcher.js";

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
app.use("/api", gameRoutes); // /api/game/*, /api/gamestate
app.use("/api", modRoutes); // /api/mod/*, /api/module/*
app.use("/api", turnRoutes); // /api/turns*, /api/sessions/*
app.use("/api", checkpointRoutes); // /api/checkpoints/*
app.use("/api", memoRoutes); // /api/memos
app.use("/api", skillRoutes); // /api/skills/*

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

// Create WebSocket server
const wsManager = new WebSocketManager(server);

// Start server
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`🔌 WebSocket server ready on ws://localhost:${PORT}/ws`);
  console.log("✅ Frontend server ready (lazy initialization)");

  if (process.env.SKIP_EMBEDDING_WARMUP !== "true") {
    LocalEmbeddingManager.getInstance()
      .warmup(["en", "zh"])
      .then(() => {
        console.log("✅ Local embedding model warmed up");
        if (process.env.SKIP_SKILL_EMBEDDING_WARMUP === "true") {
          return;
        }
        try {
          const db = DatabaseManager.getInstance().getDatabase();
          const database = db.getDatabase();
          const skills = database
            .prepare("SELECT name, description FROM skills")
            .all() as Array<{ name: string; description: string }>;
          if (skills.length === 0) {
            console.warn("⚠️  Skill embedding warmup skipped: no skills found");
            return;
          }
          warmupSkillEmbeddings(skills)
            .then(() => {
              console.log("✅ Skill embeddings warmed up");
            })
            .catch((error) => {
              console.warn("⚠️  Skill embedding warmup failed:", error);
            });
        } catch (error) {
          console.warn("⚠️  Skill embedding warmup failed:", error);
        }
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

  wsManager.close();
  DatabaseManager.getInstance().close();

  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});
