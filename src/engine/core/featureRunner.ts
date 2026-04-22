import type { FeatureReadContext } from "./featureReadContext.js";
import type { ActionStep, FeatureStateScope, StateChange } from "./types.js";
import type { PlannedOutcome, WorldFeature } from "./worldFeature.js";

const DEFAULT_PRIORITY = 999;

export class FeatureRunner {
  private readonly ordered: WorldFeature[];
  private readonly propagationTickCounter = new Map<string, number>();

  constructor(features: WorldFeature[]) {
    this.ordered = [...features].sort((a, b) => {
      const pa = a.priority ?? DEFAULT_PRIORITY;
      const pb = b.priority ?? DEFAULT_PRIORITY;
      return pa - pb;
    });
  }

  runTick(ctx: FeatureReadContext): StateChange[] {
    const out: StateChange[] = [];
    for (const f of this.ordered) {
      if (f.onTick) out.push(...f.onTick(ctx));
    }
    return out;
  }

  runActionCommit(
    step: ActionStep,
    outcome: PlannedOutcome,
    ctx: FeatureReadContext,
    opts?: { interrupted?: boolean },
  ): StateChange[] {
    const out: StateChange[] = [];
    for (const f of this.ordered) {
      if (f.onActionCommit) out.push(...f.onActionCommit(step, outcome, ctx, opts));
    }
    return out;
  }

  runPropagation(ctx: FeatureReadContext): StateChange[] {
    const out: StateChange[] = [];
    for (const f of this.ordered) {
      if (!f.propagation || !f.onPropagate) continue;
      const nextCount = (this.propagationTickCounter.get(f.id) ?? 0) + 1;
      this.propagationTickCounter.set(f.id, nextCount);
      if (nextCount % f.propagation.tickInterval !== 0) continue;
      for (const sceneId of ctx.getSceneIds()) {
        const { changes } = f.onPropagate({ sceneId, hop: 0 }, ctx);
        out.push(...changes);
      }
    }
    return out;
  }

  getFeatureScopeMap(): Map<string, FeatureStateScope> {
    const out = new Map<string, FeatureStateScope>();
    for (const f of this.ordered) out.set(f.id, f.stateScope);
    return out;
  }

  listFeatures(): ReadonlyArray<WorldFeature> {
    return this.ordered;
  }
}
