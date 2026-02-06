#!/usr/bin/env node

/**
 * Test script for ScenarioBuilderAgent using an existing module data bundle.
 */

import { config } from "dotenv";
config();

import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { CoCDatabase } from "./dist/src/shared/agents/memory/database/schema.js";
import { ScenarioBuilderAgent } from "./dist/src/dynamicworldagent/world_builder/scenarioBuilderAgent.js";
import {
  saveWorldToDatabase,
  saveWorldToJSON,
} from "./dist/src/dynamicworldagent/world_builder/persistence.js";

const logger = {
  info: (msg) => console.log(`ℹ️  ${msg}`),
  success: (msg) => console.log(`✅ ${msg}`),
  error: (msg) => console.log(`❌ ${msg}`),
  warn: (msg) => console.log(`⚠️  ${msg}`),
  debug: (msg) => console.log(`🔍 ${msg}`),
  section: (msg) => console.log(`\n📋 === ${msg} ===\n`),
};

const MODULE_NAME = process.argv[2] || "The White Silence Sings";
const MODULE_DIR = path.join(process.cwd(), "data", "Mods", MODULE_NAME);
const DIST_DIR = path.join(process.cwd(), "dist");

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

function loadNPCs(npcDir) {
  if (!fs.existsSync(npcDir)) {
    logger.warn(`NPC directory not found: ${npcDir}`);
    return [];
  }

  const files = fs.readdirSync(npcDir).filter((file) => file.endsWith(".json"));
  return files.map((file) => loadJson(path.join(npcDir, file)));
}

