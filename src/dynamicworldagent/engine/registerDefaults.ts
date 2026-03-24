import { fireFeature } from "./features/fireFeature.js";
import { lightingFeature } from "./features/lightingFeature.js";
import { sanityFeature } from "./features/sanityFeature.js";
import { staminaFeature } from "./features/staminaFeature.js";
import { eventTriggerFeature } from "./features/eventTriggerFeature.js";
import { weatherFeature } from "./features/weatherFeature.js";
import {
  characterInteractionHandler,
  movementHandler,
  objectInteractionHandler,
  routineHandler,
  sceneInteractionHandler,
} from "./handlers/index.js";
import { GameEngineRegistry } from "./registry.js";

export function createDefaultRegistry(): GameEngineRegistry {
  const registry = new GameEngineRegistry();
  registry.registerHandler(routineHandler);
  registry.registerHandler(movementHandler);
  registry.registerHandler(characterInteractionHandler);
  registry.registerHandler(objectInteractionHandler);
  registry.registerHandler(sceneInteractionHandler);

  registry.registerFeature(fireFeature);
  registry.registerFeature(weatherFeature);
  registry.registerFeature(lightingFeature);
  registry.registerFeature(staminaFeature);
  registry.registerFeature(sanityFeature);
  registry.registerFeature(eventTriggerFeature);

  return registry;
}
