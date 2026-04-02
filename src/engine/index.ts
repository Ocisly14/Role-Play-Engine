export { GameEngineRegistry } from "./registry.js";
export { createExecutionContext } from "./executionContext.js";
export { createDefaultRegistry } from "./registerDefaults.js";
export type {
  NodeHandler,
  WorldFeature,
  ExecutionContext,
  SkillRollResult,
  TickRuntimeContext,
  NpcPlanningCapability,
  FeatureNodeSchema,
  FeaturePropagationConfig,
  PropagationResult,
} from "./types.js";
export type {
  ActionTool,
  ActionToolArgsSchema,
  ToolPreCheckResult,
  ToolResolutionResult,
} from "./types.js";
export {
  actionHandler,
  movementHandler,
  characterInteractionHandler,
  objectInteractionHandler,
} from "./handlers/index.js";
export {
  findAffectedCharacters,
  findAffectedScenes,
} from "./shared/impactPropagation.js";
export { fireFeature } from "./features/fireFeature.js";
export { weatherFeature } from "./features/weatherFeature.js";
export { lightingFeature } from "./features/lightingFeature.js";
export { staminaFeature } from "./features/staminaFeature.js";
export { eventTriggerFeature } from "./features/eventTriggerFeature.js";
export {
  sanityFeature,
  applySanityLoss,
  drainPendingEmotions,
} from "./features/sanityFeature.js";
export type {
  SanityCharacterState,
  SanityEmotionEntry,
  BoutOfMadnessType,
  ActionRestriction,
} from "./features/sanityFeature.js";
