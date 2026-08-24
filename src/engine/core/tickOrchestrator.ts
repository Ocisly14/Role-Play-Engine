import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { addMinutes, diffDays, timePart } from "../../state/gameClock.js";
import { makeActionSubsystemContext } from "../subsystem/actionContext.js";
import type { SubsystemRegistry } from "../subsystem/registry.js";
import type { AnchorSubsystem } from "../subsystem/types.js";
import type { ToolResult } from "../types.js";
import type { Applier } from "./applier.js";
import { makeDGSMFeatureReadContext } from "./featureReadContext.js";
import type { Queue } from "./queue.js";
import type { ScriptedEventRunner } from "./scriptedEventRunner.js";
import type {
  ActionStep,
  CharacterAction,
  GameTime,
  PlannedOutcome,
  StateChange,
  TickReport,
} from "./types.js";

interface PendingCancellation {
  step: ActionStep;
  /** Optional caller-supplied reason — passed to the resolver so partial
   *  narrative reflects WHY the action stopped (e.g., "switching to: flee"). */
  reason?: string;
}

/** Optional context passed to the resolver when re-running mid-action because
 *  the step is being cancelled. The resolver should produce an outcome
 *  reflecting partial progress (narrative + any stateChanges that did land in
 *  the elapsed window) rather than the original plannedOutcome. */
export interface ResolveCancelContext {
  elapsedMinutes: number;
  plannedDuration: number;
  reason: string;
  /** The narrative the resolver produced at activation, for the LLM to use as
   *  reference ("you were going to X, but only Y minutes passed before Z"). */
  plannedNarrative?: string;
}

export type ResolveFn = (
  step: ActionStep,
  ctx: unknown,
  cancel?: ResolveCancelContext,
  skillCheckResult?: ToolResult
) => Promise<{
  outcome: PlannedOutcome;
  plannedDuration: number;
}>;

/**
 * Pre-resolver hook: given an LLM-engine step about to activate, run the
 * action definition's skill check (opposed roll, difficulty band, scene /
 * condition penalties) and return the verdict for the resolver to consume.
 * Returns `undefined` to mean "no skill check" — resolver treats it as auto
 * success, same as before. The returned ToolResult is also stashed on
 * `ActionStep.skillCheckResult` so the cancel-time re-resolve sees the
 * original roll.
 */
export type RunSkillCheckFn = (step: ActionStep) => ToolResult | undefined;

export interface OrchestratorDeps {
  dgsm: DynamicGameStateManager;
  queue: Queue;
  scriptedEventRunner: ScriptedEventRunner;
  applier: Applier;
  resolve: ResolveFn;
  /** Optional skill-check hook. When set, the orchestrator calls it before
   *  `resolve` at activation time and feeds the result to both the activation
   *  and any later cancel-time re-resolve. Omit to keep the legacy "auto
   *  success" path. */
  runSkillCheck?: RunSkillCheckFn;
  /** Unified Subsystem registry — required. Drives all tick paths. */
  subsystemRegistry: SubsystemRegistry;
  tickDurationMinutes: number;
  lang: string;
  /**
   * True when the engine is constructed from a persisted snapshot (rehydrated
   * session); false on a fresh session.
   */
  hasInitialized: boolean;
}

export class TickOrchestrator {
  // Sync-cancelled ActionSteps waiting to be surfaced as CharacterAction events.
  // TickEngine.cancelAction pushes here at call time; orchestrator drains into
  // TickReport.cancellations at the start of the next tick. For active steps
  // the resolver is re-run during Phase 2a so the surfaced outcome carries a
  // partial narrative.
  private pendingCancellations: PendingCancellation[] = [];
  // Latched on first tick to skip any one-shot init on subsequent ticks.
  // Initialized from deps.hasInitialized so rehydrated sessions never re-run.
  private hasInitialized: boolean;
  /**
   * Active anchor subsystem instances, keyed by `${subsystemId}:${anchorId}`.
   * Reconstructed lazily on first tick from DGSM scopedFeatureState (see
   * Phase 5 implementation). Action subsystem instances are NOT tracked here
   * — their lifetime is managed by the queue + onTick.completed signal.
   */
  private activeAnchorInstances = new Set<string>();
  private anchorInstancesRehydrated = false;

