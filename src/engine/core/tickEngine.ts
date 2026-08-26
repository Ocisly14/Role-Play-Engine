import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { ActionStore } from "../actions/actionStore.js";
import { CommandInbox } from "../actions/commandInbox.js";
import {
  ACTION_SCHEMA_VERSION,
  type ActionCommand,
  type ActionReceipt,
  type EngineAction,
} from "../actions/types.js";
import type { ScriptedEvent } from "../scriptedEvents/types.js";
import type { SubsystemRegistry } from "../subsystem/registry.js";
import { ActionIntake } from "./actionIntake.js";
import { Applier } from "./applier.js";
import { EventBus } from "./eventBus.js";
import { Queue } from "./queue.js";
import { ScriptedEventRunner } from "./scriptedEventRunner.js";
import {
  type ResolveFn,
  type RunSkillCheckFn,
  TickOrchestrator,
} from "./tickOrchestrator.js";
import type {
  ActionHandle,
  ActionInput,
  ActionStatus,
  ActionStep,
  CancelResult,
  CharacterAction,
  FeatureEvent,
  TickReport,
  Unsubscribe,
} from "./types.js";

export interface TickEngine {
  /** Submit a trusted ActionCommand (built by commandBuilder). Idempotent by
   *  commandId: resubmitting the same command returns the same actionId and
   *  never mints a second action. Returns a receipt, not a world outcome. */
  submitCommand(command: ActionCommand): Promise<ActionReceipt>;
  /** All EngineActions (any status) belonging to this actor. */
  getActorActions(actorId: string): ReadonlyArray<EngineAction>;
  getAction(actionId: string): EngineAction | undefined;

  /** @deprecated Legacy interpreter path — dies with the tickOrchestrator
   *  rewrite (plan Phase 8/11). No production caller remains. */
  submitAction(input: ActionInput): Promise<ActionHandle>;
  /** Cancel all live steps on this handle. Optional `reason` is passed to the
   *  resolver re-run on next tick (active steps only) so the partial
   *  narrative reflects WHY the action stopped (e.g., "switching to: flee"). */
  cancelAction(handle: ActionHandle, reason?: string): CancelResult;
  tick(): Promise<void>;

  on(ev: "actionCompleted", cb: (a: CharacterAction) => void): Unsubscribe;
  on(ev: "actionCancelled", cb: (a: CharacterAction) => void): Unsubscribe;
  on(ev: "featureEvent", cb: (e: FeatureEvent) => void): Unsubscribe;
  on(
    ev: "tickCompleted",
    cb: (r: TickReport) => Promise<void> | void
  ): Unsubscribe;

  getActionStatus(handle: ActionHandle): ActionStatus;
  getActorQueue(characterId: string): ReadonlyArray<ActionStep>;

  serialize(): TickEnginePersistedState;
}

export interface TickEnginePersistedState {
  /** Snapshots with a different (or absent) version are rejected outright —
   *  no legacy read mode (decision 2026-08-26). */
  actionSchemaVersion: number;
  inbox: ActionCommand[];
  actions: EngineAction[];
  /** Legacy interpreter-path state; removed with plan Phase 8/11. */
  queue: ActionStep[];
  dexByActor: Record<string, number>;
  connectionVotes: Record<string, { featureId: string; reason: string }[]>;
}

export interface CreateTickEngineOptions {
  dgsm: DynamicGameStateManager;
  scriptedEvents: ScriptedEvent[];
  /** Unified Subsystem registry. Required — drives all tick paths. */
  subsystemRegistry: SubsystemRegistry;
  interpretAction: (
    input: ActionInput,
    directory: import(
      "../../state/perceivableDirectory.js"
    ).PerceivableDirectory
  ) => Promise<{ steps: import("../types.js").InterpretedStep[] }>;
  resolve: ResolveFn;
  /** Optional pre-resolver hook. When set, the orchestrator runs the action
   *  definition's skill check before `resolve` at activation time, feeding
   *  the verdict into both activation and any later cancel-time re-resolve.
   *  Omit for legacy "auto success" behavior. */
  runSkillCheck?: RunSkillCheckFn;
  getActorDex: (characterId: string) => number;
  tickDurationMinutes: number;
  /** Session language code (e.g., "en", "zh") — passed through to ScannerContext. */
  lang: string;
  persistedState?: TickEnginePersistedState;
}

