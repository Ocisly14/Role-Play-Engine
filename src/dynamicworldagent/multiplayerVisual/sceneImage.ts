/**
 * Multiplayer Scene Image Generation — Phase 4 (Rule 22)
 *
 * Each sceneRoom generates its own scene image independently,
 * reusing the single-player generateSceneImageFromSnapshot utility.
 *
 * Scene images are generated after a sceneRoom completes a round
 * (or after a scene transition). The resulting image path is broadcast
 * to all clients in the sceneRoom via WebSocket (type: "scene_image_ready").
 */

import type { DynamicScenarioSnapshot } from "../world_builder/types.js";
import {
  generateSceneImageFromSnapshot,
  type SceneImageResult,
} from "../visual/sceneImage.js";

export type { SceneImageResult };

/**
 * Generate a scene image for a specific sceneRoom.
 *
 * @param snapshot   The current scenario snapshot for this sceneRoom
 * @param moduleName  The module name (used for file storage path)
 * @returns  Image result (path + mimeType) or null if image generation is disabled
 */
export async function generateSceneRoomImage(
  snapshot: DynamicScenarioSnapshot | null,
  moduleName: string
): Promise<SceneImageResult | null> {
  if (!snapshot) return null;
  if (!moduleName) return null;
  // generateSceneImageFromSnapshot already checks for GOOGLE_API_KEY
  return generateSceneImageFromSnapshot(snapshot, moduleName);
}
