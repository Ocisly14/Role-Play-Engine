/**
 * Macro Map Image Generation
 * Generates a single overview map of all scenarios with connections
 */

import type { ScenarioOutline } from "../world_builder/types.js";
import { generateGeminiImage } from "../../models/imageGenerator.js";
import path from "path";
import fs from "fs/promises";

export interface MapImageResult {
  path: string;        // Module-relative path, e.g. "Map/[Module Name].png"
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
  return input
    .trim()
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "map";
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
  const scenarioSummaries = scenarioOutlines.map(scenario => {
    const connections = scenario.connections
      .map(conn => `  → ${conn.scenarioName} (${conn.relationshipType})`)
      .join("\n");
    
    return `
**${scenario.name}**
${scenario.description}
${connections ? `Connections:\n${connections}` : "No connections"}
`.trim();
  }).join("\n\n");

  return `
# Macro Map Illustration Prompt

Create a single **macro/world map** showing all locations in a Lovecraftian mystery scenario.

## All Scenarios in Module

${scenarioSummaries}

## CRITICAL REQUIREMENTS

1. **Spatial Layout**: Arrange all scenarios on the map to reflect their connections.

2. **No Text Labels**: DO NOT add any text labels, names, or captions to the map. Let the visual elements (buildings, areas, paths) speak for themselves.

3. **Visual Representation**: All scenarios should appear on the map as distinct visual elements (buildings, areas, landmarks, etc.) but without text annotations.

4. **Style**: 
   - Realistic, grounded, high detail with a little bit of mystery and lovecraftian elements.
   - Choose the best view based on the scenario connections
   - DO NOT include UI elements, watermarks, or any text

5. **Connections**: Visual indication of how scenarios connect (paths, doors, passages, etc.) based on the connection information above.

Generate a single cohesive map image with clear visual distinctions between different locations, but no text overlays.
`.trim();
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
  const outputPath = path.join(process.cwd(), "data", "Mods", moduleName, relativePath);

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
    console.log("   ⚠️  GOOGLE_API_KEY not configured, skipping macro map generation");
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
