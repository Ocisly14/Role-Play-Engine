import { fireFeature } from "./features/fireFeature.js";
import { itemDamageFeature } from "./features/itemDamageFeature.js";
import { staminaFeature } from "./features/staminaFeature.js";
import { sunFeature } from "./features/sunFeature.js";
import { weatherFeature } from "./features/weatherFeature.js";
import { GameEngineRegistry } from "./registry.js";
import { loadActionDefinitions } from "./tool_definitions/loader.js";

export function createDefaultRegistry(): GameEngineRegistry {
  const registry = new GameEngineRegistry();

  // Features
  registry.registerFeature(fireFeature);
  registry.registerFeature(weatherFeature);
  registry.registerFeature(sunFeature);
  registry.registerFeature(staminaFeature);
  registry.registerFeature(itemDamageFeature);

  // Action definitions
  for (const def of loadActionDefinitions()) {
    registry.registerDefinition(def);
  }

  return registry;
}
