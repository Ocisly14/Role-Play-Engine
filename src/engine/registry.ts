import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type {
  ActionDefinition,
  ActivateResult,
  NodeStartBlockedResult,
  WorldFeature,
} from "./types.js";

export class GameEngineRegistry {
  private features = new Map<string, WorldFeature>();
  private definitions = new Map<string, ActionDefinition>();

  registerFeature(feature: WorldFeature): void {
    if (this.features.has(feature.id)) {
      console.warn(`[GameEngineRegistry] Overwriting feature: ${feature.id}`);
    }
    this.features.set(feature.id, feature);
  }

  getAllFeatures(): WorldFeature[] {
    return [...this.features.values()];
  }

  getFeature(id: string): WorldFeature | undefined {
    return this.features.get(id);
  }

  // ===== Definition management =====

  registerDefinition(def: ActionDefinition): void {
    if (this.definitions.has(def.id)) {
      console.warn(`[GameEngineRegistry] Overwriting definition: ${def.id}`);
    }
    this.definitions.set(def.id, def);
  }

  getDefinition(id: string): ActionDefinition | undefined {
    return this.definitions.get(id);
  }

  getAllDefinitions(): ActionDefinition[] {
    return [...this.definitions.values()];
  }

  /** Collect character-level skill modifiers from all registered features */
  collectCharacterPenalties(
    characterId: string,
    dgsm: DynamicGameStateManager
  ): Map<string, number> {
    const penalties = new Map<string, number>();
    for (const feature of this.features.values()) {
      if (!feature.getCharacterSkillModifiers) continue;
      const modifiers = feature.getCharacterSkillModifiers(characterId, dgsm);
      for (const { skill, delta } of modifiers) {
        penalties.set(skill, (penalties.get(skill) ?? 0) + delta);
      }
    }
    return penalties;
  }

  // ===== Propagation state management =====

  private propagationTickCounters = new Map<string, number>();
  private propagationSources = new Map<
    string,
    Array<{ sceneId: string; currentHop: number }>
  >();

  /** Reset all propagation state (call at session start) */
  resetTickCounters(): void {
    this.propagationTickCounters.clear();
    this.propagationSources.clear();
  }

  /** Register a new propagation source for a feature */
  addPropagationSource(featureId: string, sceneId: string): void {
    if (!this.propagationSources.has(featureId)) {
      this.propagationSources.set(featureId, []);
    }
    const sources = this.propagationSources.get(featureId)!;
    if (!sources.some((s) => s.sceneId === sceneId)) {
      sources.push({ sceneId, currentHop: 0 });
    }
  }

  /**
   * Check if a feature's propagation should fire this tick.
   * WARNING: This method increments the internal tick counter as a side effect.
   * Call exactly once per feature per tick.
   */
  shouldPropagationFire(featureId: string, isFullTick: boolean): boolean {
    if (!isFullTick) return false;
    const feature = this.features.get(featureId);
    if (!feature?.propagation) return false;
    const current = (this.propagationTickCounters.get(featureId) ?? 0) + 1;
    this.propagationTickCounters.set(featureId, current);
    return current % feature.propagation.tickInterval === 0;
  }

  /** Get current propagation sources for a feature */
  getPropagationSources(
    featureId: string
  ): Array<{ sceneId: string; currentHop: number }> {
    return this.propagationSources.get(featureId) ?? [];
  }

  /** Update propagation sources after a propagation step */
  updatePropagationSources(
    featureId: string,
    newSources: Array<{ sceneId: string; currentHop: number }>
  ): void {
    const feature = this.features.get(featureId);
    const maxHops = feature?.propagation?.maxHops ?? 0;
    this.propagationSources.set(
      featureId,
      newSources.filter((s) => s.currentHop < maxHops)
    );
  }

  /**
   * Call onNodeStart hooks for features whose overlay fields are present on the node.
   * Called when a node transitions from pending to in_progress (action start time).
   * Returns a blocked result if any feature vetoes the node, otherwise undefined.
   */
  startNodeFeatures(
    node: import("../planning/types.js").PlanNode,
    dgsm: import("../state/DynamicGameState.js").DynamicGameStateManager
  ): NodeStartBlockedResult | undefined {
    for (const feature of this.features.values()) {
      if (!feature.planNodeSchema || !feature.onNodeStart) continue;
      const featureFields = feature.planNodeSchema.requiredFields.map(
        (f) => f.field
      );
      const hasOverlay = featureFields.some(
        (field) => (node as Record<string, unknown>)[field] !== undefined
      );
      if (!hasOverlay) continue;
      const result = feature.onNodeStart(node, dgsm);
      if (result?.blocked) return result;
    }
    return undefined;
  }

