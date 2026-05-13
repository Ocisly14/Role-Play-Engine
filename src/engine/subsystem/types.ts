// src/engine/subsystem/types.ts
//
// Phase I unified Subsystem abstraction. Replaces WorldFeature +
// CodeEngineSubsystem. See spec at docs/superpowers/specs/2026-05-12-engine-unified-subsystem-design.md
// for design decisions.

import type { FeatureReadContext } from "../core/featureReadContext.js";
import type { ActionStep, StateChange } from "../core/types.js";

/**
 * Anchor kind for AnchorSubsystem instances. Matches `FeatureStateScope` in
 * `src/engine/core/types.ts:7` — TickOrchestrator routes anchorId enumeration
 * and DGSM scopedFeatureState lookups through this discriminator.
 */
export type AnchorKind = "scene" | "region" | "character" | "global";

/** Common metadata for every Subsystem flavor. */
export interface SubsystemBase {
  readonly id: string;
  /** Lower runs first in Phase 6 onTick loop. Default 999. */
  readonly priority?: number;
  readonly description: string;
  readonly effectSummary: string;
  readonly affectedKinds: ReadonlyArray<StateChange["kind"]>;
  /**
   * Planner-facing prose injected into the NPCPlanningAgent prompt when this
   * subsystem is active. Mirrors WorldFeature.planningPrompt; preserved for
   * the 5 migrating features so the planner sees the same guidance text.
   */
  readonly planningPrompt?: string;
  /**
   * Renders subsystem state as human-readable prose for prompt /
   * debug surfaces. Returns "" when nothing interesting to show.
   * Mirrors WorldFeature.stateDescription. Optional.
   */
  stateDescription?(ctx: FeatureReadContext): string;
}

/**
 * Per-anchor subsystem. Spawn/destroy is driven by `shouldExist`, evaluated
 * each tick in TickOrchestrator Phase 5. Initial state is seeded by
 * `initialState` on transition false→true; bucket is cleared by TickOrchestrator
 * on transition true→false.
 *
 * Invariant: `shouldExist` MUST NOT read the subsystem's own state bucket
 * (would create cyclic spawn-destroy oscillations and break rehydration).
 * Read external DGSM state: scene/character conditions, position, etc.
 */
export interface AnchorSubsystem extends SubsystemBase {
  readonly kind: "anchor";
  readonly anchorKind: AnchorKind;

  /** Per-tick existence predicate. Pure function over DGSM. */
  shouldExist(anchorId: string, ctx: FeatureReadContext): boolean;

  /**
   * Called once when shouldExist transitions false→true OR (on rehydration)
   * when DGSM has no bucket for this (subsystemId, anchorId) yet. Must be
   * safe to no-op if bucket already exists — TickOrchestrator's Phase 5
   * checks bucket presence and skips initialState if so.
   */
  initialState(anchorId: string, ctx: FeatureReadContext): StateChange[];

  /** Called every tick while alive. */
  onTick(anchorId: string, ctx: FeatureReadContext): StateChange[];
}

export interface SubsystemStepResult {
  stateChanges: StateChange[];
  completed: boolean;
  failed?: { reason: string };
}

/**
 * Action-bound subsystem. Lifetime = ActionStep lifetime. Activated by
 * TickOrchestrator Phase 3 when an `engine: "code"` step is dequeued;
 * terminated when onTick returns { completed: true } or onInterrupt fires.
 */
export interface ActionSubsystem extends SubsystemBase {
  readonly kind: "action";

  onActivate?(step: ActionStep, ctx: FeatureReadContext): SubsystemStepResult;

  onTick(step: ActionStep, ctx: FeatureReadContext): SubsystemStepResult;

  onInterrupt?(
    step: ActionStep,
    ctx: FeatureReadContext
  ): { stateChanges: StateChange[] };
}

export type Subsystem = AnchorSubsystem | ActionSubsystem;
