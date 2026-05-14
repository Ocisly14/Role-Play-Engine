# Dynamic Output Schema for Planning Templates

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace hardcoded "super-schema" JSON in planning templates with registry-generated output schema composed from handler + feature declarations.

**Architecture:** Registry gains `buildOutputSchemaPrompt()` that assembles output JSON schema from base fields + references to handler examples + feature-declared fields. Templates use this instead of hardcoded JSON. WorldFeature gains optional `planNodeFields` for future extensibility.

**Tech Stack:** TypeScript, existing GameEngineRegistry / template system

---

### Task 1: Add `planNodeFields` to WorldFeature interface

**Files:**
- Modify: `src/dynamicworldagent/engine/types.ts:78-111`

**Step 1: Add planNodeFields to WorldFeature**

In `types.ts`, add the optional `planNodeFields` property to `WorldFeature` interface, after the `planningPrompt` field (line 100):

```typescript
export interface WorldFeature {
  /** Unique identifier */
  id: string;

  /** Human-readable description */
  description: string;

  /** How many full ticks between settlements (1 = every tick, 2 = every 10 min) */
  tickInterval: number;

  /**
   * Spatial scope of this feature's effects.
   * A number (0-5) uses the impact level scale.
   * "dynamic" means scope follows each action's own impact level.
   */
  impactScope: number | "dynamic";

  /**
   * Static prompt section describing this feature's effects.
   * Injected into the planning agent prompt. Should NOT describe impact levels
   * (those are handled by the engine). Return "" to omit.
   */
  planningPrompt: string;

  /**
   * Optional fields this feature adds to every PlanNode output.
   * Used by the registry to build the output schema prompt.
   * Return undefined or [] if this feature adds no node fields.
   */
  planNodeFields?: Array<{ field: string; type: string; description: string }>;

  /** Generate current state description for LLM context. Return "" to omit. */
  stateDescription(dgsm: DynamicGameStateManager): string;

  /** Called at tick end. Receives all actions from this tick. */
  onTickEnd(
    tickActions: CharacterAction[],
    dgsm: DynamicGameStateManager,
    runtime: TickRuntimeContext
  ): Promise<WorldFeatureResult>;
}
```

**Step 2: Build and verify**

Run: `pnpm build`
Expected: Passes (planNodeFields is optional, so existing features don't break)


---

### Task 2: Add `buildOutputSchemaPrompt()` to GameEngineRegistry

**Files:**
- Modify: `src/dynamicworldagent/engine/registry.ts:60-123`

**Step 1: Add the method to GameEngineRegistry**

Add `buildOutputSchemaPrompt()` after `buildPlanningPrompt()` (after line 123). This method generates the output JSON schema dynamically from registered handlers and features.

```typescript
  /**
   * Auto-generate the output schema prompt for planning templates.
   * Composes base fields + references to handler examples + feature fields.
   * @param options.isPlayer - if true, includes difficulty and timeAdvanceMinutes fields
   * @param options.extraInstructions - additional output instructions (e.g. language, time constraints)
   */
  buildOutputSchemaPrompt(options?: {
    isPlayer?: boolean;
    extraInstructions?: string;
  }): string {
    const typeNames = this.handlers.size > 0
      ? [...this.handlers.keys()].join("|")
      : "routine|movement|character_interaction|object_interaction|scene_interaction";

    const lines: string[] = [];

    // Base JSON structure
    lines.push("```json");
    lines.push("[");
    lines.push("  {");
    lines.push(`    "nodeId": "unique-id",`);
    lines.push(`    "gameTime": "HH:MM",`);
    lines.push(`    "action": "description of what the character does",`);
    lines.push(`    "location": "sceneId",`);
    lines.push(`    "type": "${typeNames}",`);
    lines.push(`    "actionType": "exploration|social|combat|stealth|chase|mental|environmental|narrative (OMIT if no skill check)",`);
    if (options?.isPlayer) {
      lines.push(`    "difficulty": "regular|hard|extreme (only when actionType present)",`);
    }
    lines.push(`    "impact": 0,`);
    if (options?.isPlayer) {
      lines.push(`    "timeAdvanceMinutes": 15,`);
    }
    lines.push(`    "status": "pending",`);
    lines.push(`    "...type-specific fields": "see Node Type Reference above"`);

    // Feature-declared fields
    const featureFields: Array<{ field: string; type: string; description: string }> = [];
    for (const feature of this.features.values()) {
      if (feature.planNodeFields?.length) {
        featureFields.push(...feature.planNodeFields);
      }
    }
    for (const ff of featureFields) {
      lines.push(`    "${ff.field}": "(${ff.type}) ${ff.description}"`);
    }

    lines.push("  }");
    lines.push("]");
    lines.push("```");

    let prompt = "## Output\n";
    prompt += "Return a JSON array of PlanNode objects. No extra text. Always write in English.\n";
    if (options?.extraInstructions) {
      prompt += options.extraInstructions + "\n";
    }
    prompt += "\nEach node contains **base fields** plus **type-specific fields** from the Node Type Reference above. Only include optional/type-specific fields when relevant.\n\n";
    prompt += lines.join("\n") + "\n";

    return prompt;
  }
