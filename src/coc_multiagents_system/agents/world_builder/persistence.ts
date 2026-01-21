/**
 * Persistence helpers for World Builder
 * Handles saving generated world content to database and JSON files
 */

import path from "path";
import fs from "fs/promises";
import type { CoCDatabase } from "../memory/database/index.js";
import type {
  MacroSceneStructure,
  TruthEvent,
  KnowledgeHolder,
  RedHerring,
  MythosEvent,
  EndStateDefinition,
} from "./types.js";
import type { NPCProfile } from "../models/gameTypes.js";

/**
 * Save world generation results to database
 */
export async function saveWorldToDatabase(
  db: CoCDatabase,
  moduleName: string,
  macroScene: MacroSceneStructure,
  truthTimeline: TruthEvent[],
  knowledgeMatrix: KnowledgeHolder[],
  redHerrings: RedHerring[],
  mythosEvents: MythosEvent[],
  endState: EndStateDefinition,
  npcs: NPCProfile[]
): Promise<void> {
  // 1. Update module_backgrounds table with all world data
  const stmt = db.getDatabase().prepare(`
    UPDATE module_backgrounds
    SET macro_scene_structure = ?,
        truth_timeline = ?,
        knowledge_matrix = ?,
        red_herrings = ?,
        historical_mythos = ?,
        end_state_definition = ?
    WHERE title = ?
  `);

  stmt.run(
    JSON.stringify(macroScene),
    JSON.stringify(truthTimeline),
    JSON.stringify(knowledgeMatrix),
    JSON.stringify(redHerrings),
    JSON.stringify(mythosEvents),
    JSON.stringify(endState),
    moduleName
  );

  // 2. Insert NPCs into characters table
  for (const npc of npcs) {
    // Check if NPC already exists
    const existing = db.getDatabase().prepare(
      `SELECT character_id FROM characters WHERE name = ? AND is_npc = 1`
    ).get(npc.name);

    if (existing) {
      // Update existing NPC
      const updateStmt = db.getDatabase().prepare(`
        UPDATE characters
        SET occupation = ?,
            age = ?,
            gender = ?,
            appearance = ?,
            personality = ?,
            background = ?,
            attributes = ?,
            status = ?,
            skills = ?,
            inventory = ?,
            goals = ?,
            secrets = ?,
            notes = ?,
            current_location = ?
        WHERE character_id = ?
      `);

      updateStmt.run(
        npc.occupation || null,
        npc.age || null,
        npc.gender || null,
        npc.appearance || null,
        npc.personality || null,
        npc.background || null,
        JSON.stringify(npc.attributes),
        JSON.stringify(npc.status),
        JSON.stringify(npc.skills),
        JSON.stringify(npc.inventory),
        JSON.stringify(npc.goals || []),
        JSON.stringify(npc.secrets || []),
        npc.notes || null,
        (npc as any).currentLocation || null,
        (existing as any).character_id
      );
    } else {
      // Insert new NPC
      const insertStmt = db.getDatabase().prepare(`
        INSERT INTO characters (
          character_id, name, occupation, age, gender, appearance, personality, background,
          attributes, status, skills, inventory, goals, secrets, notes, is_npc, current_location
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `);

      insertStmt.run(
        npc.id,
        npc.name,
        npc.occupation || null,
        npc.age || null,
        npc.gender || null,
        npc.appearance || null,
        npc.personality || null,
        npc.background || null,
        JSON.stringify(npc.attributes),
        JSON.stringify(npc.status),
        JSON.stringify(npc.skills),
        JSON.stringify(npc.inventory),
        JSON.stringify(npc.goals || []),
        JSON.stringify(npc.secrets || []),
        npc.notes || null,
        (npc as any).currentLocation || null
      );
    }

    // Insert NPC clues
    for (const clue of npc.clues || []) {
      const clueStmt = db.getDatabase().prepare(`
        INSERT OR REPLACE INTO npc_clues (
          id, npc_id, clue_text, category, difficulty, revealed, related_to
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      clueStmt.run(
        clue.id,
        npc.id,
        clue.clueText,
        clue.category || null,
        clue.difficulty || null,
        clue.revealed ? 1 : 0,
        JSON.stringify(clue.relatedTo || [])
      );
    }

    // Insert NPC relationships
    for (const rel of npc.relationships || []) {
      const relStmt = db.getDatabase().prepare(`
        INSERT OR REPLACE INTO npc_relationships (
          id, source_id, target_id, target_name, relationship_type, attitude, description, history
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const relId = `${npc.id}_${rel.targetName}`;
      relStmt.run(
        relId,
        npc.id,
        rel.targetId || null,
        rel.targetName,
        rel.relationshipType,
        rel.attitude,
        rel.description || null,
        rel.history || null
      );
    }
  }
}

/**
 * Save world generation results to JSON files
 */
export async function saveWorldToJSON(
  moduleName: string,
  macroScene: MacroSceneStructure,
  truthTimeline: TruthEvent[],
  knowledgeMatrix: KnowledgeHolder[],
  redHerrings: RedHerring[],
  mythosEvents: MythosEvent[],
  endState: EndStateDefinition,
  npcs: NPCProfile[]
): Promise<{
  truthTimelineFile: string;
  knowledgeMatrixFile: string;
  macroSceneFile: string;
  npcsDir: string;
}> {
  const moduleDir = path.join(process.cwd(), "data", "Mods", moduleName);

  // Ensure module directory exists
  await fs.mkdir(moduleDir, { recursive: true });

  // 1. Save truth_timeline.json (Keeper-only, contains objective truth)
  const truthTimelineFile = path.join(moduleDir, "truth_timeline.json");
  await fs.writeFile(
    truthTimelineFile,
    JSON.stringify(
      {
        truthTimeline,
        note: "KEEPER ONLY - Objective sequence of events. NPCs do NOT know this timeline; they have partial/distorted knowledge.",
      },
      null,
      2
    )
  );

  // 2. Save knowledge_matrix.json (Keeper-only, maps knowledge to holders)
  const knowledgeMatrixFile = path.join(moduleDir, "knowledge_matrix.json");
  await fs.writeFile(
    knowledgeMatrixFile,
    JSON.stringify(
      {
        knowledgeMatrix,
        redHerrings,
        note: "KEEPER ONLY - Knowledge distribution and false trails. Use this to determine what NPCs know and what they believe.",
      },
      null,
      2
    )
  );

  // 3. Save macro_scene.json (includes mythos and end state)
  const macroSceneFile = path.join(moduleDir, "macro_scene.json");
  await fs.writeFile(
    macroSceneFile,
    JSON.stringify(
      {
        macroScene,
        mythosEvents,
        endState,
        note: "World structure, mythos history, and inevitable end state if no intervention occurs.",
      },
      null,
      2
    )
  );

  // 4. Save NPCs to [Module]_npc/ directory
  const npcsDir = path.join(moduleDir, `${moduleName}_npc`);
  await fs.mkdir(npcsDir, { recursive: true });

  for (const npc of npcs) {
    const npcFile = path.join(npcsDir, `${npc.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
    await fs.writeFile(npcFile, JSON.stringify(npc, null, 2));
  }

  return {
    truthTimelineFile,
    knowledgeMatrixFile,
    macroSceneFile,
    npcsDir,
  };
}
