import type { FeatureReadContext } from "./featureReadContext.js";
import type { ActionStep, FeatureStateScope, StateChange } from "./types.js";

// NOTE: `PlannedOutcome` is not yet defined in ./types.ts (as of Phase A).
// Per the B1 task spec, its shape is
//   { stateChanges: StateChange[]; elapsedMinutes: number; narrative?: string }
// We define it locally here and re-export it so downstream engine code has a
// single canonical shape until Phase A types are extended.
export interface PlannedOutcome {
  stateChanges: StateChange[];
  elapsedMinutes: number;
  narrative?: string;
}

// Skill modifiers flow through SceneCondition / CharacterCondition
// (mechanicalEffect.skillPenalty), NOT through a per-feature hook. Features
// that want to debuff a skill emit `scene.addCondition` / `character.addCondition`
// StateChanges with the mechanicalEffect filled in. The resolver aggregates
// at skill-check time by reading ctx.getScene / ctx.getCharacter conditions.

export interface WorldFeature {
  readonly id: string;
  readonly description: string;
  readonly stateScope: FeatureStateScope;
  readonly affectedKinds: ReadonlyArray<StateChange["kind"]>;
  readonly effectSummary: string;
  readonly impactRange?: Partial<
    Record<StateChange["kind"], readonly [number, number]>
  >;
  readonly priority?: number;
  readonly propagation?: { tickInterval: number; maxHops: number };
  readonly planningPrompt?: string;
  readonly planNodeSchema?: unknown;

  stateDescription?(ctx: FeatureReadContext): string;
  /**
   * Optional one-time initialization hook. Called by TickOrchestrator's Phase 0
   * the first time tick() runs on a fresh session (not on rehydrated sessions).
   * Returns StateChanges that establish the feature's initial state — e.g.,
   * weather emits region states + scene conditions from module presets.
   *
   * Read preset data via ctx.getFeatureInitConfig<T>(featureId).
   */
  init?(ctx: FeatureReadContext): StateChange[];
  onTick?(ctx: FeatureReadContext): StateChange[];
  onActionCommit?(
    step: ActionStep,
    outcome: PlannedOutcome,
    ctx: FeatureReadContext,
    opts?: { interrupted?: boolean },
  ): StateChange[];
  onPropagate?(
    source: { sceneId: string; hop: number },
    ctx: FeatureReadContext,
  ): { spreadToSceneIds: string[]; changes: StateChange[] };
}
