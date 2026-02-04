#!/usr/bin/env tsx

/**
 * Merge already-extracted NPCs in the database using the NPCLoader's LLM merge logic.
 *
 * Default DB: data/test_coc.db
 * Usage:
 *   npx tsx scripts/merge-existing-npcs.ts [dbPath]
 *
 * Steps:
 * - Read all NPCs from DB
 * - Run name-similarity clustering + LLM merge (small model)
 * - Wipe existing NPC tables and write back merged NPCs
 */

import { config } from "dotenv";
config();

import { CoCDatabase } from "../src/shared/agents/memory/database/schema.js";
import { NPCLoader } from "../src/shared/agents/character/npcloader/index.js";
import type {
  ParsedNPCData,
  NPCProfile,
} from "../src/shared/agents/models/gameTypes.js";

const dbPath = process.argv[2] || "data/test_coc.db";

function profileToParsed(npc: NPCProfile): ParsedNPCData {
  return {
    name: npc.name,
    occupation: npc.occupation,
    age: npc.age,
    appearance: npc.appearance,
    personality: npc.personality,
    background: npc.background,
    goals: npc.goals,
    secrets: npc.secrets,
    attributes: npc.attributes,
    status: npc.status,
    skills: npc.skills,
    inventory: npc.inventory,
    clues: npc.clues?.map((c) => ({
      clueText: c.clueText,
      category: c.category,
      difficulty: c.difficulty,
      relatedTo: c.relatedTo,
    })),
    relationships: npc.relationships?.map((r) => ({
      targetName: r.targetName,
      relationshipType: r.relationshipType,
      attitude: r.attitude,
      description: r.description,
      history: r.history,
    })),
    notes: npc.notes,
  };
}

async function main() {
  console.log(`Using DB: ${dbPath}`);
  const db = new CoCDatabase(dbPath);
  const loader = new NPCLoader(db);

  const npcs = loader.getAllNPCs();
  console.log(`Loaded ${npcs.length} NPC(s) from DB.`);

  if (npcs.length === 0) {
    console.log("No NPCs to merge. Exiting.");
    db.close();
    return;
  }

  const parsed = npcs.map(profileToParsed);

  console.log("Running LLM merge on similar-name clusters...");
  const merged: ParsedNPCData[] = await (loader as any).mergeSimilarNPCs(parsed);
  console.log(
    `Merge complete: ${parsed.length} -> ${merged.length} NPC(s) after dedup.`
  );

  const database = db.getDatabase();
  db.transaction(() => {
    database.prepare("DELETE FROM npc_clues").run();
    database.prepare("DELETE FROM npc_relationships").run();
    database.prepare("DELETE FROM characters WHERE is_npc = 1").run();
  });
  console.log("Cleared existing NPC data.");

  const saved: string[] = [];
  for (const npcParsed of merged) {
    const npcProfile = (loader as any).convertToNPCProfile(npcParsed);
    (loader as any).saveNPCToDatabase(npcProfile);
    saved.push(npcProfile.name);
  }

  console.log(`Saved ${saved.length} merged NPC(s) to DB.`);
  db.close();
}

main().catch((err) => {
  console.error("Merge failed:", err);
  process.exit(1);
});
