import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { addMinutes, diffDays, timePart } from "../../state/gameClock.js";
import { makeActionSubsystemContext } from "../subsystem/actionContext.js";
import type { SubsystemRegistry } from "../subsystem/registry.js";
import type { AnchorSubsystem } from "../subsystem/types.js";
import type { Applier } from "./applier.js";
import { makeDGSMFeatureReadContext } from "./featureReadContext.js";
import type { Queue } from "./queue.js";
import type { ScriptedEventRunner } from "./scriptedEventRunner.js";
import type {
  ActionStep,
  CharacterAction,
  GameTime,
  InterruptReason,
  PlannedOutcome,
  StateChange,
  TickReport,
} from "./types.js";

export interface PendingInterrupt {
  handleId: string;
  reason: InterruptReason;
  activeStepId: string;
}

export type ResolveFn = (
  step: ActionStep,
  ctx: unknown
) => Promise<{
  outcome: PlannedOutcome;
  plannedDuration: number;
}>;

export interface OrchestratorDeps {
  dgsm: DynamicGameStateManager;
  queue: Queue;
  scriptedEventRunner: ScriptedEventRunner;
  applier: Applier;
  resolve: ResolveFn;
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
  // Pending interrupt requests — only "active step needs C-compromise" work.
  // Queued-sibling cancels and full-chain cancels are applied synchronously by
  // TickEngine.cancelAction / interruptAction (Option Y decision).
  private pendingInterrupts: PendingInterrupt[] = [];
  // Sync-cancelled ActionSteps waiting to be surfaced as CharacterAction events.
  // TickEngine.cancelAction pushes here at call time; orchestrator drains into
  // TickReport.cancellations at the start of the next tick.
  private pendingCancelledSteps: ActionStep[] = [];
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

  /** Called by TickEngine.interruptAction when the active step needs C-compromise
   *  next tick. Queued siblings are cancelled synchronously by the caller. */
  queuePendingInterrupt(req: PendingInterrupt): void {
    this.pendingInterrupts.push(req);
  }

  /** Called by TickEngine.cancelAction (or interruptAction on a queued-only handle)
   *  after marking the step cancelled. Surfaced next tick in TickReport.cancellations. */
  recordCancelledStep(step: ActionStep): void {
    this.pendingCancelledSteps.push(step);
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
    const interruptions: TickReport["interruptions"] = [];
    const cancellations: CharacterAction[] = [];
    const commitsThisTick: CharacterAction[] = [];

    // Phase 2a: surface sync-cancelled steps into TickReport.cancellations
    for (const step of this.pendingCancelledSteps) {
      cancellations.push(this.stepToAction(step, nextTickTime));
    }
    this.pendingCancelledSteps = [];

    // Phase 2b: apply deferred interrupts (active-step C-compromise)
    for (const pend of this.pendingInterrupts) {
      this.applyPendingInterrupt(pend, nextTickTime, buffer, interruptions);
    }
    this.pendingInterrupts = [];

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
          commitsThisTick
        );
        continue;
      }

      const readCtx = makeDGSMFeatureReadContext(dgsm, {
        callerFeatureId: "__resolver__",
        callerScope: "global",
      });
      const resolved = await resolve(next, readCtx);
      next.activatedAt = nextTickTime;
      next.plannedDuration = resolved.plannedDuration;
      next.plannedOutcome =
        resolved.outcome as unknown as ActionStep["plannedOutcome"];
      next.completionTime = addMinutes(nextTickTime, resolved.plannedDuration);
      queue.markActive(next.id);
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
      const outcome = step.plannedOutcome as unknown as
        | PlannedOutcome
        | undefined;
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
      commits: commitsThisTick,
      interruptions,
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
    commitsThisTick: CharacterAction[]
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

  private applyPendingInterrupt(
    req: PendingInterrupt,
    nowTickTime: GameTime,
    buffer: StateChange[],
    interruptions: TickReport["interruptions"]
  ): void {
    const active = this.deps.queue.get(req.activeStepId);
    if (!active || active.status !== "active") {
      // Step resolved between interruptAction call and this phase — drop silently.
      return;
    }
    if (active.activatedAt === undefined) {
      throw new Error(
        `TickOrchestrator: active step ${active.id} has no activatedAt (queue corruption)`
      );
    }

    const elapsed = this.minutesBetween(active.activatedAt, nowTickTime);
    const planned = active.plannedDuration ?? 1;
    const ratio = elapsed / planned;
    if (ratio >= 0.5 && active.plannedOutcome) {
      // Partial commit: apply outcome stateChanges only (no feature hooks).
      const outcome = active.plannedOutcome as unknown as PlannedOutcome;
      buffer.push(...outcome.stateChanges);
    }
    this.deps.queue.markInterrupted(active.id);
    interruptions.push({
      action: this.stepToAction(active, nowTickTime),
      reason: req.reason,
    });
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
