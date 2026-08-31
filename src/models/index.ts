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
  generateToolCalls,
  resolveModelClass,
  getModelSettings,
} from "./generator.js";

export {
  configureTokenUsageDatabase,
  runWithTokenContext,
  recordTokenUsage,
  getTokenContext,
  getCurrentUsageTotals,
  resetUsageStats,
  getUsageStats,
  measureUsage,
  usageTotals,
  formatUsageReport,
  formatUsageLine,
  uncachedInputTokens,
  promptTokensSent,
} from "./tokenUsage.js";
export type { TokenUsageTotals, UsageAggregate } from "./tokenUsage.js";