  constructor(private deps: OrchestratorDeps) {
    this.hasInitialized = deps.hasInitialized;
  }

  /** Called by TickEngine.cancelAction after marking the step cancelled.
   *  Surfaced next tick in TickReport.cancellations. For previously-active
   *  steps Phase 2a re-runs the resolver with `reason` to produce a partial
   *  narrative reflecting actual progress. */
  recordCancelledStep(step: ActionStep, reason?: string): void {
    this.pendingCancellations.push({ step, reason });
  }

  /** Enumerate anchor ids for a subsystem's anchor kind. */
  private anchorIdsFor(kind: AnchorSubsystem["anchorKind"]): string[] {
    const dgsm = this.deps.dgsm;
    switch (kind) {
      case "scene":
        return dgsm.getAllSceneIds().slice().sort();
      case "region": {
        const out = new Set<string>();
        for (const sid of dgsm.getAllSceneIds()) {
          const r = dgsm.getRegionIdForScene(sid);
          if (r) out.add(r);
        }
        return Array.from(out).sort();
      }
      case "character":
        return dgsm
          .getState()
          .npcCharacters.filter((n) => dgsm.isNpcAlive(n.id))
          .map((n) => n.id)
          .sort();
      case "global":
        return ["global"];
    }
  }

  /**
   * Reconstruct activeAnchorInstances from DGSM scopedFeatureState. Called
   * once on the first tick after construction — both fresh and rehydrated
   * sessions go through this path. For fresh sessions, DGSM has no scoped
   * feature buckets yet, so activeAnchorInstances stays empty and Phase 5
   * will spawn fresh instances. For rehydrated sessions, every existing
   * bucket maps to a live instance.
   */
  private rehydrateAnchorInstancesFromDGSM(registry: SubsystemRegistry): void {
    if (this.anchorInstancesRehydrated) return;
    this.anchorInstancesRehydrated = true;
    const dgsm = this.deps.dgsm;
    for (const sub of registry.getAnchorSubsystems()) {
      const all = dgsm.getAllScopedFeatureStates<unknown>(
        sub.id,
        sub.anchorKind
      );
      for (const { key } of all) {
        this.activeAnchorInstances.add(`${sub.id}:${key}`);
      }
    }
  }

  /** Phase 5 — anchor lifecycle pass. */
  private runAnchorLifecyclePass(
    registry: SubsystemRegistry,
    buffer: StateChange[]
  ): void {
    const dgsm = this.deps.dgsm;
    for (const sub of registry.getAnchorSubsystems()) {
      const ctx = makeDGSMFeatureReadContext(dgsm, {
        callerFeatureId: sub.id,
        callerScope: sub.anchorKind,
      });
      const anchorIds = this.anchorIdsFor(sub.anchorKind);
      for (const anchorId of anchorIds) {
        const key = `${sub.id}:${anchorId}`;
        const shouldBe = sub.shouldExist(anchorId, ctx);
        const isActive = this.activeAnchorInstances.has(key);
        if (shouldBe && !isActive) {
          this.activeAnchorInstances.add(key);
          // Skip initialState if a bucket already exists (rehydrated session
          // hand-edited, or LLM pre-seeded state). Idempotency guard from D9.
          const existing = dgsm.getScopedFeatureState<unknown>(
            sub.id,
            sub.anchorKind,
            anchorId
          );
          if (existing === undefined) {
            buffer.push(...sub.initialState(anchorId, ctx));
          }
        } else if (!shouldBe && isActive) {
          this.activeAnchorInstances.delete(key);
          buffer.push({
            kind: "feature.removeState",
            featureId: sub.id,
            key: anchorId,
          });
        }
      }
    }
  }

  /** Phase 6 — unified onTick pass for anchor subsystems. */
  private runUnifiedOnTickPass(
    registry: SubsystemRegistry,
    buffer: StateChange[]
  ): void {
    const dgsm = this.deps.dgsm;
    for (const sub of registry.getAnchorSubsystems()) {
      const ctx = makeDGSMFeatureReadContext(dgsm, {
        callerFeatureId: sub.id,
        callerScope: sub.anchorKind,
      });
      for (const anchorId of this.anchorIdsFor(sub.anchorKind)) {
        if (!this.activeAnchorInstances.has(`${sub.id}:${anchorId}`)) continue;
        buffer.push(...sub.onTick(anchorId, ctx));
      }
    }
  }

