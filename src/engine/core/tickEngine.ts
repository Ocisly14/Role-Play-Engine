import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import {
  type CodeEngineRegistry,
  createDefaultCodeEngineRegistry,
} from "../codeEngine/registry.js";
import type { ScriptedEvent } from "../scriptedEvents/types.js";
import { ActionIntake } from "./actionIntake.js";
import { Applier } from "./applier.js";
import { EmergentEventEmitter } from "./emergentEventEmitter.js";
import type { EmergentScanner } from "./emergentScanner.js";
import { EventBus } from "./eventBus.js";
import { FeatureRunner } from "./featureRunner.js";
import { Queue } from "./queue.js";
import { ScriptedEventRunner } from "./scriptedEventRunner.js";
import { type ResolveFn, TickOrchestrator } from "./tickOrchestrator.js";
import type {
  ActionHandle,
  ActionInput,
  ActionStatus,
  ActionStep,
  CancelResult,
  CharacterAction,
  FeatureEvent,
  InterruptReason,
  InterruptResult,
  TickReport,
  Unsubscribe,
} from "./types.js";
import type { WorldFeature } from "./worldFeature.js";

export interface TickEngine {
  submitAction(input: ActionInput): Promise<ActionHandle>;
  cancelAction(handle: ActionHandle): CancelResult;
  interruptAction(
    handle: ActionHandle,
    reason: InterruptReason
  ): InterruptResult;
  tick(): Promise<void>;

  on(ev: "actionCompleted", cb: (a: CharacterAction) => void): Unsubscribe;
  on(
    ev: "actionInterrupted",
    cb: (a: CharacterAction, r: InterruptReason) => void
  ): Unsubscribe;
  on(ev: "actionCancelled", cb: (a: CharacterAction) => void): Unsubscribe;
  on(ev: "featureEvent", cb: (e: FeatureEvent) => void): Unsubscribe;
  on(
    ev: "tickCompleted",
    cb: (r: TickReport) => Promise<void> | void
  ): Unsubscribe;

  getActionStatus(handle: ActionHandle): ActionStatus;
  getActorQueue(characterId: string): ReadonlyArray<ActionStep>;

  serialize(): {
    queue: ActionStep[];
    dexByActor: Record<string, number>;
    connectionVotes: Record<string, { featureId: string; reason: string }[]>;
  };
}

export interface CreateTickEngineOptions {
  dgsm: DynamicGameStateManager;
  features: WorldFeature[];
  scriptedEvents: ScriptedEvent[];
  /** Pre-instantiated emergent scanners (EncounterScanner, future scanners).
   *  Order in the array = order of events in TickReport.featureEvents. */
  emergentScanners: EmergentScanner[];
  interpretAction: (
    input: ActionInput
  ) => Promise<{ steps: import("../types.js").InterpretedStep[] }>;
  resolve: ResolveFn;
  getActorDex: (characterId: string) => number;
  tickDurationMinutes: number;
  /** Session language code (e.g., "en", "zh") — passed through to ScannerContext. */
  lang: string;
  /**
   * Optional CodeEngineRegistry for `engine: "code"` action dispatch. Defaults
   * to `createDefaultCodeEngineRegistry()` (movement only in Phase E). Tests
   * and plugins can supply a custom registry to register additional
   * subsystems or replace the defaults.
   */
  codeEngineRegistry?: CodeEngineRegistry;
  persistedState?: {
    queue: ActionStep[];
    dexByActor: Record<string, number>;
    connectionVotes: Record<string, { featureId: string; reason: string }[]>;
  };
}

export function createTickEngine(opts: CreateTickEngineOptions): TickEngine {
  const queue = new Queue();
  const featureRunner = new FeatureRunner(opts.features);
  const applier = new Applier(opts.dgsm, featureRunner.getFeatureScopeMap());
  const scriptedRunner = new ScriptedEventRunner(opts.scriptedEvents);
  const emergent = new EmergentEventEmitter(opts.emergentScanners);
  const bus = new EventBus();
  const intake = new ActionIntake({
    queue,
    interpretAction: opts.interpretAction,
    getActorDex: opts.getActorDex,
    getNow: () => opts.dgsm.getGameDateTime(),
  });
  if (opts.persistedState) {
    queue.rehydrate(
      opts.persistedState.queue,
      new Map(Object.entries(opts.persistedState.dexByActor))
    );
    applier.rehydrateConnectionVotes(opts.persistedState.connectionVotes);
  }
  const codeEngineRegistry =
    opts.codeEngineRegistry ?? createDefaultCodeEngineRegistry();
  const orchestrator = new TickOrchestrator({
    dgsm: opts.dgsm,
    queue,
    featureRunner,
    scriptedEventRunner: scriptedRunner,
    emergentEventEmitter: emergent,
    applier,
    resolve: opts.resolve,
    codeEngineRegistry,
    tickDurationMinutes: opts.tickDurationMinutes,
    lang: opts.lang,
    // Rehydrated sessions ship the post-init snapshot; fresh sessions need
    // Phase 0 to run so WorldFeature.init() seed state is emitted once.
    hasInitialized: opts.persistedState !== undefined,
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
    submitAction: (input) => intake.submit(input),

    cancelAction(handle) {
      const live = liveSteps(handle.id);
      if (live.length === 0) {
        // Chain already finished or prior cancel/interrupt already marked
        // every step terminal. Idempotent: repeat call = no-op.
        return { applied: false, remainingChainCancelled: 0 };
      }
      // Sync-mark every live step cancelled. Subsequent calls see no live
      // steps and return applied:false naturally (Option Y).
      const rep =
        live.find((s) => s.status === "active") ??
        [...live].sort((a, b) => a.stepIndex - b.stepIndex)[0];
      for (const s of live) queue.markCancelled(s.id);
      orchestrator.recordCancelledStep(rep);
      return { applied: true, remainingChainCancelled: live.length };
    },

    interruptAction(handle, reason) {
      const live = liveSteps(handle.id);
      if (live.length === 0) {
        return { applied: false, remainingChainCancelled: 0 };
      }
      const active = live.find((s) => s.status === "active");
      const queuedSibs = live.filter((s) => s.status === "queued");

      // Sync: cancel queued siblings (no resolver needed).
      for (const s of queuedSibs) queue.markCancelled(s.id);

      if (!active) {
        // Spec §3 edge case: interrupt on queued-only handle behaves as cancel.
        const rep = [...queuedSibs].sort(
          (a, b) => a.stepIndex - b.stepIndex
        )[0];
        orchestrator.recordCancelledStep(rep);
        return { applied: true, remainingChainCancelled: queuedSibs.length };
      }

      // Deferred: active step needs C-compromise next tick. Step stays in
      // "active" status until then.
      orchestrator.queuePendingInterrupt({
        handleId: handle.id,
        reason,
        activeStepId: active.id,
      });
      return { applied: true, remainingChainCancelled: queuedSibs.length };
    },

    async tick() {
      const report = await orchestrator.tick();
      for (const a of report.commits) bus.emitActionCompleted(a);
      for (const i of report.interruptions)
        bus.emitActionInterrupted(i.action, i.reason);
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
        queue: queue.serialize(),
        dexByActor: Object.fromEntries(queue.getDexSnapshot()),
        connectionVotes: applier.serializeConnectionVotes(),
      };
    },
  };
}
