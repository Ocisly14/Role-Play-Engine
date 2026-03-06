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
import type { DynamicScene } from "../../world_builder/types.js";
import { TurnManager } from "./turnManager.js";

/**
 * Save DynamicGameState checkpoint to database
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
    // Convert Sets to Arrays and Maps to plain objects for JSON serialization
    const serializableState = serializeDynamicGameState(dynamicState);

    // Attach conversation history and player memos so the checkpoint is self-contained
    await db.preloadSessionTurns(dynamicState.sessionId);
    const turnManager = new TurnManager(db);
    serializableState.conversationHistory = turnManager.getConversation(
      dynamicState.sessionId,
      Number.MAX_SAFE_INTEGER
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
    const currentScene = dynamicState.currentSceneId
      ? dynamicState.scenes.get(dynamicState.currentSceneId)
      : null;
    const currentSceneName = currentScene?.name || null;
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
      `[Checkpoint] Saved ${checkpointType} checkpoint: ${checkpointName} (${checkpointId})`
    );
    return checkpointId;
  } catch (error) {
    console.error(`[Checkpoint] Failed to save checkpoint:`, error);
    // Don't throw - checkpoint failure shouldn't block game updates
    return null;
  }
}

/**
 * Serialize DynamicGameState for database storage
 * Converts Sets to Arrays and Maps to plain objects for JSON serialization
 */
function serializeDynamicGameState(state: DynamicGameState): any {
  // Convert Sets to Arrays
  const revealedTruthEvents = Array.from(state.revealedTruthEvents);
  const activatedKnowledgeHolders = Array.from(state.activatedKnowledgeHolders);
  const deployedRedHerrings = Array.from(state.deployedRedHerrings);
  const mythosRevelations = Array.from(state.mythosRevelations);

  // Convert scenes Map to plain object
  const serializedScenes: Record<string, any> = {};
  for (const [sceneId, scene] of state.scenes) {
    serializedScenes[sceneId] = scene;
  }

  // Convert Date objects to ISO strings
  const serializedState = {
    ...state,
    revealedTruthEvents,
    activatedKnowledgeHolders,
    deployedRedHerrings,
    mythosRevelations,
    currentSceneId: state.currentSceneId,
    scenes: serializedScenes,
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
  const currentScene = state.currentSceneId
    ? state.scenes.get(state.currentSceneId)
    : null;
  const sceneName = currentScene?.name || "Unknown Scene";
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
  const currentScene = state.currentSceneId
    ? state.scenes.get(state.currentSceneId)
    : null;
  const sceneName = currentScene?.name || "Unknown Scene";
  const gameTime = `Day ${state.gameDay}, ${state.timeOfDay}`;
  const sceneCount = state.scenes.size;

  let description = `${checkpointType === "manual" ? "Manual" : checkpointType === "scene_transition" ? "Scene transition" : "Automatic"} checkpoint. `;
  description += `Scene: ${sceneName}. `;
  description += `Game Time: ${gameTime}. `;
  description += `Total scenes: ${sceneCount}.`;

  return description;
}
