/**
 * Macro Scene Agent - Generates world structure truth-first
 * Implements 5-step generation following instruction.md specification
 */

import {
  generateText,
  ModelClass,
  ModelProviderName,
} from "../../models/index.js";
import { composeTemplate } from "../../template.js";
import type {
  MacroSceneStructure,
  MacroSceneSettingType,
  TruthEvent,
  KnowledgeHolder,
  RedHerring,
  MythosEvent,
  EndStateDefinition,
  ProgressCallback,
} from "./types.js";
import type { StoryLength } from "./storyLengthConfig.js";
import {
  getMacroSceneStep1Template,
  getHistoricalMythosTemplateForSetting,
  getTruthTimelineTemplateForSetting,
  getKnowledgeMatrixTemplate,
  getRedHerringsTemplate,
  getEndStateTemplate,
} from "./macroSceneTemplate.js";

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
    response.match(/\{[\s\S]*\}/)?.[0];

  if (!jsonText) {
    throw new Error("Failed to extract JSON from response");
  }

  return JSON.parse(jsonText);
}

export class MacroSceneAgent {
  private static readonly GOOGLE_PHASE1_TEMPERATURE = 1.2;
  private runtime: Runtime;

  constructor() {
    this.runtime = createRuntime();
  }

  private getPhaseOneTemperature(): number | undefined {
    if (this.runtime.modelProvider === ModelProviderName.GOOGLE) {
      return MacroSceneAgent.GOOGLE_PHASE1_TEMPERATURE;
    }
    return undefined;
  }

