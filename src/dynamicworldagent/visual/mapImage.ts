/**
 * Macro Map Image Generation
 * Generates a single overview map of all scenarios with connections
 */

import path from "path";
import fs from "fs/promises";
import { generateGeminiImage } from "../../models/imageGenerator.js";
import type {
  ScenarioConnection,
  ScenarioOutline,
} from "../world_builder/types.js";

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
      const connections = ((scenario as any).connections || [])
        .map((conn: any) => `  → ${conn.scenarioName || conn} (${conn.relationshipType || "connected"})`)
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

1. The current map is what the player has seen so far. You are adding a new location(target scene) to the map. You can move existing locations to make room for the new scene, but keep th connections between locations consistent.

2. **ADAPTIVE RESCALING FOR CLARITY**: You may uniformly scale (zoom in/out) the existing map content from the reference image when needed to fit the new scene and keep the composition readable. Keep relative positions and topology between existing locations consistent.

3. **REFLECT CONNECTION CHANGES**: If the connections listed above differ from what is shown on the reference map (new paths opened, old passages blocked, etc.), update the visual connections accordingly on the map.

3. **FINAL MAP QUALITY TAKES PRIORITY**: The final map's readability, coherence, and visual quality are the top priority. You may modify existing map content when necessary to achieve a clearer and more harmonious final result.

5. **ADD TARGET SCENE**: Add "${targetScene.name}" as a new distinct visual element. Position it to truthfully reflect its geographic or narrative relationship with "${currentScene.name}" and any other connected locations.

6. **LABEL ALL LOCATIONS**: Every location on the map (both existing and newly added) must be clearly labeled with its name in legible text. Use a consistent font style that fits the Lovecraftian aesthetic (e.g., aged serif lettering). Labels should be placed near their corresponding location without obscuring important visual details.

7. **VISUAL CONNECTIONS**: Draw paths, corridors, roads, or passages between connected locations as appropriate.

8. **MANDATORY TARGET CONNECTION COVERAGE**: You MUST render all connections listed in the target scene snapshot on the map. Every target-scene connection should be visually represented between "${targetScene.name}" and the connected location.

9. **NO HIDDEN LOCATIONS**: Do not add any location not listed above or not already present on the existing map.

10. **Style**: Maintain the same artistic style as the reference image – realistic, high detail, Lovecraftian mystery atmosphere.

11. **FULL REDRAW ALLOWED**: If the reference map is too cluttered or visually chaotic to accommodate the new scene cleanly, you may completely redraw the map from scratch. However, every location already present on the reference map AND the new target scene must all appear in the redrawn version, with all their connections preserved.

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
 * Build prompt for merging multiple maps into one.
 * Used when players from different scene rooms converge to the same scene.
 * All parent maps are sent as reference images so the model can combine them.
 */
export function buildMapMergePrompt(
  parentScenes: Array<{
    name: string;
    description: string;
    connections: ScenarioConnection[];
  }>,
  targetScene: {
    name: string;
    description: string;
    connections: ScenarioConnection[];
  } | null
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

  const parentSummaries = parentScenes
    .map((s, i) => `### Map ${i + 1} — ${s.name}\n${fmtScene(s)}`)
    .join("\n\n");

  const targetSection = targetScene
    ? `\n## Target Scene (players are converging here — add this to the merged map)\n\n${fmtScene(targetScene)}`
    : "";

  return `
# Macro Map Merge Prompt

The attached images are **${parentScenes.length} existing maps** from different player groups exploring different areas of the same world. Merge them into a single cohesive macro map.

## Existing Maps (one per attached image)

${parentSummaries}
${targetSection}

## REQUIREMENTS

1. **MERGE ALL MAPS**: Combine all locations from every attached reference map into a single cohesive macro map. Every location visible on any reference map must appear in the final result.

2. **ADAPTIVE RESCALING FOR CLARITY**: You may uniformly scale (zoom in/out) content from reference images to fit everything together. Keep relative positions and topology between locations within each source map consistent.

3. **SPATIAL COHERENCE**: Where maps share common locations (same name), align them so the same location appears only once. Use connections and geography to determine the best relative placement of non-overlapping regions.

4. **REFLECT CONNECTION CHANGES**: If the connections listed above differ from what is shown on a reference map, update the visual connections accordingly.

5. **FINAL MAP QUALITY TAKES PRIORITY**: Readability, coherence, and visual quality are the top priority. You may modify content from reference maps when necessary for a clearer result.
${targetScene ? `\n6. **ADD TARGET SCENE**: Add "${targetScene.name}" as a new distinct visual element if it does not already appear on any reference map. Position it to reflect its geographic or narrative relationships.\n` : ""}
7. **LABEL ALL LOCATIONS**: Every location must be clearly labeled with its name in legible text. Use a consistent Lovecraftian font style.

8. **VISUAL CONNECTIONS**: Draw paths, corridors, roads, or passages between connected locations as appropriate.

9. **NO HIDDEN LOCATIONS**: Do not add any location not listed above or not already present on reference maps.

10. **Style**: Realistic, high detail, Lovecraftian mystery atmosphere. Maintain a consistent style across merged regions.

11. **FULL REDRAW ALLOWED**: If the reference maps are too inconsistent to merge cleanly, you may completely redraw the map from scratch — but every location from all reference maps${targetScene ? " AND the target scene" : ""} must appear with all connections preserved.

Generate a single cohesive merged map image.
`.trim();
}

