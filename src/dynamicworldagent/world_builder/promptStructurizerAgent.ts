/**
 * Prompt Structurizer Agent - Extracts structured story elements from raw user input
 * Phase 0 of the World Builder pipeline
 */

import {
  ModelClass,
  ModelProviderName,
  generateText,
} from "../../models/index.js";
import { composeTemplate } from "../../template.js";
import { getPromptStructurizerTemplate } from "./promptStructurizerTemplate.js";
import type { StructuredStoryElements } from "./types.js";

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

function parseJSONResponse(response: string): any {
  const jsonText =
    response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ||
    response.match(/\{[\s\S]*\}/)?.[0];

  if (!jsonText) {
    throw new Error("Failed to extract JSON from response");
  }

  return JSON.parse(jsonText);
}

export class PromptStructurizerAgent {
  private runtime: Runtime;

  constructor() {
    this.runtime = createRuntime();
  }

  /**
   * Extract structured story elements from raw user creative prompt
   */
  async structurize(creativePrompt: string): Promise<StructuredStoryElements> {
    console.log(
      "\n📝 [Prompt Structurizer] Extracting story elements from user input..."
    );

    const template = getPromptStructurizerTemplate();
    const prompt = composeTemplate(template, {}, { creativePrompt });

    const response = await generateText({
      runtime: this.runtime,
      providerOverride: this.runtime.modelProvider,
      context: prompt,
      modelClass: ModelClass.SMALL,
    });

    try {
      const parsed = parseJSONResponse(response);

      // Validate required fields
      if (!parsed.era || typeof parsed.era !== "string") {
        throw new Error("Missing or invalid field: era");
      }
      if (!parsed.worldbuilding || typeof parsed.worldbuilding !== "string") {
        throw new Error("Missing or invalid field: worldbuilding");
      }
      if (!Array.isArray(parsed.genre) || parsed.genre.length === 0) {
        throw new Error(
          "Missing or invalid field: genre (must be non-empty array)"
        );
      }
      if (!parsed.tone || typeof parsed.tone !== "string") {
        throw new Error("Missing or invalid field: tone");
      }
      if (!parsed.theme || typeof parsed.theme !== "string") {
        throw new Error("Missing or invalid field: theme");
      }
      if (!parsed.refinedPrompt || typeof parsed.refinedPrompt !== "string") {
        throw new Error("Missing or invalid field: refinedPrompt");
      }

      const result: StructuredStoryElements = {
        era: parsed.era,
        worldbuilding: parsed.worldbuilding,
        genre: parsed.genre,
        tone: parsed.tone,
        theme: parsed.theme,
        refinedPrompt: parsed.refinedPrompt,
      };

      console.log("✅ [Prompt Structurizer] Story elements extracted:");
      console.log(`   Era: ${result.era}`);
      console.log(`   Genre: ${result.genre.join(", ")}`);
      console.log(`   Tone: ${result.tone}`);
      console.log(`   Theme: ${result.theme}`);

      return result;
    } catch (error) {
      console.error(
        "Failed to parse prompt structurizer response:",
        error
      );
      console.error("Response:", response.substring(0, 500));
      throw new Error(
        `Failed to structurize prompt: ${(error as Error).message}`
      );
    }
  }
}
