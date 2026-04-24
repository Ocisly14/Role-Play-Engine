import type { WorldFeature } from "./core/worldFeature.js";
import { ActionDefinitionRegistry } from "./definitions/registry.js";
import { fireFeature } from "./features/fireFeature.js";
import { itemDamageFeature } from "./features/itemDamageFeature.js";
import { staminaFeature } from "./features/staminaFeature.js";
import { sunFeature } from "./features/sunFeature.js";
import { weatherFeature } from "./features/weatherFeature.js";
import { loadActionDefinitions } from "./tool_definitions/loader.js";

export function getDefaultFeatures(): WorldFeature[] {
  return [
    weatherFeature,
    sunFeature,
    fireFeature,
    staminaFeature,
    itemDamageFeature,
  ];
}

export function createDefaultDefinitions(): ActionDefinitionRegistry {
  const reg = new ActionDefinitionRegistry();
  for (const def of loadActionDefinitions()) reg.register(def);
  return reg;
}
