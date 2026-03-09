import { GameEngineRegistry } from "./registry.js";
import {
  routineHandler,
  movementHandler,
  characterInteractionHandler,
  objectInteractionHandler,
  sceneInteractionHandler,
} from "./handlers/index.js";
import { ImpactGateFeature } from "./features/impactGateFeature.js";

/**
 * Create a GameEngineRegistry pre-loaded with all built-in handlers and features.
 */
export function createDefaultRegistry(): GameEngineRegistry {
  const registry = new GameEngineRegistry();
  registry.registerHandler(routineHandler);
  registry.registerHandler(movementHandler);
  registry.registerHandler(characterInteractionHandler);
  registry.registerHandler(objectInteractionHandler);
  registry.registerHandler(sceneInteractionHandler);
  registry.registerFeature(new ImpactGateFeature());
  return registry;
}
