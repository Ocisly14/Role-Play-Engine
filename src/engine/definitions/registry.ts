import type { ActionDefinition } from "../types.js";

export class ActionDefinitionRegistry {
  private definitions = new Map<string, ActionDefinition>();

  register(def: ActionDefinition): void {
    if (this.definitions.has(def.id)) {
      console.warn(
        `[ActionDefinitionRegistry] Overwriting definition: ${def.id}`
      );
    }
    this.definitions.set(def.id, def);
  }

  get(id: string): ActionDefinition | undefined {
    return this.definitions.get(id);
  }

  getAll(): ActionDefinition[] {
    return [...this.definitions.values()];
  }
}
