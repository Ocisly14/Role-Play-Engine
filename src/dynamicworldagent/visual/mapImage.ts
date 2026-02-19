/**
 * Macro Map Image Generation
 * Generates a single overview map of all scenarios with connections
 */

import type {
  ScenarioOutline,
  ScenarioConnection,
} from "../world_builder/types.js";
import { generateGeminiImage } from "../../models/imageGenerator.js";
import path from "path";
import fs from "fs/promises";

export interface MapImageResult {
  path: string; // Module-relative path, e.g. "Map/[Module Name].png"
  mimeType: string;
}

/**
 * Helper: Get file extension from MIME type
 */
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

/**
 * Helper: Sanitize filename (remove special characters)
 */
function safeFilename(input: string): string {
  return (
    input
      .trim()
      .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 80) || "map"
  );
}

/**
 * Helper: Generate unique suffix for filename
 */
function uniqueSuffix(): string {
  const timestamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${timestamp}_${rand}`;
}

/**
 * Build prompt for macro map image generation
 *
 * @param scenarioOutlines - All scenarios in the module
 * @returns Prompt string for Gemini image generation
 */
export function buildMapImagePrompt(
  scenarioOutlines: ScenarioOutline[]
): string {
  // Build scenario summary
  const scenarioSummaries = scenarioOutlines
    .map((scenario) => {
      const connections = scenario.connections
        .map((conn) => `  → ${conn.scenarioName} (${conn.relationshipType})`)
        .join("\n");

      return `
**${scenario.name}**
${scenario.description}
${connections ? `Connections:\n${connections}` : "No connections"}
`.trim();
    })
    .join("\n\n");

  return `
# Macro Map Illustration Prompt

Create a single **macro/world map** showing all locations in a Lovecraftian mystery scenario.

## All Scenarios in Module

${scenarioSummaries}

## REQUIREMENTS

1. **LABEL ALL LOCATIONS**: Every location on the map must be clearly labeled with its exact name as listed above. Use legible text in a consistent font style that fits the Lovecraftian aesthetic (e.g., aged serif lettering). Place labels near their corresponding location without obscuring important visual details.

2. **NO HIDDEN LOCATIONS**: Show only locations that are explicitly listed in "All Scenarios in Module" above. Do NOT add or hint at any hidden, secret, or undisclosed places. Every visible location on the map must correspond to one of the scenarios listed.

3. **Spatial Layout**: Arrange all scenarios on the map to truthfully reflect their geographic or narrative connections.

4. **Visual Representation**: Each listed scenario appears as a distinct visual element (building, area, landmark, etc.).

5. **Style**:
   - Realistic, grounded, high detail with a little bit of mystery and Lovecraftian elements.
   - Choose the best view based on the scenario connections.
   - No UI elements or watermarks.

6. **Connections**: Visual indication of how scenarios connect (paths, doors, passages, etc.) based on the connection information above.

Generate a single cohesive map image with clear visual distinctions between different locations and legible name labels for each one. Do not depict any hidden or unlisted locations.
`.trim();
}

/**
 * Save map image to module directory with a timestamp-based filename
 * (avoids browser caching issues when the map is updated incrementally)
 */
async function saveMapImageToModuleTimestamped(
  moduleName: string,
  mimeType: string,
  base64Data: string
): Promise<string> {
  const ext = extFromMime(mimeType);
  const filenameBase = safeFilename(moduleName);
  const filename = `${filenameBase}_${Date.now()}.${ext}`;
  const relativePath = path.join("Map", filename);
  const outputDir = path.join(process.cwd(), "data", "Mods", moduleName, "Map");
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

/**
 * Build a prompt for incremental map update (scene switch)
 * The LLM receives the current map image as a reference and is asked to
 * add the target scene while keeping existing locations unchanged.
 */
export function buildMapUpdatePrompt(
  currentScene: {
    name: string;
    description: string;
    connections: ScenarioConnection[];
  },
  targetScene: {
    name: string;
    description: string;
    connections: ScenarioConnection[];
  }
): string {
  const fmtScene = (scene: {
    name: string;
    description: string;
    connections: ScenarioConnection[];
  }) => {
    const conns = scene.connections
      .map((c) => `  → ${c.scenarioName} (${c.relationshipType})`)
      .join("\n");
    return `**${scene.name}**\n${scene.description}\n${conns ? `Connections:\n${conns}` : "No connections"}`.trim();
  };

  return `
# Macro Map Update Prompt

The attached image is the **current macro map**. Use it as the visual foundation for the updated map.

## Current Scene (player is leaving)

${fmtScene(currentScene)}

## Target Scene (player is entering – add this to the map)

${fmtScene(targetScene)}

## REQUIREMENTS

1. **MINIMIZE CHANGES TO EXISTING LOCATIONS**: Keep every location that already appears on the reference map as close to its original visual representation as possible. Avoid unnecessary repositioning or redrawing. However, if the actual spatial relationship between locations demands an adjustment (e.g., to correctly place the new scene relative to existing ones, or to reflect an updated connection), small layout tweaks are acceptable.

2. **ADAPTIVE RESCALING FOR CLARITY**: You may uniformly scale (zoom in/out) the existing map content from the reference image when needed to fit the new scene and keep the composition readable. Prefer global scaling over individually moving old locations. Keep relative positions and topology between existing locations consistent.

3. **REFLECT CONNECTION CHANGES**: If the connections listed above differ from what is shown on the reference map (new paths opened, old passages blocked, etc.), update the visual connections accordingly on the map.

4. **FINAL MAP QUALITY TAKES PRIORITY**: The final map's readability, coherence, and visual quality are the top priority. You may modify existing map content when necessary to achieve a clearer and more harmonious final result.

5. **ADD TARGET SCENE**: Add "${targetScene.name}" as a new distinct visual element. Position it to truthfully reflect its geographic or narrative relationship with "${currentScene.name}" and any other connected locations.

6. **LABEL ALL LOCATIONS**: Every location on the map (both existing and newly added) must be clearly labeled with its name in legible text. Use a consistent font style that fits the Lovecraftian aesthetic (e.g., aged serif lettering). Labels should be placed near their corresponding location without obscuring important visual details.

7. **VISUAL CONNECTIONS**: Draw paths, corridors, roads, or passages between connected locations as appropriate. Blocked or locked connections may be shown with a barrier symbol or broken line.

8. **NO HIDDEN LOCATIONS**: Do not add any location not listed above or not already present on the existing map.

9. **Style**: Maintain the same artistic style as the reference image – realistic, high detail, Lovecraftian mystery atmosphere.

Generate a single cohesive updated map image that integrates the new scene naturally with the existing map.
`.trim();
}

/**
 * Generate an updated macro map when the player switches scenes.
 * Sends the previous map image as a reference so the LLM can incrementally
 * add the target scene while keeping existing locations intact.
 *
 * @param moduleName - Module name (for file path resolution)
 * @param currentSceneData - Scene the player is leaving
 * @param targetSceneData - Scene the player is entering
 * @param previousMapPath - Module-relative path to the current map (e.g. "Map/foo.png")
 * @returns MapImageResult with the new timestamped file path, or null on failure
 */
export async function generateMapOnSceneSwitch(
  moduleName: string,
  currentSceneData: {
    name: string;
    description: string;
    connections: ScenarioConnection[];
  },
  targetSceneData: {
    name: string;
    description: string;
    connections: ScenarioConnection[];
  },
  previousMapPath: string | undefined
): Promise<MapImageResult | null> {
  if (!process.env.GOOGLE_API_KEY) {
    console.log("   ⚠️  GOOGLE_API_KEY not configured, skipping map update");
    return null;
  }

  if (!moduleName) {
    console.warn("   ⚠️  Module name missing, skipping map update");
    return null;
  }

  try {
    let referenceImages:
      | Array<{ mimeType: string; base64Data: string }>
      | undefined;
    let prompt: string;

    if (previousMapPath) {
      const absoluteMapPath = path.join(
        process.cwd(),
        "data",
        "Mods",
        moduleName,
        previousMapPath
      );
      try {
        const imgBuffer = await fs.readFile(absoluteMapPath);
        const base64Data = imgBuffer.toString("base64");
        // Infer mime type from extension
        const ext = path.extname(previousMapPath).toLowerCase().slice(1);
        const mimeType =
          ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "webp"
              ? "image/webp"
              : "image/png";
        referenceImages = [{ mimeType, base64Data }];
        prompt = buildMapUpdatePrompt(currentSceneData, targetSceneData);
        console.log(`   ✓ Using previous map as reference: ${previousMapPath}`);
      } catch {
        // File not found or unreadable – fall back to fresh generation
        console.warn(
          `   ⚠️  Could not read previous map (${previousMapPath}), falling back to fresh generation`
        );
        prompt = buildMapImagePrompt([
          targetSceneData as unknown as ScenarioOutline,
        ]);
        referenceImages = undefined;
      }
    } else {
      // No previous map – generate a fresh one with only the target scene
      prompt = buildMapImagePrompt([
        targetSceneData as unknown as ScenarioOutline,
      ]);
    }

    const result = await generateGeminiImage(prompt, { referenceImages });

    const relativePath = await saveMapImageToModuleTimestamped(
      moduleName,
      result.mimeType,
      result.base64Data
    );

    console.log(`   ✓ Incremental map saved: ${relativePath}`);
    return { path: relativePath, mimeType: result.mimeType };
  } catch (error) {
    console.error("   ❌ Failed to generate incremental map:", error);
    return null;
  }
}

/**
 * Save map image to module directory
 *
 * @param moduleName - Module name
 * @param mimeType - Image MIME type
 * @param base64Data - Base64-encoded image data
 * @returns Module-relative path to saved image
 */
async function saveMapImageToModule(
  moduleName: string,
  mimeType: string,
  base64Data: string
): Promise<string> {
  const ext = extFromMime(mimeType);
  const filenameBase = safeFilename(moduleName);
  const relativePath = path.join("Map", `${filenameBase}.${ext}`);
  const outputDir = path.join(process.cwd(), "data", "Mods", moduleName, "Map");
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

/**
 * Generate macro map image from scenario outlines
 *
 * @param moduleName - Module name for save path
 * @param scenarios - All scenario outlines
 * @returns Map image result or null if generation failed/skipped
 */
export async function generateMapImageFromScenarios(
  moduleName: string,
  scenarios: ScenarioOutline[]
): Promise<MapImageResult | null> {
  // Check prerequisites
  if (!process.env.GOOGLE_API_KEY) {
    console.log(
      "   ⚠️  GOOGLE_API_KEY not configured, skipping macro map generation"
    );
    return null;
  }

  if (!moduleName) {
    console.warn("   ⚠️  Module name missing, skipping macro map generation");
    return null;
  }

  if (!scenarios || scenarios.length === 0) {
    console.warn("   ⚠️  No scenarios provided, skipping macro map generation");
    return null;
  }

  try {
    // Build prompt
    const prompt = buildMapImagePrompt(scenarios);

    // Generate image
    const result = await generateGeminiImage(prompt);

    // Save to module directory
    const relativePath = await saveMapImageToModule(
      moduleName,
      result.mimeType,
      result.base64Data
    );

    return {
      path: relativePath,
      mimeType: result.mimeType,
    };
  } catch (error) {
    console.error("   ❌ Failed to generate macro map:", error);
    return null;
  }
}
