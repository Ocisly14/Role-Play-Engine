// src/engine/core/tickOrchestrator.ts
//
// Tick driver for the tool-driven action engine (plan Phase 8). One tick, in
// order:
//
//   1  drain the command inbox at the clock the actors decided on
//   2  (conditional) the START JUDGEMENT — the Engine's first function, one
//       session over that same minute: clock, bar and route for every new
//       command, committed as active from that minute; no commands → no call
//   3  advance the clock
//   4  advance deterministic movement runtimes (a walk that just started
//       takes its first step; blocked → interruption); spend the minute on
//       every active action
//   5  collect settlement triggers (due / replacement / interrupted)
//   6  (conditional) the SETTLEMENT — the Engine's second function, one
//       session over the new minute; no triggers → no call
//   8  anchor subsystems + scripted events (unchanged relative order)
//   11 single Applier flush (StateChanges + settlement WorldDeltas)
//   12 commit the settlement's lifecycle transitions, emit TickReport
//
// A command is judged the minute its actor decided it. The actor perceived
// the world at 09:00 and acted; the start judgement runs on that 09:00 world
// before the clock moves, so `startedAt` is 09:00 and the minute to 09:01 is
// the first minute spent on it. A one-minute action — plain talk, a short
// walk — is therefore due at 09:01 and settled in that same tick, its words
// delivered in that tick's occurrences. Measured before this: a spoken line
// took two ticks to be heard, and the speaker, asked to decide again in
// between and told nothing of the words still in their mouth, answered the
// same question twice.
//
// There is no queued-step activation, no plannedOutcome commit, no cancel
// re-resolve: replacement and interruption are settled by the Engine on the
// same snapshot as everything else that ends.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { addMinutes, diffDays, timePart } from "../../state/gameClock.js";
import type { ActionStore } from "../actions/actionStore.js";
import { actionIdForCommand } from "../actions/actionStore.js";
import { resolveCheck } from "../actions/adjudication/skillAdjudicator.js";
import type { CommandInbox } from "../actions/commandInbox.js";
import {
  advanceMovement,
  getMovementRuntime,
  initMovementRuntime,
} from "../actions/movementRuntime.js";
import { resolveSkillValue, rollSkill } from "../actions/skillRollService.js";
import type {
  ActionCommand,
  ActionTransition,
  EngineAction,
} from "../actions/types.js";
import { buildEngineResolutionContext } from "../resolution/contextBuilder.js";
import { decideStarts } from "../resolution/decisionsFastPaths.js";
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
import type { RawActionStart } from "../resolution/worldDeltaSchema.js";
import {
  finalizeResolution,
  validateRawResolution,
} from "../resolution/worldDeltaValidator.js";
import { catalogSkillName } from "../rules/skillCatalog.js";
import {
  effectiveSkillValue,
  getCharacterConditionPenalties,
} from "../shared/characterConditionPenalties.js";
import { fastPathMode, recordShadow } from "../shared/fastPath.js";
import type { SubsystemRegistry } from "../subsystem/registry.js";
import type { AnchorSubsystem } from "../subsystem/types.js";
import {
  WEATHER_TRANSITION_EVENT,
  type WeatherRegionState,
  type WeatherTransitionEventData,
} from "../subsystem/weather.js";
import type { CodeToolRegistry } from "../tools/codeTool.js";
import { type WeatherJudgeFn, judgeWeather } from "../weather/weatherEngine.js";
import {
  EMPTY_WEATHER_JUDGEMENT,
  buildWeatherJudgementRequest,
  weatherJudgementChanges,
} from "../weather/weatherJudgement.js";
import type { Applier } from "./applier.js";
import {
  implicitRegionIds,
  makeDGSMFeatureReadContext,
} from "./featureReadContext.js";
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
  /** Injectable for tests; defaults to the real weather engine. */
  weatherJudgeFn?: WeatherJudgeFn;
  tickDurationMinutes: number;
  /** Language every Engine session composes its prose in. Default English. */
  narrationLanguage?: string;
  /** Injectable for tests; defaults to the Decisions start judgement. */
  decideStartsFn?: typeof decideStarts;
}

