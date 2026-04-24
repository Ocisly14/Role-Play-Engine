import { MovementSubsystem } from "./movement.js";
import type { CodeEngineSubsystem } from "./types.js";

/**
 * Keyed registry of `CodeEngineSubsystem`s. The TickOrchestrator looks up a
 * subsystem by `ActionStep.codeSubsystem` (copied from
 * `ActionDefinition.codeSubsystem`) when dispatching `engine: "code"` steps.
 *
 * Mirrors the role of `ActionDefinitionRegistry` for definitions: a small
 * Map-backed collection with explicit register/get/getAll. Plugins (or tests)
 * can register additional subsystems by passing a custom registry into
 * `createTickEngine` via `CreateTickEngineOptions.codeEngineRegistry`.
 */
export class CodeEngineRegistry {
  private subsystems = new Map<string, CodeEngineSubsystem>();

  register(subsystem: CodeEngineSubsystem): void {
    if (this.subsystems.has(subsystem.id)) {
      console.warn(
        `[CodeEngineRegistry] Overwriting subsystem: ${subsystem.id}`
      );
    }
    this.subsystems.set(subsystem.id, subsystem);
  }

  get(id: string): CodeEngineSubsystem | undefined {
    return this.subsystems.get(id);
  }

  getAll(): CodeEngineSubsystem[] {
    return [...this.subsystems.values()];
  }
}

/**
 * Default registry containing every built-in CodeEngine subsystem. Phase E
 * ships only `movement`; later phases will add e.g. combat, sleep, or other
 * deterministic-tick action types.
 */
export function createDefaultCodeEngineRegistry(): CodeEngineRegistry {
  const registry = new CodeEngineRegistry();
  registry.register(new MovementSubsystem());
  return registry;
}
