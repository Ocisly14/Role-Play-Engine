#!/usr/bin/env tsx

/**
 * Test script for NPCLoader functionality
 * Tests parsing and processing of actual NPC documents
 */

import { config } from "dotenv";
config();

import fs from "fs";
import path from "path";
import { NPCLoader } from "./src/shared/agents/character/npcloader/index.js";
import { CoCDatabase } from "./src/shared/agents/memory/database/schema.js";

// Configure logging for terminal display
const logger = {
  info: (msg: string) => console.log(`ℹ️  ${msg}`),
  success: (msg: string) => console.log(`✅ ${msg}`),
  error: (msg: string) => console.log(`❌ ${msg}`),
  warn: (msg: string) => console.log(`⚠️  ${msg}`),
  debug: (msg: string) => console.log(`🔍 ${msg}`),
  section: (msg: string) => console.log(`\n📋 === ${msg} ===\n`),
};

async function testNPCLoader() {
  logger.section("NPC Loader Test - Real Document Processing");

  try {
    // Check for required environment variables
    const hasGoogleApi = !!process.env.GOOGLE_API_KEY;
    const hasOpenAiApi = !!process.env.OPENAI_API_KEY;

    if (!hasGoogleApi && !hasOpenAiApi) {
      logger.error(
        "No API keys found. Please set either GOOGLE_API_KEY or OPENAI_API_KEY environment variable."
      );
      logger.info("For testing purposes, you can set one of these:");
      logger.info("export GOOGLE_API_KEY=your_gemini_api_key");
      logger.info("export OPENAI_API_KEY=your_openai_api_key");
      return;
    }

    logger.success(
      `API Key available: ${hasGoogleApi ? "Google Gemini" : "OpenAI"}`
    );

    // Initialize database
    logger.info("Initializing database...");
    const dbPath = path.join(process.cwd(), "data", "test_coc.db");

    // Remove existing test database if it exists
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      logger.info("Removed existing test database");
    }

    const db = new CoCDatabase(dbPath);
    logger.success("Database initialized successfully");

    // Initialize NPC Loader
    const npcLoader = new NPCLoader(db);
    logger.success("NPC Loader initialized");

    // Test with the actual NPC document directory
    const npcDocDir = path.join(process.cwd(), "data", "npcs");
    logger.section(`Testing Document Processing from: ${npcDocDir}`);

    // Check what files are available
    if (fs.existsSync(npcDocDir)) {
      const files = fs.readdirSync(npcDocDir);
      const npcFiles = files.filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return ext === ".docx" || ext === ".pdf";
      });

      logger.info(
        `Found ${npcFiles.length} NPC document(s): ${npcFiles.join(", ")}`
      );

      if (npcFiles.length === 0) {
        logger.warn("No .docx or .pdf files found in the directory");
        return;
      }
    } else {
      logger.error(`NPC document directory does not exist: ${npcDocDir}`);
      return;
    }

    // Process the NPCs
    logger.section("Processing NPC Documents");

    const loadedNPCs = await npcLoader.loadNPCsFromDirectory(npcDocDir);

    if (loadedNPCs.length > 0) {
      logger.success(`Successfully processed ${loadedNPCs.length} NPC(s)`);

      // Display detailed information for each loaded NPC
      for (const npc of loadedNPCs) {
        logger.section(`📜 NPC Profile: ${npc.name}`);
        logger.info(`🆔 ID: ${npc.id}`);

        if (npc.occupation) logger.info(`💼 Occupation: ${npc.occupation}`);
        if (npc.age) logger.info(`🎂 Age: ${npc.age}`);
        if (npc.appearance)
          logger.info(`👤 Appearance: ${npc.appearance.substring(0, 100)}...`);
        if (npc.personality)
          logger.info(
            `🧠 Personality: ${npc.personality.substring(0, 100)}...`
          );

        // Attributes
        logger.debug("📊 Attributes:");
        const attrs = npc.attributes;
        logger.debug(
          `  STR: ${attrs.STR}, CON: ${attrs.CON}, DEX: ${attrs.DEX}, APP: ${attrs.APP}`
        );
        logger.debug(
          `  POW: ${attrs.POW}, SIZ: ${attrs.SIZ}, INT: ${attrs.INT}, EDU: ${attrs.EDU}`
        );

        // Status
        logger.debug("💪 Status:");
        logger.debug(`  HP: ${npc.status.hp}/${npc.status.maxHp}`);
        logger.debug(`  Sanity: ${npc.status.san}/${npc.status.maxSan}`);
        logger.debug(`  Luck: ${npc.status.luck}`);
        if (npc.status.mp) logger.debug(`  Magic Points: ${npc.status.mp}`);

        // Skills
        const skillCount = Object.keys(npc.skills).length;
        logger.debug(`🎯 Skills: ${skillCount} skills defined`);
        if (skillCount > 0) {
          const topSkills = Object.entries(npc.skills)
            .sort(([, a], [, b]) => b - a)
            .slice(0, 5);
          logger.debug(
            `  Top skills: ${topSkills.map(([name, value]) => `${name}(${value})`).join(", ")}`
          );
        }

        // Goals and Secrets
        if (npc.goals && npc.goals.length > 0) {
          logger.debug(`🎯 Goals (${npc.goals.length}):`);
          npc.goals.forEach((goal, i) => logger.debug(`  ${i + 1}. ${goal}`));
        }

        if (npc.secrets && npc.secrets.length > 0) {
          logger.debug(`🤫 Secrets (${npc.secrets.length}):`);
          npc.secrets.forEach((secret, i) =>
            logger.debug(`  ${i + 1}. ${secret.substring(0, 80)}...`)
          );
        }

        // Inventory
        if (npc.inventory.length > 0) {
          logger.debug(
            `🎒 Inventory (${npc.inventory.length} items): ${npc.inventory.slice(0, 3).join(", ")}${npc.inventory.length > 3 ? "..." : ""}`
          );
        }

        // Clues
        if (npc.clues.length > 0) {
          logger.debug(`🕵️ Clues (${npc.clues.length}):`);
          npc.clues.forEach((clue, i) => {
            logger.debug(
              `  ${i + 1}. [${clue.category}/${clue.difficulty}] ${clue.clueText.substring(0, 60)}...`
            );
          });
        }

        // Relationships
        if (npc.relationships.length > 0) {
          logger.debug(`👥 Relationships (${npc.relationships.length}):`);
          npc.relationships.forEach((rel, i) => {
            logger.debug(
              `  ${i + 1}. ${rel.targetName} (${rel.relationshipType}, attitude: ${rel.attitude})`
            );
          });
        }

        if (npc.notes) {
          logger.debug(`📝 Notes: ${npc.notes.substring(0, 100)}...`);
        }
      }

      // Test database operations
      logger.section("Testing Database Operations");

      const firstNPC = loadedNPCs[0];

      // Test retrieval
      logger.debug("Testing NPC retrieval from database...");
      const retrievedNPC = await npcLoader.getNPCById(firstNPC.id);
      if (retrievedNPC) {
        logger.success(`✓ Successfully retrieved NPC: ${retrievedNPC.name}`);
      } else {
        logger.error("✗ Failed to retrieve NPC from database");
      }

      // Test existence check
      const exists = await npcLoader.npcExists(firstNPC.id);
      logger.success(
        `✓ NPC existence check: ${exists ? "Found" : "Not found"}`
      );

      // Test getting all NPCs
      const allNPCs = await npcLoader.getAllNPCs();
      logger.success(`✓ Retrieved ${allNPCs.length} total NPCs from database`);
    } else {
      logger.warn("No NPCs were successfully processed");
    }

    // Cleanup
    db.close();
    logger.success("Database connection closed");

    logger.section("🎉 NPC Loader Test Completed Successfully");
  } catch (error) {
    logger.error(`Test failed: ${error}`);
    if (error instanceof Error) {
      logger.debug(`Error details: ${error.stack}`);
    }
    process.exit(1);
  }
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
  testNPCLoader().catch((error) => {
    console.error("Unhandled error:", error);
    process.exit(1);
  });
}
