import { eventTriggerFeature } from "./features/eventTriggerFeature.js";
import { fireFeature } from "./features/fireFeature.js";
import { lightingFeature } from "./features/lightingFeature.js";
import { sanityFeature } from "./features/sanityFeature.js";
import { staminaFeature } from "./features/staminaFeature.js";
import { weatherFeature } from "./features/weatherFeature.js";
import { GameEngineRegistry } from "./registry.js";
import { loadActionDefinitions } from "./tool_definitions/loader.js";

export function createDefaultRegistry(): GameEngineRegistry {
  const registry = new GameEngineRegistry();

  // Features
  registry.registerFeature(fireFeature);
  registry.registerFeature(weatherFeature);
  registry.registerFeature(lightingFeature);
  registry.registerFeature(staminaFeature);
  registry.registerFeature(sanityFeature);
  registry.registerFeature(eventTriggerFeature);

  // Action definitions
  for (const def of loadActionDefinitions()) {
    registry.registerDefinition(def);
  }

  return registry;
}