  /**
   * Activate feature overlays for a single executed node.
   * Returns collected outcomeNotes from all features that activated on this node.
   * Also registers propagation sources.
   */
  activateNodeFeatures(
    node: import("../planning/types.js").PlanNode,
    dgsm: import("../state/DynamicGameState.js").DynamicGameStateManager
  ): ActivateResult[] {
    const results: ActivateResult[] = [];
    for (const feature of this.features.values()) {
      if (!feature.planNodeSchema || !feature.activate) continue;
      const featureFields = feature.planNodeSchema.requiredFields.map(
        (f) => f.field
      );
      const hasOverlay = featureFields.some(
        (field) => (node as Record<string, unknown>)[field] !== undefined
      );
      if (!hasOverlay) continue;

      const result = feature.activate(node, dgsm);
      if (result?.outcomeNote) {
        results.push(result);
      }
      if (feature.propagation) {
        const sceneId =
          node.type === "movement"
            ? node.destination
            : (() => {
                const pos = dgsm.getCharacterPosition(node.characterId);
                return pos ? dgsm.resolveLocationId(pos) : undefined;
              })();
        if (!sceneId) continue;
        this.addPropagationSource(feature.id, sceneId);
      }
    }
    return results;
  }

  /**
   * Scan executed PlanNodes for feature overlay fields (batch version).
   * Calls activateNodeFeatures per node. Used when per-node results are not needed.
   */
  detectFeatureOverlays(
    executedNodes: import("../planning/types.js").PlanNode[],
    dgsm: import("../state/DynamicGameState.js").DynamicGameStateManager
  ): void {
    for (const node of executedNodes) {
      this.activateNodeFeatures(node, dgsm);
    }
  }

  // ===== Prompt generation =====

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

  /** Auto-generate full planning prompt: all feature prompts */
  buildPlanningPrompt(): string {
    const sections: string[] = [];
    for (const feature of this.features.values()) {
      if (feature.planningPrompt) {
        sections.push(feature.planningPrompt);
      }
    }
    return sections.join("\n\n");
  }

  // ===== Output schema helpers =====

  /**
   * Auto-generate the output schema prompt for planning templates.
   * Sections: base fields, feature overlays.
   */
  buildOutputSchemaPrompt(options?: {
    extraInstructions?: string;
    language?: string;
  }): string {
    const typeNames = "action|movement|character_interaction|object_interaction";

    const langName = options?.language?.startsWith("zh")
      ? "Chinese"
      : "English";

    const sections: string[] = [];

    // Header
    sections.push("## Output");
    sections.push(
      `Return a single JSON object. No extra text. JSON keys must be in English. Write "action" values in ${langName}. Keep "destination", "type", "skill", "nodeId", IDs, and enum values in English.`
    );
    if (options?.extraInstructions) {
      sections.push(options.extraInstructions);
    }

    // Assembly instruction
    sections.push("");
    sections.push(
      'The top-level object has a `"node"` field (your one next action) and an optional `"updatedShortTermIntent"` field (update your current focus if it shifted).'
    );
    sections.push("");
    sections.push("The node is a single flat JSON object combining:");
    sections.push("1. All **Base Fields** (required on every node)");
    sections.push(
      "2. **Feature overlay fields** if the action involves an active world feature (see below)"
    );

    // Response structure
    sections.push("");
    sections.push("### Response Structure");
    sections.push("```json");
    const responseStructure: Record<string, unknown> = {
      node: {
        nodeId: "unique-id",
        startTime: "HH:MM",
        endTime: "HH:MM",
        action: "description of what the character does",
        type: typeNames,
        skill: "exact skill name (OMIT if no check needed)",
      },
      updatedShortTermIntent:
        "optional — update your current focus if it changed",
    };
    sections.push(JSON.stringify(responseStructure, null, 2));
    sections.push("```");
    sections.push("");
    sections.push(
      "- `updatedShortTermIntent`: set this if your focus has shifted. Omit if unchanged."
    );

    // Feature Overlays
    const featureOverlaySections: string[] = [];
    for (const feature of this.features.values()) {
      if (!feature.planNodeSchema) continue;
      const schema = feature.planNodeSchema;

      const lines: string[] = [];
      lines.push(`**${feature.id}** — ${feature.description}`);
      lines.push(`When a node involves ${feature.id}, add these fields:`);
      for (const f of schema.requiredFields) {
        lines.push(
          `- \`"${f.field}"\`: (REQUIRED, ${f.type}) ${f.description}`
        );
      }
      if (schema.optionalFields?.length) {
        for (const f of schema.optionalFields) {
          lines.push(
            `- \`"${f.field}"\`: (optional, ${f.type}) ${f.description}`
          );
        }
      }
      lines.push("");
      lines.push("Example:");
      lines.push("```json");
      lines.push(JSON.stringify(schema.exampleNode, null, 2));
      lines.push("```");

      featureOverlaySections.push(lines.join("\n"));
    }

    if (featureOverlaySections.length > 0) {
      sections.push("");
      sections.push("### Feature Overlays (can be added to ANY node type)");
      sections.push("");
      sections.push(featureOverlaySections.join("\n\n"));
    }

    return sections.join("\n") + "\n";
  }
}
