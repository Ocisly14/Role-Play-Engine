// src/engine/core/tickOrchestrator.ts
//
// Tick driver for the tool-driven action engine (plan Phase 8). Target phases:
//
//   1  advance clock (tick-start snapshot is the pre-flush DGSM state)
//   2  advance deterministic movement runtimes (blocked → interruption)
//   3  drain + validate the command inbox
//   4  collect action resolution triggers (new / due / replacement / interrupted)
//   5-7 (conditional) build the full-world context and run ONE World Action
//       Engine session; no triggers → zero model calls
//   8  anchor subsystems + scripted events (unchanged relative order)
//   9-10 output validation happened inside the engine session (validator)
//   11 single Applier flush (StateChanges + engine WorldDeltas)
//   12 commit action lifecycle to the store, emit TickReport
//
// There is no queued-step activation, no plannedOutcome commit, no cancel
// re-resolve: replacement and interruption are resolved by the Engine on the
// same snapshot as everything else.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { addMinutes, diffDays, timePart } from "../../state/gameClock.js";
import { resolveCheck } from "../actions/adjudication/skillAdjudicator.js";
import { resolveSkillValue, rollSkill } from "../actions/skillRollService.js";
import type { ActionStore } from "../actions/actionStore.js";
import { actionIdForCommand } from "../actions/actionStore.js";
import type { CommandInbox } from "../actions/commandInbox.js";
import {
  advanceMovement,
  getMovementRuntime,
  initMovementRuntime,
} from "../actions/movementRuntime.js";
import type {
  ActionCommand,
  ActionTransition,
  EngineAction,
} from "../actions/types.js";
import { buildEngineResolutionContext } from "../resolution/contextBuilder.js";
import type {
  ObjectiveWorldEvent,
  ResolutionTrigger,
  WorldActionEngineResult,
} from "../resolution/types.js";
import type { EngineResolutionContext } from "../resolution/types.js";
import {
  type WorldActionEngineDeps,
  resolveTick,
} from "../resolution/worldActionEngine.js";
import type { SubsystemRegistry } from "../subsystem/registry.js";
import type { AnchorSubsystem } from "../subsystem/types.js";
import type { CodeToolRegistry } from "../tools/codeTool.js";
import type { Applier } from "./applier.js";
import { makeDGSMFeatureReadContext } from "./featureReadContext.js";
import type { ScriptedEventRunner } from "./scriptedEventRunner.js";
import type {
  CharacterAction,
  GameTime,
  StateChange,
  TickReport,
} from "./types.js";

export type ResolveTickFn = (
  context: EngineResolutionContext,
  deps: WorldActionEngineDeps
) => Promise<WorldActionEngineResult>;

export interface OrchestratorDeps {
  dgsm: DynamicGameStateManager;
  applier: Applier;
  scriptedEventRunner: ScriptedEventRunner;
  subsystemRegistry: SubsystemRegistry;
  inbox: CommandInbox;
  actionStore: ActionStore;
  codeTools: CodeToolRegistry;
  /** Injectable for tests; defaults to the real World Action Engine. */
  resolveTickFn?: ResolveTickFn;
  tickDurationMinutes: number;
  hasInitialized: boolean;
}

interface PendingInterruption {
  actionId: string;
  reason: string;
}

export class TickOrchestrator {
  private hasInitialized: boolean;
  private pendingInterruptions: PendingInterruption[] = [];
  private tickCounter = 0;
  private activeAnchorInstances = new Set<string>();
  private anchorInstancesRehydrated = false;

  constructor(private deps: OrchestratorDeps) {
    this.hasInitialized = deps.hasInitialized;
  }

  /** External interruption signal (e.g. actor died mid-action). The action
   *  is resolved — not silently dropped — on the next tick. */
  requestInterruption(actionId: string, reason: string): void {
    this.pendingInterruptions.push({ actionId, reason });
  }