  async tick(): Promise<TickReport> {
    const {
      dgsm,
      queue,
      scriptedEventRunner,
      applier,
      resolve,
      subsystemRegistry,
    } = this.deps;

    // Phase 1: advance clock
    const nextTickTime = this.advanceClock();

    const buffer: StateChange[] = [];
    const cancellations: CharacterAction[] = [];
    const commitsThisTick: CharacterAction[] = [];
    const activationsThisTick: ActionStep[] = [];

    // Phase 2: process pending cancellations. For previously-active steps,
    // re-run the resolver with cancel context so the surfaced outcome carries
    // a partial narrative + any stateChanges that landed in the elapsed
    // window. Queued-only cancels (never activated) just surface as-is.
    for (const pend of this.pendingCancellations) {
      await this.applyPendingCancellation(
        pend,
        nextTickTime,
        buffer,
        cancellations,
        resolve
      );
    }
    this.pendingCancellations = [];

    // Phase 3: activate idle actors. Dispatch on `step.engine`:
    //   - "code" → call ActionSubsystem.onActivate; the result is
    //     terminal (completed/failed) within this tick or moves the step into
    //     the active pool for per-tick advancement (Phase 3.5).
    //   - "llm"  → call the resolver, then mark active and let the existing
    //     completionTime-based commit logic in Phase 4 finalize.
    const actorIds = this.getIdleActorIds();
    for (const actorId of actorIds) {
      const next = queue.nextIdleForActor(actorId);
      if (!next) continue;

      if (next.engine === "code") {
        await this.activateCodeStep(
          next,
          nextTickTime,
          buffer,
          commitsThisTick,
          activationsThisTick
        );
        continue;
      }

      const readCtx = makeDGSMFeatureReadContext(dgsm, {
        callerFeatureId: "__resolver__",
        callerScope: "global",
      });
      // Skill check happens FIRST so the resolver sees the verdict when it
      // narrates / writes stateChanges. The result is also stashed on the
      // step so a later cancel-time re-resolve can reuse the same roll.
      const skillCheckResult = this.deps.runSkillCheck?.(next);
      next.skillCheckResult = skillCheckResult;
      const resolved = await resolve(
        next,
        readCtx,
        undefined,
        skillCheckResult
      );
      next.activatedAt = nextTickTime;
      next.plannedDuration = resolved.plannedDuration;
      next.plannedOutcome = resolved.outcome;
      next.completionTime = addMinutes(nextTickTime, resolved.plannedDuration);
      queue.markActive(next.id);
      activationsThisTick.push(next);
    }

    // Phase 3.5: advance any active code-engine steps that did not terminate
    // on activation. Each tick calls `subsystem.onTick(step, ctx)` until the
    // subsystem reports completed or failed.
    for (const step of queue.snapshotAll()) {
      if (step.status !== "active" || step.engine !== "code") continue;
      // Skip steps that were just activated this tick (their onActivate
      // already produced this tick's StateChanges). We detect "this tick" by
      // comparing activatedAt to nextTickTime.
      if (step.activatedAt && step.activatedAt === nextTickTime) {
        continue;
      }
      this.advanceCodeStep(step, nextTickTime, buffer, commitsThisTick);
    }

    // Phase 4: commit due LLM-driven steps. Code-engine steps were already
    // committed by activateCodeStep / advanceCodeStep above and so will not
    // appear in this filter.
    const due = queue
      .snapshotAll()
      .filter(
        (s) =>
          s.status === "active" &&
          s.engine !== "code" &&
          this.timeIsAtOrBefore(s.completionTime, nextTickTime)
      );

    for (const step of due) {
      const outcome = step.plannedOutcome;
      // plannedOutcome is set in Phase 3 before markActive; missing = programmer error.
      if (!outcome) {
        queue.markCompleted(step.id);
        continue;
      }
      buffer.push(...outcome.stateChanges);
      queue.markCompleted(step.id);
      commitsThisTick.push({
        characterId: step.characterId,
        handleId: step.handle.id,
        stepGroupId: step.stepGroupId,
        stepIndex: step.stepIndex,
        definitionId: step.definitionId,
        actionText: step.actionText,
        sceneId: step.executionSceneId,
        referencedEntities: step.referencedEntities,
        impact: step.impact,
        activatedAt: step.activatedAt!,
        completedAt: nextTickTime,
        outcome: step.plannedOutcome,
      });
    }

    // Phase 5: anchor subsystem lifecycle pass.
    this.rehydrateAnchorInstancesFromDGSM(subsystemRegistry);
    this.runAnchorLifecyclePass(subsystemRegistry, buffer);

    // Phase 6: unified anchor subsystem onTick pass.
    this.runUnifiedOnTickPass(subsystemRegistry, buffer);

    // Phase 7: scripted events
    const currentTick =
      diffDays(
        nextTickTime,
        dgsm.getState().moduleSetup?.startDate ?? nextTickTime
      ) *
        1440 +
      this.minutesOfDay(timePart(nextTickTime));
    const scriptedChanges = scriptedEventRunner.run({
      dgsm,
      currentTick,
      gameDateTime: nextTickTime,
      committedActionsThisTick: commitsThisTick,
    });
    buffer.push(...scriptedChanges);

    // Phase 8: (emergent events removed — subsystem conditionExpiry handles
    // condition cleanup; future scanners can register as anchor subsystems)

    // Phase 9: applier flush
    const applied = applier.flush(buffer, nextTickTime);

    // Phase 10: build report (event emission is TickEngine + EventBus's job)
    return {
      gameDateTime: nextTickTime,
      activations: activationsThisTick,
      commits: commitsThisTick,
      cancellations,
      featureEvents: [...applied.featureEvents],
      stateChanges: [...buffer],
      damageReports: applied.damageReports,
    };
  }

