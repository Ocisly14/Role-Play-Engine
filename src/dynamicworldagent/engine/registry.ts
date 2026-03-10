import type { DynamicGameStateManager } from "../state/DynamicGameState.js";
import type { NodeHandler, WorldFeature } from "./types.js";

/**
 * Fields that belong to the base PlanNode schema (not type-specific).
 * Used to filter handler fields when generating the output schema.
 */
const BASE_NODE_FIELDS = new Set([
  "nodeId", "gameTime", "action", "location", "type",
  "actionType", "impact", "status",
  "difficulty", "timeAdvanceMinutes",
  "characterId", "characterName", "isPlayer", "outcome",
]);

export class GameEngineRegistry {
  private handlers = new Map<string, NodeHandler>();
  private features = new Map<string, WorldFeature>();
  private featureTickCounters = new Map<string, number>();

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

  // ===== Tick counter management =====

  /** Reset all feature tick counters (call at session start) */
  resetTickCounters(): void {
    this.featureTickCounters.clear();
  }

  /** Increment tick counter for a feature, return true if feature should fire this tick */
  shouldFeatureFire(featureId: string, isFullTick: boolean): boolean {
    if (!isFullTick) return false;
    const current = (this.featureTickCounters.get(featureId) ?? 0) + 1;
    this.featureTickCounters.set(featureId, current);
    const feature = this.features.get(featureId);
    if (!feature) return false;
    return current % feature.tickInterval === 0;
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
    const required = handler.requiredFields.filter(f => !BASE_NODE_FIELDS.has(f));
    const optional = (handler.optionalFields ?? []).filter(f => !BASE_NODE_FIELDS.has(f));

    const exampleExtras: Record<string, unknown> = {};
    for (const key of Object.keys(handler.exampleNode)) {
      if (!BASE_NODE_FIELDS.has(key) && key !== "type") {
        exampleExtras[key] = (handler.exampleNode as Record<string, unknown>)[key];
      }
    }

    return { required, optional, exampleExtras };
  }

  /**
   * Build a complete example JSON node merging base + type-specific fields.
   */
  private buildCompleteExample(
    handler: NodeHandler,
    extras: Record<string, unknown>,
    isPlayer: boolean
  ): Record<string, unknown> {
    const example: Record<string, unknown> = {
      nodeId: (handler.exampleNode.nodeId as string) ?? "ci1",
      action: (handler.exampleNode.action as string) ?? "Example action",
      location: (handler.exampleNode.location as string) ?? "example_location",
      type: handler.type,
    };

    if (handler.exampleNode.actionType) {
      example.actionType = handler.exampleNode.actionType;
      if (isPlayer) {
        example.difficulty = "regular";
      }
    }

    example.impact = handler.exampleNode.impact ?? 0;

    if (isPlayer) {
      example.timeAdvanceMinutes = handler.exampleNode.timeAdvanceMinutes ?? 10;
    } else {
      example.gameTime = handler.exampleNode.gameTime ?? "09:00";
    }

    example.status = "pending";

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
   * 4. Feature Fields (from planNodeFields)
   * 5. Complete Example (one assembled JSON node)
   *
   * @param options.isPlayer - if true, uses timeAdvanceMinutes + difficulty; if false, uses gameTime
   * @param options.extraInstructions - additional output instructions
   */
  buildOutputSchemaPrompt(options?: {
    isPlayer?: boolean;
    extraInstructions?: string;
  }): string {
    const isPlayer = options?.isPlayer ?? false;
    const typeNames = this.handlers.size > 0
      ? [...this.handlers.keys()].join("|")
      : "routine|movement|character_interaction|object_interaction|scene_interaction";

    const sections: string[] = [];

    // Header
    sections.push("## Output");
    sections.push("Return a JSON array of PlanNode objects. No extra text. Always write in English.");
    if (options?.extraInstructions) {
      sections.push(options.extraInstructions);
    }

    // Section 1: Assembly instruction
    sections.push("");
    sections.push("Each node is a single flat JSON object combining:");
    sections.push("1. All **Base Fields** (required on every node)");
    sections.push("2. **Type-specific fields** for the chosen `type` (see below — omit if type has none)");
    sections.push("3. **Feature fields** if applicable (see below)");

    // Section 2: Base Fields
    sections.push("");
    sections.push("### Base Fields (every node)");
    const baseJson: Record<string, string | number> = {
      nodeId: "unique-id",
    };
    if (!isPlayer) {
      baseJson.gameTime = "HH:MM";
    }
    baseJson.action = "description of what the character does";
    baseJson.location = "sceneId";
    baseJson.type = typeNames;
    baseJson.actionType = "exploration|social|combat|stealth|chase|mental|environmental|narrative (OMIT if no skill check)";
    if (isPlayer) {
      baseJson.difficulty = "regular|hard|extreme (only when actionType present)";
    }
    baseJson.impact = 0;
    if (isPlayer) {
      baseJson.timeAdvanceMinutes = 15;
    }
    baseJson.status = "pending";

    sections.push("```json");
    sections.push(JSON.stringify(baseJson, null, 2));
    sections.push("```");

    // Section 3: Type-Specific Additional Fields
    const typeSpecSections: string[] = [];
    for (const handler of this.handlers.values()) {
      const { required, optional, exampleExtras } = this.getTypeSpecificFields(handler);
      if (required.length === 0 && optional.length === 0) continue;

      const lines: string[] = [];
      lines.push(`**${handler.type}** adds:`);
      for (const f of required) {
        const exVal = exampleExtras[f] !== undefined
          ? ` e.g. ${JSON.stringify(exampleExtras[f])}`
          : "";
        lines.push(`- \`"${f}"\`: (REQUIRED)${exVal}`);
      }
      for (const f of optional) {
        const exVal = exampleExtras[f] !== undefined
          ? ` e.g. ${JSON.stringify(exampleExtras[f])}`
          : "";
        lines.push(`- \`"${f}"\`: (optional)${exVal}`);
      }
      typeSpecSections.push(lines.join("\n"));
    }

    if (typeSpecSections.length > 0) {
      sections.push("");
      sections.push("### Type-Specific Additional Fields");
      sections.push("");
      sections.push(typeSpecSections.join("\n\n"));
    }

    // Section 4: Feature Fields
    const featureFieldLines: string[] = [];
    for (const feature of this.features.values()) {
      if (feature.planNodeFields?.length) {
        for (const ff of feature.planNodeFields) {
          featureFieldLines.push(`- \`"${ff.field}"\`: (${ff.type}) ${ff.description}`);
        }
      }
    }
    if (featureFieldLines.length > 0) {
      sections.push("");
      sections.push("### Feature Fields");
      sections.push("");
      sections.push(featureFieldLines.join("\n"));
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
      const fullExample = this.buildCompleteExample(richestHandler, richestExtras, isPlayer);
      sections.push("");
      sections.push("### Complete Example");
      sections.push("```json");
      sections.push(JSON.stringify([fullExample], null, 2));
      sections.push("```");
    }

    return sections.join("\n") + "\n";
  }

}
