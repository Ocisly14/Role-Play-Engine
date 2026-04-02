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
  registry.registerHandler(actionHandler);
  registry.registerHandler(movementHandler);
  registry.registerHandler(characterInteractionHandler);

  registry.registerFeature(fireFeature);
  registry.registerFeature(weatherFeature);
  registry.registerFeature(lightingFeature);
  registry.registerFeature(staminaFeature);
  registry.registerFeature(sanityFeature);
  registry.registerFeature(eventTriggerFeature);

  registry.registerTool(itemTool);

  return registry;
}