  // --- helpers ---

  /**
   * Activate a code-engine step. Calls `subsystem.onActivate(step, ctx)` and:
   *   - Pushes any returned StateChanges into the buffer (Applier flushes
   *     them in Phase 9).
   *   - If completed/failed: marks the step terminal, surfaces a
   *     CharacterAction commit so downstream listeners see the action close.
   *   - Otherwise: marks the step active so Phase 3.5 will drive it forward
   *     each subsequent tick via `subsystem.onTick`.
   */
  private async activateCodeStep(
    step: ActionStep,
    nextTickTime: GameTime,
    buffer: StateChange[],
    commitsThisTick: CharacterAction[],
    activationsThisTick: ActionStep[]
  ): Promise<void> {
    const subsystem = step.codeSubsystem
      ? this.deps.subsystemRegistry.getActionSubsystem(step.codeSubsystem)
      : undefined;
    if (!subsystem) {
      throw new Error(
        `TickOrchestrator: ActionStep ${step.id} declares engine="code" but codeSubsystem "${step.codeSubsystem}" is not registered`
      );
    }
    const ctx = this.makeCodeCtx();
    const result = subsystem.onActivate
      ? subsystem.onActivate(step, ctx)
      : { stateChanges: [], completed: false };
    buffer.push(...result.stateChanges);
    step.activatedAt = nextTickTime;
    this.deps.queue.markActive(step.id);
    activationsThisTick.push(step);
    if (result.failed || result.completed) {
      step.completionTime = nextTickTime;
      this.deps.queue.markCompleted(step.id);
      commitsThisTick.push(this.stepToAction(step, nextTickTime));
    }
  }

  /**
   * Drive an in-flight code-engine step forward by one tick. Pushes
   * StateChanges and surfaces a commit on terminal results.
   */
  private advanceCodeStep(
    step: ActionStep,
    nextTickTime: GameTime,
    buffer: StateChange[],
    commitsThisTick: CharacterAction[]
  ): void {
    const subsystem = step.codeSubsystem
      ? this.deps.subsystemRegistry.getActionSubsystem(step.codeSubsystem)
      : undefined;
    if (!subsystem) {
      throw new Error(
        `TickOrchestrator: ActionStep ${step.id} declares engine="code" but codeSubsystem "${step.codeSubsystem}" is not registered`
      );
    }
    const ctx = this.makeCodeCtx();
    const result = subsystem.onTick(step, ctx);
    buffer.push(...result.stateChanges);
    if (result.failed || result.completed) {
      step.completionTime = nextTickTime;
      this.deps.queue.markCompleted(step.id);
      commitsThisTick.push(this.stepToAction(step, nextTickTime));
    }
  }

