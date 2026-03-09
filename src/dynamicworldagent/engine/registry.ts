import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { NodeHandler, WorldFeature } from "./types.js";

export class GameEngineRegistry {
  private handlers = new Map<string, NodeHandler>();
  private features = new Map<string, WorldFeature>();

  registerHandler(handler: NodeHandler): void {
    if (this.handlers.has(handler.type)) {
      console.warn(`[GameEngineRegistry] Overwriting handler for type: ${handler.type}`);
    }
    this.handlers.set(handler.type, handler);
  }

  registerFeature(feature: WorldFeature): void {
    if (this.features.has(feature.id)) {
      console.warn(`[GameEngineRegistry] Overwriting feature: ${feature.id}`);
    }
    this.features.set(feature.id, feature);
  }

  getHandler(type: string): NodeHandler | undefined {
    return this.handlers.get(type);
  }

  hasHandler(type: string): boolean {
    return this.handlers.has(type);
  }

  getAllHandlers(): NodeHandler[] {
    return [...this.handlers.values()];
  }

  getAllFeatures(): WorldFeature[] {
    return [...this.features.values()];
  }

  getFeature(id: string): WorldFeature | undefined {
    return this.features.get(id);
  }

  /** Auto-generate prompt fragment listing all registered node types with descriptions + examples */
  buildHandlerPrompt(): string {
    if (this.handlers.size === 0) return "";

    let prompt = "## Node Type Reference\n\n";
    for (const handler of this.handlers.values()) {
      prompt += `### ${handler.type}\n`;
      prompt += `${handler.description}\n`;
      prompt += `Required fields: ${handler.requiredFields.join(", ")}\n`;
      if (handler.optionalFields?.length) {
        prompt += `Optional fields: ${handler.optionalFields.join(", ")}\n`;
      }
      prompt += `Example:\n\`\`\`json\n${JSON.stringify(handler.exampleNode, null, 2)}\n\`\`\`\n\n`;
    }
    return prompt;
  }

  /** Auto-generate prompt fragment with current world state from all active features */
  buildWorldStatePrompt(dgsm: DynamicGameStateManager): string {
    const sections: string[] = [];
    for (const feature of this.features.values()) {
      const state = feature.stateDescription(dgsm);
      if (state) {
        sections.push(`### ${feature.description}\n${state}`);
      }
    }
    if (sections.length === 0) return "";
    return "## Current World State\n\n" + sections.join("\n\n") + "\n";
  }

  /** Auto-generate prompt fragment from all feature planningPrompts (field schemas + semantics) */
  buildFeaturePlanningPrompt(): string {
    const sections: string[] = [];
    for (const feature of this.features.values()) {
      if (feature.planningPrompt) {
        sections.push(feature.planningPrompt);
      }
    }
    return sections.join("\n\n");
  }
}
