import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { Applier } from "./applier.js";
import type { EmergentEventEmitter } from "./emergentEventEmitter.js";
import { makeDGSMFeatureReadContext } from "./featureReadContext.js";
import type { FeatureRunner } from "./featureRunner.js";
import type { Queue } from "./queue.js";
import type { ScriptedEventRunner } from "./scriptedEventRunner.js";
import type {
  ActionStep,
  CharacterAction,
  GameTime,
  InterruptReason,
  StateChange,
  TickReport,
} from "./types.js";
// PlannedOutcome defined in worldFeature.ts (B1).
import type { PlannedOutcome, WorldFeature } from "./worldFeature.js";

export interface PendingInterrupt {
  handleId: string;
  reason: InterruptReason;
  activeStepId: string;
}

export interface ResolveFn {
  (
    step: ActionStep,
    ctx: unknown,
  ): Promise<{
    outcome: PlannedOutcome;
    plannedDuration: number;
  }>;
}

export interface OrchestratorDeps {
  dgsm: DynamicGameStateManager;
  queue: Queue;
  featureRunner: FeatureRunner;
  scriptedEventRunner: ScriptedEventRunner;
  emergentEventEmitter: EmergentEventEmitter;
  applier: Applier;
  resolve: ResolveFn;
  tickDurationMinutes: number;
  lang: string;
  /**
   * True when the engine is constructed from a persisted snapshot (rehydrated
   * session); false on a fresh session. Gates Phase 0 one-shot feature init.
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
  // Latched on first tick to skip Phase 0 on subsequent ticks. Initialized from
  // deps.hasInitialized so rehydrated sessions never re-run feature init().
  private hasInitialized: boolean;

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

  async tick(): Promise<TickReport> {
    const {
      dgsm,
      queue,
      featureRunner,
      scriptedEventRunner,
      emergentEventEmitter,
      applier,
      resolve,
    } = this.deps;

    // Phase 0: one-shot feature init on fresh sessions.
    // Rehydrated sessions already carry the post-init snapshot, so this runs
    // only when hasInitialized is false — i.e., the engine was constructed
    // without persistedState. Per-feature init failures are isolated so one
    // bad feature doesn't prevent others from initializing; `hasInitialized`
    // latches to true regardless so we never retry (which would duplicate
    // scene conditions emitted by already-succeeded features).
    if (!this.hasInitialized) {
      const currentTickTime: GameTime = {
        day: dgsm.getGameDay(),
        tickTime: dgsm.getTickTime(),
      };
      const initChanges: StateChange[] = [];
      for (const f of featureRunner.listFeatures()) {
        if (!f.init) continue;
        const ctx = makeDGSMFeatureReadContext(dgsm, {
          callerFeatureId: f.id,
          callerScope: f.stateScope,
        });
        try {
          initChanges.push(...f.init(ctx));
        } catch (err) {
          console.error(
            `[TickOrchestrator] feature "${f.id}" init() threw; skipping. Error:`,
            err,
          );
        }
      }
      if (initChanges.length > 0) {
        applier.flush(initChanges, currentTickTime);
      }
      this.hasInitialized = true;
    }

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

    // Phase 3: activate idle actors
    const actorIds = this.getIdleActorIds();
    for (const actorId of actorIds) {
      const next = queue.nextIdleForActor(actorId);
      if (!next) continue;
      const readCtx = makeDGSMFeatureReadContext(dgsm, {
        callerFeatureId: "__resolver__",
        callerScope: "global",
      });
      const resolved = await resolve(next, readCtx);
      next.activatedAt = nextTickTime;
      next.plannedDuration = resolved.plannedDuration;
      next.plannedOutcome = resolved.outcome as unknown as ActionStep["plannedOutcome"];
      next.completionTime = this.addMinutes(nextTickTime, resolved.plannedDuration);
      queue.markActive(next.id);
    }

    // Phase 4: commit due steps
    const due = queue
      .snapshotAll()
      .filter(
        (s) =>
          s.status === "active" &&
          this.timeIsAtOrBefore(s.completionTime, nextTickTime),
      );

    // Per-feature ctx factory for commit-time onActionCommit hooks (mirrors
    // the Phase 5+6 reasoning below — fire.onActionCommit reads its own state
    // when boosting an existing fire, and it must hit the `("fire","scene")`
    // bucket, not a shared `__commit__/global` one.)
    const commitCtxFor = (f: WorldFeature) =>
      makeDGSMFeatureReadContext(dgsm, {
        callerFeatureId: f.id,
        callerScope: f.stateScope,
      });
    for (const step of due) {
      const outcome = step.plannedOutcome as unknown as PlannedOutcome | undefined;
      // plannedOutcome is set in Phase 3 before markActive; missing = programmer error.
      if (!outcome) {
        queue.markCompleted(step.id);
        continue;
      }
      const featureChanges = featureRunner.runActionCommit(
        step,
        outcome,
        commitCtxFor,
      );
      buffer.push(...featureChanges);
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
        targetCharacterIds: step.targetCharacterIds,
        activatedAt: step.activatedAt!,
        completedAt: nextTickTime,
        outcome: step.plannedOutcome,
      });
    }

    // Phase 5+6: feature onTick / propagation. Each feature gets a per-feature
    // read context so own-state reads (`ctx.getFeatureState`,
    // `ctx.getAllFeatureStates`) route to that feature's `(featureId, scope)`
    // bucket in DGSM. A shared `__tick__` ctx would silently drop every
    // stateful feature's read on the floor.
    const featureCtxFor = (f: WorldFeature) =>
      makeDGSMFeatureReadContext(dgsm, {
        callerFeatureId: f.id,
        callerScope: f.stateScope,
      });
    buffer.push(...featureRunner.runTick(featureCtxFor));

    // Phase 6: feature propagation
    buffer.push(...featureRunner.runPropagation(featureCtxFor));

    // Phase 7: scripted events
    const currentTick =
      nextTickTime.day * 1440 + this.minutesOfDay(nextTickTime.tickTime);
    const scriptedChanges = scriptedEventRunner.run({
      dgsm,
      currentTick,
      tickTime: nextTickTime,
      committedActionsThisTick: commitsThisTick,
    });
    buffer.push(...scriptedChanges);

    // Phase 8: emergent events scan — aggregator runs all registered scanners
    const scannerCtx = {
      dgsm,
      tickTime: nextTickTime,
      committedActionsThisTick: commitsThisTick,
      lang: this.deps.lang,
    };
    const { featureEvents: emergentEvents } =
      emergentEventEmitter.scan(scannerCtx);

    // Phase 9: applier flush
    const applied = applier.flush(buffer, nextTickTime);

    // Phase 9.5 — sweep expired character conditions.
    // CharacterCondition can carry expiresAt (GameTime); when reached, the
    // condition is auto-removed. Scene conditions don't have expiresAt today.
    this.sweepExpiredCharacterConditions(nextTickTime);

    // Phase 10: build report (event emission is TickEngine + EventBus's job)
    return {
      tickTime: nextTickTime,
      commits: commitsThisTick,
      interruptions,
      cancellations,
      featureEvents: [...applied.featureEvents, ...emergentEvents],
      stateChanges: [...buffer],
      damageReports: applied.damageReports,
    };
  }

  // --- helpers ---

  private applyPendingInterrupt(
    req: PendingInterrupt,
    nowTickTime: GameTime,
    buffer: StateChange[],
    interruptions: TickReport["interruptions"],
  ): void {
    const active = this.deps.queue.get(req.activeStepId);
    if (!active || active.status !== "active") {
      // Step resolved between interruptAction call and this phase — drop silently.
      return;
    }
    if (active.activatedAt === undefined) {
      throw new Error(
        `TickOrchestrator: active step ${active.id} has no activatedAt (queue corruption)`,
      );
    }

    const elapsed = this.minutesBetween(active.activatedAt, nowTickTime);
    const planned = active.plannedDuration ?? 1;
    const ratio = elapsed / planned;
    if (ratio >= 0.5 && active.plannedOutcome) {
      const ctx = makeDGSMFeatureReadContext(this.deps.dgsm, {
        callerFeatureId: "__interrupt__",
        callerScope: "global",
      });
      const partialChanges = this.deps.featureRunner.runActionCommit(
        active,
        active.plannedOutcome as unknown as PlannedOutcome,
        ctx,
        { interrupted: true },
      );
      buffer.push(...partialChanges);
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
      targetCharacterIds: step.targetCharacterIds,
      activatedAt: step.activatedAt ?? step.submittedAt,
      completedAt: now,
      outcome: step.plannedOutcome,
    };
  }

  private advanceClock(): GameTime {
    const before = {
      day: this.deps.dgsm.getGameDay(),
      tickTime: this.deps.dgsm.getTickTime(),
    };
    const next = this.addMinutes(before, this.deps.tickDurationMinutes);
    this.deps.dgsm.setGameDay(next.day);
    this.deps.dgsm.setTickTime(next.tickTime);
    return next;
  }

  private getIdleActorIds(): string[] {
    const all = new Set<string>();
    for (const s of this.deps.queue.snapshotAll()) all.add(s.characterId);
    return [...all].filter((id) => !this.deps.queue.hasActiveFor(id));
  }

  private addMinutes(t: GameTime, minutes: number): GameTime {
    const [h, m] = t.tickTime.split(":").map(Number);
    let total = h * 60 + m + minutes;
    let day = t.day;
    while (total >= 24 * 60) {
      total -= 24 * 60;
      day += 1;
    }
    const hh = String(Math.floor(total / 60)).padStart(2, "0");
    const mm = String(total % 60).padStart(2, "0");
    return { day, tickTime: `${hh}:${mm}` };
  }

  private minutesOfDay(tickTime: string): number {
    const [h, m] = tickTime.split(":").map(Number);
    return h * 60 + m;
  }

  private minutesBetween(a: GameTime, b: GameTime): number {
    const [ah, am] = a.tickTime.split(":").map(Number);
    const [bh, bm] = b.tickTime.split(":").map(Number);
    return (b.day - a.day) * 1440 + (bh * 60 + bm) - (ah * 60 + am);
  }

  private sweepExpiredCharacterConditions(now: GameTime): void {
    const npcs = this.deps.dgsm.getState().npcCharacters;
    for (const npc of npcs) {
      const conditions = npc.status?.conditions;
      if (!conditions || conditions.length === 0) continue;
      // Iterate via copy because removeCharacterCondition mutates the array.
      const expired = conditions.filter(
        (c) => c.expiresAt && this.timeIsAtOrBefore(c.expiresAt, now),
      );
      for (const c of expired) {
        this.deps.dgsm.removeCharacterCondition(npc.id, c.id);
      }
    }
  }

  private timeIsAtOrBefore(t: GameTime | undefined, now: GameTime): boolean {
    if (!t) return false;
    if (t.day < now.day) return true;
    if (t.day > now.day) return false;
    return t.tickTime <= now.tickTime;
  }
}
