/**
 * Scenario Builder Agent - Generates scenario outlines from world structure
 * Uses knowledge matrix PLACE holders to define scenarios and connections
 */

import {
  generateText,
  ModelClass,
  ModelProviderName,
} from "../../models/index.js";
import { composeTemplate } from "../../template.js";
import type {
  MacroSceneStructure,
  TruthEvent,
  KnowledgeHolder,
  ScenarioOutline,
  StartingSceneSelection,
  ScenarioNpcAssignments,
  ProgressCallback,
} from "./types.js";
import {
  getScenarioBuilderTemplate,
  getStartingSceneSnapshotTemplate,
} from "./scenarioBuilderTemplate.js";
import type { DynamicNPCProfile } from "./types.js";
import { generateSceneImageFromSnapshot } from "../visual/sceneImage.js";

interface Runtime {
  modelProvider: ModelProviderName;
  getSetting: (key: string) => string | undefined;
}

const createRuntime = (): Runtime => ({
  modelProvider:
    (process.env.MODEL_PROVIDER as ModelProviderName) ||
    ModelProviderName.OPENAI,
  getSetting: (key: string) => process.env[key],
});

/**
 * Parse JSON from LLM response (handles markdown code blocks)
 */
function parseJSONResponse(response: string): any {
  const jsonText =
    response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ||
    response.match(/\{[\s\S]*\}/)?.[0];

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

  async generate(
    macroScene: MacroSceneStructure,
    truthTimeline: TruthEvent[],
    knowledgeMatrix: KnowledgeHolder[],
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
      }
    );

    progressCallback?.("Calling AI for scenario outlines...");
    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.LARGE,
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
        const scenarioEvidence = scenario.evidence || [];
        const missingEvidence = place.containsEvidence.filter(
          (evidence) =>
            !scenarioEvidence.some(
              (entry) =>
                entry.trim().toLowerCase() === evidence.trim().toLowerCase()
            )
        );
        if (missingEvidence.length > 0) {
          console.warn(
            `Scenario "${scenario.name}" missing evidence from PLACE holder: ${missingEvidence.join(", ")}`
          );
        }

        const scenarioClues = scenario.clues || [];
        const missingClues = place.containsEvidence.filter((evidence) => {
          const needle = evidence.trim().toLowerCase();
          return !scenarioClues.some((clue) => {
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
        const clues = scenario?.clues || [];
        for (const clue of clues) {
          if (!clue?.clueText) {
            console.warn(`Scenario "${sourceName}" clue missing clueText`);
          }
        }
        const sourceKey = sourceName.toLowerCase();
        const connections = scenario?.connections || [];

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

  async generateStartingSceneSnapshot(
    macroScene: MacroSceneStructure,
    truthTimeline: TruthEvent[],
    knowledgeMatrix: KnowledgeHolder[],
    scenarios: ScenarioOutline[],
    npcs: DynamicNPCProfile[],
    progressCallback?: ProgressCallback
  ): Promise<{
    startingScene: StartingSceneSelection;
    otherScenarioNpcAssignments: ScenarioNpcAssignments[];
  }> {
    progressCallback?.("Selecting starting scene and generating snapshot...");

    const template = getStartingSceneSnapshotTemplate();
    const prompt = composeTemplate(
      template,
      {},
      {
        macroSceneJson: JSON.stringify(macroScene, null, 2),
        truthTimelineJson: JSON.stringify(truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(knowledgeMatrix, null, 2),
        scenariosJson: JSON.stringify(scenarios, null, 2),
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

    progressCallback?.("Calling AI for starting scene snapshot...");
    const response = await generateText({
      runtime: this.runtime,
      context: prompt,
      modelClass: ModelClass.LARGE,
    });

    try {
      const parsed = parseJSONResponse(response);
      const startingScene = parsed.startingScene as
        | StartingSceneSelection
        | undefined;
      const otherScenarioNpcAssignments =
        (parsed.otherScenarioNpcAssignments as
          | ScenarioNpcAssignments[]
          | undefined) || [];

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

      const resolvedStartingScene: StartingSceneSelection = {
        scenarioId: selectedScenario.id,
        scenarioName: selectedScenario.name,
        selectionReason:
          startingScene?.selectionReason || "Fallback selection.",
        snapshot: startingScene?.snapshot as StartingSceneSelection["snapshot"],
      };

      const snapshot = resolvedStartingScene.snapshot || {
        id: `${selectedScenario.id}-snapshot`,
        name: selectedScenario.name,
        location: selectedScenario.name,
        description: selectedScenario.description,
        characters: [],
        clues: [],
        conditions: [],
        events: [],
      };

      snapshot.name = snapshot.name || selectedScenario.name;
      snapshot.id = snapshot.id || `${selectedScenario.id}-snapshot`;

      if (snapshot.name !== selectedScenario.name) {
        console.warn(
          `Starting snapshot name "${snapshot.name}" does not match scenario "${selectedScenario.name}"`
        );
      }

      snapshot.characters = Array.isArray(snapshot.characters)
        ? snapshot.characters
        : [];
      snapshot.clues = Array.isArray(snapshot.clues) ? snapshot.clues : [];
      snapshot.conditions = Array.isArray(snapshot.conditions)
        ? snapshot.conditions
        : [];

      for (const char of snapshot.characters) {
        if (!char.id || !char.name || !char.role || !char.status) {
          console.warn(
            "Scenario snapshot character missing id/name/role/status"
          );
        }
      }

      for (const clue of snapshot.clues) {
        if (!clue.id) {
          clue.id = `${snapshot.id}-clue-${Math.random().toString(36).slice(2, 8)}`;
        }
        if (!clue.clueText) {
          clue.clueText = "Unspecified clue";
        }
        clue.category = clue.category || "environment";
        clue.difficulty = clue.difficulty || "regular";
        clue.location = clue.location || snapshot.location;
        if (typeof clue.discovered !== "boolean") {
          clue.discovered = false;
        }
      }

      for (const condition of snapshot.conditions) {
        if (!condition.type || !condition.description) {
          console.warn("Scenario snapshot condition missing type/description");
        }
      }

      const npcById = new Map(npcs.map((npc) => [npc.id, npc]));
      const npcByName = new Map(
        npcs.map((npc) => [npc.name.toLowerCase(), npc])
      );
      const accountedNpcIds = new Set<string>();

      for (const char of snapshot.characters) {
        const npc =
          (char.id && npcById.get(char.id)) ||
          (char.name && npcByName.get(char.name.toLowerCase()));
        if (!npc) {
          console.warn(
            `Snapshot character "${char.name}" does not match any NPC`
          );
          continue;
        }
        accountedNpcIds.add(npc.id);
      }

      const nonStartingScenarioIds = scenarios
        .filter((scenario) => scenario.id !== selectedScenario.id)
        .map((scenario) => scenario.id);
      const assignmentScenarioIds = new Set(
        otherScenarioNpcAssignments.map((assignment) => assignment.scenarioId)
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

        if (
          assignment.scenarioId === selectedScenario.id &&
          assignment.npcs?.length
        ) {
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

      progressCallback?.(
        `Starting scene snapshot generated: ${resolvedStartingScene.scenarioName}`
      );

      if (process.env.GOOGLE_API_KEY) {
        progressCallback?.("Generating starting scene image...");
        try {
          const imageResult = await generateSceneImageFromSnapshot(
            snapshot,
            macroScene.moduleName
          );
          if (imageResult) {
            snapshot.sceneImage = {
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

      return {
        startingScene: {
          ...resolvedStartingScene,
          snapshot,
        },
        otherScenarioNpcAssignments: completedAssignments,
      };
    } catch (error) {
      console.error("Failed to parse starting scene snapshot response:", error);
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to generate starting scene snapshot: ${(error as Error).message}`
      );
    }
  }
}
