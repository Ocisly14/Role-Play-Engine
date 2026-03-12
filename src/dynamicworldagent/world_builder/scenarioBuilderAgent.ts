/**
 * Scenario Builder Agent - Generates scenario outlines from world structure
 * Uses knowledge matrix PLACE holders to define scenarios and connections
 */

import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../models/index.js";
import { composeTemplate } from "../../template.js";
import { generateSceneImageFromScene } from "../visual/sceneImage.js";
import type { ModuleSizeConfig } from "./moduleSizeConfig.js";
import {
  buildMacroLocationPrompt,
  getNpcAssignmentTemplate,
  getScenarioBuilderTemplate,
  getStartingSceneTemplate,
} from "./scenarioBuilderTemplate.js";
import type {
  DynamicNPCProfile,
  DynamicScene,
  KnowledgeHolder,
  MacroSceneStructure,
  ProgressCallback,
  ScenarioNpcAssignments,
  ScenarioOutline,
  StartingSceneSelection,
  StructuredStoryElements,
  TruthEvent,
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

export class ScenarioBuilderAgent {
  private runtime: Runtime;

  constructor() {
    this.runtime = createRuntime();
  }

  /**
   * Generate macro locations from setting + story premise (inverted pipeline).
   * Produces ScenarioOutline[] with id, name, description, and subSceneCount.
   * No clues, evidence, or NPC assignments — just physical locations.
   */
  async generateMacroLocations(
    macroScene: MacroSceneStructure,
    storyPremise: string,
    moduleSize: ModuleSizeConfig,
    storyElements?: StructuredStoryElements,
    progressCallback?: ProgressCallback
  ): Promise<ScenarioOutline[]> {
    progressCallback?.("Generating macro locations from setting + story premise...");

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
        settingParts.push(`Natural features: ${geo.naturalFeatures.join(", ")}`);
      }
      if (geo.artificialStructures?.length) {
        settingParts.push(`Structures: ${geo.artificialStructures.join(", ")}`);
      }
      if (geo.keyLocations?.length) {
        settingParts.push(`Key locations: ${geo.keyLocations.join(", ")}`);
      }
    }
    if (macroScene.economicCore) {
      settingParts.push(`Economic base: ${macroScene.economicCore}`);
    }
    if (storyElements) {
      settingParts.push(`Era: ${storyElements.era}`);
      settingParts.push(`Tone: ${storyElements.tone}`);
      settingParts.push(`Genre: ${storyElements.genre.join(", ")}`);
      if (storyElements.worldbuilding) {
        settingParts.push(`Worldbuilding: ${storyElements.worldbuilding}`);
      }
    }

    const settingDescription = settingParts.join("\n");

    const prompt = buildMacroLocationPrompt({
      settingDescription,
      storyPremise,
      macroLocationRange: moduleSize.macroLocationCount,
      subSceneRange: moduleSize.subSceneRange,
    });

    progressCallback?.("Calling AI for macro locations...");
    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
    });

    try {
      const parsed = parseJSONResponse(response);
      const locations: any[] = Array.isArray(parsed)
        ? parsed
        : parsed.locations || parsed.scenarios || [];

      if (!Array.isArray(locations) || locations.length === 0) {
        throw new Error("Response must contain a non-empty array of locations");
      }

      // Validate each location
      const scenarios: ScenarioOutline[] = [];
      for (let i = 0; i < locations.length; i++) {
        const loc = locations[i];

        if (!loc.id || !loc.name || !loc.description) {
          console.warn(
            `Macro location at index ${i} missing required fields (id/name/description), skipping.`
          );
          continue;
        }

        const subSceneCount =
          typeof loc.subSceneCount === "number" && loc.subSceneCount >= 1
            ? loc.subSceneCount
            : moduleSize.subSceneRange[0];

        scenarios.push({
          id: loc.id,
          name: loc.name,
          description: loc.description,
          subSceneCount,
        });
      }

      if (scenarios.length === 0) {
        throw new Error("No valid macro locations after validation");
      }

      progressCallback?.(
        `Macro locations generated: ${scenarios.length} locations`
      );
      return scenarios;
    } catch (error) {
      console.error("Failed to parse macro location response:", error);
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to generate macro locations: ${(error as Error).message}`
      );
    }
  }

  /**
   * @deprecated Use generateMacroLocations() instead. This method relies on
   * truth timeline + knowledge matrix which don't exist yet in the inverted pipeline.
   */
  async generate(
    macroScene: MacroSceneStructure,
    truthTimeline: TruthEvent[],
    knowledgeMatrix: KnowledgeHolder[],
    storyElements?: StructuredStoryElements,
    progressCallback?: ProgressCallback
  ): Promise<ScenarioOutline[]> {
    progressCallback?.("Generating scenario outlines from place holders...");

    const placeNames = knowledgeMatrix
      .filter((holder) => holder.holderType === "PLACE")
      .map((holder) => holder.holderName.trim())
      .filter(Boolean);
    const placeEvidence = knowledgeMatrix
      .filter((holder) => holder.holderType === "PLACE")
      .map((holder) => ({
        holderName: holder.holderName.trim(),
        containsEvidence: holder.containsEvidence || [],
      }))
      .filter((holder) => holder.holderName);

    const template = getScenarioBuilderTemplate();
    const prompt = composeTemplate(
      template,
      {},
      {
        macroSceneJson: JSON.stringify(macroScene, null, 2),
        truthTimelineJson: JSON.stringify(truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(knowledgeMatrix, null, 2),
        storyElements: storyElements
          ? JSON.stringify(storyElements, null, 2)
          : "",
      }
    );

    progressCallback?.("Calling AI for scenario outlines...");
    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
    });

    try {
      const parsed = parseJSONResponse(response);
      const scenarios = parsed.scenarios || parsed;

      if (!Array.isArray(scenarios)) {
        throw new Error("Scenarios must be an array");
      }

      const scenarioNames = scenarios
        .map((scenario: ScenarioOutline) => scenario?.name?.trim())
        .filter(Boolean);
      const missingPlaces = placeNames.filter(
        (placeName) =>
          !scenarioNames.some(
            (name) => name.toLowerCase() === placeName.toLowerCase()
          )
      );

      if (missingPlaces.length > 0) {
        console.warn(
          `Scenario coverage missing PLACE holders: ${missingPlaces.join(", ")}`
        );
      }

      // Ensure sourcePlaceId and sourcePlaceName are set for scenarios matching PLACE holders
      const placeHolderMap = new Map(
        knowledgeMatrix
          .filter((holder) => holder.holderType === "PLACE")
          .map((holder) => [holder.holderName.trim().toLowerCase(), holder])
      );

      for (const scenario of scenarios as ScenarioOutline[]) {
        const scenarioName = scenario?.name?.trim();
        if (!scenarioName) continue;

        // Find matching PLACE holder by name
        const matchingHolder = placeHolderMap.get(scenarioName.toLowerCase());
        if (matchingHolder) {
          // Ensure sourcePlaceId and sourcePlaceName are set
          if (!scenario.sourcePlaceId) {
            scenario.sourcePlaceId = matchingHolder.id;
            console.log(
              `  ✓ Auto-assigned sourcePlaceId "${matchingHolder.id}" to scenario "${scenarioName}"`
            );
          }
          if (!scenario.sourcePlaceName) {
            scenario.sourcePlaceName = matchingHolder.holderName;
          }
        } else if (!scenario.sourcePlaceId) {
          // Connector scenarios may not have a PLACE holder match
          console.warn(
            `  ⚠️  Scenario "${scenarioName}" has no sourcePlaceId and doesn't match any PLACE holder`
          );
        }
      }

      for (const place of placeEvidence) {
        if (place.containsEvidence.length === 0) continue;
        const scenario = (scenarios as ScenarioOutline[]).find(
          (entry) =>
            entry.name?.trim().toLowerCase() === place.holderName.toLowerCase()
        );
        if (!scenario) continue;
        const scenarioEvidence = (scenario as any).evidence || [];
        const missingEvidence = place.containsEvidence.filter(
          (evidence) =>
            !scenarioEvidence.some(
              (entry: any) =>
                entry.trim().toLowerCase() === evidence.trim().toLowerCase()
            )
        );
        if (missingEvidence.length > 0) {
          console.warn(
            `Scenario "${scenario.name}" missing evidence from PLACE holder: ${missingEvidence.join(", ")}`
          );
        }

        const scenarioClues = (scenario as any).clues || [];
        const missingClues = place.containsEvidence.filter((evidence) => {
          const needle = evidence.trim().toLowerCase();
          return !scenarioClues.some((clue: any) => {
            const clueText = clue?.clueText?.toLowerCase?.() || "";
            const evidenceRef = clue?.evidenceRef?.toLowerCase?.() || "";
            return clueText.includes(needle) || evidenceRef.includes(needle);
          });
        });
        if (missingClues.length > 0) {
          console.warn(
            `Scenario "${scenario.name}" clues do not expand evidence: ${missingClues.join(", ")}`
          );
        }
      }

      const scenarioNameSet = new Set(
        scenarioNames.map((name) => name.toLowerCase())
      );
      const invalidConnections: string[] = [];
      const adjacency = new Map<string, Set<string>>();

      for (const name of scenarioNames) {
        adjacency.set(name.toLowerCase(), new Set());
      }

      for (const scenario of scenarios as ScenarioOutline[]) {
        const sourceName = scenario?.name?.trim();
        if (!sourceName) continue;
        const clues = (scenario as any)?.clues || [];
        for (const clue of clues) {
          if (!clue?.clueText) {
            console.warn(`Scenario "${sourceName}" clue missing clueText`);
          }
        }
        const sourceKey = sourceName.toLowerCase();
        const connections = (scenario as any)?.connections || [];

        for (const connection of connections) {
          const targetName = connection?.scenarioName?.trim();
          if (!targetName) continue;
          const targetKey = targetName.toLowerCase();

          if (!scenarioNameSet.has(targetKey)) {
            invalidConnections.push(`${sourceName} -> ${targetName}`);
            continue;
          }

          adjacency.get(sourceKey)?.add(targetKey);
          adjacency.get(targetKey)?.add(sourceKey);
        }
      }

      if (invalidConnections.length > 0) {
        console.warn(
          `Scenario connections reference unknown names: ${invalidConnections.join(", ")}`
        );
      }

      if (scenarioNames.length > 1) {
        const withoutConnections = scenarioNames.filter((name) => {
          const key = name.toLowerCase();
          return (adjacency.get(key)?.size ?? 0) === 0;
        });

        if (withoutConnections.length > 0) {
          console.warn(
            `Scenario connectivity missing links for: ${withoutConnections.join(", ")}`
          );
        }

        const visited = new Set<string>();
        const queue: string[] = [scenarioNames[0].toLowerCase()];

        while (queue.length > 0) {
          const current = queue.shift();
          if (!current || visited.has(current)) continue;
          visited.add(current);
          const neighbors = adjacency.get(current);
          if (!neighbors) continue;
          for (const neighbor of neighbors) {
            if (!visited.has(neighbor)) {
              queue.push(neighbor);
            }
          }
        }

        const disconnected = scenarioNames.filter(
          (name) => !visited.has(name.toLowerCase())
        );

        if (disconnected.length > 0) {
          console.warn(
            `Scenario graph is disconnected; unreachable: ${disconnected.join(", ")}`
          );
        }
      }

      progressCallback?.(
        `Scenario outlines generated: ${scenarios.length} entries`
      );
      return scenarios as ScenarioOutline[];
    } catch (error) {
      console.error("Failed to parse scenario builder response:", error);
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to generate scenarios: ${(error as Error).message}`
      );
    }
  }

  /**
   * Phase 4a: Select starting scene and generate scene (NO NPC assignments)
   * @deprecated Starting scene selection moves to a later phase in the inverted pipeline.
   */
  async generateStartingScene(
    macroScene: MacroSceneStructure,
    truthTimeline: TruthEvent[],
    knowledgeMatrix: KnowledgeHolder[],
    scenarios: ScenarioOutline[],
    storyElements?: StructuredStoryElements,
    progressCallback?: ProgressCallback
  ): Promise<StartingSceneSelection> {
    progressCallback?.("Selecting starting scene and generating scene...");

    const template = getStartingSceneTemplate();
    const prompt = composeTemplate(
      template,
      {},
      {
        macroSceneJson: JSON.stringify(macroScene, null, 2),
        truthTimelineJson: JSON.stringify(truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(knowledgeMatrix, null, 2),
        scenariosJson: JSON.stringify(scenarios, null, 2),
        storyElements: storyElements
          ? JSON.stringify(storyElements, null, 2)
          : "",
      }
    );

    progressCallback?.("Calling AI for starting scene...");
    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
    });

    try {
      const parsed = parseJSONResponse(response);
      const startingScene = parsed.startingScene as
        | StartingSceneSelection
        | undefined;

      if (!startingScene) {
        console.warn("Missing startingScene; falling back to first scenario.");
      }

      const scenarioById = new Map(
        scenarios.map((scenario) => [scenario.id, scenario])
      );
      const scenarioByName = new Map(
        scenarios.map((scenario) => [scenario.name.toLowerCase(), scenario])
      );

      const selectedScenario =
        (startingScene?.scenarioId &&
          scenarioById.get(startingScene.scenarioId)) ||
        (startingScene?.scenarioName &&
          scenarioByName.get(startingScene.scenarioName.toLowerCase())) ||
        scenarios[0];

      if (!selectedScenario) {
        throw new Error("No scenarios available to select starting scene.");
      }

      // Build scene from LLM output, falling back to scenario outline defaults
      const parsedScene = (startingScene as any)?.scene;
      const scene: DynamicScene = {
        id: selectedScenario.id,
        name: selectedScenario.name,
        description: parsedScene?.description || selectedScenario.description,
        parentLocationId: parsedScene?.parentLocationId || "",
        connections: parsedScene?.connections || [],
        items: parsedScene?.items || [],
        clues: (parsedScene?.clues || []).map((c: any) => ({
          id: c.id || `clue_${crypto.randomUUID().slice(0, 8)}`,
          clueText: c.clueText || "Unspecified clue",
          category: c.category || "environment",
          difficulty: c.difficulty || "regular",
          location: c.location || selectedScenario.name,
          discovered: false,
        })),
        conditions: parsedScene?.conditions || [],
        sceneImage: undefined,
      };

      // Enforce starting scene identity to match the selected scenario exactly.
      if (scene.id !== selectedScenario.id) {
        console.warn(
          `Starting scene id "${scene.id}" does not match scenario id "${selectedScenario.id}", overriding.`
        );
        scene.id = selectedScenario.id;
      }
      if (scene.name !== selectedScenario.name) {
        console.warn(
          `Starting scene name "${scene.name}" does not match scenario "${selectedScenario.name}", overriding.`
        );
        scene.name = selectedScenario.name;
      }

      for (const condition of scene.conditions) {
        if (!condition.type || !condition.description) {
          console.warn("Scene condition missing type/description");
        }
      }

      // Generate scene image if available
      if (process.env.GOOGLE_API_KEY) {
        progressCallback?.("Generating starting scene image...");
        try {
          const imageResult = await generateSceneImageFromScene(
            scene,
            macroScene.moduleName
          );
          if (imageResult) {
            scene.sceneImage = {
              path: imageResult.path,
              mimeType: imageResult.mimeType,
              generatedAt: new Date().toISOString(),
            };
            progressCallback?.("Starting scene image generated.");
          }
        } catch (error) {
          console.warn("Failed to generate starting scene image:", error);
        }
      }

      progressCallback?.(
        `Starting scene generated: ${selectedScenario.name}`
      );

      return {
        scenarioId: selectedScenario.id,
        scenarioName: selectedScenario.name,
        scene,
      };
    } catch (error) {
      console.error("Failed to parse starting scene response:", error);
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to generate starting scene: ${(error as Error).message}`
      );
    }
  }

  /**
   * Phase 4b: Assign all NPCs to scenarios
   * @deprecated NPC assignment moves to a later phase in the inverted pipeline.
   */
  async assignNpcsToScenarios(
    startingScene: StartingSceneSelection,
    scenarios: ScenarioOutline[],
    npcs: DynamicNPCProfile[],
    storyElements?: StructuredStoryElements,
    progressCallback?: ProgressCallback
  ): Promise<{
    startingSceneCharacters: Array<{
      id: string;
      name: string;
      role: string;
      status: string;
      location?: string;
      notes?: string;
    }>;
    otherScenarioNpcAssignments: ScenarioNpcAssignments[];
  }> {
    progressCallback?.("Assigning NPCs to scenarios...");

    const template = getNpcAssignmentTemplate();
    const prompt = composeTemplate(
      template,
      {},
      {
        startingSceneJson: JSON.stringify(
          {
            scenarioId: startingScene.scenarioId,
            scenarioName: startingScene.scenarioName,
          },
          null,
          2
        ),
        scenariosJson: JSON.stringify(scenarios, null, 2),
        storyElements: storyElements
          ? JSON.stringify(storyElements, null, 2)
          : "",
        npcsJson: JSON.stringify(
          npcs.map((npc) => ({
            id: npc.id,
            name: npc.name,
            occupation: npc.occupation,
            age: npc.age,
            gender: npc.gender,
            appearance: npc.appearance,
            personality: npc.personality,
            background: npc.background,
            goals: npc.goals,
            secrets: npc.secrets,
          })),
          null,
          2
        ),
      }
    );

    progressCallback?.("Calling AI for NPC assignments...");
    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
    });

    try {
      const parsed = parseJSONResponse(response);
      const startingSceneCharacters = Array.isArray(
        parsed.startingSceneCharacters
      )
        ? parsed.startingSceneCharacters
        : [];
      const otherScenarioNpcAssignments = Array.isArray(
        parsed.otherScenarioNpcAssignments
      )
        ? (parsed.otherScenarioNpcAssignments as ScenarioNpcAssignments[])
        : [];

      // Validate and reconcile
      const scenarioById = new Map(
        scenarios.map((scenario) => [scenario.id, scenario])
      );
      const scenarioByName = new Map(
        scenarios.map((scenario) => [scenario.name.toLowerCase(), scenario])
      );
      const npcById = new Map(npcs.map((npc) => [npc.id, npc]));
      const npcByName = new Map(
        npcs.map((npc) => [npc.name.toLowerCase(), npc])
      );
      const accountedNpcIds = new Set<string>();

      // Validate starting scene characters
      for (const char of startingSceneCharacters) {
        if (!char.id || !char.name || !char.role || !char.status) {
          console.warn(
            "Starting scene character missing id/name/role/status"
          );
        }
        const npc =
          (char.id && npcById.get(char.id)) ||
          (char.name && npcByName.get(char.name.toLowerCase()));
        if (!npc) {
          console.warn(
            `Starting scene character "${char.name}" does not match any NPC`
          );
          continue;
        }
        accountedNpcIds.add(npc.id);
      }

      // Validate other scenario assignments
      const nonStartingScenarioIds = scenarios
        .filter((scenario) => scenario.id !== startingScene.scenarioId)
        .map((scenario) => scenario.id);
      const assignmentScenarioIds = new Set(
        otherScenarioNpcAssignments.map((a) => a.scenarioId)
      );

      const missingAssignments = nonStartingScenarioIds.filter(
        (id) => !assignmentScenarioIds.has(id)
      );
      if (missingAssignments.length > 0) {
        console.warn(
          `Other scenario assignments missing scenarios: ${missingAssignments.join(", ")}`
        );
      }

      for (const assignment of otherScenarioNpcAssignments) {
        const scenario =
          scenarioById.get(assignment.scenarioId) ||
          scenarioByName.get(assignment.scenarioName?.toLowerCase?.() ?? "");
        if (!scenario) {
          console.warn(
            `NPC assignment references unknown scenario "${assignment.scenarioId}" / "${assignment.scenarioName}"`
          );
          continue;
        }

        assignment.scenarioId = scenario.id;
        assignment.scenarioName = scenario.name;

        if (assignment.scenarioId === startingScene.scenarioId && assignment.npcs?.length) {
          console.warn("Starting scene NPCs assigned to other scenarios");
        }

        for (const npc of assignment.npcs || []) {
          if (!npc.id || !npc.name || !npc.activity) {
            console.warn("NPC assignment missing id, name, or activity");
          }
          if (accountedNpcIds.has(npc.id)) {
            console.warn(`NPC "${npc.name}" assigned multiple times`);
          }
          const npcMatch =
            npcById.get(npc.id) || npcByName.get(npc.name.toLowerCase());
          if (!npcMatch) {
            console.warn(`Assigned NPC "${npc.name}" does not match any NPC`);
            continue;
          }
          accountedNpcIds.add(npcMatch.id);
        }
      }

      const missingNpcs = npcs
        .map((npc) => npc.id)
        .filter((id) => !accountedNpcIds.has(id));
      if (missingNpcs.length > 0) {
        console.warn(
          `Not all NPCs assigned to scenarios: ${missingNpcs.join(", ")}`
        );
      }

      const completedAssignments = [
        ...otherScenarioNpcAssignments,
        ...missingAssignments.map((scenarioId) => {
          const scenario = scenarioById.get(scenarioId);
          return {
            scenarioId,
            scenarioName: scenario?.name || scenarioId,
            npcs: [],
          };
        }),
      ];

      progressCallback?.(
        `NPC assignment complete: ${startingSceneCharacters.length} in starting scene, ${accountedNpcIds.size - startingSceneCharacters.length} elsewhere`
      );

      return {
        startingSceneCharacters,
        otherScenarioNpcAssignments: completedAssignments,
      };
    } catch (error) {
      console.error("Failed to parse NPC assignment response:", error);
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to assign NPCs to scenarios: ${(error as Error).message}`
      );
    }
  }
}
