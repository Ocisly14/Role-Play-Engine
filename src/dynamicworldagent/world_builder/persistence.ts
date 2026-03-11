/**
 * Persistence helpers for World Builder
 * Handles saving generated world content to database and JSON files
 */

import { randomUUID } from "crypto";
import path from "path";
import fs from "fs/promises";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../shared/agents/memory/database/index.js";
import { getPrismaClient } from "../../shared/agents/memory/database/prismaClient.js";
import type { ActionLogEntry } from "../../shared/agents/models/gameTypes.js";
import type {
  EndStateDefinition,
  KnowledgeHolder,
  MacroSceneStructure,
  ModuleDigest,
  MythosEvent,
  RedHerring,
  ScenarioNpcAssignments,
  ScenarioOutline,
  StartingSceneSelection,
  TruthEvent,
} from "./types.js";
import type { DynamicNPCProfile } from "./types.js";
import { encodeSceneItemsPayload } from "./sceneItemContextPayload.js";

/**
 * Save world generation results to database
 */
export async function saveWorldToDatabase(
  db: CoCDatabase | CoCDatabaseAdapter,
  moduleName: string,
  macroScene: MacroSceneStructure,
  truthTimeline: TruthEvent[],
  knowledgeMatrix: KnowledgeHolder[],
  redHerrings: RedHerring[],
  mythosEvents: MythosEvent[],
  endState: EndStateDefinition,
  npcs: DynamicNPCProfile[],
  scenarios: ScenarioOutline[],
  startingScene: StartingSceneSelection | null,
  otherScenarioNpcAssignments: ScenarioNpcAssignments[]
): Promise<void> {
  const prisma = getPrismaClient();
  const moduleBackground = await prisma.moduleBackground.findFirst({
    where: { title: moduleName },
    select: { moduleId: true },
    orderBy: { moduleId: "asc" },
  });
  if (!moduleBackground?.moduleId) {
    throw new Error(
      `Cannot resolve module_id for module "${moduleName}" before saving scenarios`
    );
  }
  const moduleId = moduleBackground.moduleId;

  // 1. Update module_backgrounds table with all world data
  await prisma.moduleBackground.updateMany({
    where: { title: moduleName },
    data: {
      macroSceneStructure: macroScene as any,
      truthTimeline: truthTimeline as any,
      knowledgeMatrix: knowledgeMatrix as any,
      redHerrings: redHerrings as any,
      historicalMythos: mythosEvents as any,
      endStateDefinition: endState as any,
    },
  });

  // 2. Insert NPCs into characters table
  for (const npc of npcs) {
    // Check if NPC already exists
    const existing = await prisma.character.findFirst({
      where: { name: npc.name, isNpc: true },
      select: { characterId: true },
    });

    const npcData = {
      occupation: npc.occupation || null,
      age: npc.age || null,
      gender: npc.gender || null,
      appearance: npc.appearance || null,
      personality: npc.personality || null,
      background: npc.background || null,
      attributes: npc.attributes as any,
      status: npc.status as any,
      skills: npc.skills as any,
      inventory: npc.inventory as any,
      goals: (npc.goals || []) as any,
      secrets: (npc.secrets || []) as any,
      notes: npc.notes || null,
      currentLocation: null, // currentLocation removed - location tracked via actionLog
      instantiatedFrom: npc.instantiatedFrom || null,
      inheritsKnowledge: (npc.inheritsKnowledge || []) as any,
    };

    if (existing) {
      // Update existing NPC
      await prisma.character.update({
        where: { characterId: existing.characterId },
        data: npcData,
      });
    } else {
      // Insert new NPC
      await prisma.character.create({
        data: {
          characterId: npc.id,
          name: npc.name,
          isNpc: true,
          ...npcData,
        },
      });
    }

    // Insert NPC clues
    for (const clue of npc.clues || []) {
      await prisma.npcClue.upsert({
        where: { id: clue.id },
        update: {
          npcId: npc.id,
          clueText: clue.clueText,
          category: clue.category || null,
          difficulty: clue.difficulty || null,
          revealed: clue.revealed ? true : false,
          relatedTo: (clue.relatedTo || []) as any,
        },
        create: {
          id: clue.id,
          npcId: npc.id,
          clueText: clue.clueText,
          category: clue.category || null,
          difficulty: clue.difficulty || null,
          revealed: clue.revealed ? true : false,
          relatedTo: (clue.relatedTo || []) as any,
        },
      });
    }

    // Insert NPC relationships
    for (const rel of npc.relationships || []) {
      // Skip relationships without a valid targetId (FK constraint requires it)
      if (!rel.targetId) continue;

      const relId = `${npc.id}_${rel.targetName}`;
      await prisma.npcRelationship.upsert({
        where: { id: relId },
        update: {
          sourceId: npc.id,
          targetId: rel.targetId,
          targetName: rel.targetName,
          relationshipType: rel.relationshipType,
          attitude: rel.attitude,
          description: rel.description || null,
          history: rel.history || null,
        },
        create: {
          id: relId,
          sourceId: npc.id,
          targetId: rel.targetId,
          targetName: rel.targetName,
          relationshipType: rel.relationshipType,
          attitude: rel.attitude,
          description: rel.description || null,
          history: rel.history || null,
        },
      });
    }
  }

  if (scenarios.length > 0) {
    const now = new Date().toISOString();
    const scenarioByName = new Map(
      scenarios.map((scenario) => [scenario.name.toLowerCase(), scenario])
    );

    for (const scenario of scenarios) {
      const metadata = {
        createdAt: now,
        updatedAt: now,
        source: "world_builder",
        author: "world_builder",
        gameSystem: "CoC 7e",
      };

      await prisma.scenario.upsert({
        where: {
          moduleId_scenarioId: {
            moduleId,
            scenarioId: scenario.id,
          },
        },
        update: {
          moduleId,
          name: scenario.name,
          description: scenario.description,
          residents: (scenario.residents || []) as any,
          subSceneCount: scenario.subSceneCount ?? null,
          metadata: metadata as any,
          sourcePlaceId: scenario.sourcePlaceId || null,
          mapImagePath: null,
        },
        create: {
          scenarioId: scenario.id,
          moduleId,
          name: scenario.name,
          description: scenario.description,
          residents: (scenario.residents || []) as any,
          subSceneCount: scenario.subSceneCount ?? null,
          metadata: metadata as any,
          sourcePlaceId: scenario.sourcePlaceId || null,
          mapImagePath: null,
        },
      });
    }

    if (startingScene?.scene) {
      const scene = startingScene.scene;
      const sceneExists = await prisma.scene.findUnique({
        where: { moduleId_sceneId: { moduleId, sceneId: scene.id } },
        select: { sceneId: true },
      });

      if (!sceneExists) {
        await prisma.scene.create({
          data: {
            sceneId: scene.id,
            scenarioId: startingScene.scenarioId,
            moduleId,
            name: scene.name,
            description: scene.description,
            parentLocationId: scene.parentLocationId || null,
            connections: (scene.connections || []) as any,
            items: encodeSceneItemsPayload(scene) as any,
            events: scene.events as any,
            initialScene: true,
            gameTime: null,
          },
        });

        // NPCs are no longer stored in the scene — they are managed separately.

        if (scene.clues?.length) {
          for (const clue of scene.clues) {
            try {
              await prisma.scenarioClue.create({
                data: {
                  clueId: clue.id,
                  sceneId: scene.id,
                  moduleId,
                  clueText: clue.clueText,
                  category: clue.category,
                  difficulty: clue.difficulty,
                  clueLocation: clue.location,
                  discoveryMethod: clue.discoveryMethod || null,
                  reveals: (clue.reveals || []) as any,
                  discovered: clue.discovered ? true : false,
                  discoveryDetails: clue.discoveryDetails
                    ? (clue.discoveryDetails as any)
                    : null,
                },
              });
            } catch (e: any) {
              // Skip duplicate key errors (equivalent to INSERT OR IGNORE)
              if (e?.code !== "P2002") throw e;
            }
          }
        }

        if (scene.conditions?.length) {
          for (const condition of scene.conditions) {
            const conditionId = `${scene.id}-cond-${randomUUID().slice(0, 8)}`;
            try {
              await prisma.scenarioCondition.create({
                data: {
                  conditionId,
                  sceneId: scene.id,
                  moduleId,
                  conditionType: condition.type,
                  description: condition.description,
                  mechanicalEffect: condition.mechanicalEffect ?? undefined,
                },
              });
            } catch (e: any) {
              // Skip duplicate key errors (equivalent to INSERT OR IGNORE)
              if (e?.code !== "P2002") throw e;
            }
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
  npcs: DynamicNPCProfile[],
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

  // 4. Save scenario outlines
  const scenariosFile = path.join(moduleDir, "scenarios_outline.json");
  await fs.writeFile(
    scenariosFile,
    JSON.stringify(
      {
        scenarios,
        note: "Scenario outlines derived from knowledge matrix places. Scenes not generated yet.",
      },
      null,
      2
    )
  );

  // 4b. Save scenario files in [Module]_Scenarios directory
  const scenariosDir = path.join(moduleDir, `${moduleName}_Scenarios`);
  await fs.mkdir(scenariosDir, { recursive: true });

  const assignmentsByScenarioId = new Map(
    otherScenarioNpcAssignments.map((assignment) => [
      assignment.scenarioId,
      assignment,
    ])
  );

  const actionLogsByNpcId = new Map<string, ActionLogEntry[]>();
  const pushActionLog = (
    npcId: string | undefined,
    location: string | null | undefined,
    summary: string | null | undefined
  ) => {
    if (!npcId || !summary) return;
    const trimmedSummary = summary.trim();
    if (!trimmedSummary) return;
    const entry: ActionLogEntry = {
      time: "initial",
      location: location || "unknown",
      summary: trimmedSummary,
    };
    const existing = actionLogsByNpcId.get(npcId) || [];
    existing.push(entry);
    actionLogsByNpcId.set(npcId, existing);
  };

  for (const assignment of otherScenarioNpcAssignments) {
    for (const npc of assignment.npcs || []) {
      pushActionLog(npc.id, assignment.scenarioName, npc.activity);
    }
  }

  for (const scenario of scenarios) {
    const assignment = assignmentsByScenarioId.get(scenario.id);
    const isStartingScene = startingScene?.scenarioId === scenario.id;

    // Generate scene data for all scenarios
    let sceneData;
    if (isStartingScene && startingScene?.scene) {
      // Use LLM-generated scene for starting scene
      const scene = startingScene.scene;
      sceneData = {
        id: scene.id,
        name: scene.name,
        description: scene.description,
        parentLocationId: scene.parentLocationId,
        items: scene.items,
        itemContexts: scene.itemContexts,
        clues: scene.clues,
        conditions: scene.conditions,
        connections: scene.connections,
        sceneImage: scene.sceneImage,
        events: scene.events,
        initialScene: true,
      };
    } else {
      // Create basic scene structure for non-starting scenarios
      sceneData = {
        id: scenario.id,
        name: scenario.name,
        description: scenario.description,
        parentLocationId: "",
        clues: [],
        conditions: [],
        connections: [],
        items: [],
        events: [],
        initialScene: false,
      };
    }

    const scenarioPayload: any = {
      name: scenario.name,
      description: scenario.description,
      scene: sceneData,
      npcAssignments: assignment?.npcs || [],
    };

    // Preserve DynamicWorld specific fields
    if (scenario.sourcePlaceId) {
      scenarioPayload.sourcePlaceId = scenario.sourcePlaceId;
    }
    if (scenario.sourcePlaceName) {
      scenarioPayload.sourcePlaceName = scenario.sourcePlaceName;
    }

    const fileName = `${scenario.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    const filePath = path.join(scenariosDir, fileName);
    await fs.writeFile(filePath, JSON.stringify([scenarioPayload], null, 2));
  }

  const startingSceneFile: string | null = null;

  // 5. Save NPCs to [Module]_npc/ directory
  const npcsDir = path.join(moduleDir, `${moduleName}_npc`);
  await fs.mkdir(npcsDir, { recursive: true });

  for (const npc of npcs) {
    const npcFile = path.join(
      npcsDir,
      `${npc.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`
    );
    const actionLog = [
      ...(npc.actionLog || []),
      ...(actionLogsByNpcId.get(npc.id) || []),
    ];
    const npcPayload = actionLog.length > 0 ? { ...npc, actionLog } : npc;
    await fs.writeFile(npcFile, JSON.stringify(npcPayload, null, 2));
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

export async function saveModuleDigestToJSON(
  moduleName: string,
  digest: ModuleDigest
): Promise<string> {
  const moduleDir = path.join(process.cwd(), "data", "Mods", moduleName);
  await fs.mkdir(moduleDir, { recursive: true });
  const filePath = path.join(moduleDir, "module_digest.json");
  const payload = { title: moduleName, ...digest };
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}
