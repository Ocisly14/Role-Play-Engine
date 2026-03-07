/**
 * Scene Graph Builder - Generates transport network (street/road scenes) connecting macro locations
 * Produces outdoor scenes, transport edges, and an outdoor macro location container.
 */

import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../models/index.js";
import {
  buildTransportNetworkPrompt,
  type TransportNetworkParams,
} from "./sceneGraphBuilderTemplate.js";
import type {
  DynamicScene,
  MacroSceneStructure,
  ProgressCallback,
  ScenarioOutline,
  TransportEdge,
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

/** Fixed ID and name for the outdoor macro location container */
const OUTDOOR_LOCATION_ID = "outdoor_streets";
const OUTDOOR_LOCATION_NAME = "Streets & Paths";

export class SceneGraphBuilder {
  private runtime: Runtime;

  constructor() {
    this.runtime = createRuntime();
  }

  /**
   * Generate the transport network connecting macro locations.
   *
   * 1. Calls the LLM with buildTransportNetworkPrompt()
   * 2. Parses the response into outdoor scenes and transport edges
   * 3. Creates an "outdoor_streets" macro location container for outdoor scenes
   * 4. Converts raw outdoor scenes into DynamicScene objects
   *
   * @returns outdoorScenes, transportEdges, and the outdoor macro location (ScenarioOutline)
   */
  async generateTransportNetwork(
    macroLocations: ScenarioOutline[],
    macroScene: MacroSceneStructure,
    storyPremise: string,
    progressCallback?: ProgressCallback
  ): Promise<{
    outdoorScenes: DynamicScene[];
    transportEdges: TransportEdge[];
    outdoorMacroLocation: ScenarioOutline;
  }> {
    progressCallback?.("Generating transport network (streets & paths)...");

    // Build setting description from macroScene
    const settingParts: string[] = [];
    settingParts.push(`Module: ${macroScene.moduleName}`);
    settingParts.push(`Location: ${macroScene.locationName}`);
    if (macroScene.settingType) {
      settingParts.push(`Setting type: ${macroScene.settingType}`);
    }
    if (macroScene.geographicLayout) {
      const geo = macroScene.geographicLayout;
      if (geo.naturalFeatures?.length) {
        settingParts.push(
          `Natural features: ${geo.naturalFeatures.join(", ")}`
        );
      }
      if (geo.artificialStructures?.length) {
        settingParts.push(
          `Structures: ${geo.artificialStructures.join(", ")}`
        );
      }
      if (geo.keyLocations?.length) {
        settingParts.push(
          `Key locations: ${geo.keyLocations.join(", ")}`
        );
      }
    }
    if (macroScene.economicCore) {
      settingParts.push(`Economic base: ${macroScene.economicCore}`);
    }

    const settingDescription = settingParts.join("\n");

    const promptParams: TransportNetworkParams = {
      macroLocations: macroLocations.map((loc) => ({
        id: loc.id,
        name: loc.name,
        description: loc.description,
      })),
      settingDescription,
      storyPremise,
    };

    const prompt = buildTransportNetworkPrompt(promptParams);

    progressCallback?.("Calling AI for transport network...");
    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    try {
      const parsed = parseJSONResponse(response);

      // --- Validate outdoor scenes ---
      const rawScenes: any[] = Array.isArray(parsed.outdoorScenes)
        ? parsed.outdoorScenes
        : [];

      if (rawScenes.length === 0) {
        throw new Error(
          "Response must contain a non-empty outdoorScenes array"
        );
      }

      const validSceneIds = new Set<string>();
      const outdoorScenes: DynamicScene[] = [];

      for (let i = 0; i < rawScenes.length; i++) {
        const raw = rawScenes[i];
        if (!raw.id || !raw.name || !raw.description) {
          console.warn(
            `Outdoor scene at index ${i} missing required fields (id/name/description), skipping.`
          );
          continue;
        }

        validSceneIds.add(raw.id);

        outdoorScenes.push({
          id: raw.id,
          name: raw.name,
          description: raw.description,
          parentLocationId: OUTDOOR_LOCATION_ID,
          items: [],
          clues: [],
          conditions: [],
          connections: [],
          events: [],
        });
      }

      if (outdoorScenes.length === 0) {
        throw new Error("No valid outdoor scenes after validation");
      }

      // --- Validate transport edges ---
      const rawEdges: any[] = Array.isArray(parsed.transportEdges)
        ? parsed.transportEdges
        : [];

      const macroLocationIds = new Set(macroLocations.map((loc) => loc.id));
      const transportEdges: TransportEdge[] = [];

      for (const raw of rawEdges) {
        if (
          !raw.fromLocationId ||
          !raw.toLocationId ||
          !raw.streetSceneId
        ) {
          console.warn(
            `Transport edge missing required fields, skipping: ${JSON.stringify(raw)}`
          );
          continue;
        }

        // Validate references
        if (
          !macroLocationIds.has(raw.fromLocationId) &&
          !validSceneIds.has(raw.fromLocationId)
        ) {
          console.warn(
            `Transport edge references unknown fromLocationId "${raw.fromLocationId}", skipping.`
          );
          continue;
        }
        if (
          !macroLocationIds.has(raw.toLocationId) &&
          !validSceneIds.has(raw.toLocationId)
        ) {
          console.warn(
            `Transport edge references unknown toLocationId "${raw.toLocationId}", skipping.`
          );
          continue;
        }
        if (!validSceneIds.has(raw.streetSceneId)) {
          console.warn(
            `Transport edge references unknown streetSceneId "${raw.streetSceneId}", skipping.`
          );
          continue;
        }

        const travelTime =
          typeof raw.travelTimeMinutes === "number" && raw.travelTimeMinutes > 0
            ? raw.travelTimeMinutes
            : 5; // default 5 minutes

        transportEdges.push({
          fromLocationId: raw.fromLocationId,
          toLocationId: raw.toLocationId,
          streetSceneId: raw.streetSceneId,
          travelTimeMinutes: travelTime,
        });
      }

      // --- Connectivity check ---
      this.validateConnectivity(macroLocations, transportEdges);

      // --- Create the outdoor macro location container ---
      const outdoorMacroLocation: ScenarioOutline = {
        id: OUTDOOR_LOCATION_ID,
        name: OUTDOOR_LOCATION_NAME,
        description:
          "Outdoor roads, streets, and paths connecting the locations of the scenario.",
        subSceneCount: outdoorScenes.length,
      };

      progressCallback?.(
        `Transport network generated: ${outdoorScenes.length} outdoor scenes, ${transportEdges.length} edges`
      );

      return { outdoorScenes, transportEdges, outdoorMacroLocation };
    } catch (error) {
      console.error("Failed to parse transport network response:", error);
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to generate transport network: ${(error as Error).message}`
      );
    }
  }

  /**
   * Warn if the transport graph is not fully connected (BFS reachability check).
   */
  private validateConnectivity(
    macroLocations: ScenarioOutline[],
    transportEdges: TransportEdge[]
  ): void {
    if (macroLocations.length <= 1) return;

    // Build undirected adjacency from transport edges
    const adjacency = new Map<string, Set<string>>();

    const ensureNode = (id: string) => {
      if (!adjacency.has(id)) {
        adjacency.set(id, new Set());
      }
    };

    for (const loc of macroLocations) {
      ensureNode(loc.id);
    }

    for (const edge of transportEdges) {
      ensureNode(edge.fromLocationId);
      ensureNode(edge.toLocationId);
      adjacency.get(edge.fromLocationId)!.add(edge.toLocationId);
      adjacency.get(edge.toLocationId)!.add(edge.fromLocationId);
    }

    // BFS from first macro location
    const startId = macroLocations[0].id;
    const visited = new Set<string>();
    const queue: string[] = [startId];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const neighbors = adjacency.get(current);
      if (!neighbors) continue;
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          queue.push(neighbor);
        }
      }
    }

    const unreachable = macroLocations
      .map((loc) => loc.id)
      .filter((id) => !visited.has(id));

    if (unreachable.length > 0) {
      console.warn(
        `Transport graph is NOT fully connected. Unreachable macro locations: ${unreachable.join(", ")}`
      );
    }
  }
}
