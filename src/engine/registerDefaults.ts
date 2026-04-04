import { loadActionDefinitions } from "./actions/loader.js";
import { eventTriggerFeature } from "./features/eventTriggerFeature.js";
import { fireFeature } from "./features/fireFeature.js";
import { lightingFeature } from "./features/lightingFeature.js";
import { sanityFeature } from "./features/sanityFeature.js";
import { staminaFeature } from "./features/staminaFeature.js";
import { weatherFeature } from "./features/weatherFeature.js";
import {
  actionHandler,
  characterInteractionHandler,
  movementHandler,
} from "./handlers/index.js";
import { GameEngineRegistry } from "./registry.js";
import { itemTool } from "./tools/itemTool.js";

export function createDefaultRegistry(): GameEngineRegistry {
  const registry = new GameEngineRegistry();

  // Handlers (kept for backward compat, removed in Task 10)
  registry.registerHandler(actionHandler);
  registry.registerHandler(movementHandler);
  registry.registerHandler(characterInteractionHandler);

  // Features
  registry.registerFeature(fireFeature);
  registry.registerFeature(weatherFeature);
  registry.registerFeature(lightingFeature);
  registry.registerFeature(staminaFeature);
  registry.registerFeature(sanityFeature);
  registry.registerFeature(eventTriggerFeature);

  // Tools (kept for backward compat, removed in Task 10)
  registry.registerTool(itemTool);

  // Action definitions (new)
  for (const def of loadActionDefinitions()) {
    registry.registerDefinition(def);
  }

  return registry;
}
