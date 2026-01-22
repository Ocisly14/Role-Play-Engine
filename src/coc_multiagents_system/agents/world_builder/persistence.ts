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
  ScenarioOutline,
  StartingSceneSelection,
  ScenarioNpcAssignments,
} from "./types.js";
import type { NPCProfile } from "../models/gameTypes.js";
import { randomUUID } from "crypto";

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
  npcs: NPCProfile[],
  scenarios: ScenarioOutline[],
  startingScene: StartingSceneSelection | null,
  otherScenarioNpcAssignments: ScenarioNpcAssignments[]
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

  if (scenarios.length > 0) {
    const database = db.getDatabase();
    const hasMapImagePath = db.hasColumn("scenarios", "map_image_path");
    const now = new Date().toISOString();
    const scenarioByName = new Map(
      scenarios.map((scenario) => [scenario.name.toLowerCase(), scenario])
    );

    const scenarioConnections = (scenario: ScenarioOutline) =>
      (scenario.connections || []).map((connection) => {
        const targetScenario = scenarioByName.get(connection.scenarioName.toLowerCase());
        return {
          scenarioId: targetScenario?.id || connection.scenarioName,
          relationshipType: connection.relationshipType,
          description: connection.description,
        };
      });

    for (const scenario of scenarios) {
      const metadata = {
        createdAt: now,
        updatedAt: now,
        source: "world_builder",
        author: "world_builder",
        gameSystem: "CoC 7e",
      };

      const scenarioColumns = [
        "scenario_id",
        "name",
        "description",
        "tags",
        "connections",
        "permanent_changes",
        "metadata",
      ];
      const scenarioValues: any[] = [
        scenario.id,
        scenario.name,
        scenario.description,
        JSON.stringify(scenario.tags || []),
        JSON.stringify(scenarioConnections(scenario)),
        null,
        JSON.stringify(metadata),
      ];

      if (hasMapImagePath) {
        scenarioColumns.push("map_image_path");
        scenarioValues.push(null);
      }

      const scenarioStmt = database.prepare(
        `INSERT OR REPLACE INTO scenarios (${scenarioColumns.join(", ")}) VALUES (${scenarioColumns
          .map(() => "?")
          .join(", ")})`
      );
      scenarioStmt.run(...scenarioValues);
    }

    if (startingScene?.snapshot) {
      const snapshot = startingScene.snapshot;
      const snapshotExists = database
        .prepare("SELECT snapshot_id FROM scenario_snapshots WHERE snapshot_id = ?")
        .get(snapshot.id);

      if (!snapshotExists) {
        const snapshotStmt = database.prepare(
          `INSERT INTO scenario_snapshots (
            snapshot_id, scenario_id, snapshot_name, location, description, events, exits,
            keeper_notes, time_restriction, show_map
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );

        snapshotStmt.run(
          snapshot.id,
          startingScene.scenarioId,
          snapshot.name,
          snapshot.location,
          snapshot.description,
          JSON.stringify(snapshot.events || []),
          JSON.stringify(snapshot.exits || []),
          snapshot.keeperNotes || null,
          snapshot.timeRestriction || null,
          snapshot.showMap === false ? 0 : 1
        );

        if (snapshot.characters?.length) {
          const charStmt = database.prepare(`
            INSERT OR IGNORE INTO scenario_characters (
              id, snapshot_id, character_name, character_role, character_status,
              character_location, character_notes
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `);

          for (const char of snapshot.characters) {
            charStmt.run(
              char.id,
              snapshot.id,
              char.name,
              char.role,
              char.status,
              char.location || null,
              char.notes || null
            );
          }
        }

        if (snapshot.clues?.length) {
          const clueStmt = database.prepare(`
            INSERT OR IGNORE INTO scenario_clues (
              clue_id, snapshot_id, clue_text, category, difficulty,
              clue_location, discovery_method, reveals, discovered, discovery_details
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          for (const clue of snapshot.clues) {
            clueStmt.run(
              clue.id,
              snapshot.id,
              clue.clueText,
              clue.category,
              clue.difficulty,
              clue.location,
              clue.discoveryMethod || null,
              JSON.stringify(clue.reveals || []),
              clue.discovered ? 1 : 0,
              clue.discoveryDetails ? JSON.stringify(clue.discoveryDetails) : null
            );
          }
        }

        if (snapshot.conditions?.length) {
          const conditionStmt = database.prepare(`
            INSERT OR IGNORE INTO scenario_conditions (
              condition_id, snapshot_id, condition_type, description, mechanical_effect
            ) VALUES (?, ?, ?, ?, ?)
          `);

          for (const condition of snapshot.conditions) {
            const conditionId = `${snapshot.id}-cond-${randomUUID().slice(0, 8)}`;
            conditionStmt.run(
              conditionId,
              snapshot.id,
              condition.type,
              condition.description,
              condition.mechanicalEffect || null
            );
          }
        }
      }
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
  scenarios: ScenarioOutline[],
  npcs: NPCProfile[],
  startingScene: StartingSceneSelection | null,
  otherScenarioNpcAssignments: ScenarioNpcAssignments[]
): Promise<{
  truthTimelineFile: string;
  knowledgeMatrixFile: string;
  macroSceneFile: string;
  scenariosFile: string;
  startingSceneFile: string | null;
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

  // 4. Save scenario outlines (no snapshots yet)
  const scenariosFile = path.join(moduleDir, "scenarios_outline.json");
  await fs.writeFile(
    scenariosFile,
    JSON.stringify(
      {
        scenarios,
        note: "Scenario outlines derived from knowledge matrix places. Snapshots not generated yet.",
      },
      null,
      2
    )
  );

  // 4b. Save scenario files in [Module]_Scenarios directory
  const scenariosDir = path.join(moduleDir, `${moduleName}_Scenarios`);
  await fs.mkdir(scenariosDir, { recursive: true });

  const assignmentsByScenarioId = new Map(
    otherScenarioNpcAssignments.map((assignment) => [assignment.scenarioId, assignment])
  );

  for (const scenario of scenarios) {
    const assignment = assignmentsByScenarioId.get(scenario.id);
    const isStartingScene = startingScene?.scenarioId === scenario.id;
    const snapshot = isStartingScene ? startingScene?.snapshot : undefined;

    const scenarioPayload = {
      name: scenario.name,
      description: scenario.description,
      evidence: scenario.evidence || [],
      clues: scenario.clues || [],
      snapshot: snapshot
        ? {
            name: snapshot.name,
            location: snapshot.location,
            description: snapshot.description,
            showMap: snapshot.showMap,
            characters: snapshot.characters,
            clues: snapshot.clues,
            conditions: snapshot.conditions,
            events: snapshot.events,
            exits: snapshot.exits,
            keeperNotes: snapshot.keeperNotes,
            permanentChanges: snapshot.permanentChanges,
            estimatedShortActions: snapshot.estimatedShortActions,
            timeRestriction: snapshot.timeRestriction,
          }
        : undefined,
      tags: scenario.tags || [],
      connections: scenario.connections || [],
      npcAssignments: assignment?.npcs || [],
    };

    const fileName = `${scenario.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    const filePath = path.join(scenariosDir, fileName);
    await fs.writeFile(filePath, JSON.stringify([scenarioPayload], null, 2));
  }

  let startingSceneFile: string | null = null;

  // 5. Save NPCs to [Module]_npc/ directory
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
    scenariosFile,
    startingSceneFile,
    npcsDir,
  };
}