export function createTickEngine(opts: CreateTickEngineOptions): TickEngine {
  const queue = new Queue();
  const applier = new Applier(opts.dgsm, new Map());
  const scriptedRunner = new ScriptedEventRunner(opts.scriptedEvents);
  const bus = new EventBus();
  const intake = new ActionIntake({
    queue,
    dgsm: opts.dgsm,
    interpretAction: opts.interpretAction,
    getActorDex: opts.getActorDex,
    getNow: () => opts.dgsm.getGameDateTime(),
  });
  const inbox = new CommandInbox();
  const actionStore = new ActionStore();
  if (opts.persistedState) {
    if (opts.persistedState.actionSchemaVersion !== ACTION_SCHEMA_VERSION) {
      throw new Error(
        `TickEngine snapshot has actionSchemaVersion ${JSON.stringify(
          opts.persistedState.actionSchemaVersion
        )}, expected ${ACTION_SCHEMA_VERSION}. Legacy snapshots are not supported — start a fresh session.`
      );
    }
    inbox.rehydrate(opts.persistedState.inbox);
    actionStore.rehydrate(opts.persistedState.actions);
    queue.rehydrate(
      opts.persistedState.queue,
      new Map(Object.entries(opts.persistedState.dexByActor))
    );
    applier.rehydrateConnectionVotes(opts.persistedState.connectionVotes);
  }
  const orchestrator = new TickOrchestrator({
    dgsm: opts.dgsm,
    queue,
    scriptedEventRunner: scriptedRunner,
    applier,
    resolve: opts.resolve,
    runSkillCheck: opts.runSkillCheck,
    tickDurationMinutes: opts.tickDurationMinutes,
    lang: opts.lang,
    hasInitialized: opts.persistedState !== undefined,
    subsystemRegistry: opts.subsystemRegistry,
  });

  /** Returns all queued + active steps for a handle. Used by cancel/interrupt. */
  function liveSteps(handleId: string): ActionStep[] {
    return queue
      .serialize()
      .filter(
        (s) =>
          s.handle.id === handleId &&
          (s.status === "queued" || s.status === "active")
      );
  }

  return {
    async submitCommand(command) {
      // Idempotency: a command that already produced an action (drained or
      // not) returns the original receipt shape — never a second action.
      const existing = actionStore.getByCommandId(command.commandId);
      if (existing) {
        return {
          accepted: true,
          actionId: existing.id,
          status: "queued",
        };
      }
      // Boundary invariant (plan §4.3): declaredSkillId ⇔ skillRoll. A
      // command violating it never came from the trusted builder.
      if (
        (command.declaredSkillId === undefined) !==
        (command.skillRoll === undefined)
      ) {
        return {
          accepted: false,
          status: "rejected",
          reason:
            "declaredSkillId and skillRoll must both be present or both be absent",
        };
      }
      const action = actionStore.createFromCommand(
        command,
        opts.dgsm.getGameDateTime()
      );
      inbox.add(command);
      return { accepted: true, actionId: action.id, status: "queued" };
    },

    getActorActions: (actorId) => actionStore.getActorActions(actorId),
    getAction: (actionId) => actionStore.get(actionId),

    submitAction: (input) => intake.submit(input),

    cancelAction(handle, reason) {
      const live = liveSteps(handle.id);
      if (live.length === 0) {
        // Chain already finished or prior cancel already marked every step
        // terminal. Idempotent: repeat call = no-op.
        return { applied: false, remainingChainCancelled: 0 };
      }
      // Sync-mark every live step cancelled. Subsequent calls see no live
      // steps and return applied:false naturally (Option Y).
      // For ACTIVE steps the orchestrator will re-run the resolver next tick
      // with `reason` so the surfaced cancellation carries a partial
      // narrative reflecting actual progress.
      const rep =
        live.find((s) => s.status === "active") ??
        [...live].sort((a, b) => a.stepIndex - b.stepIndex)[0];
      for (const s of live) queue.markCancelled(s.id);
      orchestrator.recordCancelledStep(rep, reason);
      return { applied: true, remainingChainCancelled: live.length };
    },

    async tick() {
      const report = await orchestrator.tick();
      for (const a of report.commits) bus.emitActionCompleted(a);
      for (const c of report.cancellations) bus.emitActionCancelled(c);
      for (const e of report.featureEvents) bus.emitFeatureEvent(e);
      await bus.emitTickCompleted(report);
    },

    on: bus.on.bind(bus),

    getActionStatus(handle) {
      const found = queue
        .serialize()
        .filter((s) => s.handle.id === handle.id)
        .sort((a, b) => b.stepIndex - a.stepIndex)[0];
      return found?.status ?? "completed"; // absent ⇒ all cleaned up (completed)
    },

    getActorQueue(characterId) {
      return queue.serialize().filter((s) => s.characterId === characterId);
    },

    serialize() {
      return {
        actionSchemaVersion: ACTION_SCHEMA_VERSION,
        inbox: inbox.serialize(),
        actions: actionStore.serialize(),
        queue: queue.serialize(),
        dexByActor: Object.fromEntries(queue.getDexSnapshot()),
        connectionVotes: applier.serializeConnectionVotes(),
      };
    },
  };
}
