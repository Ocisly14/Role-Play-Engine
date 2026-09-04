import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { ActionStore } from "../actions/actionStore.js";
import { CommandInbox } from "../actions/commandInbox.js";
import {
  ACTION_SCHEMA_VERSION,
  type ActionCommand,
  type ActionReceipt,
  type EngineAction,
} from "../actions/types.js";
import { createDefaultCodeToolRegistry } from "../registerDefaults.js";
import type { ScriptedEvent } from "../scriptedEvents/types.js";
import type { SubsystemRegistry } from "../subsystem/registry.js";
import type { CodeToolRegistry } from "../tools/codeTool.js";
import type { WeatherJudgeFn } from "../weather/weatherEngine.js";
import { Applier } from "./applier.js";
import { EventBus } from "./eventBus.js";
import { ScriptedEventRunner } from "./scriptedEventRunner.js";
import { type ResolveTickFn, TickOrchestrator } from "./tickOrchestrator.js";
import type {
  CharacterAction,
  FeatureEvent,
  FeatureStateScope,
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
  /** External interruption signal (actor died, scripted force-stop). The
   *  action is resolved by the Engine next tick — never silently dropped. */
  requestInterruption(actionId: string, reason: string): void;

  tick(): Promise<void>;

  on(ev: "actionCompleted", cb: (a: CharacterAction) => void): Unsubscribe;
  on(ev: "actionCancelled", cb: (a: CharacterAction) => void): Unsubscribe;
  on(ev: "featureEvent", cb: (e: FeatureEvent) => void): Unsubscribe;
  on(
    ev: "tickCompleted",
    cb: (r: TickReport) => Promise<void> | void
  ): Unsubscribe;

  serialize(): TickEnginePersistedState;
}

export interface TickEnginePersistedState {
  /** Snapshots with a different (or absent) version are rejected outright —
   *  no legacy read mode (decision 2026-08-26). */
  actionSchemaVersion: number;
  inbox: ActionCommand[];
  actions: EngineAction[];
}

export interface CreateTickEngineOptions {
  dgsm: DynamicGameStateManager;
  scriptedEvents: ScriptedEvent[];
  /** Unified Subsystem registry. Required — drives all tick paths. */
  subsystemRegistry: SubsystemRegistry;
  tickDurationMinutes: number;
  /** Deterministic code tools for the World Action Engine session. Defaults
   *  to the standard registry. */
  codeTools?: CodeToolRegistry;
  /** Test seam: replaces the World Action Engine LLM session. */
  resolveTickFn?: ResolveTickFn;
  /** Test seam: replaces the weather engine LLM call. */
  weatherJudgeFn?: WeatherJudgeFn;
  persistedState?: TickEnginePersistedState;
}

export function createTickEngine(opts: CreateTickEngineOptions): TickEngine {
  // Each subsystem's state lives under ITS anchor kind. The Applier used to
  // be handed an empty map here and wrote every feature.setState under
  // "scene", while the orchestrator and the read contexts read under the
  // subsystem's own kind — region-scoped weather was written where nothing
  // ever read it, and stood at its preset for the whole run.
  const featureScopes = new Map<string, FeatureStateScope>(
    opts.subsystemRegistry
      .getAnchorSubsystems()
      .map((s) => [s.id, s.anchorKind] as const)
  );
  const applier = new Applier(opts.dgsm, featureScopes);
  const scriptedRunner = new ScriptedEventRunner(opts.scriptedEvents);
  const bus = new EventBus();
  const inbox = new CommandInbox();
  const actionStore = new ActionStore();
  const codeTools = opts.codeTools ?? createDefaultCodeToolRegistry();

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
  }

  const orchestrator = new TickOrchestrator({
    dgsm: opts.dgsm,
    applier,
    scriptedEventRunner: scriptedRunner,
    subsystemRegistry: opts.subsystemRegistry,
    inbox,
    actionStore,
    codeTools,
    resolveTickFn: opts.resolveTickFn,
    weatherJudgeFn: opts.weatherJudgeFn,
    tickDurationMinutes: opts.tickDurationMinutes,
  });

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
      // Boundary invariant: a command names a skill, it never carries a
      // roll. Dice happen when the action's time is spent, against the bar
      // the Engine set at the start — a roll arriving here would mean
      // something rolled before the difficulty existed.
      if (command.skillRoll !== undefined) {
        return {
          accepted: false,
          status: "rejected",
          reason:
            "a command carries no roll — the check is rolled when the action resolves, against the bar set when it started",
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
    requestInterruption: (actionId, reason) =>
      orchestrator.requestInterruption(actionId, reason),

    async tick() {
      const report = await orchestrator.tick();
      for (const a of report.commits) bus.emitActionCompleted(a);
      for (const c of report.cancellations) bus.emitActionCancelled(c);
      for (const e of report.featureEvents) bus.emitFeatureEvent(e);
      await bus.emitTickCompleted(report);
    },

    on: bus.on.bind(bus),

    serialize() {
      return {
        actionSchemaVersion: ACTION_SCHEMA_VERSION,
        inbox: inbox.serialize(),
        actions: actionStore.serialize(),
      };
    },
  };
}
