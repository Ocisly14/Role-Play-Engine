export { ActionDefinitionRegistry } from "./definitions/registry.js";
export { createExecutionContext } from "./executionContext.js";
export {
  createDefaultDefinitions,
  getDefaultFeatures,
} from "./registerDefaults.js";
export type {
  WorldFeature,
  ExecutionContext,
  SkillRollResult,
  TickRuntimeContext,
  NpcPlanningCapability,
  FeatureNodeSchema,
  FeaturePropagationConfig,
  PropagationResult,
  ActionDefinition,
  StateDomainSpec,
  InterpretedResult,
  StateResolution,
  ToolResult,
} from "./types.js";
export {
  findAffectedCharacters,
  findAffectedScenes,
} from "./shared/impactPropagation.js";
export { fireFeature } from "./features/fireFeature.js";
export { weatherFeature } from "./features/weatherFeature.js";
export { sunFeature } from "./features/sunFeature.js";
export { staminaFeature } from "./features/staminaFeature.js";
export { itemDamageFeature } from "./features/itemDamageFeature.js";
