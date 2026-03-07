/**
 * Macro Scene Agent - Generates world structure truth-first
 * Implements 5-step generation following instruction.md specification
 */

import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../models/index.js";
import { composeTemplate } from "../../template.js";
import {
  buildStoryPremisePrompt,
  getEndStateTemplate,
  getHistoricalMythosTemplateForSetting,
  getKnowledgeMatrixTemplate,
  getMacroSceneStep1Template,
  getRedHerringsTemplate,
  getTruthTimelineTemplateForSetting,
} from "./macroSceneTemplate.js";
import type { StoryLength } from "./storyLengthConfig.js";
import type {
  DynamicScene,
  EndStateDefinition,
  KnowledgeHolder,
  MacroSceneSettingType,
  MacroSceneStructure,
  MythosEvent,
  ProgressCallback,
  RedHerring,
  ScenarioOutline,
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
    storyElements: StructuredStoryElements,
    progressCallback?: ProgressCallback,
    storyLength: StoryLength = "medium"
  ): Promise<MacroSceneStructure> {
    progressCallback?.(`Generating ${settingType} structure...`);

    const template = getMacroSceneStep1Template(settingType, storyLength);
    const prompt = composeTemplate(
      template,
      {},
      {
        storyElements: JSON.stringify(storyElements, null, 2),
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
    storyElements: StructuredStoryElements,
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
        storyElements: JSON.stringify(storyElements, null, 2),
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
    storyElements: StructuredStoryElements,
    progressCallback?: ProgressCallback,
    storyLength: StoryLength = "medium",
    scenesContext?: string
  ): Promise<TruthEvent[]> {
    progressCallback?.("Generating truth timeline (current events)...");

    const template = getTruthTimelineTemplateForSetting(
      macroScene.settingType ?? "small_town",
      storyLength,
      scenesContext
    );
    const prompt = composeTemplate(
      template,
      {},
      {
        macroSceneJson: JSON.stringify(macroScene, null, 2),
        mythosEventsJson: JSON.stringify(mythosEvents, null, 2),
        storyElements: JSON.stringify(storyElements, null, 2),
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
    storyElements: StructuredStoryElements,
    progressCallback?: ProgressCallback,
    storyLength: StoryLength = "medium",
    scenesContext?: string
  ): Promise<KnowledgeHolder[]> {
    progressCallback?.("Generating knowledge matrix (abstract holders)...");

    const template = getKnowledgeMatrixTemplate(storyLength, scenesContext);
    const prompt = composeTemplate(
      template,
      {},
      {
        macroSceneJson: JSON.stringify(macroScene, null, 2),
        mythosEventsJson: JSON.stringify(mythosEvents, null, 2),
        truthTimelineJson: JSON.stringify(truthTimeline, null, 2),
        storyElements: JSON.stringify(storyElements, null, 2),
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
    storyElements: StructuredStoryElements,
    progressCallback?: ProgressCallback,
    storyLength: StoryLength = "medium",
    scenesContext?: string
  ): Promise<RedHerring[]> {
    progressCallback?.("Generating red herrings (false trails)...");

    const template = getRedHerringsTemplate(storyLength, scenesContext);
    const prompt = composeTemplate(
      template,
      {},
      {
        mythosEventsJson: JSON.stringify(mythosEvents, null, 2),
        truthTimelineJson: JSON.stringify(truthTimeline, null, 2),
        knowledgeMatrixJson: JSON.stringify(knowledgeMatrix, null, 2),
        storyElements: JSON.stringify(storyElements, null, 2),
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
    truthTimeline: TruthEvent[] | undefined,
    storyElements: StructuredStoryElements,
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
        truthTimelineJson: JSON.stringify(truthTimeline ?? [], null, 2),
        storyElements: JSON.stringify(storyElements, null, 2),
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
   * Generate a 1-2 paragraph story premise from the setting seed, mythos, and end state.
   * The premise describes the mystery and themes without detailed plot, NPCs, or clue specifics.
   */
  private async generateStoryPremise(
    macroScene: MacroSceneStructure,
    mythosEvents: MythosEvent[],
    endState: EndStateDefinition,
    storyElements?: StructuredStoryElements
  ): Promise<string> {
    const prompt = buildStoryPremisePrompt({
      macroScene,
      mythosEvents,
      endState,
      storyElements,
    });

    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.MEDIUM,
      temperature: this.getPhaseOneTemperature(),
    });

    // The response should be plain prose — strip any accidental markdown fencing
    return response
      .replace(/^```[\s\S]*?\n/, "")
      .replace(/\n```\s*$/, "")
      .trim();
  }

  /**
   * Phase 1 entry point — generates the setting seed (world structure, mythos, end state, premise).
   * Run BEFORE scenes are created. Produces the foundation that downstream scene builders consume.
   */
  async generateSettingSeed(
    settingType: MacroSceneSettingType = "small_town",
    creativePromptOrElements: string | StructuredStoryElements,
    progressCallback?: ProgressCallback
  ): Promise<{
    macroScene: MacroSceneStructure;
    mythosEvents: MythosEvent[];
    endState: EndStateDefinition;
    storyPremise: string;
  }> {
    const storyElements: StructuredStoryElements =
      typeof creativePromptOrElements === "string"
        ? {
            era: "",
            worldbuilding: "",
            genre: [],
            tone: "",
            theme: "",
            refinedPrompt: creativePromptOrElements,
          }
        : creativePromptOrElements;

    console.log(
      `\n[Macro Scene Agent] Starting setting seed generation for ${settingType}...`
    );

    // Step 1: Setting structure
    progressCallback?.("Phase 1/4: Generating setting structure...");
    const macroScene = await this.generateTownStructure(
      settingType,
      storyElements,
      progressCallback
    );

    // Step 2: Historical mythos layer
    progressCallback?.("Phase 2/4: Generating historical mythos...");
    const mythosEvents = await this.generateHistoricalMythos(
      macroScene,
      storyElements,
      progressCallback
    );

    // Step 3: End state (what happens if investigators don't intervene)
    progressCallback?.("Phase 3/4: Generating end state...");
    const endState = await this.generateEndState(
      macroScene,
      mythosEvents,
      undefined, // No truth timeline yet — that comes after scenes
      storyElements,
      progressCallback
    );

    // Step 4: Story premise (narrative seed)
    progressCallback?.("Phase 4/4: Generating story premise...");
    const storyPremise = await this.generateStoryPremise(
      macroScene,
      mythosEvents,
      endState,
      storyElements
    );

    console.log("[Macro Scene Agent] Setting seed generation complete");
    console.log(`   Setting: ${macroScene.locationName} (${settingType})`);
    console.log(`   Historical mythos events: ${mythosEvents.length}`);
    console.log(`   Story premise: ${storyPremise.substring(0, 80)}...`);

    return { macroScene, mythosEvents, endState, storyPremise };
  }

  /**
   * Build a textual summary of all existing scenes and macro locations
   * for injection into downstream prompts.
   */
  private buildScenesContext(
    scenarios: ScenarioOutline[],
    scenes: Map<string, DynamicScene>
  ): string {
    const lines: string[] = [];

    for (const scenario of scenarios) {
      lines.push(`### Macro Location: ${scenario.name} (id: ${scenario.id})`);
      lines.push(`   Description: ${scenario.description}`);

      // Collect sub-scenes belonging to this scenario
      const subScenes: DynamicScene[] = [];
      for (const scene of scenes.values()) {
        if (scene.parentLocationId === scenario.id) {
          subScenes.push(scene);
        }
      }

      if (subScenes.length > 0) {
        lines.push("   Sub-scenes:");
        for (const scene of subScenes) {
          lines.push(`     - ${scene.name} (id: ${scene.id}): ${scene.description}`);
        }
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * Phase 6-8 entry point — generates story-layer elements WITH scene context.
   * Run AFTER scenes and macro locations exist. Produces truth timeline,
   * knowledge matrix, and red herrings that reference real locations.
   */
  async generateStoryInWorld(
    macroScene: MacroSceneStructure,
    mythosEvents: MythosEvent[],
    endState: EndStateDefinition,
    storyPremise: string,
    scenarios: ScenarioOutline[],
    scenes: Map<string, DynamicScene>,
    creativePromptOrElements: string | StructuredStoryElements,
    progressCallback?: ProgressCallback
  ): Promise<{
    truthTimeline: TruthEvent[];
    knowledgeMatrix: KnowledgeHolder[];
    redHerrings: RedHerring[];
  }> {
    const storyElements: StructuredStoryElements =
      typeof creativePromptOrElements === "string"
        ? {
            era: "",
            worldbuilding: "",
            genre: [],
            tone: "",
            theme: "",
            refinedPrompt: creativePromptOrElements,
          }
        : creativePromptOrElements;

    console.log(
      "\n[Macro Scene Agent] Starting story-in-world generation (with scene context)..."
    );

    // Build scene context string for prompt injection
    const scenesContext = this.buildScenesContext(scenarios, scenes);

    // Step 1: Truth timeline (with scene context)
    progressCallback?.("Story phase 1/3: Generating truth timeline with scene context...");
    const truthTimeline = await this.generateTruthTimeline(
      macroScene,
      mythosEvents,
      storyElements,
      progressCallback,
      "medium",
      scenesContext
    );

    // Step 2: Knowledge matrix (with scene context)
    progressCallback?.("Story phase 2/3: Generating knowledge matrix with scene context...");
    const knowledgeMatrix = await this.generateKnowledgeMatrix(
      macroScene,
      mythosEvents,
      truthTimeline,
      storyElements,
      progressCallback,
      "medium",
      scenesContext
    );

    // Step 3: Red herrings (with scene context)
    progressCallback?.("Story phase 3/3: Generating red herrings with scene context...");
    const redHerrings = await this.generateRedHerrings(
      mythosEvents,
      truthTimeline,
      knowledgeMatrix,
      storyElements,
      progressCallback,
      "medium",
      scenesContext
    );

    console.log("[Macro Scene Agent] Story-in-world generation complete");
    console.log(`   Truth events: ${truthTimeline.length}`);
    console.log(`   Knowledge holders: ${knowledgeMatrix.length}`);
    console.log(`   Red herrings: ${redHerrings.length}`);

    return { truthTimeline, knowledgeMatrix, redHerrings };
  }

  /**
   * @deprecated Use generateSettingSeed() + generateStoryInWorld() instead.
   * Main entry point - runs all 6 steps sequentially (legacy monolithic generation).
   */
  async generate(
    settingType: MacroSceneSettingType = "small_town",
    creativePromptOrElements: string | StructuredStoryElements,
    progressCallback?: ProgressCallback
  ): Promise<{
    macroScene: MacroSceneStructure;
    mythosEvents: MythosEvent[];
    truthTimeline: TruthEvent[];
    knowledgeMatrix: KnowledgeHolder[];
    redHerrings: RedHerring[];
    endState: EndStateDefinition;
  }> {
    const storyElements: StructuredStoryElements =
      typeof creativePromptOrElements === "string"
        ? {
            era: "",
            worldbuilding: "",
            genre: [],
            tone: "",
            theme: "",
            refinedPrompt: creativePromptOrElements,
          }
        : creativePromptOrElements;

    console.log(
      `\n🌍 [Macro Scene Agent] Starting world generation for ${settingType}...`
    );
    console.log(
      `   Creative Prompt: ${storyElements.refinedPrompt.substring(0, 100)}${storyElements.refinedPrompt.length > 100 ? "..." : ""}`
    );

    // Step 1: Setting structure (adaptive to setting type)
    const macroScene = await this.generateTownStructure(
      settingType,
      storyElements,
      progressCallback
    );

    // Step 2: Historical mythos layer (foundation for current events)
    const mythosEvents = await this.generateHistoricalMythos(
      macroScene,
      storyElements,
      progressCallback
    );

    // Step 3: Truth timeline (current events, influenced by historical mythos)
    const truthTimeline = await this.generateTruthTimeline(
      macroScene,
      mythosEvents,
      storyElements,
      progressCallback
    );

    // Step 4: Knowledge matrix
    const knowledgeMatrix = await this.generateKnowledgeMatrix(
      macroScene,
      mythosEvents,
      truthTimeline,
      storyElements,
      progressCallback
    );

    // Step 5: Red herrings
    const redHerrings = await this.generateRedHerrings(
      mythosEvents,
      truthTimeline,
      knowledgeMatrix,
      storyElements,
      progressCallback
    );

    // Step 6: End state
    const endState = await this.generateEndState(
      macroScene,
      mythosEvents,
      truthTimeline,
      storyElements,
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
