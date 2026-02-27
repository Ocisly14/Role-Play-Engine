/**
 * Multiplayer Checkpoint helpers
 *
 * Serializes a MultiplayerDynamicGameState (via its manager) into a
 * self-contained JSON payload suitable for storage in MultiplayerCheckpoint.payload.
 *
 * Conversation history and language are attached so the checkpoint is
 * fully restorable without touching the turn table.
 */

import type {
  CoCDatabase,
  CoCDatabaseAdapter,
} from "../../../shared/agents/memory/database/index.js";
import { getPrismaClient } from "../../../shared/agents/memory/database/prismaClient.js";
import type { MultiplayerDynamicGameStateManager } from "../../multiplayerState/MultiplayerDynamicGameState.js";
import { TurnManager } from "./turnManager.js";

/**
 * Build a self-contained checkpoint payload from the current game-state manager.
 *
 * The returned object is plain JSON (no Sets, Maps, or Date instances) and
 * includes `conversationHistory` + `language` so restoring a checkpoint
 * does not require the original session to still exist.
 */
export async function serializeMultiplayerCheckpoint(
  manager: MultiplayerDynamicGameStateManager,
  db: CoCDatabase | CoCDatabaseAdapter
): Promise<Record<string, unknown>> {
  const state = manager.getState();
  const payload: Record<string, unknown> = manager.toJSON();

  // Attach conversation history (across all sceneRooms)
  try {
    await db.preloadSessionTurns(state.sessionId);
    const turnManager = new TurnManager(db);
    payload.conversationHistory = turnManager.getConversation(
      state.sessionId,
      Number.MAX_SAFE_INTEGER
    );
  } catch {
    payload.conversationHistory = [];
  }

  // Attach language from session metadata
  try {
    const prisma = getPrismaClient();
    const session = await prisma.session.findUnique({
      where: { sessionId: state.sessionId },
      select: { metadata: true },
    });
    const metadata = (session?.metadata ?? {}) as Record<string, any>;
    payload.language =
      metadata.language === "en" || metadata.language === "zh"
        ? metadata.language
        : "zh";
  } catch {
    payload.language = "zh";
  }

  return payload;
}

/**
 * Generate a human-readable checkpoint name from the active scene rooms.
 */
export function generateMultiplayerCheckpointName(
  manager: MultiplayerDynamicGameStateManager
): string {
  const state = manager.getState();

  // Collect active (non-frozen) scene names
  const activeSceneNames: string[] = [];
  for (const room of Object.values(state.sceneRooms)) {
    if (!room.isFrozen && room.currentScenario?.name) {
      activeSceneNames.push(room.currentScenario.name);
    }
  }

  const scenePart =
    activeSceneNames.length > 0
      ? activeSceneNames.slice(0, 2).join(", ")
      : "No active scene";

  const gameTime = `Day ${state.gameDay}, ${state.timeOfDay}`;
  return `${scenePart} (${gameTime})`;
}
