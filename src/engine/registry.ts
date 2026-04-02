import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type {
  ActivateResult,
  NodeHandler,
  NodeStartBlockedResult,
  WorldFeature,
} from "./types.js";

/**
 * Fields that belong to the base PlanNode schema (not type-specific).
 * Used to filter handler fields when generating the output schema.
 */
const BASE_NODE_FIELDS = new Set([
  "nodeId",
  "startTime",
  "endTime",
  "action",
  "type",
  "skill",
  "impact",
  "status",
  "difficulty",
  "executionMeta",
  "characterId",
  "characterName",
  "outcome",
]);

export class GameEngineRegistry {
  private handlers = new Map<string, NodeHandler>();
  private features = new Map<string, WorldFeature>();

  registerHandler(handler: NodeHandler): void {
    if (this.handlers.has(handler.type)) {
      console.warn(
        `[GameEngineRegistry] Overwriting handler for type: ${handler.type}`
      );
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

  /** Generate the impact level prompt (engine-owned, not feature-owned) */
  buildImpactPrompt(): string {
    return `## Impact Levels

The \`impact\` field on every PlanNode determines **who in the game world perceives and reacts to** the action. The tick engine propagates events outward based on this level:

- **0 — Private / unnoticed**: Only the acting character knows. No one else perceives or reacts.
  Examples: thinking, reading alone, checking belongings, observing from afar, writing notes, resting
- **1 — Targeted / one-on-one**: Only the specific target character perceives it. A private exchange.
  Examples: whispering, passing a note, pickpocketing someone, private conversation, discreet item handoff
- **2 — Sub-scene / room-wide**: Everyone in the current room or sub-scene perceives it. Visible/audible to bystanders.
  Examples: speaking loudly, firing a gun, breaking a door, starting a fight, searching a room openly, screaming
- **3 — Building / macro-location-wide**: Everyone in the same building or macro location perceives it (all rooms/floors).
  Examples: fire alarm, shouting down a stairwell, smoke filling the building, event audible throughout
- **4 — Neighborhood**: Perceived at the current building and nearby buildings within walking distance.
  Examples: explosion heard across the block, gunshot echoing, building collapse, large fire
- **5 — Global / far-reaching**: The entire game world is affected. Consequences ripple everywhere.
  Examples: triggering a town alarm, summoning ritual, radio broadcast, earthquake

**Required field:** \`"impact": 0|1|2|3|4|5\` on every PlanNode.`;
  }

  /** Auto-generate full planning prompt: impact levels + all feature prompts */
  buildPlanningPrompt(): string {
    const sections: string[] = [this.buildImpactPrompt()];
    for (const feature of this.features.values()) {
      if (feature.planningPrompt) {
        sections.push(feature.planningPrompt);
      }
    }
    return sections.join("\n\n");
  }

  // ===== Output schema helpers =====

  /**
   * Extract type-specific fields from a handler by filtering out base fields.
   * Returns required/optional extras and example values for those extras.
   */
  private getTypeSpecificFields(handler: NodeHandler): {
    required: string[];
    optional: string[];
    exampleExtras: Record<string, unknown>;
  } {
    const required = handler.requiredFields.filter(
      (f) => !BASE_NODE_FIELDS.has(f)
    );
    const optional = (handler.optionalFields ?? []).filter(
      (f) => !BASE_NODE_FIELDS.has(f)
    );

    const exampleExtras: Record<string, unknown> = {};
    for (const key of Object.keys(handler.exampleNode)) {
      if (!BASE_NODE_FIELDS.has(key) && key !== "type") {
        exampleExtras[key] = (handler.exampleNode as Record<string, unknown>)[
          key
        ];
      }
    }

    return { required, optional, exampleExtras };
  }

  /**
   * Build a complete example JSON node merging base + type-specific fields.
   */
  private buildCompleteExample(
    handler: NodeHandler,
    extras: Record<string, unknown>
  ): Record<string, unknown> {
    const example: Record<string, unknown> = {
      nodeId: (handler.exampleNode.nodeId as string) ?? "ci1",
      startTime: (handler.exampleNode.startTime as string) ?? "09:00",
      endTime: (handler.exampleNode.endTime as string) ?? "09:05",
      action: (handler.exampleNode.action as string) ?? "Example action",
      type: handler.type,
    };

    if (handler.exampleNode.skill) {
      example.skill = handler.exampleNode.skill;
    }

    example.impact = handler.exampleNode.impact ?? 0;

    // Merge type-specific extras
    for (const [k, v] of Object.entries(extras)) {
      example[k] = v;
    }

    return example;
  }

  /**
   * Auto-generate the output schema prompt for planning templates.
   * Produces a 5-section output:
   * 1. Assembly instruction
   * 2. Base Fields (player vs NPC variant)
   * 3. Type-Specific Additional Fields (per handler)
   * 4. Feature Overlays (from planNodeSchema)
   * 5. Complete Example (one assembled JSON node)
   *
   * @param options.extraInstructions - additional output instructions
   */
  buildOutputSchemaPrompt(options?: {
    extraInstructions?: string;
    language?: string;
  }): string {
    const typeNames =
      this.handlers.size > 0
        ? [...this.handlers.keys()].join("|")
        : "routine|movement|character_interaction|object_interaction|scene_interaction";

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

    // Section 1: Assembly instruction
    sections.push("");
    sections.push(
      'The top-level object has a `"node"` field (your one next action) and an optional `"updatedShortTermIntent"` field (update your current focus if it shifted).'
    );
    sections.push("");
    sections.push("The node is a single flat JSON object combining:");
    sections.push("1. All **Base Fields** (required on every node)");
    sections.push(
      "2. **Type-specific fields** for the chosen `type` (see below — omit if type has none)"
    );
    sections.push(
      "3. **Feature overlay fields** if the action involves an active world feature (see below)"
    );

    // Section 2: Top-level structure + Base Fields
    sections.push("");
    sections.push("### Response Structure");
    sections.push("```json");
    sections.push(
      JSON.stringify(
        {
          node: {
            nodeId: "unique-id",
            startTime: "HH:MM",
            endTime: "HH:MM",
            action: "description of what the character does",
            type: typeNames,
            skill: "exact skill name (OMIT if no check needed)",
            impact: 0,
          },
          updatedShortTermIntent:
            "optional — update your current focus if it changed",
        },
        null,
        2
      )
    );
    sections.push("```");
    sections.push("");
    sections.push(
      "- `updatedShortTermIntent`: set this if your focus has shifted. Omit if unchanged."
    );

    // Section 3: Type-Specific Additional Fields (show ALL types)
    const typeSpecSections: string[] = [];
    for (const handler of this.handlers.values()) {
      const { required, optional, exampleExtras } =
        this.getTypeSpecificFields(handler);

      const lines: string[] = [];
      if (required.length === 0 && optional.length === 0) {
        lines.push(`**${handler.type}**: no additional fields`);
      } else {
        lines.push(`**${handler.type}** adds:`);
        for (const f of required) {
          const exVal =
            exampleExtras[f] !== undefined
              ? ` e.g. ${JSON.stringify(exampleExtras[f])}`
              : "";
          lines.push(`- \`"${f}"\`: (REQUIRED)${exVal}`);
        }
        for (const f of optional) {
          const exVal =
            exampleExtras[f] !== undefined
              ? ` e.g. ${JSON.stringify(exampleExtras[f])}`
              : "";
          lines.push(`- \`"${f}"\`: (optional)${exVal}`);
        }
      }
      typeSpecSections.push(lines.join("\n"));
    }

    if (typeSpecSections.length > 0) {
      sections.push("");
      sections.push("### Type-Specific Additional Fields");
      sections.push("");
      sections.push(typeSpecSections.join("\n\n"));
    }

    // Section 4: Feature Overlays
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

    // Section 5: Complete Example — pick handler with the most extra fields
    let richestHandler: NodeHandler | undefined;
    let richestExtras: Record<string, unknown> = {};
    let maxExtras = 0;
    for (const handler of this.handlers.values()) {
      const { exampleExtras } = this.getTypeSpecificFields(handler);
      const count = Object.keys(exampleExtras).length;
      if (count > maxExtras) {
        maxExtras = count;
        richestHandler = handler;
        richestExtras = exampleExtras;
      }
    }

    if (richestHandler) {
      const fullExample = this.buildCompleteExample(
        richestHandler,
        richestExtras
      );
      sections.push("");
      sections.push("### Complete Example");
      sections.push("```json");
      sections.push(
        JSON.stringify(
          {
            node: fullExample,
            updatedShortTermIntent: "optional — update if focus changed",
          },
          null,
          2
        )
      );
      sections.push("```");
    }

    return sections.join("\n") + "\n";
  }
}