function ensureModuleBackground(db, title) {
  const database = db.getDatabase();
  const existing = database
    .prepare("SELECT module_id FROM module_backgrounds WHERE title = ?")
    .get(title);

  if (existing) {
    return;
  }

  const moduleId = `module-${title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^\w-]/g, "")}-${randomUUID().slice(0, 8)}`;
  const hasInitialGameTime = db.hasColumn(
    "module_backgrounds",
    "initial_game_time"
  );
  const hasIntroduction = db.hasColumn("module_backgrounds", "introduction");
  const hasInitialScenarioNPCs = db.hasColumn(
    "module_backgrounds",
    "initial_scenario_npcs"
  );

  if (hasInitialGameTime && hasIntroduction && hasInitialScenarioNPCs) {
    database
      .prepare(
        `INSERT INTO module_backgrounds (
          module_id, title, background, story_outline, module_notes,
          keeper_guidance, module_limitations, initial_game_time,
          initial_scenario_npcs, introduction, tags
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        moduleId,
        title,
        null,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify([]),
        null,
        JSON.stringify([])
      );
  } else if (hasInitialGameTime && hasInitialScenarioNPCs) {
    database
      .prepare(
        `INSERT INTO module_backgrounds (
          module_id, title, background, story_outline, module_notes,
          keeper_guidance, module_limitations, initial_game_time,
          initial_scenario_npcs, tags
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        moduleId,
        title,
        null,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify([]),
        JSON.stringify([])
      );
  } else if (hasInitialGameTime) {
    database
      .prepare(
        `INSERT INTO module_backgrounds (
          module_id, title, background, story_outline, module_notes,
          keeper_guidance, module_limitations, initial_game_time, tags
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        moduleId,
        title,
        null,
        null,
        null,
        null,
        null,
        null,
        JSON.stringify([])
      );
  } else {
    database
      .prepare(
        `INSERT INTO module_backgrounds (
          module_id, title, background, story_outline, module_notes,
          keeper_guidance, module_limitations, tags
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(moduleId, title, null, null, null, null, null, JSON.stringify([]));
  }

  logger.success(`Inserted module_backgrounds row for "${title}"`);
}

async function testScenarioBuilder() {
  logger.section("Scenario Builder Test - Existing Module Bundle");

  if (!fs.existsSync(DIST_DIR)) {
    logger.error(
      "Missing dist output. Run `npm run build` before executing this script."
    );
    return;
  }

  const hasGoogleApi = !!process.env.GOOGLE_API_KEY;
  const hasOpenAiApi = !!process.env.OPENAI_API_KEY;

  if (!hasGoogleApi && !hasOpenAiApi) {
    logger.error(
      "No API keys found. Please set GOOGLE_API_KEY or OPENAI_API_KEY."
    );
    return;
  }

  logger.success(
    `API Key available: ${hasGoogleApi ? "Google Gemini" : "OpenAI"}`
  );

  if (!fs.existsSync(MODULE_DIR)) {
    logger.error(`Module directory not found: ${MODULE_DIR}`);
    return;
  }

  const macroSceneFile = path.join(MODULE_DIR, "macro_scene.json");
  const truthTimelineFile = path.join(MODULE_DIR, "truth_timeline.json");
  const knowledgeMatrixFile = path.join(MODULE_DIR, "knowledge_matrix.json");
  const npcDir = path.join(MODULE_DIR, `${MODULE_NAME}_npc`);
  const scenariosDir = path.join(MODULE_DIR, `${MODULE_NAME}_Scenarios`);

  const macroSceneRaw = loadJson(macroSceneFile);
  const truthTimelineRaw = loadJson(truthTimelineFile);
  const knowledgeMatrixRaw = loadJson(knowledgeMatrixFile);

  const macroScene = macroSceneRaw.macroScene || macroSceneRaw;
  const mythosEvents = macroSceneRaw.mythosEvents || [];
  const endState = macroSceneRaw.endState;
  const truthTimeline = truthTimelineRaw.truthTimeline || [];
  const knowledgeMatrix = knowledgeMatrixRaw.knowledgeMatrix || [];
  const redHerrings = knowledgeMatrixRaw.redHerrings || [];
  const npcs = loadNPCs(npcDir);

  if (!endState) {
    logger.error("Missing endState in macro_scene.json");
    return;
  }

  logger.info(`Loaded macro scene: ${macroScene.moduleName}`);
  logger.info(`Truth events: ${truthTimeline.length}`);
  logger.info(`Knowledge holders: ${knowledgeMatrix.length}`);
  logger.info(`NPCs: ${npcs.length}`);

  logger.info("Initializing database...");
  const db = new CoCDatabase();
  ensureModuleBackground(db, MODULE_NAME);
  logger.success("Database ready");

  const scenarioBuilder = new ScenarioBuilderAgent();

  logger.section("Generating scenario outlines...");
  const scenarios = await scenarioBuilder.generate(
    macroScene,
    truthTimeline,
    knowledgeMatrix,
    (msg) => logger.info(msg)
  );
  logger.success(`Generated ${scenarios.length} scenario outlines`);
  if (scenarios.length === 0) {
    logger.error("No scenarios generated; aborting snapshot generation.");
    return;
  }

  logger.section("Generating starting scene snapshot...");
  const { startingScene, otherScenarioNpcAssignments } =
    await scenarioBuilder.generateStartingSceneSnapshot(
      macroScene,
      truthTimeline,
      knowledgeMatrix,
      scenarios,
      npcs,
      (msg) => logger.info(msg)
    );
  logger.success(`Starting scene: ${startingScene.scenarioName}`);

  logger.section("Persisting to JSON/DB...");
  await saveWorldToDatabase(
    db,
    MODULE_NAME,
    macroScene,
    truthTimeline,
    knowledgeMatrix,
    redHerrings,
    mythosEvents,
    endState,
    npcs,
    scenarios,
    startingScene,
    otherScenarioNpcAssignments
  );

  const generatedFiles = await saveWorldToJSON(
    MODULE_NAME,
    macroScene,
    truthTimeline,
    knowledgeMatrix,
    redHerrings,
    mythosEvents,
    endState,
    scenarios,
    npcs,
    startingScene,
    otherScenarioNpcAssignments
  );

  logger.success("Scenario builder test complete");
  logger.info(`Scenario outlines: ${generatedFiles.scenariosFile}`);
  if (fs.existsSync(scenariosDir)) {
    const scenarioFiles = fs
      .readdirSync(scenariosDir)
      .filter((file) => file.endsWith(".json"));
    logger.info(`Scenario files: ${scenarioFiles.length} in ${scenariosDir}`);
    logger.debug(`Files: ${scenarioFiles.join(", ")}`);
  } else {
    logger.warn(`Scenario directory not found: ${scenariosDir}`);
  }
}

testScenarioBuilder().catch((error) => {
  logger.error(`Scenario builder test failed: ${error.message}`);
});
