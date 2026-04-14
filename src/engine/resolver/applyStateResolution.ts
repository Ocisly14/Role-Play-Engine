/**
 * Applies a state resolution object to DynamicGameStateManager.
 * Dispatches to type-specific appliers based on definition's outputSchema.
 * Pure code — no LLM calls.
 */

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { OutputSchemaConfig } from "../types.js";
import { applyByTypeId } from "./stateChangeAppliers.js";

/**
 * Apply state changes from a resolver response.
 */
export function applyStateResolution(
  dgsm: DynamicGameStateManager,
  resolution: Record<string, any>,
  config: OutputSchemaConfig
): void {
  applyByTypeId(dgsm, resolution, config);
}