```

**Step 2: Build and verify**

Run: `pnpm build`
Expected: Passes


---

### Task 3: Update PlayerPlanTemplate to use dynamic output schema

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanTemplate.ts`

**Step 1: Add outputSchemaPrompt to PlayerPlanParams**

Add the field to the interface (after `planningPrompt`):

```typescript
export interface PlayerPlanParams {
  // ...existing fields...
  /** Registry-generated prompt: impact levels + all feature planning prompts */
  planningPrompt?: string;
  /** Registry-generated output schema prompt */
  outputSchemaPrompt?: string;
}
```

**Step 2: Replace hardcoded output JSON with dynamic schema**

In `buildPlayerPlanPrompt()`, replace the entire `## Output` section (lines 190-214) and the hardcoded JSON with `${params.outputSchemaPrompt || DEFAULT_OUTPUT_SCHEMA}`.

Add a fallback constant after `DEFAULT_NODE_TYPE_REFERENCE`:

```typescript
const DEFAULT_PLAYER_OUTPUT_SCHEMA = `## Output
Return a JSON array of PlanNode objects. No extra text.
Only include optional fields (actionType, difficulty, targetCharacterId, payloads, sceneConnectionEffect) when relevant. Omit them otherwise.

Each node contains **base fields** plus **type-specific fields** from the Node Type Reference above. Only include optional/type-specific fields when relevant.

\`\`\`json
[
  {
    "nodeId": "unique-id",
    "gameTime": "HH:MM",
    "action": "description of what the player does",
    "location": "${"${params.currentScenarioId}"}",
    "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
    "actionType": "exploration|social|combat|stealth|chase|mental|environmental|narrative (OMIT if no skill check needed)",
    "difficulty": "regular|hard|extreme (only when actionType present)",
    "impact": 0,
    "timeAdvanceMinutes": 15,
    "status": "pending",
    "...type-specific fields": "see Node Type Reference above"
  }
]
\`\`\``;
```

Wait — the default uses `${params.currentScenarioId}` which is a template param. We can't put that in a const. Let me revise:

The default fallback should be a function, or we handle it differently. Actually, the simplest approach: keep a static default that doesn't reference params, and the dynamic version from registry also doesn't. The `currentScenarioId` hint was just helpful context — not essential for the schema.

Replace the `## Output` section (from `## Time Advance` to end of template) with:

```typescript
${params.outputSchemaPrompt || DEFAULT_PLAYER_OUTPUT_SCHEMA}

Only include optional fields (actionType, difficulty, targetCharacterId, payloads, sceneConnectionEffect) when relevant. Omit them otherwise.`;
```

Actually, let me keep this simpler. The fallback default is a plain string. The template just does:

```typescript
${params.outputSchemaPrompt || DEFAULT_PLAYER_OUTPUT_SCHEMA}`;
```

Where `DEFAULT_PLAYER_OUTPUT_SCHEMA` is a const string containing the current hardcoded output section (but restructured to match the new pattern).

Full replacement for the end of `buildPlayerPlanPrompt` (replace everything from `## Time Advance` onward):

```typescript
## Time Advance
Estimate realistic minutes for each action:
- Quick action (glance, pick up): 5
- Short conversation: 10-15
- Detailed investigation: 15-30
- Travel between scenes: 15-30
- Extended activity: 30-60

${params.outputSchemaPrompt || DEFAULT_PLAYER_OUTPUT_SCHEMA}`;
```

And the default:

```typescript
const DEFAULT_PLAYER_OUTPUT_SCHEMA = `## Output
Return a JSON array of PlanNode objects. No extra text outside the JSON.

Each node contains **base fields** plus **type-specific fields** from the Node Type Reference above. Only include optional/type-specific fields when relevant.

\\\`\\\`\\\`json
[
  {
    "nodeId": "unique-id",
    "gameTime": "HH:MM",
    "action": "description of what the player does",
    "location": "sceneId",
    "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
    "actionType": "exploration|social|combat|stealth|chase|mental|environmental|narrative (OMIT if no skill check needed)",
    "difficulty": "regular|hard|extreme (only when actionType present)",
    "impact": 0,
    "timeAdvanceMinutes": 15,
    "status": "pending",
    "...type-specific fields": "see Node Type Reference above"
  }
]
\\\`\\\`\\\``;
```

**Step 3: Build and verify**

Run: `pnpm build`
Expected: Passes

---

### Task 4: Update NPCPlanningTemplate to use dynamic output schema

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningTemplate.ts`

