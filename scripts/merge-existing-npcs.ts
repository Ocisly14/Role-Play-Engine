#!/usr/bin/env tsx

/**
 * Merge already-extracted NPCs in the database using the NPCLoader's LLM merge logic.
 *
 * Uses current DATABASE_URL (PostgreSQL via Prisma)
 * Usage:
 *   npx tsx scripts/merge-existing-npcs.ts
 *
 * Steps:
 * - Read all NPCs from DB
 * - Run name-similarity clustering + LLM merge (small model)
 * - Wipe existing NPC tables and write back merged NPCs
 */

import { config } from "dotenv";
config();

import { NPCLoader } from "../src/shared/agents/character/npcloader/index.js";
import { CoCDatabaseAdapter } from "../src/shared/agents/memory/database/CoCDatabaseAdapter.js";

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required");
  }

  console.log("Using PostgreSQL DATABASE_URL from environment");
  const db = new CoCDatabaseAdapter();
  const loader = new NPCLoader(db);

  const merged = await loader.mergeExistingNPCs();
  console.log(`Saved ${merged.length} merged NPC(s) to DB.`);
  db.close();
}

main().catch((err) => {
  console.error("Merge failed:", err);
  process.exit(1);
});