  async tick(): Promise<TickReport> {
    const { dgsm, applier, scriptedEventRunner, subsystemRegistry } = this.deps;
    this.tickCounter += 1;

    // Phase 1 — clock
    const nextTickTime = this.advanceClock();
    const buffer: StateChange[] = [];

    // Phase 2 — deterministic movement advancement (no model calls). Blocked
    // routes become interruption triggers; arrivals force the action due now.
    const arrivedActionIds = new Set<string>();
    for (const action of this.deps.actionStore.liveActions()) {
      if (action.status !== "active") continue;
      const movement = getMovementRuntime(action);
      if (!movement) continue;
      const advanced = advanceMovement(dgsm, action.command.actorId, movement);
      buffer.push(...advanced.stateChanges);
      if (advanced.status === "blocked") {
        this.pendingInterruptions.push({
          actionId: action.id,
          reason: advanced.blockedReason ?? "route blocked",
        });
      } else if (advanced.status === "arrived") {
        arrivedActionIds.add(action.id);
      }
    }

    // Phase 2b — time. Every action in flight advances by exactly one tick,
    // from the clock and nothing else. The Engine is never asked how much
    // time passed and cannot say: it decides how long a thing SHOULD take,
    // and this is where that estimate is spent, minute by minute.
    for (const action of this.deps.actionStore.liveActions()) {
      if (action.status !== "active") continue;
      action.progressMinutes += this.deps.tickDurationMinutes;
      action.lastAdvancedAt = nextTickTime;
    }

    // Phase 3 — drain inbox; dead actors get an immediate failed transition.
    const drained = this.deps.inbox.drain();
    const newCommands: ActionCommand[] = [];
    const preTransitions: ActionTransition[] = [];
    for (const command of drained) {
      if (!dgsm.isNpcAlive(command.actorId)) {
        const action = this.deps.actionStore.getByCommandId(command.commandId);
        if (action) {
          action.status = "failed";
          preTransitions.push({
            actionId: action.id,
            actorId: command.actorId,
            from: "queued",
            to: "failed",
            progressDeltaMinutes: 0,
            reason: "actor is dead",
          });
        }
        continue;
      }
      newCommands.push(command);
    }

    // Dead actors with live actions → interruption triggers.
    for (const action of this.deps.actionStore.liveActions()) {
      if (!dgsm.isNpcAlive(action.command.actorId)) {
        this.pendingInterruptions.push({
          actionId: action.id,
          reason: "actor died",
        });
      }
    }

    // Phase 4 — trigger collection (plan §5 trigger policy).
    const activeActions = this.deps.actionStore
      .liveActions()
      .filter((a) => a.status === "active");
    const triggers: ResolutionTrigger[] = [];
    if (newCommands.length > 0) {
      triggers.push({
        actionIds: newCommands.map((c) => actionIdForCommand(c.commandId)),
        reason: "new_action",
      });
    }
    const replacedIds = newCommands
      .map((c) => c.replacesActionId)
      .filter((id): id is string => {
        if (!id) return false;
        const target = this.deps.actionStore.get(id);
        return (
          target !== undefined &&
          (target.status === "active" || target.status === "queued")
        );
      });
    if (replacedIds.length > 0) {
      triggers.push({ actionIds: replacedIds, reason: "replacement" });
    }
    const dueIds = activeActions
      .filter(
        (a) =>
          arrivedActionIds.has(a.id) ||
          (a.resolvedDurationTicks !== undefined &&
            a.progressMinutes >=
              a.resolvedDurationTicks * this.deps.tickDurationMinutes)
      )
      .map((a) => a.id);
    if (dueIds.length > 0) {
      triggers.push({ actionIds: dueIds, reason: "duration_reached" });
    }
    const interruptions = this.pendingInterruptions.filter((p) => {
      const action = this.deps.actionStore.get(p.actionId);
      return (
        action !== undefined &&
        (action.status === "active" || action.status === "queued")
      );
    });
    this.pendingInterruptions = [];
    if (interruptions.length > 0) {
      triggers.push({
        actionIds: [...new Set(interruptions.map((p) => p.actionId))],
        reason: "interrupted",
      });
    }

    // Phases 5-7 — conditional global resolution. No triggers → no model call.
    let engineResult: (WorldActionEngineResult & { ok: true }) | undefined;
    if (triggers.length > 0) {
      // Dice, now that the bar is old news: the Engine set requiredLevel when
      // the action started and has not seen a number since. Rolling here puts
      // the result in the context it is about to read.
      this.rollDueChecks(triggers.flatMap((t) => t.actionIds));
      const objectiveWorldEvents: ObjectiveWorldEvent[] = interruptions.map(
        (p) => ({
          kind: "interruption",
          actionId: p.actionId,
          description: p.reason,
        })
      );
      const context = buildEngineResolutionContext({
        dgsm,
        tickId: `tick_${this.tickCounter}_${nextTickTime}`,
        tickStartTime: nextTickTime,
        durationMinutes: this.deps.tickDurationMinutes,
        triggers,
        newCommands,
        activeActions,
        objectiveWorldEvents,
      });
      const resolveFn = this.deps.resolveTickFn ?? resolveTick;
      const result = await resolveFn(context, {
        dgsm,
        codeTools: this.deps.codeTools,
      });

      if (result.ok) {
        engineResult = result;
      } else {
        // The Engine produced nothing usable. Nothing it would have changed
        // is applied — and the inputs it consumed go back, or they vanish:
        // drained commands have queued actions that no trigger would pick up
        // again, and a swallowed interruption never fires twice. Putting them
        // back is what makes "nothing happened this tick" true rather than
        // "this tick silently ate two commands".
        for (const command of newCommands) this.deps.inbox.add(command);
        this.pendingInterruptions.push(...interruptions);
      }
    }

    // Movement runtime init for newly-resolved movement legs. Read-only
    // planning; a failed init downgrades the transition to failed.
    const movementStates = new Map<
      string,
      ReturnType<typeof initMovementRuntime>
    >();
    if (engineResult) {
      // The bar, written once as the action starts. It is not revisable: the
      // whole point is that it was chosen before any roll existed.
      for (const [actionId, bar] of Object.entries(engineResult.checkInits)) {
        const action = this.deps.actionStore.get(actionId);
        const skillId = action?.command.declaredSkillId;
        if (!action || action.check || !skillId) continue;
        action.check = {
          skillId,
          requiredLevel: bar.requiredLevel,
          basis: bar.basis,
          ...(bar.opposedBy ? { opposedBy: bar.opposedBy } : {}),
        };
      }
      for (const [actionId, init] of Object.entries(
        engineResult.movementInits
      )) {
        const action = this.deps.actionStore.get(actionId) ?? undefined;
        const actorId = action?.command.actorId;
        if (!actorId) continue;
        movementStates.set(
          actionId,
          initMovementRuntime(dgsm, actorId, init.destinationId)
        );
      }
      for (const transition of engineResult.resolution.transitions) {
        const planned = movementStates.get(transition.actionId);
        if (planned && !planned.ok && transition.to === "active") {
          transition.to = "failed";
          transition.reason = planned.reason;
          transition.nextWakeAt = undefined;
        }
      }
    }

    const transitions: ActionTransition[] = [
      ...preTransitions,
      ...(engineResult?.resolution.transitions ?? []),
    ];

    // Every action that ended must leave the actor something to perceive.
    // The validator asks the Engine for this, but some terminal transitions
    // never reach the Engine at all — a command failed here because the actor
    // is dead, a movement leg whose route could not be planned, a resolution
    // the Engine could not deliver. Those would end silently, and a silent
    // failure is invisible: the actor's position and surroundings are
    // unchanged, so next tick's perception is identical and they re-issue the
    // same doomed action. Observed live as a seven-tick loop.
    const occurrences = [...(engineResult?.resolution.occurrences ?? [])];
    const traced = new Set(occurrences.flatMap((occ) => occ.sourceActionIds));
    for (const t of transitions) {
      if (t.to === "active" || traced.has(t.actionId)) continue;
      const action = this.deps.actionStore.get(t.actionId);
      if (!action) continue;
      const occurrenceId = `occ_${nextTickTime}_fallback_${t.actionId}`;
      occurrences.push({
        id: occurrenceId,
        tickId: nextTickTime,
        sourceActionIds: [t.actionId],
        ...(action.command.issuedSceneId
          ? { locationId: action.command.issuedSceneId }
          : {}),
        facts: [
          {
            id: `${occurrenceId}#f0`,
            type: "action_result",
            content: `${t.actorId} 的行动「${action.command.description}」${
              t.to === "completed" ? "结束了" : `没有进行下去（${t.to}）`
            }${t.reason ? `：${t.reason}` : "，没有留下可见的变化"}`,
            entityRefs: [{ kind: "character", id: t.actorId }],
          },
        ],
        participants: [{ characterId: t.actorId, role: "actor" }],
        // Only the actor: a failure nobody else could see stays private.
        perceiverCharacterIds: [t.actorId],
        signals: [{ factIds: [`${occurrenceId}#f0`], channel: "direct" }],
      });
    }
    const commits: CharacterAction[] = [];
    const cancellations: CharacterAction[] = [];
    for (const t of transitions) {
      const action = this.deps.actionStore.get(t.actionId);
      if (!action) continue;
      if (t.to === "completed") {
        commits.push(this.toCharacterAction(action, t, nextTickTime));
      } else if (
        t.to === "interrupted" ||
        t.to === "cancelled" ||
        t.to === "failed"
      ) {
        cancellations.push(this.toCharacterAction(action, t, nextTickTime));
      }
    }

    // Phase 8 — anchor subsystems and scripted events (existing order).
    this.rehydrateAnchorInstancesFromDGSM(subsystemRegistry);
    this.runAnchorLifecyclePass(subsystemRegistry, buffer);
    this.runUnifiedOnTickPass(subsystemRegistry, buffer);

    const currentTick =
      diffDays(
        nextTickTime,
        dgsm.getState().moduleSetup?.startDate ?? nextTickTime
      ) *
        1440 +
      this.minutesOfDay(timePart(nextTickTime));
    buffer.push(
      ...scriptedEventRunner.run({
        dgsm,
        currentTick,
        gameDateTime: nextTickTime,
        committedActionsThisTick: commits,
      })
    );

    // Phase 11 — single flush. Engine WorldDeltas are consumed natively by
    // the Applier and apply ahead of the buffered StateChanges, so semantic
    // outcomes land first and deterministic execution (movement
    // interpolation) plus ambient subsystem effects replay after them.
    const engineDeltas = engineResult
      ? [
          ...engineResult.resolution.characterChanges,
          ...engineResult.resolution.sceneChanges,
          ...engineResult.resolution.itemChanges,
        ]
      : [];
    const applied = applier.flush(buffer, nextTickTime, engineDeltas);

    // Phase 12 — lifecycle commit AFTER a successful flush.
    for (const t of transitions) {
      const action = this.deps.actionStore.get(t.actionId);
      if (!action) continue;
      this.applyTransition(action, t, nextTickTime, engineResult);
      const planned = movementStates.get(t.actionId);
      if (planned?.ok && action.status === "active") {
        action.runtime = { ...(action.runtime ?? {}), movement: planned.state };
      }
    }

    return {
      gameDateTime: nextTickTime,
      transitions,
      occurrences,
      commits,
      cancellations,
      featureEvents: [...applied.featureEvents],
      stateChanges: applied.stateChanges,
      damageReports: applied.damageReports,
    };
  }