interface PendingInterruption {
  actionId: string;
  reason: string;
}

export class TickOrchestrator {
  private pendingInterruptions: PendingInterruption[] = [];
  private tickCounter = 0;
  private activeAnchorInstances = new Set<string>();
  private anchorInstancesRehydrated = false;

  constructor(private deps: OrchestratorDeps) {}

  /** External interruption signal (e.g. actor died mid-action). The action
   *  is resolved — not silently dropped — on the next tick. */
  requestInterruption(actionId: string, reason: string): void {
    this.pendingInterruptions.push({ actionId, reason });
  }

  async tick(): Promise<TickReport> {
    const { dgsm, applier, scriptedEventRunner, subsystemRegistry } = this.deps;
    this.tickCounter += 1;
    const tick = this.deps.tickDurationMinutes;
    const resolveFn = this.deps.resolveTickFn ?? resolveTick;
    const engineDeps: WorldActionEngineDeps = {
      dgsm,
      codeTools: this.deps.codeTools,
    };

    // Phase 1 — drain the inbox at the clock the actors decided on. The
    // world still stands at the minute they perceived; nothing has moved.
    const decidedAt = dgsm.getGameDateTime();
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

    // Phase 2 — the START JUDGEMENT: the Engine's first function, one
    // session over the world at `decidedAt`. It sets each new action's
    // clock, bar and route, and the action is committed as active from THIS
    // minute — `startedAt` is the minute the actor decided, not a minute
    // later — so the clock that advances next spends its first minute on it.
    // No new command → no session, no model call.
    const startTransitions: ActionTransition[] = [];
    if (newCommands.length > 0) {
      const startContext = (commands: ActionCommand[]) =>
        buildEngineResolutionContext({
          dgsm,
          tickId: `tick_${this.tickCounter}_${decidedAt}_start`,
          tickStartTime: decidedAt,
          durationMinutes: tick,
          triggers: [
            {
              actionIds: commands.map((c) => actionIdForCommand(c.commandId)),
              reason: "new_action",
            },
          ],
          newCommands: commands,
          activeActions: this.activeActions(),
          objectiveWorldEvents: [],
          narrationLanguage: this.deps.narrationLanguage,
        });

      // Phase 2a — DECISIONS_STARTS (design §6.2). Commands whose every start
      // field the Decisions API answers with confidence get their rows from
      // it, checked by the same gate as a model's; the rest go to the model.
      let llmCommands = newCommands;
      let shadowRows: RawActionStart[] = [];
      const startsMode = fastPathMode("DECISIONS_STARTS");
      if (startsMode !== "off") {
        const decided = await (this.deps.decideStartsFn ?? decideStarts)(
          startContext(newCommands),
          dgsm
        );
        if (startsMode === "shadow") {
          shadowRows = decided.rows;
        } else if (decided.rows.length > 0) {
          const subset = newCommands.filter((c) =>
            decided.decided.has(actionIdForCommand(c.commandId))
          );
          const subContext = startContext(subset);
          const raw = { starting: decided.rows };
          const errors = validateRawResolution(raw, subContext);
          if (errors.length === 0) {
            const finalized = finalizeResolution(raw, subContext);
            startTransitions.push(
              ...this.commitStarts(
                {
                  ok: true,
                  resolution: finalized.resolution,
                  movementInits: finalized.movementInits,
                  checkInits: finalized.checkInits,
                  codeToolInvocations: [],
                },
                decidedAt,
                subset
              )
            );
            llmCommands = newCommands.filter(
              (c) => !decided.decided.has(actionIdForCommand(c.commandId))
            );
          } else {
            console.warn(
              `[TickOrchestrator] Decisions start rows refused (${errors[0].message}); the model judges them`
            );
          }
        }
      }

      if (llmCommands.length > 0) {
        const result = await resolveFn(startContext(llmCommands), engineDeps);
        if (result.ok) {
          if (shadowRows.length > 0) {
            this.recordStartsShadow(shadowRows, result, decidedAt);
          }
          startTransitions.push(
            ...this.commitStarts(result, decidedAt, llmCommands)
          );
        } else {
          // The Engine produced nothing usable. The commands go back: drained
          // commands have queued actions that no trigger would pick up again,
          // and putting them back is what makes "nothing happened" true
          // rather than "this tick silently ate two commands". They start a
          // minute late, on the next drain.
          for (const command of llmCommands) this.deps.inbox.add(command);
        }
      }
    }

    // Phase 3 — clock. Every action that is active now, the ones judged a
    // moment ago included, spends this minute.
    const nextTickTime = this.advanceClock();
    const buffer: StateChange[] = [];

    // Phase 4 — deterministic movement advancement (no model calls). A walk
    // that just started takes its first step here, on the world its actor
    // saw. Blocked routes become interruption triggers; arrivals force the
    // action due now.
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

    // Phase 4b — time. Every action in flight advances by exactly one tick,
    // from the clock and nothing else. The Engine is never asked how much
    // time passed and cannot say: it decides how long a thing SHOULD take,
    // and this is where that estimate is spent, minute by minute.
    for (const action of this.deps.actionStore.liveActions()) {
      if (action.status !== "active") continue;
      action.progressMinutes += tick;
      action.lastAdvancedAt = nextTickTime;
    }

    // Dead actors with live actions → interruption triggers. Only active
    // actions: a settlement context cannot address a still-queued action (its
    // worklist silently drops the id), so a queued command of a dead actor is
    // left for the next drain, where the dead-actor check there fails it.
    for (const action of this.deps.actionStore.liveActions()) {
      if (
        action.status === "active" &&
        !dgsm.isNpcAlive(action.command.actorId)
      ) {
        this.pendingInterruptions.push({
          actionId: action.id,
          reason: "actor died",
        });
      }
    }

    // Phase 5 — settlement triggers (plan §5 trigger policy): what is due,
    // what its actor cut short, what the world stopped.
    const activeActions = this.activeActions();
    const triggers: ResolutionTrigger[] = [];
    // Only "active" is eligible: a settlement context cannot address a
    // still-queued action (its worklist silently drops the id). An
    // interruption requested against an action that is still queued — a
    // command sent back by a failed start session — stays pending until the
    // action is active, rather than being dropped on the floor. Computed
    // before the due set so an arrival that is also being interrupted is
    // never mistaken for a plain one below.
    const interruptions = this.pendingInterruptions.filter((p) => {
      const action = this.deps.actionStore.get(p.actionId);
      return action !== undefined && action.status === "active";
    });
    this.pendingInterruptions = this.pendingInterruptions.filter(
      (p) => this.deps.actionStore.get(p.actionId)?.status === "queued"
    );
    const interruptedIds = new Set(interruptions.map((p) => p.actionId));
    let dueIds = activeActions
      .filter(
        (a) =>
          arrivedActionIds.has(a.id) ||
          (a.resolvedDurationTicks !== undefined &&
            a.progressMinutes >= a.resolvedDurationTicks * tick)
      )
      .map((a) => a.id);
    // Everything due this minute, closed by code or not: an action whose time
    // is spent is never "replaced", whoever ends up settling it.
    const due = new Set(dueIds);

    // Phase 5a — a plain arrival closes in code (ENGINE_ARRIVAL_SKIP). A walk
    // that arrived with no check and no words has nothing for the Engine to
    // judge: the endings phase could only answer no_change, which sources no
    // change and no occurrence, and the walker's new position is already in
    // the movement runtime's state changes. `shadow` still settles it and
    // records whether the Engine agreed.
    const arrivalMode = fastPathMode("ENGINE_ARRIVAL_SKIP");
    const plainArrivals =
      arrivalMode === "off"
        ? []
        : dueIds.filter((id) =>
            this.isPlainArrival(id, arrivedActionIds, interruptedIds)
          );
    const codeTransitions: ActionTransition[] = [];
    if (arrivalMode === "on" && plainArrivals.length > 0) {
      const closed = new Set(plainArrivals);
      dueIds = dueIds.filter((id) => !closed.has(id));
      for (const id of plainArrivals) {
        const action = this.deps.actionStore.get(id);
        if (!action) continue;
        codeTransitions.push({
          actionId: id,
          actorId: action.command.actorId,
          from: "active",
          to: "completed",
          progressDeltaMinutes: 0,
        });
      }
    }
    // A replacement is the actor cutting an action short. An action whose
    // time is spent this very minute was not cut short — it ended on its own,
    // and its successor is simply the next thing the actor does — so it is
    // listed as due and never as replaced. Measured: told an action that was
    // also due had been cut short, the Engine wrote the old action's speech
    // row as if it were the new one's. Only "active" is eligible: a
    // settlement context cannot address a still-queued action (its worklist
    // silently drops the id), so a queued target is answered by the next
    // drain instead of being named here.
    const replacedIds = newCommands
      .map((c) => c.replacesActionId)
      .filter((id): id is string => {
        if (!id || due.has(id)) return false;
        const target = this.deps.actionStore.get(id);
        return target !== undefined && target.status === "active";
      });
    if (replacedIds.length > 0) {
      triggers.push({ actionIds: replacedIds, reason: "replacement" });
    }
    if (dueIds.length > 0) {
      triggers.push({ actionIds: dueIds, reason: "duration_reached" });
    }
    if (interruptions.length > 0) {
      triggers.push({
        actionIds: [...new Set(interruptions.map((p) => p.actionId))],
        reason: "interrupted",
      });
    }

    // Phase 6 — the SETTLEMENT: the Engine's second function, one session
    // over the world at `nextTickTime`. No triggers → no model call.
    let settlement: (WorldActionEngineResult & { ok: true }) | undefined;
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
        durationMinutes: tick,
        triggers,
        newCommands: [],
        activeActions,
        objectiveWorldEvents,
        narrationLanguage: this.deps.narrationLanguage,
      });
      const result = await resolveFn(context, engineDeps);
      if (result.ok) {
        settlement = result;
      } else {
        // Nothing it would have changed is applied. A due action stays due
        // and is asked about again next minute; a swallowed interruption
        // would never fire twice, so it goes back.
        this.pendingInterruptions.push(...interruptions);
      }
    }
    if (arrivalMode === "shadow" && settlement) {
      this.recordArrivalShadow(plainArrivals, settlement, nextTickTime);
    }

    const transitions: ActionTransition[] = [
      ...preTransitions,
      ...startTransitions,
      ...codeTransitions,
      ...(settlement?.resolution.transitions ?? []),
    ];

    // Failures outside the settlement need an actor-visible explanation.
    // The validator asks the Engine for this, but some terminal transitions
    // never reach the Engine at all — a command failed here because the actor
    // is dead, a movement leg whose route could not be planned, a resolution
    // the Engine could not deliver. Those would end silently, and a silent
    // failure is invisible: the actor's position and surroundings are
    // unchanged, so next tick's perception is identical and they re-issue the
    // same doomed action. Observed live as a seven-tick loop.
    const occurrences = [...(settlement?.resolution.occurrences ?? [])];
    const traced = new Set(occurrences.flatMap((occ) => occ.sourceActionIds));
    // A validated settlement may deliberately close an observation/wait with
    // no new result. Its transition still wakes the actor; do not synthesize
    // an event or an observation recap. Fallbacks are for transitions outside
    // the settlement (dead actor, failed route, failed resolution, etc.).
    // A plain arrival closed in code is settled too: it ended with nothing to
    // say, by the same rule as a no_change ending.
    const settled = new Set([
      ...(settlement?.resolution.transitions.map((t) => t.actionId) ?? []),
      ...codeTransitions.map((t) => t.actionId),
    ]);
    for (const t of transitions) {
      if (
        t.to === "active" ||
        traced.has(t.actionId) ||
        settled.has(t.actionId)
      )
        continue;
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
            content: this.fallbackFact(t, action),
            entityRefs: [{ kind: "character", id: t.actorId }],
          },
        ],
        participants: [{ characterId: t.actorId, role: "actor" }],
        // Only the actor: a failure nobody else could see stays private.
        perceivers: [{ characterId: t.actorId, clarity: "full" }],
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

    // Phase 8b — weather judgement. A region whose weather changed this tick
    // (the subsystem's transition, its seeding, or a script's weather.set)
    // raised a transition event into the buffer; the weather engine says
    // which passages that weather closes and what each outdoor place is
    // like, and its answer joins this same flush. After the scripted events,
    // so a script's weather.set is judged in the tick it lands. Clear weather
    // is asked too: a clear sky closes nothing, but it still changes what an
    // outdoor place is like — light, long shadows, dry footing, sound that
    // carries — and the storm's own conditions have to be replaced by
    // something rather than merely deleted.
    const weatherTransitions = new Map<string, WeatherRegionState>();
    for (const c of buffer) {
      if (
        c.kind !== "event.emit" ||
        c.event.type !== WEATHER_TRANSITION_EVENT
      ) {
        continue;
      }
      const data = c.event.data as unknown as
        | WeatherTransitionEventData
        | undefined;
      if (data?.regionId && data.state) {
        weatherTransitions.set(data.regionId, data.state);
      }
    }
    for (const [regionId, state] of weatherTransitions) {
      const request = buildWeatherJudgementRequest(
        dgsm,
        regionId,
        state,
        this.deps.narrationLanguage
      );
      const judged = await (this.deps.weatherJudgeFn ?? judgeWeather)(request);
      let judgement = judged.ok ? judged.judgement : undefined;
      if (!judged.ok) {
        const clear = state.weatherType === "clear" || state.intensity <= 0;
        // Failing back to "leave it as it was" is right while the weather
        // still justifies what stands. Under a clear sky it is not: the
        // storm is over, and its closures and conditions would outlive it.
        // So a failed clear judgement still applies the empty one, which is
        // exactly what this phase did for every clear transition before.
        judgement = clear ? EMPTY_WEATHER_JUDGEMENT : undefined;
        console.warn(
          `[TickOrchestrator] weather judgement for ${regionId} failed: ${judged.failure} — ${
            clear
              ? "sky is clear, so its passages and conditions are lifted anyway"
              : "passages and conditions left as they were"
          }`
        );
      }
      if (!judgement) continue;
      buffer.push(...weatherJudgementChanges(regionId, state, judgement));
    }

    // `weather.transition` is an internal hand-off from the deterministic
    // subsystem to the weather judge, not an occurrence in the world. Remove
    // it before the Applier builds the public TickReport/event stream.
    const flushBuffer = buffer.filter(
      (change) =>
        change.kind !== "event.emit" ||
        change.event.type !== WEATHER_TRANSITION_EVENT
    );

    // Phase 11 — single flush. Engine WorldDeltas are consumed natively by
    // the Applier and apply ahead of the buffered StateChanges, so semantic
    // outcomes land first and deterministic execution (movement
    // interpolation) plus ambient subsystem effects replay after them.
    const engineDeltas = settlement
      ? [
          ...settlement.resolution.characterChanges,
          ...settlement.resolution.sceneChanges,
          ...settlement.resolution.itemChanges,
        ]
      : [];
    const applied = applier.flush(flushBuffer, nextTickTime, engineDeltas);

    // Phase 12 — the settlement's lifecycle commit, AFTER a successful flush.
    // (The starts were committed in Phase 2: they had nothing to flush.)
    for (const t of [
      ...codeTransitions,
      ...(settlement?.resolution.transitions ?? []),
    ]) {
      const action = this.deps.actionStore.get(t.actionId);
      if (!action) continue;
      this.applyTransition(action, t, nextTickTime);
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

  /** An arrival with nothing for the Engine to judge: the walk reached its
   *  destination this minute, no check was set when it started, it carries
   *  no words to deliver, and nothing is interrupting it. */
  private isPlainArrival(
    actionId: string,
    arrivedActionIds: ReadonlySet<string>,
    interruptedIds: ReadonlySet<string>
  ): boolean {
    if (!arrivedActionIds.has(actionId) || interruptedIds.has(actionId)) {
      return false;
    }
    const action = this.deps.actionStore.get(actionId);
    if (!action || action.check) return false;
    return !action.command.utterance?.trim();
  }

  /** Shadow record for DECISIONS_STARTS: the Decisions rows beside what the
   *  model set for the same commands. */
  private recordStartsShadow(
    rows: readonly RawActionStart[],
    result: WorldActionEngineResult & { ok: true },
    tickTime: GameTime
  ): void {
    for (const row of rows) {
      const t = result.resolution.transitions.find(
        (x) => x.actionId === row.actionId
      );
      const llmLevel = result.checkInits[row.actionId]?.requiredLevel ?? "none";
      const oursLevel = row.check?.requiredLevel ?? "none";
      const llmRoute = result.movementInits[row.actionId]?.route;
      const record: Record<string, unknown> = {
        tick: tickTime,
        actionId: row.actionId,
        check: {
          ours: oursLevel,
          llm: llmLevel,
          agree: oursLevel === llmLevel,
        },
      };
      if (row.movement) {
        record.route = {
          ours: row.movement.route,
          llm: llmRoute ?? null,
          agree:
            JSON.stringify(row.movement.route) === JSON.stringify(llmRoute),
        };
      } else {
        record.duration = {
          ours: row.resolvedDurationTicks,
          llm: t?.resolvedDurationTicks ?? null,
        };
      }
      recordShadow("DECISIONS_STARTS", record);
    }
  }

  /** Shadow record for ENGINE_ARRIVAL_SKIP: what the Engine made of each
   *  arrival code would have closed as no_change. */
  private recordArrivalShadow(
    actionIds: readonly string[],
    settlement: WorldActionEngineResult & { ok: true },
    tickTime: GameTime
  ): void {
    for (const actionId of actionIds) {
      const t = settlement.resolution.transitions.find(
        (x) => x.actionId === actionId
      );
      const cited = settlement.resolution.occurrences.some((o) =>
        o.sourceActionIds.includes(actionId)
      );
      const llm = !t ? "unsettled" : t.reason || cited ? "result" : "no_change";
      recordShadow("ENGINE_ARRIVAL_SKIP", {
        tick: tickTime,
        actionId,
        predicted: "no_change",
        llm,
        agree: llm === "no_change",
      });
    }
  }

  private activeActions(): EngineAction[] {
    return this.deps.actionStore
      .liveActions()
      .filter((a) => a.status === "active");
  }

  /**
   * Apply an accepted start judgement to the store, at the minute the actors
   * decided. The bar is written once (it is not revisable: the whole point is
   * that it was chosen before any roll existed); each movement is planned
   * read-only and its clock DERIVED from the route — never the Engine's — or
   * the start fails outright when the route cannot be walked; then every
   * transition commits, so the action is under way from this minute.
   * Returns the transitions as committed, for the tick's report.
   */
  private commitStarts(
    result: WorldActionEngineResult & { ok: true },
    now: GameTime,
    newCommands: readonly ActionCommand[]
  ): ActionTransition[] {
    const { dgsm } = this.deps;
    const tick = this.deps.tickDurationMinutes;
    for (const [actionId, bar] of Object.entries(result.checkInits)) {
      const action = this.deps.actionStore.get(actionId);
      const skillId = action?.command.declaredSkillId;
      if (!action || action.check || !skillId || !catalogSkillName(skillId)) {
        continue;
      }
      action.check = {
        skillId,
        ...(action.command.declaredLanguage !== undefined
          ? { language: action.command.declaredLanguage }
          : {}),
        requiredLevel: bar.requiredLevel,
        ...(bar.opposedBy ? { opposedBy: bar.opposedBy } : {}),
      };
    }
    const movementStates = new Map<
      string,
      ReturnType<typeof initMovementRuntime>
    >();
    for (const [actionId, init] of Object.entries(result.movementInits)) {
      const actorId = this.deps.actionStore.get(actionId)?.command.actorId;
      if (!actorId) continue;
      movementStates.set(
        actionId,
        initMovementRuntime(
          dgsm,
          actorId,
          init.route,
          init.vehicleId,
          init.passBlockedConnectionId,
          init.viaConcealedConnectionId
        )
      );
    }
    // Only the transitions of the commands this session was asked about:
    // a start judgement answers its worklist and nothing else.
    const asked = new Set(
      newCommands.map((c) => actionIdForCommand(c.commandId))
    );
    const transitions = result.resolution.transitions.filter((t) =>
      asked.has(t.actionId)
    );
    for (const transition of transitions) {
      const planned = movementStates.get(transition.actionId);
      if (!planned || transition.to !== "active") continue;
      if (!planned.ok) {
        transition.to = "failed";
        transition.reason = planned.reason;
        if (planned.unstatedHop) transition.unstatedHop = planned.unstatedHop;
        if (planned.notAboard) transition.notAboard = planned.notAboard;
        transition.nextWakeAt = undefined;
        continue;
      }
      // Movement time is DERIVED, never the Engine's: the stated route (and
      // vehicle) determine it. Whatever duration the Engine set — or omitted
      // — the plan's own minutes are the action's clock.
      const minutes = Math.max(tick, planned.totalMinutes);
      transition.resolvedDurationTicks = Math.ceil(minutes / tick);
      transition.timingReason =
        transition.timingReason ?? "movement time derived from the route";
      // Wake at the duration we just RESOLVED, not at the raw estimate. A leg
      // that begins or ends partway along a road costs a fractional number of
      // minutes (|0 - 0.1| * 15 = 1.5), which the movement runtime handles by
      // advancing a minute per tick and clamping — so the leg really does
      // take `resolvedDurationTicks`. Deriving the wake time from the same
      // number keeps the two from describing the same action differently,
      // and keeps a fraction off the clock, which rejects one outright.
      transition.nextWakeAt = addMinutes(
        now,
        transition.resolvedDurationTicks * tick
      );
    }
    for (const t of transitions) {
      const action = this.deps.actionStore.get(t.actionId);
      if (!action) continue;
      this.applyTransition(action, t, now);
      const planned = movementStates.get(t.actionId);
      if (planned?.ok && action.status === "active") {
        action.runtime = { ...(action.runtime ?? {}), movement: planned.state };
      }
    }
    return transitions;
  }

  /** Roll every declared-but-unrolled check among these actions. The record
   *  is written once and reused by retries and rehydration — an action is
   *  never rolled twice. */
  private rollDueChecks(actionIds: string[]): void {
    const { dgsm } = this.deps;
    const skillsOf = (characterId: string): Record<string, number> =>
      dgsm.getNpcProfile(characterId)?.skills ?? {};
    // A character's active conditions handicap the roll. Applied to the
    // RESOLVED value, not to the skills record, so an untrained domain (base
    // value) and a Languages check (learned tongues) cannot escape it.
    //
    // This is the deterministic code engine's dice, NOT the trust boundary:
    // a shaken character may still declare anything anyone could declare.
    // `commandValidator` and `commandBuilder` never read conditions and must
    // not start.
    const rollFor = (
      characterId: string,
      canonicalSkillId: string,
      rawValue: number
    ) => {
      const penalized = effectiveSkillValue(
        canonicalSkillId,
        rawValue,
        getCharacterConditionPenalties(characterId, dgsm)
      );
      const record = rollSkill(canonicalSkillId, penalized);
      return penalized === rawValue
        ? record
        : { ...record, skillValueBase: rawValue };
    };

    for (const actionId of new Set(actionIds)) {
      const action = this.deps.actionStore.get(actionId);
      if (!action?.check || action.checkOutcome) continue;

      const actorSkill = resolveSkillValue(
        action.check.skillId,
        skillsOf(action.command.actorId),
        dgsm.getNpcProfile(action.command.actorId)?.languages,
        action.check.language
      );
      if (!actorSkill) continue;

      const outcome = resolveCheck({
        actorRoll: rollFor(
          action.command.actorId,
          actorSkill.canonicalSkillId,
          actorSkill.value
        ),
        requiredLevel: action.check.requiredLevel,
        ...(action.check.opposedBy
          ? { opposedBy: action.check.opposedBy }
          : {}),
        rollDefender: (characterId, skillId) => {
          // A defender is never asked to defend in a language, so no tongue
          // is threaded here: an opposed Languages check is not a thing.
          const defense = resolveSkillValue(skillId, skillsOf(characterId));
          return defense
            ? {
                ok: true,
                record: rollFor(
                  characterId,
                  defense.canonicalSkillId,
                  defense.value
                ),
              }
            : { ok: false, reason: `unknown defense skill "${skillId}"` };
        },
      });
      if (outcome.ok) {
        action.checkOutcome = outcome.check;
      } else {
        // Never silent. A check that cannot be rolled discards BOTH sides'
        // dice and leaves the Engine judging the ending with no roll in
        // front of it; the validator refuses the known cause (a defense
        // skill outside the catalog), and anything that still reaches here
        // is a fault worth seeing.
        console.warn(
          `[TickEngine] ${actionId}: check not rolled — ${outcome.error}`
        );
      }
    }
  }

  // --- lifecycle helpers ---

  private applyTransition(
    action: EngineAction,
    t: ActionTransition,
    now: GameTime
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

  /** A place as the person standing in it would name it. */
  private placeName(id: string): string {
    const { dgsm } = this.deps;
    return (
      dgsm.getScene(id)?.name ?? dgsm.getTopology?.()?.roads.get(id)?.name ?? id
    );
  }

  /**
   * What the actor is told when an action ended without the Engine narrating
   * it. This is the only account they will get, so it has to be an account —
   * something that happened to them, in words about the world.
   *
   * The route case earns its own sentence. Handed the engine's own diagnostic
   * ("route hop … is not a single stretch"), the renderer had nothing
   * experiential to work with and rendered a dizzy spell; the character read
   * that as his own confusion and re-stated the SAME wrong route twice more.
   * The truth is narrower and far more useful to him: the way he had in mind
   * runs between two places that are not joined, and he never set off.
   */
  private fallbackFact(t: ActionTransition, action: EngineAction): string {
    const what = `「${action.command.description}」`;
    if (t.unstatedHop) {
      const from = this.placeName(t.unstatedHop.fromId);
      const to = this.placeName(t.unstatedHop.toId);
      // Not "you misremembered": in both observed cases every memory the
      // actor held was correct and they had joined two of them. Saying the
      // memory was wrong sends them to doubt their own head — which is
      // exactly what both of them then did.
      return `${t.actorId} 没有出发。他心里那条路要从「${from}」接到「${to}」，可这两处之间并没有一条路——不是他记错了什么，是这两段本来就接不上。他还在原地，${what} 一步也没有开始，时间也没有花掉；要去别处，得走一条他确实知道通向那里的路。`;
    }
    if (t.notAboard) {
      const vehicle =
        this.deps.dgsm.getVehicle?.(t.notAboard.vehicleId)?.name ??
        t.notAboard.vehicleId;
      // The same narrowness as the route case: not "the action failed" but
      // the one fact that lets him fix it — he is standing beside the
      // vehicle, not in it.
      return `${t.actorId} 没有出发。他不在「${vehicle}」里——车停在原地，他还站在车外，方向盘不在他手上。${what} 一步也没有开始，时间也没有花掉；要开这辆车，得先上车。`;
    }
    if (t.to === "completed") {
      return `${t.actorId} 的行动${what}结束了${t.reason ? `：${t.reason}` : "，没有留下可见的变化"}`;
    }
    return `${t.actorId} 的行动${what}没有进行下去（${t.to}）${
      t.reason ? `：${t.reason}` : "，没有留下可见的变化"
    }`;
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
        // The emitter has always read `narrative` into the persisted event's
        // `outcome`; nothing ever wrote it, so every failed row in the log
        // said only that something ended. The reason is the whole value of
        // the row.
        ...(t.reason ? { narrative: t.reason } : {}),
      },
    };
  }

  // --- anchor subsystem passes (unchanged mechanics) ---

  private anchorIdsFor(kind: AnchorSubsystem["anchorKind"]): string[] {
    const dgsm = this.deps.dgsm;
    switch (kind) {
      case "scene":
        return dgsm.getAllSceneIds().slice().sort();
      // Same rule as makeDGSMFeatureReadContext.getAllRegionIds — see
      // implicitRegionIds in featureReadContext.ts for why the outdoors
      // counts as a region even though no scene names it as a parent.
      case "region":
        return implicitRegionIds(dgsm);
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