/**
 * Generate a merged map from multiple parent scene rooms' maps.
 * Collects all available parent maps as reference images and asks the
 * model to produce a single combined map.
 *
 * @param moduleName - Module name (for file path resolution)
 * @param parentScenes - Scene data + mapImagePath for each parent room
 * @param targetScene - Target scene data (null if converging to an existing parent scene)
 * @param fallbackMapPath - Global macroMapPath fallback if no parent has a map
 * @returns MapImageResult or null on failure
 */
export async function generateMergedMap(
  moduleName: string,
  parentScenes: Array<{
    name: string;
    description: string;
    connections: ScenarioConnection[];
    mapImagePath?: string | null;
  }>,
  targetScene: {
    name: string;
    description: string;
    connections: ScenarioConnection[];
  } | null,
  fallbackMapPath?: string
): Promise<MapImageResult | null> {
  if (!process.env.GOOGLE_API_KEY) {
    console.log("   ⚠️  GOOGLE_API_KEY not configured, skipping merged map generation");
    return null;
  }
  if (!moduleName) {
    console.warn("   ⚠️  Module name missing, skipping merged map generation");
    return null;
  }

  try {
    // Collect all available parent maps as reference images
    const referenceImages: Array<{ mimeType: string; base64Data: string }> = [];

    const mapPaths = parentScenes
      .map((s) => s.mapImagePath)
      .filter((p): p is string => Boolean(p));

    // If no parent has a map, try the fallback
    if (mapPaths.length === 0 && fallbackMapPath) {
      mapPaths.push(fallbackMapPath);
    }

    // Deduplicate paths (parents may share the same map file)
    const uniquePaths = [...new Set(mapPaths)];

    for (const mapPath of uniquePaths) {
      const absoluteMapPath = path.join(
        process.cwd(), "data", "Mods", moduleName, mapPath
      );
      try {
        const imgBuffer = await fs.readFile(absoluteMapPath);
        const base64Data = imgBuffer.toString("base64");
        const ext = path.extname(mapPath).toLowerCase().slice(1);
        const mimeType =
          ext === "jpg" || ext === "jpeg"
            ? "image/jpeg"
            : ext === "webp"
              ? "image/webp"
              : "image/png";
        referenceImages.push({ mimeType, base64Data });
        console.log(`   ✓ Loaded parent map as reference: ${mapPath}`);
      } catch {
        console.warn(`   ⚠️  Could not read parent map (${mapPath}), skipping`);
      }
    }

    // Build prompt — if we have reference images use merge prompt,
    // otherwise fall back to a fresh generation with just the scene list
    let prompt: string;
    if (referenceImages.length > 0) {
      prompt = buildMapMergePrompt(parentScenes, targetScene);
    } else if (targetScene) {
      // No maps at all — generate fresh with target scene only
      prompt = buildMapImagePrompt([
        targetScene as unknown as ScenarioOutline,
      ]);
    } else {
      console.warn("   ⚠️  No reference maps and no target scene, skipping merged map");
      return null;
    }

    const result = await generateGeminiImage(prompt, {
      referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
    });

    const relativePath = await saveMapImageToModuleTimestamped(
      moduleName,
      result.mimeType,
      result.base64Data
    );

    console.log(`   ✓ Merged map saved: ${relativePath}`);
    return { path: relativePath, mimeType: result.mimeType };
  } catch (error) {
    console.error("   ❌ Failed to generate merged map:", error);
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
