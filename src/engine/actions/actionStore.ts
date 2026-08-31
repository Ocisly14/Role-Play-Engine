// src/engine/actions/actionStore.ts
//
// Persisted first-class EngineAction state (plan D5). One EngineAction per
// accepted ActionCommand — the actionId is derived from the commandId, which
// is what makes command retries idempotent: the same command can never mint a
// second action. The store never re-rolls or regenerates anything on
// rehydration; actions round-trip verbatim.

import type { GameTime } from "../core/types.js";
import type {
  ActionCommand,
  EngineAction,
  EngineActionStatus,
} from "./types.js";

/** Deterministic commandId → actionId mapping (idempotency backbone). */
export function actionIdForCommand(commandId: string): string {
  return `action_${commandId}`;
}

const LIVE_STATUSES: ReadonlySet<EngineActionStatus> = new Set([
  "queued",
  "active",
]);

export class ActionStore {
  private actions = new Map<string, EngineAction>();

  /** Create the queued EngineAction for an accepted command. Calling twice
   *  with the same command returns the existing action unchanged. */
  createFromCommand(command: ActionCommand, submittedAt: GameTime): EngineAction {
    const id = actionIdForCommand(command.commandId);
    const existing = this.actions.get(id);
    if (existing) return existing;
    const action: EngineAction = {
      id,
      command,
      status: "queued",
      submittedAt,
      progressMinutes: 0,
    };
    this.actions.set(id, action);
    return action;
  }

  get(actionId: string): EngineAction | undefined {
    return this.actions.get(actionId);
  }

  getByCommandId(commandId: string): EngineAction | undefined {
    return this.actions.get(actionIdForCommand(commandId));
  }

  getActorActions(actorId: string): EngineAction[] {
    return [...this.actions.values()].filter(
      (a) => a.command.actorId === actorId
    );
  }

  /** The actor's single live (queued or active) action, if any. Used by the
   *  controller to fill `replacesActionId` — never to cancel eagerly. */
  liveForActor(actorId: string): EngineAction | undefined {
    // Prefer active over queued when both exist momentarily.
    let queued: EngineAction | undefined;
    for (const a of this.actions.values()) {
      if (a.command.actorId !== actorId || !LIVE_STATUSES.has(a.status))
        continue;
      if (a.status === "active") return a;
      queued ??= a;
    }
    return queued;
  }

  liveActions(): EngineAction[] {
    return [...this.actions.values()].filter((a) => LIVE_STATUSES.has(a.status));
  }

  all(): EngineAction[] {
    return [...this.actions.values()];
  }

  serialize(): EngineAction[] {
    return [...this.actions.values()];
  }

  rehydrate(actions: EngineAction[]): void {
    this.actions.clear();
    for (const a of actions) this.actions.set(a.id, a);
  }
}
