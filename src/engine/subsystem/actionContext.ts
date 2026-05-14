// src/engine/subsystem/actionContext.ts
//
// Build an ActionSubsystem-flavoured context object. Wraps a base
// FeatureReadContext with the underlying DGSM via a private `_dgsm`
// channel so action subsystems (e.g. movement) can read raw position/
// topology state that the FeatureReadContext intentionally hides.
// Phase I migration of makeCodeEngineContext from src/engine/codeEngine/types.ts.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { FeatureReadContext } from "../core/featureReadContext.js";

export function makeActionSubsystemContext(
  base: FeatureReadContext,
  dgsm: DynamicGameStateManager
): FeatureReadContext {
  return Object.assign(Object.create(null), base, {
    _dgsm: dgsm,
  }) as FeatureReadContext;
}

export function getActionSubsystemDgsm(
  ctx: FeatureReadContext
): DynamicGameStateManager | undefined {
  return (ctx as unknown as { _dgsm?: DynamicGameStateManager })._dgsm;
}