  /**
   * Step 1: Generate macro scene structure (setting-adaptive)
   */
  async generateTownStructure(
    settingType: MacroSceneSettingType = "small_town",
    creativePrompt: string,
    progressCallback?: ProgressCallback,
    storyLength: StoryLength = "medium"
  ): Promise<MacroSceneStructure> {
    progressCallback?.(`Generating ${settingType} structure...`);

    const template = getMacroSceneStep1Template(settingType, storyLength);
    const prompt = composeTemplate(
      template,
      {},
      {
        userPrompt: creativePrompt,
      }
    );

    progressCallback?.("Calling AI for town structure...");
    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
      temperature: this.getPhaseOneTemperature(),
    });

    try {
      const parsed = parseJSONResponse(response);
      const macroScene = parsed.macroScene || parsed;

      // Validate required fields
      if (!macroScene.locationName) {
        throw new Error("Missing required field: locationName");
      }

      progressCallback?.(
        `Setting structure generated: ${macroScene.locationName}`
      );
      return macroScene as MacroSceneStructure;
    } catch (error) {
      console.error("Failed to parse macro scene response:", error);
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to generate town structure: ${(error as Error).message}`
      );
    }
  }

  /**
   * Step 2: Generate historical mythos layer
   */
  async generateHistoricalMythos(
    macroScene: MacroSceneStructure,
    creativePrompt: string,
    progressCallback?: ProgressCallback
  ): Promise<MythosEvent[]> {
    progressCallback?.("Generating historical mythos layer...");

    const template = getHistoricalMythosTemplateForSetting(
      macroScene.settingType ?? "small_town"
    );
    const prompt = composeTemplate(
      template,
      {},
      {
        macroSceneJson: JSON.stringify(macroScene, null, 2),
        userPrompt: creativePrompt,
      }
    );

    progressCallback?.("Calling AI for historical mythos...");
    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
      temperature: this.getPhaseOneTemperature(),
    });

    try {
      const parsed = parseJSONResponse(response);
      const mythosEvents = parsed.mythosEvents || parsed;

      if (!Array.isArray(mythosEvents)) {
        throw new Error("Mythos events must be an array");
      }

      progressCallback?.(
        `Historical mythos layer generated: ${mythosEvents.length} events`
      );
      return mythosEvents as MythosEvent[];
    } catch (error) {
      console.error("Failed to parse historical mythos response:", error);
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to generate historical mythos: ${(error as Error).message}`
      );
    }
  }

  /**
   * Step 3: Generate truth timeline (current events, NO names)
   */
  async generateTruthTimeline(
    macroScene: MacroSceneStructure,
    mythosEvents: MythosEvent[],
    creativePrompt: string,
    progressCallback?: ProgressCallback,
    storyLength: StoryLength = "medium"
  ): Promise<TruthEvent[]> {
    progressCallback?.("Generating truth timeline (current events)...");

    const template = getTruthTimelineTemplateForSetting(
      macroScene.settingType ?? "small_town",
      storyLength
    );
    const prompt = composeTemplate(
      template,
      {},
      {
        macroSceneJson: JSON.stringify(macroScene, null, 2),
        mythosEventsJson: JSON.stringify(mythosEvents, null, 2),
        userPrompt: creativePrompt,
      }
    );

    progressCallback?.("Calling AI for truth timeline...");
    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
      temperature: this.getPhaseOneTemperature(),
    });

    try {
      const parsed = parseJSONResponse(response);
      const truthEvents = parsed.truthEvents || parsed;

      if (!Array.isArray(truthEvents)) {
        throw new Error("Truth timeline must be an array");
      }

      // Validate no names in events
      for (const event of truthEvents) {
        if (!event.id || !event.event) {
          throw new Error("Truth event missing required fields (id, event)");
        }
      }

      progressCallback?.(
        `Truth timeline generated: ${truthEvents.length} events`
      );
      return truthEvents as TruthEvent[];
    } catch (error) {
      console.error("Failed to parse truth timeline response:", error);
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to generate truth timeline: ${(error as Error).message}`
      );
    }
  }

  /**
   * Step 4: Generate knowledge matrix (who/what knows what)
   */
  async generateKnowledgeMatrix(
    macroScene: MacroSceneStructure,
    mythosEvents: MythosEvent[],
    truthTimeline: TruthEvent[],
    progressCallback?: ProgressCallback,
    storyLength: StoryLength = "medium"
  ): Promise<KnowledgeHolder[]> {
    progressCallback?.("Generating knowledge matrix (abstract holders)...");

    const template = getKnowledgeMatrixTemplate(storyLength);
    const prompt = composeTemplate(
      template,
      {},
      {
        macroSceneJson: JSON.stringify(macroScene, null, 2),
        mythosEventsJson: JSON.stringify(mythosEvents, null, 2),
        truthTimelineJson: JSON.stringify(truthTimeline, null, 2),
      }
    );

    progressCallback?.("Calling AI for knowledge matrix...");
    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
      temperature: this.getPhaseOneTemperature(),
    });

    try {
      const parsed = parseJSONResponse(response);
      const knowledgeHolders = parsed.knowledgeHolders || parsed;

      if (!Array.isArray(knowledgeHolders)) {
        throw new Error("Knowledge matrix must be an array");
      }

      // Add IDs if missing
      for (let i = 0; i < knowledgeHolders.length; i++) {
        if (!knowledgeHolders[i].id) {
          const prefix =
            knowledgeHolders[i].holderType?.substring(0, 4).toUpperCase() ||
            "KH";
          knowledgeHolders[i].id = `${prefix}_${i + 1}`;
        }
      }

      progressCallback?.(
        `Knowledge matrix generated: ${knowledgeHolders.length} holders`
      );
      return knowledgeHolders as KnowledgeHolder[];
    } catch (error) {
      console.error("Failed to parse knowledge matrix response:", error);
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to generate knowledge matrix: ${(error as Error).message}`
      );
    }
  }

  /**
   * Step 5: Generate red herrings (false but plausible explanations)
   */
  async generateRedHerrings(
    mythosEvents: MythosEvent[],
    truthTimeline: TruthEvent[],
    knowledgeMatrix: KnowledgeHolder[],
    progressCallback?: ProgressCallback,
    storyLength: StoryLength = "medium"
  ): Promise<RedHerring[]> {
    progressCallback?.("Generating red herrings (false trails)...");

    const template = getRedHerringsTemplate(storyLength);
    const prompt = composeTemplate(
      template,
      {},
      {
        mythosEventsJson: JSON.stringify(mythosEvents, null, 2),
        truthTimelineJson: JSON.stringify(truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(knowledgeMatrix, null, 2),
      }
    );

    progressCallback?.("Calling AI for red herrings...");
    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
      temperature: this.getPhaseOneTemperature(),
    });

    try {
      const parsed = parseJSONResponse(response);
      const redHerrings = parsed.redHerrings || parsed;

      if (!Array.isArray(redHerrings)) {
        throw new Error("Red herrings must be an array");
      }

      progressCallback?.(
        `Red herrings generated: ${redHerrings.length} false trails`
      );
      return redHerrings as RedHerring[];
    } catch (error) {
      console.error("Failed to parse red herrings response:", error);
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to generate red herrings: ${(error as Error).message}`
      );
    }
  }

  /**
   * Step 6: Generate end state definition
   */
  async generateEndState(
    macroScene: MacroSceneStructure,
    mythosEvents: MythosEvent[],
    truthTimeline: TruthEvent[],
    progressCallback?: ProgressCallback
  ): Promise<EndStateDefinition> {
    progressCallback?.("Generating end state definition...");

    const template = getEndStateTemplate();
    const prompt = composeTemplate(
      template,
      {},
      {
        macroSceneJson: JSON.stringify(macroScene, null, 2),
        mythosEventsJson: JSON.stringify(mythosEvents, null, 2),
        truthTimelineJson: JSON.stringify(truthTimeline, null, 2),
      }
    );

    progressCallback?.("Calling AI for end state...");
    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
      temperature: this.getPhaseOneTemperature(),
    });

    try {
      const parsed = parseJSONResponse(response);
      const endState = parsed.endState || parsed;

      if (!endState || !endState.summary) {
        throw new Error("End state missing required fields (summary)");
      }

      progressCallback?.("End state definition generated");
      return endState as EndStateDefinition;
    } catch (error) {
      console.error("Failed to parse end state response:", error);
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to generate end state: ${(error as Error).message}`
      );
    }
  }

  /**
   * Main entry point - runs all 6 steps sequentially
   */
  async generate(
    settingType: MacroSceneSettingType = "small_town",
    creativePrompt: string,
    progressCallback?: ProgressCallback
  ): Promise<{
    macroScene: MacroSceneStructure;
    mythosEvents: MythosEvent[];
    truthTimeline: TruthEvent[];
    knowledgeMatrix: KnowledgeHolder[];
    redHerrings: RedHerring[];
    endState: EndStateDefinition;
  }> {
    console.log(
      `\n🌍 [Macro Scene Agent] Starting world generation for ${settingType}...`
    );
    console.log(
      `   Creative Prompt: ${creativePrompt.substring(0, 100)}${creativePrompt.length > 100 ? "..." : ""}`
    );

    // Step 1: Setting structure (adaptive to setting type)
    const macroScene = await this.generateTownStructure(
      settingType,
      creativePrompt,
      progressCallback
    );

    // Step 2: Historical mythos layer (foundation for current events)
    const mythosEvents = await this.generateHistoricalMythos(
      macroScene,
      creativePrompt,
      progressCallback
    );

    // Step 3: Truth timeline (current events, influenced by historical mythos)
    const truthTimeline = await this.generateTruthTimeline(
      macroScene,
      mythosEvents,
      creativePrompt,
      progressCallback
    );

    // Step 4: Knowledge matrix
    const knowledgeMatrix = await this.generateKnowledgeMatrix(
      macroScene,
      mythosEvents,
      truthTimeline,
      progressCallback
    );

    // Step 5: Red herrings
    const redHerrings = await this.generateRedHerrings(
      mythosEvents,
      truthTimeline,
      knowledgeMatrix,
      progressCallback
    );

    // Step 6: End state
    const endState = await this.generateEndState(
      macroScene,
      mythosEvents,
      truthTimeline,
      progressCallback
    );

    console.log("✅ [Macro Scene Agent] World generation complete");
    console.log(`   Setting: ${macroScene.locationName} (${settingType})`);
    console.log(`   Historical mythos events: ${mythosEvents.length}`);
    console.log(`   Current truth events: ${truthTimeline.length}`);
    console.log(`   Knowledge holders: ${knowledgeMatrix.length}`);
    console.log(`   Red herrings: ${redHerrings.length}`);

    return {
      macroScene,
      mythosEvents,
      truthTimeline,
      knowledgeMatrix,
      redHerrings,
      endState,
    };
  }
}
