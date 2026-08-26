// src/engine/actions/commandInbox.ts
//
// Holding pen for ActionCommands between submit and their first tick
// resolution. Commands are immutable here — the SkillRollRecord attached at
// creation is the only roll that ever exists for the command; drain, retry
// and rehydration all reuse it.

import type { ActionCommand } from "./types.js";

export class CommandInbox {
  /** Pending commands in submit order, keyed by commandId. */
  private pending = new Map<string, ActionCommand>();

  has(commandId: string): boolean {
    return this.pending.has(commandId);
  }

  /** Add a command. Re-adding the same commandId is a no-op (idempotent). */
  add(command: ActionCommand): void {
    if (this.pending.has(command.commandId)) return;
    this.pending.set(command.commandId, command);
  }

  /** Remove and return all pending commands in submit order. */
  drain(): ActionCommand[] {
    const drained = [...this.pending.values()];
    this.pending.clear();
    return drained;
  }

  peek(): ReadonlyArray<ActionCommand> {
    return [...this.pending.values()];
  }

  get size(): number {
    return this.pending.size;
  }

  serialize(): ActionCommand[] {
    return [...this.pending.values()];
  }

  rehydrate(commands: ActionCommand[]): void {
    this.pending.clear();
    for (const c of commands) this.pending.set(c.commandId, c);
  }
}
