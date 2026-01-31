/**
 * CoC Agent Model System
 * Centralized model selection and generation system similar to senti-agent_2.0
 */

export * from "./types.js";
export * from "./configuration.js";
export * from "./generator.js";

// Re-export commonly used items for convenience
export { ModelClass, ModelProviderName } from "./types.js";
export {
  generateText,
  resolveModelClass,
  getModelSettings,
  createChatModel,
} from "./generator.js";

export {
  configureTokenUsageDatabase,
  runWithTokenContext,
  recordTokenUsage,
  getTokenContext,
  getCurrentUsageTotals,
} from "./tokenUsage.js";
