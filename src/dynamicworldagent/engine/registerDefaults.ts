import { GameEngineRegistry } from "./registry.js";
import {
  routineHandler,
  movementHandler,
  characterInteractionHandler,
  objectInteractionHandler,
  sceneInteractionHandler,
} from "./handlers/index.js";
import { fireFeature } from "./features/fireFeature.js";
import { weatherFeature } from "./features/weatherFeature.js";
import { lightingFeature } from "./features/lightingFeature.js";
import { staminaFeature } from "./features/staminaFeature.js";

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

  return registry;
}
