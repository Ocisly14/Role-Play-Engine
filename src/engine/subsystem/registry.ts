// src/engine/subsystem/registry.ts
//
// Map-backed Subsystem collection. Mirrors the pattern of
// ActionDefinitionRegistry and the pre-Phase-I CodeEngineRegistry.

import type { ActionSubsystem, AnchorSubsystem, Subsystem } from "./types.js";

export class SubsystemRegistry {
  private subsystems = new Map<string, Subsystem>();

  register(subsystem: Subsystem): void {
    if (this.subsystems.has(subsystem.id)) {
      console.warn(
        `[SubsystemRegistry] Overwriting subsystem: ${subsystem.id}`
      );
    }
    this.subsystems.set(subsystem.id, subsystem);
  }

  get(id: string): Subsystem | undefined {
    return this.subsystems.get(id);
  }

  getAll(): Subsystem[] {
    return [...this.subsystems.values()];
  }

  /** All AnchorSubsystems, sorted by priority asc (lower first). */
  getAnchorSubsystems(): AnchorSubsystem[] {
    return this.getAll()
      .filter((s): s is AnchorSubsystem => s.kind === "anchor")
      .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));
  }

  /**
   * Lookup an ActionSubsystem by id. Caller (TickOrchestrator Phase 3) maps
   * `ActionStep.codeSubsystem` → subsystem id. Returns undefined if no match
   * or the registered subsystem is an AnchorSubsystem (caller treats as
   * configuration error).
   */
  getActionSubsystem(id: string): ActionSubsystem | undefined {
    const s = this.subsystems.get(id);
    return s?.kind === "action" ? s : undefined;
  }
}
