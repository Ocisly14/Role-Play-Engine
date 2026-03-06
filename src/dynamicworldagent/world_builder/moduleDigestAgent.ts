/**
 * Module Digest Agent - Generates module notes, guidance, limitations, and introduction
 */

import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../models/index.js";
import { composeTemplate } from "../../template.js";
import { getModuleDigestTemplate } from "./moduleDigestTemplate.js";
import type {
  EndStateDefinition,
  KnowledgeHolder,
  MacroSceneStructure,
  ModuleDigest,
  ScenarioOutline,
  StartingSceneSelection,
  StructuredStoryElements,
  TruthEvent,
} from "./types.js";
import type { DynamicNPCProfile } from "./types.js";

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

const parseJSONResponse = (response: string): any => {
  const jsonText =
    response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ||
    response.match(/\{[\s\S]*\}/)?.[0];

  if (!jsonText) {
    throw new Error("Failed to extract JSON from response");
  }

  return JSON.parse(jsonText);
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Missing or invalid field: ${field}`);
  }
  return value;
};

export class ModuleDigestAgent {
  private runtime: Runtime;

  constructor() {
    this.runtime = createRuntime();
  }

  async generate(
    macroScene: MacroSceneStructure,
    truthTimeline: TruthEvent[],
    knowledgeMatrix: KnowledgeHolder[],
    npcs: DynamicNPCProfile[],
    scenarios: ScenarioOutline[],
    startingScene: StartingSceneSelection | null,
    storyElements: StructuredStoryElements,
    endState: EndStateDefinition,
    macroMapPath?: string
  ): Promise<ModuleDigest> {
    const template = getModuleDigestTemplate();
    const startingSceneId = startingScene?.scene?.id;
    const startingSceneName = startingScene?.scene?.name;
    const prompt = composeTemplate(
      template,
      {},
      {
        macroSceneJson: JSON.stringify(macroScene, null, 2),
        truthTimelineJson: JSON.stringify(truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(knowledgeMatrix, null, 2),
        npcsBriefJson: JSON.stringify(
          npcs.map((npc) => ({ id: npc.id, name: npc.name })),
          null,
          2
        ),
        sceneBriefJson: JSON.stringify(
          scenarios.map((scenario) => {
            if (startingScene && scenario.id === startingScene.scenarioId) {
              return {
                id: startingSceneId || scenario.id,
                name: startingSceneName || scenario.name,
              };
            }
            return { id: scenario.id, name: scenario.name };
          }),
          null,
          2
        ),
        initialSceneJson: JSON.stringify(
          startingScene?.scene ?? null,
          null,
          2
        ),
        storyElements: JSON.stringify(storyElements, null, 2),
        endStateJson: JSON.stringify(endState, null, 2),
      }
    );

    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
    });

    const parsed = parseJSONResponse(response);
    return {
      moduleNotes: requireString(parsed.moduleNotes, "moduleNotes"),
      keeperGuidance: requireString(parsed.keeperGuidance, "keeperGuidance"),
      moduleLimitations: requireString(
        parsed.moduleLimitations,
        "moduleLimitations"
      ),
      introduction: requireString(parsed.introduction, "introduction"),
      macroMapPath: macroMapPath || undefined,
      globalTrigger: parsed.globalTrigger || undefined,
      victoryTrigger: parsed.victoryTrigger || undefined,
    };
  }
}