  /** Roll every declared-but-unrolled check among these actions. The record
   *  is written once and reused by retries and rehydration — an action is
   *  never rolled twice. */
  private rollDueChecks(actionIds: string[]): void {
    const { dgsm } = this.deps;
    const skillsOf = (characterId: string): Record<string, number> =>
      dgsm.getNpcProfile(characterId)?.skills ?? {};

    for (const actionId of new Set(actionIds)) {
      const action = this.deps.actionStore.get(actionId);
      if (!action?.check || action.checkOutcome) continue;

      const actorSkill = resolveSkillValue(
        action.check.skillId,
        skillsOf(action.command.actorId)
      );
      if (!actorSkill) continue;

      const outcome = resolveCheck({
        actorRoll: rollSkill(actorSkill.canonicalSkillId, actorSkill.value),
        requiredLevel: action.check.requiredLevel,
        ...(action.check.opposedBy
          ? { opposedBy: action.check.opposedBy }
          : {}),
        rollDefender: (characterId, skillId) => {
          const defense = resolveSkillValue(skillId, skillsOf(characterId));
          return defense
            ? {
                ok: true,
                record: rollSkill(defense.canonicalSkillId, defense.value),
              }
            : { ok: false, reason: `unknown defense skill "${skillId}"` };
        },
      });
      if (outcome.ok) action.checkOutcome = outcome.check;
    }
  }

