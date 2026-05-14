#!/usr/bin/env tsx

/**
 * Quick test for ModuleLoader
 * Loads module briefings from data/background and prints results
 */

import { config } from "dotenv";
config();

import fs from "fs";
import path from "path";
import { CoCDatabase } from "./src/shared/agents/memory/database/schema.js";
import { ModuleLoader } from "./src/shared/agents/memory/moduleloader/index.js";

const logger = {
  info: (msg: string) => console.log(`ℹ️  ${msg}`),
  success: (msg: string) => console.log(`✅ ${msg}`),
  warn: (msg: string) => console.log(`⚠️  ${msg}`),
  error: (msg: string) => console.log(`❌ ${msg}`),
  section: (msg: string) => console.log(`\n📋 === ${msg} ===\n`),
};

async function run() {
  logger.section("Module Loader Test");

  const hasGemini = !!process.env.GOOGLE_API_KEY;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  if (!hasGemini && !hasOpenAI) {
    logger.error(
      "API key not found (GOOGLE_API_KEY or OPENAI_API_KEY). Please configure one before running."
    );
    return;
  }
  logger.success(`Using ${hasGemini ? "Google Gemini" : "OpenAI"} for parsing`);

  const dbPath = path.join(process.cwd(), "data", "test_module.db");
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
    logger.info("Removed existing test database");
  }

  const db = new CoCDatabase(dbPath);
  const loader = new ModuleLoader(db);

  const backgroundDir = path.join(process.cwd(), "data", "background");
  if (!fs.existsSync(backgroundDir)) {
    fs.mkdirSync(backgroundDir, { recursive: true });
    logger.warn(
      `Created directory: ${backgroundDir}. Add .docx/.pdf files and rerun.`
    );
    return;
  }

  const files = fs
    .readdirSync(backgroundDir)
    .filter((f) => [".docx", ".pdf"].includes(path.extname(f).toLowerCase()));
  if (files.length === 0) {
    logger.warn(
      `Directory is empty: ${backgroundDir}. Add .docx/.pdf files and rerun.`
    );
    return;
  }
  logger.info(`Found ${files.length} document(s): ${files.join(", ")}`);

  logger.section("Start Import");
  const modules = await loader.loadModulesFromDirectory(backgroundDir);

  logger.section("Import Results");
  if (modules.length === 0) {
    logger.warn("No modules imported. Check parser logs.");
    return;
  }

  modules.forEach((m, idx) => {
    logger.success(
      `${idx + 1}. ${m.title} | Limitations: ${m.moduleLimitations ?? "none"} | Tags: ${m.tags.join(", ") || "none"}`
    );
  });

  const latest = modules[modules.length - 1];
  logger.section("Latest Module Snapshot");
  console.log(
    JSON.stringify(
      {
        id: latest.id,
        title: latest.title,
        background: latest.background?.slice(0, 160) ?? "none",
        outline: latest.storyOutline?.slice(0, 160) ?? "none",
        hook: latest.storyHook ?? "none",
        limitations: latest.moduleLimitations ?? "none",
      },
      null,
      2
    )
  );
}

run().catch((err) => {
  logger.error(
    `Test failed: ${err instanceof Error ? err.message : String(err)}`
  );
});