**Step 1: Add outputSchemaPrompt to DailyPlanParams**

```typescript
export interface DailyPlanParams {
  // ...existing fields...
  /** Registry-generated prompt: impact levels + all feature planning prompts */
  planningPrompt?: string;
  /** Registry-generated output schema prompt */
  outputSchemaPrompt?: string;
}
```

**Step 2: Replace hardcoded output JSON**

In `buildGenerateDailyPlanPrompt()`, replace the `## Output` section (lines 132-153) with:

```typescript
${params.outputSchemaPrompt || DEFAULT_NPC_OUTPUT_SCHEMA}`;
```

Add fallback const after `DEFAULT_NPC_NODE_TYPE_REFERENCE`:

```typescript
const DEFAULT_NPC_OUTPUT_SCHEMA = `## Output
Return a JSON array of nodes. No extra text. Always write in English.
Only generate nodes from current time onward. Use concrete "HH:MM" timestamps that reflect realistic timing for each action. Include optional fields only when relevant.

Each node contains **base fields** plus **type-specific fields** from the Node Type Reference above. Only include optional/type-specific fields when relevant.

\\\`\\\`\\\`json
[
  {
    "nodeId": "unique-id",
    "gameTime": "HH:MM",
    "action": "description of what the NPC does",
    "location": "scenarioId where this happens",
    "type": "routine|movement|character_interaction|object_interaction|scene_interaction",
    "actionType": "exploration|social|combat|stealth|chase|mental|environmental|narrative (OMIT if no skill roll)",
    "impact": 0,
    "status": "pending",
    "...type-specific fields": "see Node Type Reference above"
  }
]
\\\`\\\`\\\``;
```

**Step 3: Build and verify**

Run: `pnpm build`
Expected: Passes
---

### Task 5: Update PlayerPlanAgent to pass outputSchemaPrompt

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/PlayerPlanAgent.ts:92-118`

**Step 1: Generate and pass outputSchemaPrompt**

In `generatePlayerNodes()`, after line 95 (`const planningPrompt = ...`), add:

```typescript
const outputSchemaPrompt = registry?.buildOutputSchemaPrompt({
  isPlayer: true,
  extraInstructions: "Only include optional fields (actionType, difficulty, targetCharacterId, payloads, sceneConnectionEffect) when relevant. Omit them otherwise.",
});
```

Then add `outputSchemaPrompt` to the params object (after `planningPrompt` on line 117):

```typescript
const params: PlayerPlanParams = {
  // ...existing...
  planningPrompt,
  outputSchemaPrompt,
};
```

**Step 2: Build and verify**

Run: `pnpm build`
Expected: Passes

---

### Task 6: Update NPCPlanningAgent to pass outputSchemaPrompt

**Files:**
- Modify: `src/dynamicworldagent/dynamicBasicAgent/npcPlanning/NPCPlanningAgent.ts:106-120`

**Step 1: Generate and pass outputSchemaPrompt**

In `generateDailyPlans()`, inside the `npcs.map(async (npc) => {` callback, after line 119 (`planningPrompt: registry?.buildPlanningPrompt()`), add:

```typescript
const prompt = buildGenerateDailyPlanPrompt({
  // ...existing params...
  handlerPrompt: registry?.buildHandlerPrompt(),
  planningPrompt: registry?.buildPlanningPrompt(),
  outputSchemaPrompt: registry?.buildOutputSchemaPrompt({
    isPlayer: false,
    extraInstructions: "Only generate nodes from current time onward. Use concrete \"HH:MM\" timestamps that reflect realistic timing for each action. Include optional fields only when relevant.",
  }),
});
```

**Step 2: Build and verify**

Run: `pnpm build`
Expected: Passes

---

### Task 7: Export new type and final verification

**Step 1: Verify engine exports include planNodeFields type**

The `planNodeFields` type is inline on WorldFeature (not a separate type), so no export changes needed. Verify by checking `src/dynamicworldagent/engine/index.ts` already exports `WorldFeature`.

**Step 2: Full build**

Run: `pnpm build`
Expected: Passes (all 178+ files compiled)

Run: `pnpm build:tsc`
Expected: Only pre-existing unrelated type errors

**Step 3: Commit**

Only if any cleanup was needed. Otherwise, all tasks are already committed.