  private makeCodeCtx() {
    const base = makeDGSMFeatureReadContext(this.deps.dgsm, {
      callerFeatureId: "__codeEngine__",
      callerScope: "global",
    });
    return makeActionSubsystemContext(base, this.deps.dgsm);
  }

  private async applyPendingCancellation(
    pend: PendingCancellation,
    nowTickTime: GameTime,
    buffer: StateChange[],
    cancellations: CharacterAction[],
    resolve: ResolveFn
  ): Promise<void> {
    const step = pend.step;
    const wasActivated =
      step.activatedAt !== undefined && step.plannedOutcome !== undefined;

    if (wasActivated) {
      // Re-run the resolver with cancel context to produce a partial outcome
      // (narrative + stateChanges reflecting what actually happened in the
      // elapsed window). On error, keep the original plannedOutcome so the
      // surfaced cancellation still has SOMETHING; Controller will downgrade
      // to actionText fallback if narrative is missing.
      const elapsed = this.minutesBetween(step.activatedAt!, nowTickTime);
      const planned = step.plannedDuration ?? 1;
      // Derive `plannedNarrative` from the resolver's original memory.event
      // content. `memory.event` is now a member of the StateChange
      // discriminated union, so the .find narrows naturally.
      const plannedNarrative = step.plannedOutcome?.stateChanges.find(
        (s): s is Extract<StateChange, { kind: "memory.event" }> =>
          s.kind === "memory.event" && s.characterId === step.characterId
      )?.content;
      try {
        const readCtx = makeDGSMFeatureReadContext(this.deps.dgsm, {
          callerFeatureId: "__resolver_cancel__",
          callerScope: "global",
        });
        const reResolved = await resolve(
          step,
          readCtx,
          {
            elapsedMinutes: elapsed,
            plannedDuration: planned,
            reason: pend.reason ?? "cancelled",
            plannedNarrative,
          },
          // Reuse the original activation-time skill-check verdict so the
          // partial outcome is consistent with the original roll (cancel
          // doesn't re-roll the dice).
          step.skillCheckResult
        );
        buffer.push(...reResolved.outcome.stateChanges);
        step.plannedOutcome = reResolved.outcome;
      } catch (err) {
        console.warn(
          `[TickOrchestrator] cancel re-resolve failed for step ${step.id}; keeping plannedOutcome:`,
          err
        );
      }
    }
    // Surface — stepToAction copies plannedOutcome onto CharacterAction.outcome.
    cancellations.push(this.stepToAction(step, nowTickTime));
  }

  private stepToAction(step: ActionStep, now: GameTime): CharacterAction {
    return {
      characterId: step.characterId,
      handleId: step.handle.id,
      stepGroupId: step.stepGroupId,
      stepIndex: step.stepIndex,
      definitionId: step.definitionId,
      actionText: step.actionText,
      sceneId: step.executionSceneId,
      referencedEntities: step.referencedEntities,
      impact: step.impact,
      activatedAt: step.activatedAt ?? step.submittedAt,
      completedAt: now,
      outcome: step.plannedOutcome,
    };
  }

  private advanceClock(): GameTime {
    const before = this.deps.dgsm.getGameDateTime();
    const next = addMinutes(before, this.deps.tickDurationMinutes);
    this.deps.dgsm.setGameDateTime(next);
    return next;
  }

  private getIdleActorIds(): string[] {
    const all = new Set<string>();
    for (const s of this.deps.queue.snapshotAll()) all.add(s.characterId);
    return [...all].filter((id) => !this.deps.queue.hasActiveFor(id));
  }

  private minutesOfDay(tickTime: string): number {
    const [h, m] = tickTime.split(":").map(Number);
    return h * 60 + m;
  }

  private minutesBetween(a: GameTime, b: GameTime): number {
    const [ah, am] = timePart(a).split(":").map(Number);
    const [bh, bm] = timePart(b).split(":").map(Number);
    return diffDays(b, a) * 1440 + (bh * 60 + bm) - (ah * 60 + am);
  }

  private timeIsAtOrBefore(t: GameTime | undefined, now: GameTime): boolean {
    if (!t) return false;
    return t <= now;
  }
}
