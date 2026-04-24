import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { ActionStep, StateChange } from "../core/types.js";

/**
 * Build a CodeEngine-flavoured context object. Wraps a base
 * FeatureReadContext with the underlying DGSM so code subsystems (e.g.
 * movement) can read raw position/topology state that the
 * `FeatureReadContext` intentionally hides from features. The
 * `_dgsm` property is a private channel — features must not rely on it.
 */
export function makeCodeEngineContext(
  base: FeatureReadContext,
  dgsm: DynamicGameStateManager
): FeatureReadContext {
  return Object.assign(Object.create(null), base, {
    _dgsm: dgsm,
  }) as FeatureReadContext;
}

/** Internal helper: extract the DGSM from a CodeEngine context. */
export function getCodeEngineDgsm(
  ctx: FeatureReadContext
): DynamicGameStateManager | undefined {
  return (ctx as unknown as { _dgsm?: DynamicGameStateManager })._dgsm;
}

/**
 * Per-step processor for `engine: "code"` action definitions. The
 * TickOrchestrator dispatches code-engine steps to a subsystem keyed by
 * `ActionDefinition.codeSubsystem` (e.g. `"movement"`). Subsystems hold their
 * own per-character/per-step internal state — same pattern as features holding
 * `fire.intensity` per scene — and emit `StateChange[]` that flow through the
 * Applier just like LLM-resolver output.
 */
export interface CodeEngineSubsystem {
  /** Matches `ActionDefinition.codeSubsystem`. */
  readonly id: string;

  /**
   * Called when the orchestrator first activates the step. May return initial
   * `StateChange[]` to seed effects, mark the step `completed` immediately
   * (zero-tick action), or `failed` with a reason.
   */
  onActivate(
    step: ActionStep,
    ctx: FeatureReadContext
  ): CodeEngineStepResult;

  /**
   * Called every tick after activation, until the subsystem reports
   * completed/failed.
   */
  onTick(
    step: ActionStep,
    ctx: FeatureReadContext
  ): CodeEngineStepResult;

  /**
   * Optional cleanup hook called when the step is interrupted by the role-sim
   * layer. Subsystems may emit final `StateChange[]` to flush partial state.
   */
  onInterrupt?(
    step: ActionStep,
    ctx: FeatureReadContext
  ): { stateChanges: StateChange[] };
}

export interface CodeEngineStepResult {
  stateChanges: StateChange[];
  completed: boolean;
  failed?: { reason: string };
}
