import path from "path";
import fs from "fs/promises";
import { generateGeminiImage } from "../../models/imageGenerator.js";
import type { DynamicGameState } from "../state/index.js";
import type { DynamicScene } from "../world_builder/types.js";

export interface SceneImageResult {
  path: string;
  mimeType: string;
}

function sanitizeScene(scene: DynamicScene): Partial<DynamicScene> {
  const { clues, ...rest } = scene;
  return rest;
}

export function buildSceneImagePromptFromScene(
  scene: Partial<DynamicScene>
): string {
  const sceneJson = JSON.stringify(scene, null, 2);

  return `
# Scene Illustration Prompt

Create a cinematic, atmospheric scene illustration for a Lovecraftian mystery.

## Source of Truth (CRITICAL)
Use the full target scene below as the ONLY source of factual details. Do not invent locations, props, or characters that are not implied by the scene.

## Target Scene (full JSON)
\`\`\`json
${sceneJson}
\`\`\`

## Visual Requirements
- The image must reflect the environment, conditions, and notable elements implied by the scene.
- Style: realistic lighting, moody, grounded, high detail, wide establishing shot.
- Do not include text, captions, watermarks, or UI elements.
`.trim();
}

export function buildSceneImagePrompt(
  scene: DynamicScene,
  state: DynamicGameState
): string {
  const sanitizedScene = sanitizeScene(scene);

  return buildSceneImagePromptFromScene(sanitizedScene);
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
  return (
    input
      .trim()
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "scene"
  );
}

function formatTimeLabel(timeOfDay?: string): string {
  if (!timeOfDay) {
    return "unknown_time";
  }
  return timeOfDay
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
  timeOfDay: string | undefined,
  mimeType: string,
  base64Data: string
): Promise<string> {
  const ext = extFromMime(mimeType);
  const timeLabel = formatTimeLabel(timeOfDay);
  const filenameBase = safeFilename(
    `${sceneName}_${timeLabel}_${uniqueSuffix()}`
  );
  const relativePath = path.join("Sceneimage", `${filenameBase}.${ext}`);
  const outputDir = path.join(
    process.cwd(),
    "data",
    "Mods",
    moduleName,
    "Sceneimage"
  );
  const outputPath = path.join(
    process.cwd(),
    "data",
    "Mods",
    moduleName,
    relativePath
  );

  await fs.mkdir(outputDir, { recursive: true });
  const buffer = Buffer.from(base64Data, "base64");
  await fs.writeFile(outputPath, buffer);

  return relativePath.replace(/\\/g, "/");
}

export async function generateSceneImage(
  scene: DynamicScene,
  state: DynamicGameState
): Promise<SceneImageResult | null> {
  if (!process.env.GOOGLE_API_KEY) {
    return null;
  }
  if (!state.moduleName) {
    return null;
  }

  const prompt = buildSceneImagePrompt(scene, state);
  const result = await generateGeminiImage(prompt);
  const moduleName = state.moduleName;
  const sceneName = scene.name || scene.id || "scene";
  const timeOfDay = state.timeOfDay;
  const relativePath = await saveSceneImageToModule(
    moduleName,
    sceneName,
    timeOfDay,
    result.mimeType,
    result.base64Data
  );

  return {
    path: relativePath,
    mimeType: result.mimeType,
  };
}

export async function generateSceneImageFromScene(
  scene: DynamicScene,
  moduleName: string
): Promise<SceneImageResult | null> {
  if (!process.env.GOOGLE_API_KEY) {
    return null;
  }
  if (!moduleName) {
    return null;
  }

  const sanitizedScene = sanitizeScene(scene);
  const prompt = buildSceneImagePromptFromScene(sanitizedScene);
  const result = await generateGeminiImage(prompt);
  const sceneName = scene.name || scene.id || "scene";
  const relativePath = await saveSceneImageToModule(
    moduleName,
    sceneName,
    undefined,
    result.mimeType,
    result.base64Data
  );

  return {
    path: relativePath,
    mimeType: result.mimeType,
  };
}
