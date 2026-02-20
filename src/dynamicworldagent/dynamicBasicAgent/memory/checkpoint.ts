/**
 * Checkpoint functionality for DynamicGameState
 * Saves complete game state to database before major updates
 */

import { randomUUID } from "crypto";
import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../../shared/agents/memory/database/index.js";
import { getPrismaClient } from "../../../shared/agents/memory/database/prismaClient.js";
import type { DynamicGameState } from "../../state/index.js";
import type { DynamicScenarioSnapshot } from "../../world_builder/types.js";
import { TurnManager } from "./turnManager.js";

/**
 * Save DynamicGameState checkpoint to database
 * Includes all historical snapshots for each scenario
 *
 * @param db - Database instance
 * @param dynamicState - Complete DynamicGameState to save
 * @param checkpointType - Type of checkpoint ('auto' | 'manual' | 'scene_transition')
 * @param description - Optional description for the checkpoint
 * @returns Checkpoint ID if successful, null if failed
 */
export async function saveDynamicGameStateCheckpoint(
  db: CoCDatabase | CoCDatabaseAdapter,
  dynamicState: DynamicGameState,
  checkpointType: "auto" | "manual" | "scene_transition" = "auto",
  description?: string
): Promise<string | null> {
  try {
    const prisma = getPrismaClient();

    // Generate checkpoint ID based on type
    let checkpointId: string;
    if (checkpointType === "manual") {
      checkpointId = `manual-${Date.now()}`;
    } else {
      checkpointId = randomUUID();
    }

    const checkpointName = generateCheckpointName(dynamicState, checkpointType);

    const sessionScope = await prisma.session.findUnique({
      where: { sessionId: dynamicState.sessionId },
      select: { moduleId: true, emailId: true },
    });

    // Serialize DynamicGameState to JSON
    // Convert Sets to Arrays for JSON serialization
    const serializableState = await serializeDynamicGameState(
      dynamicState,
      db,
      sessionScope?.moduleId
    );

    // Attach conversation history and player memos so the checkpoint is self-contained
    await db.preloadSessionTurns(dynamicState.sessionId);
    const turnManager = new TurnManager(db);
    serializableState.conversationHistory = turnManager.getConversation(
      dynamicState.sessionId
    );
    try {
      const memos = await prisma.playerMemo.findMany({
        where: { sessionId: dynamicState.sessionId },
        orderBy: { createdAt: "asc" },
        select: {
          memoId: true,
          emailId: true,
          text: true,
          gameDay: true,
          gameTime: true,
          location: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      serializableState.playerMemos = memos;
    } catch (error) {
      serializableState.playerMemos = [];
    }

    // Save language setting from session metadata to checkpoint
    try {
      const session = await prisma.session.findUnique({
        where: { sessionId: dynamicState.sessionId },
        select: { metadata: true },
      });

      console.log(`[Checkpoint Save] Session found:`, !!session);
      console.log(`[Checkpoint Save] Session metadata:`, session?.metadata);

      let languageToSave: "en" | "zh" = "zh"; // Default to zh

      if (session) {
        if (session.metadata) {
          // Prisma returns JSONB already parsed - no JSON.parse needed
          const metadata = session.metadata as Record<string, any>;
          console.log(`[Checkpoint Save] Parsed metadata:`, metadata);
          if (metadata.language === "en" || metadata.language === "zh") {
            languageToSave = metadata.language;
            console.log(
              `[Checkpoint Save] Found language in metadata: ${languageToSave}`
            );
          } else {
            console.log(
              `[Checkpoint Save] No valid language in metadata, using default: ${languageToSave}`
            );
          }
        } else {
          console.log(
            `[Checkpoint Save] Session metadata is NULL, initializing with default language: ${languageToSave}`
          );
          // Initialize metadata for existing sessions that don't have it
          const newMetadata = { language: languageToSave };
          await prisma.session.update({
            where: { sessionId: dynamicState.sessionId },
            data: { metadata: newMetadata },
          });
          console.log(
            `[Checkpoint Save] Initialized session metadata with language: ${languageToSave}`
          );
        }
      } else {
        console.warn(
          `[Checkpoint Save] Session not found in database, using default language: ${languageToSave}`
        );
      }

      // Save language to checkpoint
      serializableState.language = languageToSave;
      console.log(
        `[Checkpoint Save] Saved language to checkpoint: ${languageToSave}`
      );
    } catch (error) {
      console.warn("Failed to save language setting to checkpoint:", error);
      // Continue without language - not critical
      serializableState.language = "zh"; // Fallback to default
    }

    // Save to database using Prisma
    // Extract metadata for quick queries
    const currentSceneName = dynamicState.currentScenario?.name || null;
    const isAutoCheckpoint = checkpointType === "auto";

    await prisma.gameCheckpoint.create({
      data: {
        checkpointId,
        sessionId: dynamicState.sessionId,
        moduleId: sessionScope?.moduleId || null,
        emailId: sessionScope?.emailId || null,
        checkpointName,
        gameState: serializableState,
        currentSceneName,
        isAutoCheckpoint,
        turnNumber: dynamicState.turnsInCurrentScene || 0,
      },
    });

    console.log(
      `\u{1F4BE} [Checkpoint] Saved ${checkpointType} checkpoint: ${checkpointName} (${checkpointId})`
    );
    return checkpointId;
  } catch (error) {
    console.error(`\u274C [Checkpoint] Failed to save checkpoint:`, error);
    // Don't throw - checkpoint failure shouldn't block game updates
    return null;
  }
}

/**
 * Serialize DynamicGameState for database storage
 * Converts Sets to Arrays and ensures all data is JSON-serializable
 */
async function serializeDynamicGameState(
  state: DynamicGameState,
  db: CoCDatabase | CoCDatabaseAdapter,
  moduleId?: string | null
): Promise<any> {
  // Convert Sets to Arrays
  const revealedTruthEvents = Array.from(state.revealedTruthEvents);
  const activatedKnowledgeHolders = Array.from(state.activatedKnowledgeHolders);
  const deployedRedHerrings = Array.from(state.deployedRedHerrings);
  const mythosRevelations = Array.from(state.mythosRevelations);

  // Convert Map<string, DynamicScenarioSnapshot[]> to object
  // Only save the latest snapshot for each scenario in checkpoint
  // Historical snapshots are saved to database separately
  const updatedDynamicScenarioSnapshots: Record<string, any> = {};
  for (const [scenarioId, snapshots] of state.updatedDynamicScenarioSnapshots) {
    // Only save the latest snapshot (last in array) to checkpoint
    if (snapshots.length > 0) {
      const latestSnapshot = snapshots[snapshots.length - 1];
      updatedDynamicScenarioSnapshots[scenarioId] = {
        ...latestSnapshot,
        // Ensure Date objects are serialized as ISO strings
        timestamp: latestSnapshot.timestamp
          ? latestSnapshot.timestamp.toISOString()
          : undefined,
      };

      // Save historical snapshots (all except the latest) to database
      if (snapshots.length > 1) {
        const historicalSnapshots = snapshots.slice(0, -1); // All except the last one
        await saveHistoricalSnapshotsToDatabase(
          db,
          scenarioId,
          historicalSnapshots,
          moduleId
        );
      }
    }
  }

  // Convert Date objects to ISO strings
  const serializedState = {
    ...state,
    revealedTruthEvents,
    activatedKnowledgeHolders,
    deployedRedHerrings,
    mythosRevelations,
    updatedDynamicScenarioSnapshots,
    loadedAt: state.loadedAt.toISOString(),
    lastUpdated: state.lastUpdated.toISOString(),
    lastPlayerInputTime: state.lastPlayerInputTime
      ? state.lastPlayerInputTime.toISOString()
      : null,
    // Ensure temporaryInfo doesn't have circular references
    temporaryInfo: {
      ...state.temporaryInfo,
      // Convert any Date objects in temporaryInfo
      contextualData: state.temporaryInfo.contextualData
        ? JSON.parse(JSON.stringify(state.temporaryInfo.contextualData))
        : null,
    },
  };

  return serializedState;
}

/**
 * Generate checkpoint name based on game state and type
 */
function generateCheckpointName(
  state: DynamicGameState,
  checkpointType: "auto" | "manual" | "scene_transition"
): string {
  const sceneName = state.currentScenario?.name || "Unknown Scene";
  const gameTime = `Day ${state.gameDay}, ${state.timeOfDay}`;

  switch (checkpointType) {
    case "manual":
      return `Manual Save - ${sceneName} (${gameTime})`;
    case "scene_transition":
      return `Scene Transition - ${sceneName} (${gameTime})`;
    case "auto":
    default:
      return `Auto Save - ${sceneName} (${gameTime})`;
  }
}

/**
 * Generate checkpoint description
 */
function generateCheckpointDescription(
  state: DynamicGameState,
  checkpointType: "auto" | "manual" | "scene_transition"
): string {
  const sceneName = state.currentScenario?.name || "Unknown Scene";
  const location = state.currentScenario?.location || "Unknown Location";
  const gameTime = `Day ${state.gameDay}, ${state.timeOfDay}`;
  const scenarioCount = state.updatedDynamicScenarioSnapshots.size;

  let description = `${checkpointType === "manual" ? "Manual" : checkpointType === "scene_transition" ? "Scene transition" : "Automatic"} checkpoint. `;
  description += `Scene: ${sceneName} (${location}). `;
  description += `Game Time: ${gameTime}. `;
  description += `Scenarios with snapshots: ${scenarioCount}.`;

  return description;
}

/**
 * Save historical snapshots to database
 * These are snapshots that are not the latest (all except the last one)
 */
async function saveHistoricalSnapshotsToDatabase(
  db: CoCDatabase | CoCDatabaseAdapter,
  scenarioId: string,
  historicalSnapshots: DynamicScenarioSnapshot[],
  moduleIdHint?: string | null
): Promise<void> {
  try {
    const prisma = getPrismaClient();
    const scenarioRow = await prisma.scenario.findFirst({
      where: {
        scenarioId,
        ...(moduleIdHint ? { moduleId: moduleIdHint } : {}),
      },
      select: { moduleId: true },
    });
    if (!scenarioRow?.moduleId) {
      console.warn(
        `\u{1F4BE} [Checkpoint] Skip saving historical snapshot, scenario missing module scope: ${scenarioId}`
      );
      return;
    }
    const moduleId = scenarioRow.moduleId;

    for (const snapshot of historicalSnapshots) {
      // Generate a unique snapshot ID for historical snapshot
      const historicalSnapshotId = `hist-${scenarioId}-${Date.now()}-${randomUUID().slice(0, 8)}`;

      // Check if snapshot already exists
      const existing = await prisma.scenarioSnapshot.findUnique({
        where: { snapshotId: historicalSnapshotId },
        select: { snapshotId: true },
      });

      if (existing) {
        continue; // Skip if already exists
      }

      // Insert snapshot
      await prisma.scenarioSnapshot.create({
        data: {
          snapshotId: historicalSnapshotId,
          scenarioId,
          moduleId,
          snapshotName:
            snapshot.name || `Historical snapshot for ${scenarioId}`,
          location: snapshot.location,
          description: snapshot.description,
          events: [], // events removed
          exits: [], // exits removed
          keeperNotes: snapshot.keeperNotes || null,
          timeRestriction: snapshot.timeRestriction || null,
          showMap: snapshot.showMap !== false,
          initialSnapshot: false,
          gameTime: snapshot.gameTime || null,
          isDynamicHistorical: true,
        },
      });

      // Insert characters if present
      if (snapshot.characters && snapshot.characters.length > 0) {
        for (const char of snapshot.characters) {
          const charId =
            char.id ||
            `${historicalSnapshotId}-char-${randomUUID().slice(0, 8)}`;

          await prisma.scenarioCharacter.upsert({
            where: { id: charId },
            update: {},
            create: {
              id: charId,
              snapshotId: historicalSnapshotId,
              moduleId,
              characterName: char.name,
              characterRole: char.role,
              characterStatus: char.status,
              characterLocation: char.location || null,
              characterNotes: char.notes || null,
            },
          });
        }
      }

      // Insert clues if present
      if (snapshot.clues && snapshot.clues.length > 0) {
        for (const clue of snapshot.clues) {
          const clueId =
            clue.id ||
            `${historicalSnapshotId}-clue-${randomUUID().slice(0, 8)}`;

          await prisma.scenarioClue.upsert({
            where: { clueId },
            update: {},
            create: {
              clueId,
              snapshotId: historicalSnapshotId,
              moduleId,
              clueText: clue.clueText,
              category: clue.category,
              difficulty: clue.difficulty,
              clueLocation: clue.location,
              discoveryMethod: clue.discoveryMethod || null,
              reveals: clue.reveals || [],
              discovered: clue.discovered || false,
              discoveryDetails: clue.discoveryDetails || undefined,
            },
          });
        }
      }

      // Insert conditions if present
      if (snapshot.conditions && snapshot.conditions.length > 0) {
        for (const condition of snapshot.conditions) {
          const conditionId = `${historicalSnapshotId}-cond-${randomUUID().slice(0, 8)}`;

          await prisma.scenarioCondition.upsert({
            where: { conditionId },
            update: {},
            create: {
              conditionId,
              snapshotId: historicalSnapshotId,
              moduleId,
              conditionType: condition.type,
              description: condition.description,
              mechanicalEffect: condition.mechanicalEffect || null,
            },
          });
        }
      }
    }

    console.log(
      `\u{1F4BE} [Checkpoint] Saved ${historicalSnapshots.length} historical snapshots to database for scenario ${scenarioId}`
    );
  } catch (error) {
    console.error(
      `\u274C [Checkpoint] Failed to save historical snapshots to database:`,
      error
    );
    // Don't throw - snapshot save failure shouldn't block checkpoint save
  }
}
