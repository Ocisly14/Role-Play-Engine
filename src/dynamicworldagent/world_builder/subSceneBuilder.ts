/**
 * Sub-Scene Builder - Generates sub-scenes (rooms/floors) for each macro location
 * Runs in parallel for all macro locations using Promise.all()
 */

import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../models/index.js";
import { buildSubScenePrompt } from "./subSceneBuilderTemplate.js";
import type {
  DynamicScene,
  MacroSceneStructure,
  ScenarioOutline,
} from "./types.js";

interface Runtime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): Runtime => ({
  modelProvider:
    (process.env.WORLD_BUILDER_MODEL_PROVIDER as ModelProviderName) ||
    ModelProviderName.OPENAI,
  getSetting: (key: string) => process.env[key],
});

/**
 * Parse JSON from LLM response (handles markdown code blocks)
 */
function parseJSONResponse(response: string): any {
  const jsonText =
    response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ||
    response.match(/\{[\s\S]*\}/)?.[0] ||
    response.match(/\[[\s\S]*\]/)?.[0];

  if (!jsonText) {
    throw new Error("Failed to extract JSON from response");
  }

  return JSON.parse(jsonText);
}

export class SubSceneBuilder {
  private runtime: Runtime;

  constructor() {
    this.runtime = createRuntime();
  }

  /**
   * Generate sub-scenes for a single macro location.
   *
   * 1. Calls LLM with buildSubScenePrompt()
   * 2. Parses response
   * 3. Converts each raw sub-scene to DynamicScene
   * 4. Identifies entry scene (isEntry flag or first scene as fallback)
   */
  async generateSubScenes(
    macroLocation: ScenarioOutline,
    macroScene: MacroSceneStructure,
    connectedStreetScenes: Array<{ id: string; name: string }>
  ): Promise<{ scenes: DynamicScene[]; entrySceneId: string }> {
    // Build setting description from macroScene
    const settingParts: string[] = [];
    settingParts.push(`Module: ${macroScene.moduleName}`);
    settingParts.push(`Location: ${macroScene.locationName}`);
    if (macroScene.settingType) {
      settingParts.push(`Setting type: ${macroScene.settingType}`);
    }
    if (macroScene.economicCore) {
      settingParts.push(`Economic base: ${macroScene.economicCore}`);
    }
    const settingDescription = settingParts.join("\n");

    const prompt = buildSubScenePrompt({
      macroLocation: {
        id: macroLocation.id,
        name: macroLocation.name,
        description: macroLocation.description,
        subSceneCount: macroLocation.subSceneCount,
        residents: macroLocation.residents,
      },
      settingDescription,
      connectedStreetScenes,
    });

    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    try {
      const parsed = parseJSONResponse(response);
      const rawSubScenes: any[] = Array.isArray(parsed)
        ? parsed
        : parsed.subScenes || parsed.scenes || [];

      if (!Array.isArray(rawSubScenes) || rawSubScenes.length === 0) {
        throw new Error(
          `No sub-scenes returned for macro location "${macroLocation.name}"`
        );
      }

      // Convert raw sub-scenes to DynamicScene[]
      const scenes: DynamicScene[] = [];
      let entrySceneId: string | null = null;

      for (const raw of rawSubScenes) {
        if (!raw.id || !raw.name || !raw.description) {
          console.warn(
            `Sub-scene missing required fields (id/name/description) in "${macroLocation.name}", skipping.`
          );
          continue;
        }

        const scene: DynamicScene = {
          id: raw.id,
          name: raw.name,
          description: raw.description,
          parentLocationId: macroLocation.id,
          items: Array.isArray(raw.items)
            ? raw.items
                .filter((item: any) => item?.id && item?.name)
                .map((item: any) => ({
                  id: item.id,
                  name: item.name,
                  description: item.description,
                }))
            : [],
          clues: [], // Clues placed separately in a later step
          conditions: Array.isArray(raw.conditions)
            ? raw.conditions
                .filter((c: any) => c?.type && c?.description)
                .map((c: any) => ({
                  type: c.type,
                  description: c.description,
                  mechanicalEffect: c.mechanicalEffect,
                }))
            : [],
          connections: Array.isArray(raw.internalConnections)
            ? raw.internalConnections
            : [],
          sceneImage: undefined,
        };

        scenes.push(scene);

        // Track entry scene
        if (raw.isEntry === true && !entrySceneId) {
          entrySceneId = scene.id;
        }
      }

      if (scenes.length === 0) {
        throw new Error(
          `No valid sub-scenes after validation for "${macroLocation.name}"`
        );
      }

      // Fallback: use first scene as entry if none marked
      if (!entrySceneId) {
        entrySceneId = scenes[0].id;
        console.warn(
          `No isEntry sub-scene found for "${macroLocation.name}", using first scene "${entrySceneId}" as entry.`
        );
      }

      console.log(
        `[SubSceneBuilder] Generated ${scenes.length} sub-scenes for "${macroLocation.name}" (entry: ${entrySceneId})`
      );

      return { scenes, entrySceneId };
    } catch (error) {
      console.error(
        `Failed to parse sub-scene response for "${macroLocation.name}":`,
        error
      );
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to generate sub-scenes for "${macroLocation.name}": ${(error as Error).message}`
      );
    }
  }

  /**
   * Generate sub-scenes for ALL macro locations in parallel.
   * Returns results keyed by macro location ID.
   */
  async generateAllSubScenes(
    macroLocations: ScenarioOutline[],
    macroScene: MacroSceneStructure,
    streetScenesByLocation: Map<string, Array<{ id: string; name: string }>>
  ): Promise<Map<string, { scenes: DynamicScene[]; entrySceneId: string }>> {
    console.log(
      `[SubSceneBuilder] Generating sub-scenes for ${macroLocations.length} macro locations in parallel...`
    );

    const results = await Promise.all(
      macroLocations.map(async (location) => {
        const connectedStreets =
          streetScenesByLocation.get(location.id) || [];
        const result = await this.generateSubScenes(
          location,
          macroScene,
          connectedStreets
        );
        return { locationId: location.id, result };
      })
    );

    const resultMap = new Map<
      string,
      { scenes: DynamicScene[]; entrySceneId: string }
    >();
    for (const { locationId, result } of results) {
      resultMap.set(locationId, result);
    }

    console.log(
      `[SubSceneBuilder] All sub-scenes generated: ${resultMap.size} locations processed`
    );

    return resultMap;
  }
}
