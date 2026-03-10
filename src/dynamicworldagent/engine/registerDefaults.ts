import { GameEngineRegistry } from "./registry.js";
import {
  routineHandler,
  movementHandler,
  characterInteractionHandler,
  objectInteractionHandler,
  sceneInteractionHandler,
} from "./handlers/index.js";

export function createDefaultRegistry(): GameEngineRegistry {
  const registry = new GameEngineRegistry();
  registry.registerHandler(routineHandler);
  registry.registerHandler(movementHandler);
  registry.registerHandler(characterInteractionHandler);
  registry.registerHandler(objectInteractionHandler);
  registry.registerHandler(sceneInteractionHandler);
  return registry;
}