  // --- lifecycle helpers ---

  private applyTransition(
    action: EngineAction,
    t: ActionTransition,
    now: GameTime,
    engineResult: (WorldActionEngineResult & { ok: true }) | undefined
  ): void {
    if (action.status === "queued" && t.to !== "queued") {
      action.startedAt = now;
    }
    action.status = t.to;
    action.lastAdvancedAt = now;
    if (t.resolvedDurationTicks !== undefined) {
      action.resolvedDurationTicks = t.resolvedDurationTicks;
    }
    if (t.to === "active") {
      if (t.nextWakeAt !== undefined) action.nextWakeAt = t.nextWakeAt;
    } else {
      action.nextWakeAt = undefined;
    }

  }

  private toCharacterAction(
    action: EngineAction,
    t: ActionTransition,
    now: GameTime
  ): CharacterAction {
    const command = action.command;
    return {
      characterId: command.actorId,
      handleId: action.id,
      stepGroupId: action.id,
      stepIndex: 0,
      definitionId: "act",
      actionText: command.description,
      sceneId: command.issuedSceneId,
      referencedEntities: command.objectRefs.map((r) => ({
        id: r.id,
        kind: r.kind,
      })),
      impact: 2,
      activatedAt: action.startedAt ?? action.submittedAt,
      completedAt: now,
      outcome: {
        stateChanges: [],
        elapsedMinutes: action.progressMinutes,
      },
    };
  }

  // --- anchor subsystem passes (unchanged mechanics) ---

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

  // --- misc helpers ---

  private advanceClock(): GameTime {
    const before = this.deps.dgsm.getGameDateTime();
    const next = addMinutes(before, this.deps.tickDurationMinutes);
    this.deps.dgsm.setGameDateTime(next);
    return next;
  }

  private minutesOfDay(tickTime: string): number {
    const [h, m] = tickTime.split(":").map(Number);
    return h * 60 + m;
  }
}
