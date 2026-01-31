import type { DynamicGameState } from "../state/index.js";
import type { DynamicScenarioSnapshot } from "../world_builder/types.js";
import { generateGeminiImage } from "../../models/imageGenerator.js";
import path from "path";
import fs from "fs/promises";

export interface SceneImageResult {
  path: string;
  mimeType: string;
}

function sanitizeSnapshot(snapshot: DynamicScenarioSnapshot): DynamicScenarioSnapshot {
  return {
    ...snapshot,
    clues: [],
    keeperNotes: undefined,
  };
}

export function buildSceneImagePromptFromSnapshot(
  snapshot: DynamicScenarioSnapshot
): string {
  const snapshotJson = JSON.stringify(snapshot, null, 2);

  return `
# Scene Illustration Prompt

Create a cinematic, atmospheric scene illustration for a Lovecraftian mystery.

## Source of Truth (CRITICAL)
Use the full target scene snapshot below as the ONLY source of factual details. Do not invent locations, props, or characters that are not implied by the snapshot.

## Target Scene Snapshot (full JSON)
\`\`\`json
${snapshotJson}
\`\`\`

## Visual Requirements
- The image must reflect the location, environment, characters, conditions, and notable elements implied by the snapshot.
- Style: realistic lighting, moody, grounded, high detail, wide establishing shot.
- Do not include text, captions, watermarks, or UI elements.
`.trim();
}

export function buildSceneImagePrompt(
  scenario: DynamicScenarioSnapshot,
  state: DynamicGameState
): string {
  const sanitizedSnapshot = sanitizeSnapshot(scenario);

  return buildSceneImagePromptFromSnapshot(sanitizedSnapshot);
}

function extFromMime(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/png":
    default:
      return "png";
  }
}

function safeFilename(input: string): string {
  return input
    .trim()
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "scene";
}

function formatGameTimeLabel(gameTime?: string): string {
  if (!gameTime) {
    return "unknown_time";
  }
  return gameTime
    .replace(/Day\s*/i, "Day_")
    .replace(/,\s*/g, "_")
    .replace(/:/g, "-")
    .replace(/\s+/g, "_");
}

function uniqueSuffix(): string {
  const timestamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${timestamp}_${rand}`;
}

async function saveSceneImageToModule(
  moduleName: string,
  sceneName: string,
  gameTime: string | undefined,
  mimeType: string,
  base64Data: string
): Promise<string> {
  const ext = extFromMime(mimeType);
  const timeLabel = formatGameTimeLabel(gameTime);
  const filenameBase = safeFilename(`${sceneName}_${timeLabel}_${uniqueSuffix()}`);
  const relativePath = path.join("Sceneimage", `${filenameBase}.${ext}`);
  const outputDir = path.join(process.cwd(), "data", "Mods", moduleName, "Sceneimage");
  const outputPath = path.join(process.cwd(), "data", "Mods", moduleName, relativePath);

  await fs.mkdir(outputDir, { recursive: true });
  const buffer = Buffer.from(base64Data, "base64");
  await fs.writeFile(outputPath, buffer);

  return relativePath.replace(/\\/g, "/");
}

export async function generateSceneImage(
  scenario: DynamicScenarioSnapshot,
  state: DynamicGameState
): Promise<SceneImageResult | null> {
  if (!process.env.GOOGLE_API_KEY) {
    return null;
  }
  if (!state.moduleName) {
    return null;
  }

  const prompt = buildSceneImagePrompt(scenario, state);
  const result = await generateGeminiImage(prompt);
  const moduleName = state.moduleName;
  const sceneName = scenario.name || scenario.id || "scene";
  const gameTime = scenario.gameTime || `Day ${state.gameDay}, ${state.timeOfDay}`;
  const relativePath = await saveSceneImageToModule(
    moduleName,
    sceneName,
    gameTime,
    result.mimeType,
    result.base64Data
  );

  return {
    path: relativePath,
    mimeType: result.mimeType,
  };
}

export async function generateSceneImageFromSnapshot(
  snapshot: DynamicScenarioSnapshot,
  moduleName: string
): Promise<SceneImageResult | null> {
  if (!process.env.GOOGLE_API_KEY) {
    return null;
  }
  if (!moduleName) {
    return null;
  }

  const sanitizedSnapshot = sanitizeSnapshot(snapshot);
  const prompt = buildSceneImagePromptFromSnapshot(
    sanitizedSnapshot
  );
  const result = await generateGeminiImage(prompt);
  const sceneName = snapshot.name || snapshot.id || "scene";
  const gameTime = snapshot.gameTime;
  const relativePath = await saveSceneImageToModule(
    moduleName,
    sceneName,
    gameTime,
    result.mimeType,
    result.base64Data
  );

  return {
    path: relativePath,
    mimeType: result.mimeType,
  };
}
