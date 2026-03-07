/**
 * Clue Placement Agent - Distributes clues across scenes and NPCs (Phase 10)
 *
 * This is the final step of the inverted generation pipeline. The physical
 * world (scenes) and characters (NPCs) have already been created. This agent
 * takes the truth timeline, knowledge matrix, NPCs, and existing scenes, then
 * distributes investigative clues to scenes and NPCs.
 *
 * Scene clues are physical/documentary/environmental evidence placed in rooms.
 * NPC clues are knowledge/observations/rumors/secrets that NPCs can reveal.
 */

import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../models/index.js";
import type { NPCClue } from "../../shared/agents/models/gameTypes.js";
import type { ScenarioClue } from "../../shared/agents/models/scenarioTypes.js";
import {
  buildCluePlacementPrompt,
  type CluePlacementParams,
} from "./cluePlacementTemplate.js";
import type {
  DynamicNPCProfile,
  DynamicScene,
  KnowledgeHolder,
  ProgressCallback,
  ScenarioOutline,
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

/** Valid scene clue categories */
const SCENE_CLUE_CATEGORIES = new Set([
  "physical",
  "witness",
  "document",
  "environment",
  "knowledge",
  "observation",
]);

/** Valid NPC clue categories */
const NPC_CLUE_CATEGORIES = new Set([
  "knowledge",
  "observation",
  "rumor",
  "secret",
]);

/** Valid difficulty levels (ScenarioClue supports "automatic"; NPCClue Difficulty does not) */
const SCENE_DIFFICULTIES = new Set([
  "automatic",
  "regular",
  "hard",
  "extreme",
]);
const NPC_DIFFICULTIES = new Set(["regular", "hard", "extreme"]);

export class CluePlacementAgent {
  private runtime: Runtime;

  constructor() {
    this.runtime = createRuntime();
  }

  /**
   * Phase 10: Distribute clues across scenes and NPCs.
   * Mutates scene.clues and npc.clues in-place.
   *
   * @param truthTimeline - Objective events that happened
   * @param knowledgeMatrix - Who/what knows or contains evidence
   * @param scenes - All generated scenes (Map keyed by scene ID)
   * @param npcs - All generated NPCs
   * @param scenarios - Macro locations (ScenarioOutline[])
   * @param progressCallback - Optional progress reporting
   */
  async placeClues(
    truthTimeline: TruthEvent[],
    knowledgeMatrix: KnowledgeHolder[],
    scenes: Map<string, DynamicScene>,
    npcs: DynamicNPCProfile[],
    scenarios: ScenarioOutline[],
    progressCallback?: ProgressCallback
  ): Promise<void> {
    progressCallback?.("Distributing clues across scenes and NPCs...");

    // Build prompt params
    const sceneList: CluePlacementParams["scenes"] = [];
    for (const scene of scenes.values()) {
      sceneList.push({
        id: scene.id,
        name: scene.name,
        description: scene.description,
        parentLocationId: scene.parentLocationId,
      });
    }

    const npcList: CluePlacementParams["npcs"] = npcs.map((npc) => ({
      id: npc.id,
      name: npc.name,
      residence: npc.residence,
      instantiatedFrom: npc.instantiatedFrom,
    }));

    const macroLocations: CluePlacementParams["macroLocations"] =
      scenarios.map((s) => ({
        id: s.id,
        name: s.name,
        description: s.description,
      }));

    const promptParams: CluePlacementParams = {
      truthTimeline: truthTimeline.map((t) => ({
        id: t.id,
        time: t.time,
        event: t.event,
        mythosInvolved: t.mythosInvolved,
      })),
      knowledgeMatrix: knowledgeMatrix.map((k) => ({
        id: k.id,
        holderType: k.holderType,
        holderName: k.holderName,
        knows: k.knows,
        containsEvidence: k.containsEvidence,
      })),
      scenes: sceneList,
      npcs: npcList,
      macroLocations,
    };

    const prompt = buildCluePlacementPrompt(promptParams);

    progressCallback?.("Calling AI for clue placement...");
    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
    });

    // Parse and validate response
    let sceneCluesRaw: Array<{
      sceneId: string;
      clues: Array<Record<string, unknown>>;
    }>;
    let npcCluesRaw: Array<{
      npcId: string;
      clues: Array<Record<string, unknown>>;
    }>;

    try {
      const parsed = parseJSONResponse(response);
      sceneCluesRaw = Array.isArray(parsed.sceneClues)
        ? parsed.sceneClues
        : [];
      npcCluesRaw = Array.isArray(parsed.npcClues) ? parsed.npcClues : [];
    } catch (error) {
      console.error("Failed to parse clue placement response:", error);
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to parse clue placement: ${(error as Error).message}`
      );
    }

    // Valid truth event IDs for validation
    const truthEventIds = new Set(truthTimeline.map((t) => t.id));

    // Distribute scene clues
    let totalSceneClues = 0;
    for (const entry of sceneCluesRaw) {
      const scene = scenes.get(entry.sceneId);
      if (!scene) {
        console.warn(
          `[CluePlacement] Scene clue references unknown scene "${entry.sceneId}", skipping.`
        );
        continue;
      }

      const cluesArray = Array.isArray(entry.clues) ? entry.clues : [];
      for (const raw of cluesArray) {
        const clueText =
          typeof raw.clueText === "string" ? raw.clueText : null;
        if (!clueText) {
          console.warn(
            `[CluePlacement] Scene clue in "${entry.sceneId}" missing clueText, skipping.`
          );
          continue;
        }

        const category = SCENE_CLUE_CATEGORIES.has(raw.category as string)
          ? (raw.category as ScenarioClue["category"])
          : "environment";

        const difficulty = SCENE_DIFFICULTIES.has(raw.difficulty as string)
          ? (raw.difficulty as ScenarioClue["difficulty"])
          : "regular";

        const reveals = Array.isArray(raw.reveals)
          ? (raw.reveals as string[]).filter((id) => truthEventIds.has(id))
          : [];

        const discoveryMethod =
          typeof raw.discoveryMethod === "string"
            ? raw.discoveryMethod
            : undefined;

        const clue: ScenarioClue = {
          id: `clue-${entry.sceneId}-${scene.clues.length + 1}`,
          clueText,
          category,
          difficulty,
          location: scene.name,
          discoveryMethod,
          reveals,
          discovered: false,
        };

        scene.clues.push(clue);
        totalSceneClues++;
      }
    }

    // Distribute NPC clues
    const npcById = new Map(npcs.map((npc) => [npc.id, npc]));
    let totalNpcClues = 0;

    for (const entry of npcCluesRaw) {
      const npc = npcById.get(entry.npcId);
      if (!npc) {
        console.warn(
          `[CluePlacement] NPC clue references unknown NPC "${entry.npcId}", skipping.`
        );
        continue;
      }

      const cluesArray = Array.isArray(entry.clues) ? entry.clues : [];
      for (const raw of cluesArray) {
        const clueText =
          typeof raw.clueText === "string" ? raw.clueText : null;
        if (!clueText) {
          console.warn(
            `[CluePlacement] NPC clue for "${entry.npcId}" missing clueText, skipping.`
          );
          continue;
        }

        const category = NPC_CLUE_CATEGORIES.has(raw.category as string)
          ? (raw.category as NPCClue["category"])
          : "knowledge";

        const difficulty = NPC_DIFFICULTIES.has(raw.difficulty as string)
          ? (raw.difficulty as NPCClue["difficulty"])
          : "regular";

        const relatedTo = Array.isArray(raw.relatedTo)
          ? (raw.relatedTo as string[]).filter((id) => truthEventIds.has(id))
          : [];

        const clue: NPCClue = {
          id: `clue-${entry.npcId}-${npc.clues.length + 1}`,
          clueText,
          category,
          difficulty,
          revealed: false,
          relatedTo,
        };

        npc.clues.push(clue);
        totalNpcClues++;
      }
    }

    // Coverage report
    const scenesWithClues = Array.from(scenes.values()).filter(
      (s) => s.clues.length > 0
    ).length;
    const npcsWithClues = npcs.filter((n) => n.clues.length > 0).length;

    // Check truth event coverage
    const coveredBySceneClues = new Set<string>();
    for (const scene of scenes.values()) {
      for (const clue of scene.clues) {
        for (const eventId of clue.reveals || []) {
          coveredBySceneClues.add(eventId);
        }
      }
    }
    const coveredByNpcClues = new Set<string>();
    for (const npc of npcs) {
      for (const clue of npc.clues) {
        for (const eventId of clue.relatedTo || []) {
          coveredByNpcClues.add(eventId);
        }
      }
    }
    const allCoveredEvents = new Set([
      ...coveredBySceneClues,
      ...coveredByNpcClues,
    ]);
    const uncoveredEvents = truthTimeline
      .map((t) => t.id)
      .filter((id) => !allCoveredEvents.has(id));

    if (uncoveredEvents.length > 0) {
      console.warn(
        `[CluePlacement] Truth events with no clue coverage: ${uncoveredEvents.join(", ")}`
      );
    }

    console.log(
      `[CluePlacement] Placed ${totalSceneClues} scene clues across ${scenesWithClues}/${scenes.size} scenes`
    );
    console.log(
      `[CluePlacement] Placed ${totalNpcClues} NPC clues across ${npcsWithClues}/${npcs.length} NPCs`
    );
    console.log(
      `[CluePlacement] Truth event coverage: ${allCoveredEvents.size}/${truthTimeline.length} events`
    );

    progressCallback?.(
      `Clue placement complete: ${totalSceneClues} scene clues, ${totalNpcClues} NPC clues across ${allCoveredEvents.size}/${truthTimeline.length} truth events.`
    );
  }
}
