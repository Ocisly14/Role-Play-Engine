// src/engine/subsystem/registry.ts
//
// Map-backed Subsystem collection.

import type { AnchorSubsystem, Subsystem } from "./types.js";

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

}
