export { GameEngineRegistry } from "./registry.js";
export { createExecutionContext } from "./executionContext.js";
export { createDefaultRegistry } from "./registerDefaults.js";
export type {
  NodeHandler, WorldFeature, ExecutionContext, SkillRollResult,
  TickRuntimeContext, NpcPlanningCapability,
  FeatureNodeSchema, FeaturePropagationConfig, PropagationResult,
} from "./types.js";
export {
  routineHandler,
  movementHandler,
  characterInteractionHandler,
  objectInteractionHandler,
  sceneInteractionHandler,
} from "./handlers/index.js";
export { findAffectedCharacters, findAffectedScenes } from "./shared/impactPropagation.js";
export { fireFeature } from "./features/fireFeature.js";
export { weatherFeature } from "./features/weatherFeature.js";
export { lightingFeature } from "./features/lightingFeature.js";
export { staminaFeature } from "./features/staminaFeature.js";
