# State Resolver Output Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hardcoded `StateResolution` type with a definition-driven output schema system where each action definition declares which state change types it uses, and the resolver dynamically builds JSON Schema to constrain LLM output.

**Architecture:** Define a registry of standard state change types (character.hp, item.move, etc.), each with its own JSON Schema. Definitions declare `outputSchema.use: [...]` to select types + optional `custom` fields. At runtime, schemas are assembled, injected into the LLM prompt, and used to validate responses. `applyStateResolution` dispatches by typeId.

**Tech Stack:** TypeScript, Vitest, YAML frontmatter parsing (existing `yaml` package)

---

## File Structure

**New files:**
- `src/engine/resolver/stateChangeTypes.ts` — State change type registry (schemas + descriptions)
- `src/engine/resolver/schemaBuilder.ts` — Assembles JSON Schema from definition's outputSchema
- `src/engine/resolver/stateChangeAppliers.ts` — typeId → apply function dispatch map
- `src/engine/resolver/__tests__/stateChangeTypes.test.ts`
- `src/engine/resolver/__tests__/schemaBuilder.test.ts`
- `src/engine/resolver/__tests__/stateChangeAppliers.test.ts`

**Modified files:**
- `src/engine/types.ts:229-315` — Add `OutputSchemaConfig` type to `ActionDefinition`, deprecate old `StateResolution`
- `src/engine/tool_definitions/loader.ts:17-76` — Parse `outputSchema` from YAML frontmatter
- `src/engine/resolver/stateResolver.ts` — Inject output schema into prompt, validate response, remove narrative
- `src/engine/resolver/applyStateResolution.ts` — Rewrite to use typeId-based dispatch
- `src/engine/runtime/tickProcessor.ts:498-570` — Pass definition to apply, remove narrative references
- `src/engine/tool_definitions/action.md:25-37` — Add outputSchema, remove output from stateDomains
- `src/engine/tool_definitions/character_interaction.md:25-38` — Add outputSchema
- `src/engine/tool_definitions/movement.md:9-14` — Add outputSchema
- `src/engine/tool_definitions/item_modify.md:26-42` — Add outputSchema
- `src/engine/tool_definitions/item_assemble.md:23-37` — Add outputSchema
- `src/engine/tool_definitions/item_disassemble.md:23-37` — Add outputSchema
- `src/engine/resolver/__tests__/stateResolver.test.ts` — Update for new return shape
- `src/engine/resolver/__tests__/applyStateResolution.test.ts` — Update for typeId dispatch

---

### Task 1: State Change Type Registry

**Files:**
- Create: `src/engine/resolver/stateChangeTypes.ts`
- Test: `src/engine/resolver/__tests__/stateChangeTypes.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/engine/resolver/__tests__/stateChangeTypes.test.ts
import {
  STATE_CHANGE_TYPES,
  getStateChangeType,
  getAllStateChangeTypeIds,
} from "../stateChangeTypes.js";

describe("STATE_CHANGE_TYPES", () => {
  it("contains all expected character types", () => {
    const ids = getAllStateChangeTypeIds();
    expect(ids).toContain("character.hp");
    expect(ids).toContain("character.san");
    expect(ids).toContain("character.fatigue");
    expect(ids).toContain("character.condition");
    expect(ids).toContain("character.position");
  });

  it("contains all expected item types", () => {
    const ids = getAllStateChangeTypeIds();
    expect(ids).toContain("item.move");
    expect(ids).toContain("item.destroy");
    expect(ids).toContain("item.create");
    expect(ids).toContain("item.modify");
  });

  it("contains scene, memory, and relationship types", () => {
    const ids = getAllStateChangeTypeIds();
    expect(ids).toContain("scene.condition");
    expect(ids).toContain("memory.event");
    expect(ids).toContain("memory.witness");
    expect(ids).toContain("memory.information");
    expect(ids).toContain("relationship.change");
  });

  it("each type has schema with type=object and properties", () => {
    for (const [id, def] of Object.entries(STATE_CHANGE_TYPES)) {
      expect(def.schema.type).toBe("object");
      expect(def.schema.properties).toBeDefined();
      expect(def.description).toBeTruthy();
    }
  });

  it("getStateChangeType returns correct type", () => {
    const hp = getStateChangeType("character.hp");
    expect(hp).toBeDefined();
    expect(hp!.schema.properties.characterId).toEqual({ type: "string" });
    expect(hp!.schema.properties.delta).toEqual({ type: "number" });
    expect(hp!.schema.required).toContain("characterId");
    expect(hp!.schema.required).toContain("delta");
  });

  it("getStateChangeType returns undefined for unknown type", () => {
    expect(getStateChangeType("unknown.type")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/resolver/__tests__/stateChangeTypes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/engine/resolver/stateChangeTypes.ts

export interface JsonSchemaProperty {
  type: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  enum?: string[];
  description?: string;
}

export interface StateChangeSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties?: boolean;
}

export interface StateChangeTypeDef {
  schema: StateChangeSchema;
  description: string;
}

export const STATE_CHANGE_TYPES: Record<string, StateChangeTypeDef> = {
  // ---- Character ----
  "character.hp": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        delta: { type: "number" },
      },
      required: ["characterId", "delta"],
    },
    description: "HP change (negative = damage)",
  },

  "character.san": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        delta: { type: "number" },
      },
      required: ["characterId", "delta"],
    },
    description: "SAN change (negative = loss)",
  },

  "character.fatigue": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        delta: { type: "number" },
      },
      required: ["characterId", "delta"],
    },
    description: "Fatigue delta",
  },

  "character.condition": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        add: { type: "array", items: { type: "string" } },
        remove: { type: "array", items: { type: "string" } },
      },
      required: ["characterId"],
    },
    description: "Add/remove conditions on a character",
  },

  "character.position": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        sceneId: { type: "string" },
        junction: { type: "string" },
      },
      required: ["characterId", "sceneId"],
    },
    description: "Relocate character to a different scene",
  },

  // ---- Item ----
  "item.move": {
    schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["itemId", "from", "to"],
    },
    description: "Transfer item between locations (NPC id or scene:{sceneId})",
  },

  "item.destroy": {
    schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        from: { type: "string" },
      },
      required: ["itemId"],
    },
    description: "Remove item from world",
  },

  "item.create": {
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        location: { type: "string" },
        properties: { type: "object" },
      },
      required: ["name", "location"],
    },
    description: "Spawn new item at location",
  },

  "item.modify": {
    schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        properties: { type: "object" },
      },
      required: ["itemId", "properties"],
    },
    description: "Update item properties",
  },

  // ---- Scene ----
  "scene.condition": {
    schema: {
      type: "object",
      properties: {
        sceneId: { type: "string" },
        add: { type: "array", items: { type: "string" } },
        remove: { type: "array", items: { type: "string" } },
      },
      required: ["sceneId"],
    },
    description: "Add/remove environmental conditions on a scene",
  },

  // ---- Memory ----
  "memory.event": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        content: { type: "string" },
      },
      required: ["characterId", "content"],
    },
    description: "Event memory for participant",
  },

  "memory.witness": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        content: { type: "string" },
      },
      required: ["characterId", "content"],
    },
    description: "Witness memory for observer",
  },

  "memory.information": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        content: { type: "string" },
      },
      required: ["characterId", "content"],
    },
    description: "Learned information",
  },

  // ---- Relationship ----
  "relationship.change": {
    schema: {
      type: "object",
      properties: {
        fromId: { type: "string" },
        toId: { type: "string" },
        delta: { type: "number" },
        note: { type: "string" },
      },
      required: ["fromId", "toId"],
    },
    description: "Relationship score change between characters",
  },
};

export function getStateChangeType(
  typeId: string
): StateChangeTypeDef | undefined {
  return STATE_CHANGE_TYPES[typeId];
}

export function getAllStateChangeTypeIds(): string[] {
  return Object.keys(STATE_CHANGE_TYPES);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/resolver/__tests__/stateChangeTypes.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add state change type registry"
```

---

### Task 2: Schema Builder

**Files:**
- Create: `src/engine/resolver/schemaBuilder.ts`
- Test: `src/engine/resolver/__tests__/schemaBuilder.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/engine/resolver/__tests__/schemaBuilder.test.ts
import { buildOutputSchema } from "../schemaBuilder.js";
import type { OutputSchemaConfig } from "../../types.js";

describe("buildOutputSchema", () => {
  it("builds schema with standard types wrapped as arrays", () => {
    const config: OutputSchemaConfig = {
      use: ["character.hp", "character.fatigue"],
    };

    const schema = buildOutputSchema(config);

    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties["character.hp"]).toEqual({
      type: "array",
      items: expect.objectContaining({
        type: "object",
        properties: expect.objectContaining({
          characterId: { type: "string" },
          delta: { type: "number" },
        }),
      }),
    });
    expect(schema.properties["character.fatigue"]).toBeDefined();
  });

  it("includes custom fields at top level", () => {
    const config: OutputSchemaConfig = {
      use: ["memory.event"],
      custom: {
        discoveredClue: {
          type: "string",
          description: "Clue ID if found",
        },
      },
    };

    const schema = buildOutputSchema(config);

    expect(schema.properties["memory.event"]).toBeDefined();
    expect(schema.properties.discoveredClue).toEqual({
      type: "string",
      description: "Clue ID if found",
    });
  });

  it("handles string[] custom type", () => {
    const config: OutputSchemaConfig = {
      use: [],
      custom: {
        tags: {
          type: "string[]",
          description: "Tags",
        },
      },
    };

    const schema = buildOutputSchema(config);

    expect(schema.properties.tags).toEqual({
      type: "array",
      items: { type: "string" },
      description: "Tags",
    });
  });

  it("throws on unknown state change type", () => {
    const config: OutputSchemaConfig = {
      use: ["unknown.type"],
    };

    expect(() => buildOutputSchema(config)).toThrow("unknown.type");
  });

  it("produces empty properties when use is empty and no custom", () => {
    const config: OutputSchemaConfig = { use: [] };
    const schema = buildOutputSchema(config);

    expect(Object.keys(schema.properties)).toHaveLength(0);
    expect(schema.additionalProperties).toBe(false);
  });

  it("builds a complete schema for a realistic definition", () => {
    const config: OutputSchemaConfig = {
      use: [
        "character.hp",
        "character.san",
        "character.condition",
        "item.move",
        "memory.event",
        "relationship.change",
      ],
    };

    const schema = buildOutputSchema(config);

    expect(Object.keys(schema.properties)).toHaveLength(6);
    for (const typeId of config.use) {
      expect(schema.properties[typeId]).toBeDefined();
      expect(schema.properties[typeId].type).toBe("array");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/resolver/__tests__/schemaBuilder.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/engine/resolver/schemaBuilder.ts

import { STATE_CHANGE_TYPES } from "./stateChangeTypes.js";
import type { OutputSchemaConfig, CustomFieldDef } from "../types.js";

export interface JsonSchema {
  type: string;
  properties: Record<string, any>;
  additionalProperties: boolean;
}

function customFieldToJsonSchema(fieldDef: CustomFieldDef): Record<string, any> {
  if (fieldDef.type === "string[]") {
    return {
      type: "array",
      items: { type: "string" },
      ...(fieldDef.description ? { description: fieldDef.description } : {}),
    };
  }
  if (fieldDef.type === "number[]") {
    return {
      type: "array",
      items: { type: "number" },
      ...(fieldDef.description ? { description: fieldDef.description } : {}),
    };
  }
  return {
    type: fieldDef.type,
    ...(fieldDef.description ? { description: fieldDef.description } : {}),
  };
}

export function buildOutputSchema(config: OutputSchemaConfig): JsonSchema {
  const properties: Record<string, any> = {};

  for (const typeId of config.use) {
    const changeType = STATE_CHANGE_TYPES[typeId];
    if (!changeType) {
      throw new Error(
        `Unknown state change type: "${typeId}". Available types: ${Object.keys(STATE_CHANGE_TYPES).join(", ")}`
      );
    }
    properties[typeId] = {
      type: "array",
      items: changeType.schema,
    };
  }

  if (config.custom) {
    for (const [name, fieldDef] of Object.entries(config.custom)) {
      properties[name] = customFieldToJsonSchema(fieldDef);
    }
  }

  return {
    type: "object",
    properties,
    additionalProperties: false,
  };
}

/**
 * Format the output schema as a prompt section for the LLM.
 * Shows the JSON Schema and describes each field.
 */
export function formatOutputSchemaPrompt(config: OutputSchemaConfig): string {
  const schema = buildOutputSchema(config);
  const lines: string[] = [];

  lines.push("## Output Format");
  lines.push("");
  lines.push("Respond with a JSON object matching this schema exactly. Do not include any fields not listed here. Each state change type is an array (may be empty or omitted if no changes of that type).");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(schema, null, 2));
  lines.push("```");
  lines.push("");

  // Add human-readable descriptions
  lines.push("### Field Descriptions");
  for (const typeId of config.use) {
    const changeType = STATE_CHANGE_TYPES[typeId];
    lines.push(`- **${typeId}**: ${changeType.description}`);
  }
  if (config.custom) {
    for (const [name, fieldDef] of Object.entries(config.custom)) {
      lines.push(`- **${name}**: ${fieldDef.description ?? fieldDef.type}`);
    }
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/resolver/__tests__/schemaBuilder.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add schema builder for definition-driven output"
```

---

### Task 3: Types and Loader Updates

**Files:**
- Modify: `src/engine/types.ts:229-256`
- Modify: `src/engine/tool_definitions/loader.ts:17-76`

- [ ] **Step 1: Add OutputSchemaConfig and CustomFieldDef types to types.ts**

Add after `StateDomainSpec` (line 233):

```typescript
// After the existing StateDomainSpec interface (line 233), add:

export interface CustomFieldDef {
  type: string;
  description?: string;
}

export interface OutputSchemaConfig {
  use: string[];
  custom?: Record<string, CustomFieldDef>;
}
```

Add `outputSchema` to `ActionDefinition` (line 245-256):

```typescript
export interface ActionDefinition {
  id: string;
  title: string;
  description: string;
  content: string;
  guidanceBody: string;
  skillCheck?: ActionDefinitionSkillCheck;
  stateDomains?: Record<string, StateDomainSpec>;
  outputSchema?: OutputSchemaConfig;  // NEW
  interpreter?: ActionDefinitionInterpreter;
  featureOverlay?: Record<string, unknown>;
  impactHint?: ActionDefinitionImpactHint;
}
```

- [ ] **Step 2: Update loader.ts to parse outputSchema**

In `loader.ts`, add `OutputSchemaConfig` to the `YamlFrontmatter` interface (line 17-26):

```typescript
interface YamlFrontmatter {
  id?: string;
  title?: string;
  description?: string;
  interpreter?: ActionDefinitionInterpreter;
  skillCheck?: ActionDefinitionSkillCheck;
  stateDomains?: Record<string, StateDomainSpec>;
  outputSchema?: import("../types.js").OutputSchemaConfig;  // NEW
  featureOverlay?: Record<string, unknown>;
  impactHint?: ActionDefinitionImpactHint;
}
```

In `loadActionDefinitions()` return object (line 64-75), add `outputSchema`:

```typescript
return {
  id: frontmatter.id ?? id,
  title,
  description: frontmatter.description ?? title,
  content: raw,
  guidanceBody: body,
  skillCheck: frontmatter.skillCheck,
  stateDomains: frontmatter.stateDomains,
  outputSchema: frontmatter.outputSchema,  // NEW
  interpreter: frontmatter.interpreter,
  featureOverlay: frontmatter.featureOverlay,
  impactHint: frontmatter.impactHint,
};
```

- [ ] **Step 3: Run existing tests to verify nothing breaks**

Run: `npx vitest run src/engine/resolver/__tests__/stateResolver.test.ts src/engine/resolver/__tests__/applyStateResolution.test.ts`
Expected: PASS (no behavior changes yet)

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add OutputSchemaConfig type and parse from definition frontmatter"
```

---

### Task 4: Update Definition Files

**Files:**
- Modify: `src/engine/tool_definitions/action.md:25-37`
- Modify: `src/engine/tool_definitions/character_interaction.md:25-38`
- Modify: `src/engine/tool_definitions/movement.md:9-14`
- Modify: `src/engine/tool_definitions/item_modify.md:26-42`
- Modify: `src/engine/tool_definitions/item_assemble.md:23-37`
- Modify: `src/engine/tool_definitions/item_disassemble.md:23-37`

- [ ] **Step 1: Add outputSchema to action.md**

Add after `stateDomains` block (after line 37, before the closing `---`):

```yaml
outputSchema:
  use:
    - character.fatigue
    - character.condition
    - scene.condition
    - item.move
    - item.modify
    - item.destroy
    - memory.event
```

- [ ] **Step 2: Add outputSchema to character_interaction.md**

Add after `stateDomains` block (after line 38, before the closing `---`):

```yaml
outputSchema:
  use:
    - character.hp
    - character.san
    - character.fatigue
    - character.condition
    - character.position
    - item.move
    - item.destroy
    - memory.event
    - memory.witness
    - memory.information
    - relationship.change
```

- [ ] **Step 3: Add outputSchema to movement.md**

Add after `stateDomains` block (after line 14, before the closing `---`):

```yaml
outputSchema:
  use:
    - character.fatigue
    - character.position
    - memory.event
    - memory.witness
```

- [ ] **Step 4: Add outputSchema to item_modify.md**

Add after `stateDomains` block (after line 42, before the closing `---`):

```yaml
outputSchema:
  use:
    - item.move
    - item.modify
    - item.destroy
    - character.fatigue
    - memory.event
```

- [ ] **Step 5: Add outputSchema to item_assemble.md**

Add after `stateDomains` block (after line 37, before the closing `---`):

```yaml
outputSchema:
  use:
    - item.move
    - item.modify
    - item.destroy
    - item.create
    - character.fatigue
    - memory.event
```

- [ ] **Step 6: Add outputSchema to item_disassemble.md**

Add after `stateDomains` block (after line 37, before the closing `---`):

```yaml
outputSchema:
  use:
    - item.move
    - item.modify
    - item.destroy
    - item.create
    - character.fatigue
    - memory.event
```

- [ ] **Step 7: Verify definitions load correctly**

Write a quick smoke test:

Run: `npx vitest run src/engine/resolver/__tests__/stateChangeTypes.test.ts`
Expected: PASS (definitions parseable, no errors)

- [ ] **Step 8: Commit**

```bash
git commit -m "feat: add outputSchema to all action definition files"
```

---

### Task 5: State Change Appliers

**Files:**
- Create: `src/engine/resolver/stateChangeAppliers.ts`
- Test: `src/engine/resolver/__tests__/stateChangeAppliers.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/engine/resolver/__tests__/stateChangeAppliers.test.ts
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import { applyByTypeId, STATE_CHANGE_APPLIERS } from "../stateChangeAppliers.js";
import type { OutputSchemaConfig } from "../../types.js";

function makeMockDgsm(): DynamicGameStateManager {
  const npcCharacters: any[] = [
    {
      id: "npc_1",
      name: "Alice",
      status: { hp: 10, sanity: 60, conditions: [] as string[] },
    },
  ];
  const npcInventories: Record<string, any[]> = {
    npc_1: [{ id: "lantern", name: "Lantern", type: "other" }],
  };
  const scenes: Map<string, any> = new Map([
    [
      "scene_study",
      {
        id: "scene_study",
        name: "Study",
        items: [{ id: "book", name: "Old Book", type: "other" }],
      },
    ],
  ]);
  const scenarioConditions: Record<string, any[]> = {};
  const characterPositions: Record<string, any> = {};

  const state: any = {
    npcCharacters,
    npcInventories,
    scenes,
    scenarioConditions,
    characterPositions,
  };

  return {
    getState: () => state,
    updateNpcHp: vi.fn(),
    updateNpcSan: vi.fn(),
    setCharacterPosition: vi.fn(),
    getSceneConditions: vi.fn((id: string) => scenarioConditions[id] ?? []),
    replaceSceneConditions: vi.fn(
      (id: string, conds: any[]) => (scenarioConditions[id] = conds)
    ),
    appendSceneCondition: vi.fn((id: string, cond: any) => {
      if (!scenarioConditions[id]) scenarioConditions[id] = [];
      scenarioConditions[id].push(cond);
    }),
    getNpcInventory: vi.fn((id: string) => npcInventories[id] ?? []),
    addItemToNpc: vi.fn((id: string, item: any) => {
      if (!npcInventories[id]) npcInventories[id] = [];
      npcInventories[id].push(item);
    }),
    removeItemFromNpc: vi.fn((id: string, itemId: string) => {
      if (!npcInventories[id]) return undefined;
      const idx = npcInventories[id].findIndex((i: any) => i.id === itemId);
      if (idx === -1) return undefined;
      return npcInventories[id].splice(idx, 1)[0];
    }),
    getScene: vi.fn((id: string) => scenes.get(id) ?? null),
  } as unknown as DynamicGameStateManager;
}

describe("STATE_CHANGE_APPLIERS", () => {
  it("has an applier for every standard type", () => {
    const expectedTypes = [
      "character.hp",
      "character.san",
      "character.fatigue",
      "character.condition",
      "character.position",
      "item.move",
      "item.destroy",
      "item.create",
      "item.modify",
      "scene.condition",
      "memory.event",
      "memory.witness",
      "memory.information",
      "relationship.change",
    ];
    for (const typeId of expectedTypes) {
      expect(STATE_CHANGE_APPLIERS[typeId]).toBeDefined();
      expect(typeof STATE_CHANGE_APPLIERS[typeId]).toBe("function");
    }
  });
});

describe("applyByTypeId", () => {
  it("applies character.hp changes", () => {
    const dgsm = makeMockDgsm();
    const resolution = {
      "character.hp": [{ characterId: "npc_1", delta: -3 }],
    };
    const config: OutputSchemaConfig = { use: ["character.hp"] };

    applyByTypeId(dgsm, resolution, config);

    expect(dgsm.updateNpcHp).toHaveBeenCalledWith("npc_1", -3);
  });

  it("applies character.condition changes", () => {
    const dgsm = makeMockDgsm();
    const resolution = {
      "character.condition": [
        { characterId: "npc_1", add: ["bleeding"], remove: [] },
      ],
    };
    const config: OutputSchemaConfig = { use: ["character.condition"] };

    applyByTypeId(dgsm, resolution, config);

    const npc = dgsm.getState().npcCharacters.find((n: any) => n.id === "npc_1");
    expect(npc?.status.conditions).toContain("bleeding");
  });

  it("applies scene.condition changes", () => {
    const dgsm = makeMockDgsm();
    const resolution = {
      "scene.condition": [
        { sceneId: "scene_study", add: ["lights are off"] },
      ],
    };
    const config: OutputSchemaConfig = { use: ["scene.condition"] };

    applyByTypeId(dgsm, resolution, config);

    expect(dgsm.appendSceneCondition).toHaveBeenCalledWith("scene_study", {
      description: "lights are off",
    });
  });

  it("skips types not in use list", () => {
    const dgsm = makeMockDgsm();
    const resolution = {
      "character.hp": [{ characterId: "npc_1", delta: -3 }],
      "character.san": [{ characterId: "npc_1", delta: -5 }],
    };
    // Only character.hp is in use — character.san should be ignored
    const config: OutputSchemaConfig = { use: ["character.hp"] };

    applyByTypeId(dgsm, resolution, config);

    expect(dgsm.updateNpcHp).toHaveBeenCalledWith("npc_1", -3);
    expect(dgsm.updateNpcSan).not.toHaveBeenCalled();
  });

  it("skips empty arrays", () => {
    const dgsm = makeMockDgsm();
    const resolution = {
      "character.hp": [],
    };
    const config: OutputSchemaConfig = { use: ["character.hp"] };

    applyByTypeId(dgsm, resolution, config);

    expect(dgsm.updateNpcHp).not.toHaveBeenCalled();
  });

  it("ignores custom fields (not dispatched to appliers)", () => {
    const dgsm = makeMockDgsm();
    const resolution = {
      "character.hp": [{ characterId: "npc_1", delta: -1 }],
      discoveredClue: "clue_001",
    };
    const config: OutputSchemaConfig = {
      use: ["character.hp"],
      custom: { discoveredClue: { type: "string" } },
    };

    // Should not throw
    applyByTypeId(dgsm, resolution, config);
    expect(dgsm.updateNpcHp).toHaveBeenCalledWith("npc_1", -1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/resolver/__tests__/stateChangeAppliers.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/engine/resolver/stateChangeAppliers.ts

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { OutputSchemaConfig } from "../types.js";

type Applier = (dgsm: DynamicGameStateManager, changes: any[]) => void;

export const STATE_CHANGE_APPLIERS: Record<string, Applier> = {
  "character.hp": (dgsm, changes) => {
    for (const c of changes) {
      if (c.delta !== 0) dgsm.updateNpcHp(c.characterId, c.delta);
    }
  },

  "character.san": (dgsm, changes) => {
    for (const c of changes) {
      if (c.delta !== 0) dgsm.updateNpcSan(c.characterId, c.delta);
    }
  },

  "character.fatigue": (dgsm, changes) => {
    for (const c of changes) {
      if (c.delta === 0) continue;
      try {
        const { applyFatigueDelta } =
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require("../../features/staminaFeature.js") as {
            applyFatigueDelta: (
              dgsm: DynamicGameStateManager,
              characterId: string,
              delta: number | undefined
            ) => void;
          };
        applyFatigueDelta(dgsm, c.characterId, c.delta);
      } catch {
        // staminaFeature not available — skip
      }
    }
  },

  "character.condition": (dgsm, changes) => {
    for (const c of changes) {
      const state = dgsm.getState();
      const npc = state.npcCharacters.find(
        (n: any) => n.id === c.characterId
      );
      if (!npc) continue;
      if (c.remove?.length) {
        const toRemove = new Set(c.remove);
        npc.status.conditions = npc.status.conditions.filter(
          (cond: string) => !toRemove.has(cond)
        );
      }
      if (c.add?.length) {
        const existing = new Set(npc.status.conditions);
        for (const cond of c.add) {
          if (!existing.has(cond)) {
            npc.status.conditions.push(cond);
            existing.add(cond);
          }
        }
      }
    }
  },

  "character.position": (dgsm, changes) => {
    for (const c of changes) {
      dgsm.setCharacterPosition(c.characterId, {
        type: "scene",
        sceneId: c.sceneId,
        ...(c.junction ? { junction: c.junction } : {}),
      });
    }
  },

  "item.move": (dgsm, changes) => {
    for (const c of changes) {
      const fromIsScene = c.from?.startsWith("scene:");
      const fromSceneId = fromIsScene ? c.from.slice("scene:".length) : null;
      const fromNpcId = fromIsScene ? null : c.from;

      let movedItem: any;

      if (fromNpcId) {
        movedItem = dgsm.removeItemFromNpc(fromNpcId, c.itemId) ?? undefined;
      }
      if (!movedItem && fromSceneId) {
        const scene = dgsm.getScene(fromSceneId);
        if (scene?.items) {
          const idx = scene.items.findIndex((i: any) => i.id === c.itemId);
          if (idx !== -1) [movedItem] = scene.items.splice(idx, 1);
        }
      }

      if (movedItem && c.to) {
        if (c.to.startsWith("scene:")) {
          const toScene = dgsm.getScene(c.to.slice("scene:".length));
          if (toScene?.items) toScene.items.push(movedItem);
        } else {
          dgsm.addItemToNpc(c.to, movedItem);
        }
      }
    }
  },

  "item.destroy": (dgsm, changes) => {
    for (const c of changes) {
      const state = dgsm.getState();
      for (const npc of state.npcCharacters) {
        dgsm.removeItemFromNpc(npc.id, c.itemId);
      }
      if (c.from) {
        const scene = dgsm.getScene(c.from);
        if (scene?.items) {
          const idx = scene.items.findIndex((i: any) => i.id === c.itemId);
          if (idx !== -1) scene.items.splice(idx, 1);
        }
      }
    }
  },

  "item.create": (dgsm, changes) => {
    for (const c of changes) {
      const newItem = {
        id: `item_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: c.name,
        ...(c.properties ?? {}),
      };
      if (c.location.startsWith("scene:")) {
        const scene = dgsm.getScene(c.location.slice("scene:".length));
        if (scene?.items) scene.items.push(newItem);
      } else {
        dgsm.addItemToNpc(c.location, newItem);
      }
    }
  },

  "item.modify": (dgsm, changes) => {
    for (const c of changes) {
      const state = dgsm.getState();
      let found = false;
      for (const npc of state.npcCharacters) {
        const inv = dgsm.getNpcInventory(npc.id);
        const item = inv.find((i: any) => i.id === c.itemId);
        if (item) {
          Object.assign(item, c.properties);
          found = true;
          break;
        }
      }
      if (!found) {
        for (const scene of state.scenes.values()) {
          if (scene.items) {
            const item = scene.items.find((i: any) => i.id === c.itemId);
            if (item) {
              Object.assign(item, c.properties);
              break;
            }
          }
        }
      }
    }
  },

  "scene.condition": (dgsm, changes) => {
    for (const c of changes) {
      if (c.remove?.length) {
        const toRemove = new Set(c.remove);
        const existing = dgsm.getSceneConditions(c.sceneId);
        const filtered = existing.filter(
          (cond: any) => !toRemove.has(cond.description)
        );
        if (filtered.length !== existing.length) {
          dgsm.replaceSceneConditions(c.sceneId, filtered);
        }
      }
      if (c.add?.length) {
        for (const desc of c.add) {
          dgsm.appendSceneCondition(c.sceneId, { description: desc });
        }
      }
    }
  },

  "memory.event": (_dgsm, _changes) => {
    // Memory writing is handled by the caller (tickProcessor) via memoryManager,
    // not by the applier. This is a no-op placeholder for registry completeness.
  },

  "memory.witness": (_dgsm, _changes) => {
    // Same as memory.event — handled by caller.
  },

  "memory.information": (_dgsm, _changes) => {
    // Same as memory.event — handled by caller.
  },

  "relationship.change": (dgsm, changes) => {
    for (const c of changes) {
      (dgsm as any).updateRelationship?.(c.fromId, c.toId, c.delta, c.note);
    }
  },
};

/**
 * Apply a state resolution by dispatching to type-specific appliers.
 * Only processes types declared in the definition's outputSchema.use.
 * Custom fields are ignored (returned to caller for domain-specific handling).
 */
export function applyByTypeId(
  dgsm: DynamicGameStateManager,
  resolution: Record<string, any>,
  config: OutputSchemaConfig
): void {
  for (const typeId of config.use) {
    const changes = resolution[typeId];
    if (!Array.isArray(changes) || changes.length === 0) continue;
    const applier = STATE_CHANGE_APPLIERS[typeId];
    if (applier) {
      applier(dgsm, changes);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/resolver/__tests__/stateChangeAppliers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "feat: add state change appliers with typeId-based dispatch"
```

---

### Task 6: Refactor StateResolver

**Files:**
- Modify: `src/engine/resolver/stateResolver.ts`
- Modify: `src/engine/resolver/__tests__/stateResolver.test.ts`

- [ ] **Step 1: Update tests for new behavior**

Replace `src/engine/resolver/__tests__/stateResolver.test.ts`:

```typescript
import type { ActionDefinition, OutputSchemaConfig } from "../../types.js";
import {
  buildResolverPrompt,
  parseStateResolution,
  validateResolution,
} from "../stateResolver.js";

const makeDef = (
  guidance: string,
  outputSchema?: OutputSchemaConfig
): ActionDefinition => ({
  id: "test",
  title: "Test",
  description: "Test definition",
  content: guidance,
  guidanceBody: guidance,
  outputSchema,
});

// ─── buildResolverPrompt ──────────────────────────────────────────────────────

describe("buildResolverPrompt", () => {
  it("includes action description in the prompt", () => {
    const prompt = buildResolverPrompt({
      action: "Search the study",
      definition: makeDef("### On Success\n#### item\n- Discover hidden items"),
      outcomeSection: "Discover hidden items",
      stateContext: {
        actorSection: "## Actor\nID: npc_1\nName: Investigator",
        sceneSection: "## Scene\nID: scene_study",
      },
    });

    expect(prompt).toContain("Search the study");
  });

  it("includes definition guidance body", () => {
    const prompt = buildResolverPrompt({
      action: "Search the study",
      definition: makeDef(
        "# Search Guidance\n\nDiscover hidden items in the scene"
      ),
      outcomeSection: "Discover hidden items",
      stateContext: {},
    });

    expect(prompt).toContain("Discover hidden items in the scene");
  });

  it("includes output schema section when definition has outputSchema", () => {
    const prompt = buildResolverPrompt({
      action: "Search the study",
      definition: makeDef("Guidance", {
        use: ["character.hp", "memory.event"],
      }),
      outcomeSection: "find clues",
      stateContext: {},
    });

    expect(prompt).toContain("## Output Format");
    expect(prompt).toContain("character.hp");
    expect(prompt).toContain("memory.event");
  });

  it("includes actor state from stateContext", () => {
    const prompt = buildResolverPrompt({
      action: "Search the study",
      definition: makeDef("On Success: find clues"),
      outcomeSection: "find clues",
      stateContext: {
        actorSection: "## Actor\nID: npc_1\nName: Alice",
      },
    });

    expect(prompt).toContain("npc_1");
    expect(prompt).toContain("Alice");
  });

  it("includes skill check result when provided", () => {
    const prompt = buildResolverPrompt({
      action: "Attempt to persuade",
      definition: makeDef("On Failure: target becomes hostile"),
      outcomeSection: "target becomes hostile",
      stateContext: {},
      skillCheckResult: {
        done: true,
        status: "failed",
        outcomeDescription: "The dice rolled poorly",
        successLevel: "fail",
      },
    });

    expect(prompt).toContain("fail");
    expect(prompt).toContain("The dice rolled poorly");
  });

  it("includes world state from stateContext", () => {
    const prompt = buildResolverPrompt({
      action: "Look around",
      definition: makeDef("On Success: observe the room"),
      outcomeSection: "observe the room",
      stateContext: {
        worldStateSection: "Heavy rain outside. Visibility reduced.",
      },
    });

    expect(prompt).toContain("Heavy rain outside");
  });

  it("respects the language parameter", () => {
    const prompt = buildResolverPrompt({
      action: "Search",
      definition: makeDef("On Success: find clue"),
      outcomeSection: "find clue",
      stateContext: {},
      language: "zh",
    });

    expect(prompt).toContain("zh");
  });

  it("includes target sections when provided", () => {
    const prompt = buildResolverPrompt({
      action: "Talk to the captain",
      definition: makeDef("Social guidance"),
      outcomeSection: "social result",
      stateContext: {
        actorSection: "## Actor\nID: npc_1",
        targetSections:
          "## Target: Captain\nID: captain_wang\nOccupation: Ship Captain",
      },
    });

    expect(prompt).toContain("captain_wang");
    expect(prompt).toContain("Ship Captain");
  });

  it("includes item section when provided", () => {
    const prompt = buildResolverPrompt({
      action: "Pick up the key",
      definition: makeDef("Item guidance"),
      outcomeSection: "item result",
      stateContext: {
        itemSection: "### Scene Items\n- **Rusty Key** (id: key_001)",
      },
    });

    expect(prompt).toContain("key_001");
    expect(prompt).toContain("Rusty Key");
  });

  it("includes feature notes when provided", () => {
    const prompt = buildResolverPrompt({
      action: "Cast ritual",
      definition: makeDef("Ritual guidance"),
      outcomeSection: "ritual result",
      stateContext: {},
      featureNotes: ["Ritual circle activated", "Sanity pressure building"],
    });

    expect(prompt).toContain("Ritual circle activated");
    expect(prompt).toContain("Sanity pressure building");
  });
});

// ─── parseStateResolution ─────────────────────────────────────────────────────

describe("parseStateResolution", () => {
  it("parses valid JSON with state changes", () => {
    const raw = JSON.stringify({
      "character.fatigue": [{ characterId: "npc_1", delta: 1 }],
    });

    const result = parseStateResolution(raw);

    expect(result["character.fatigue"]).toHaveLength(1);
    expect(result["character.fatigue"][0].characterId).toBe("npc_1");
  });

  it("parses JSON wrapped in markdown fences", () => {
    const raw = `Here is the result:\n\`\`\`json\n${JSON.stringify({
      "character.hp": [{ characterId: "npc_alice", delta: -2 }],
    })}\n\`\`\``;

    const result = parseStateResolution(raw);

    expect(result["character.hp"]?.[0].delta).toBe(-2);
  });

  it("returns empty object on invalid JSON", () => {
    const result = parseStateResolution("garbage input not json");

    expect(result).toEqual({});
  });

  it("preserves multiple state change types", () => {
    const raw = JSON.stringify({
      "scene.condition": [
        { sceneId: "scene_hall", add: ["lights are off"] },
      ],
      "memory.event": [
        { characterId: "npc_1", content: "Turned off the lights" },
      ],
    });

    const result = parseStateResolution(raw);

    expect(result["scene.condition"]).toHaveLength(1);
    expect(result["memory.event"]).toHaveLength(1);
  });

  it("preserves custom fields", () => {
    const raw = JSON.stringify({
      "character.hp": [{ characterId: "npc_1", delta: -1 }],
      discoveredClue: "clue_001",
    });

    const result = parseStateResolution(raw);

    expect(result.discoveredClue).toBe("clue_001");
  });
});

// ─── validateResolution ───────────────────────────────────────────────────────

describe("validateResolution", () => {
  it("returns true for valid resolution matching schema", () => {
    const resolution = {
      "character.hp": [{ characterId: "npc_1", delta: -3 }],
    };
    const config: OutputSchemaConfig = { use: ["character.hp"] };

    expect(validateResolution(resolution, config)).toBe(true);
  });

  it("returns true when resolution has empty arrays for declared types", () => {
    const resolution = {
      "character.hp": [],
    };
    const config: OutputSchemaConfig = { use: ["character.hp"] };

    expect(validateResolution(resolution, config)).toBe(true);
  });

  it("returns false when resolution has undeclared types", () => {
    const resolution = {
      "character.hp": [{ characterId: "npc_1", delta: -3 }],
      "character.san": [{ characterId: "npc_1", delta: -5 }],
    };
    // Only character.hp is declared
    const config: OutputSchemaConfig = { use: ["character.hp"] };

    expect(validateResolution(resolution, config)).toBe(false);
  });

  it("returns true for empty resolution", () => {
    const config: OutputSchemaConfig = { use: ["character.hp"] };
    expect(validateResolution({}, config)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/engine/resolver/__tests__/stateResolver.test.ts`
Expected: FAIL — `validateResolution` not exported, return types changed

- [ ] **Step 3: Rewrite stateResolver.ts**

Replace `src/engine/resolver/stateResolver.ts`:

```typescript
/**
 * StateResolver — LLM call that generates state changes from action context.
 *
 * Pure state-change engine: no narrative, no storytelling.
 * Output schema is driven by the action definition's outputSchema config.
 */

import { ModelClass, generateText } from "../../models/index.js";
import type {
  ActionDefinition,
  OutputSchemaConfig,
  ToolResult,
} from "../types.js";
import type { StateContext } from "./stateContextBuilder.js";
import { formatOutputSchemaPrompt } from "./schemaBuilder.js";

// ===== ResolverContext =====

export interface ResolverContext {
  action: string;
  definition: ActionDefinition;
  outcomeSection: string;
  skillCheckResult?: ToolResult;
  stateContext: StateContext;
  executionContext?: string;
  featureNotes?: string[];
  language?: string;
}

// ===== Skill check formatting =====

function formatSkillCheckResult(result?: ToolResult): string {
  if (!result) return "No skill check — auto success";

  const lines: string[] = [];
  lines.push(
    `Skill roll: ${result.successLevel ?? "unknown"} — ${result.outcomeDescription}`
  );
  if (result.rollDetail) {
    lines.push(`Detail: ${result.rollDetail}`);
  }
  if (result.perTargetResults) {
    lines.push("Opposed results per target:");
    for (const [targetId, r] of Object.entries(result.perTargetResults)) {
      const wonLabel = r.actorWon ? "Actor wins" : "Target resists";
      const damagePart = r.damage != null ? `, damage: ${r.damage}` : "";
      lines.push(`  ${targetId}: ${r.detail} — ${wonLabel}${damagePart}`);
    }
  }
  return lines.join("\n");
}

// ===== Prompt builder =====

export function buildResolverPrompt(ctx: ResolverContext): string {
  const language = ctx.language ?? "en";
  const { definition, stateContext } = ctx;

  const guidance = definition.guidanceBody || definition.content;

  const sections: string[] = [];

  sections.push(`# Action Node`);
  sections.push(`Action: "${ctx.action}"`);
  sections.push("");
  sections.push(formatSkillCheckResult(ctx.skillCheckResult));

  if (ctx.executionContext) {
    sections.push("");
    sections.push(ctx.executionContext);
  }

  if (stateContext.actorSection) {
    sections.push("");
    sections.push(stateContext.actorSection);
  }

  if (stateContext.targetSections) {
    sections.push("");
    sections.push(stateContext.targetSections);
  }

  if (stateContext.sceneSection) {
    sections.push("");
    sections.push(stateContext.sceneSection);
  }

  if (stateContext.itemSection) {
    sections.push("");
    sections.push(stateContext.itemSection);
  }

  if (stateContext.worldStateSection) {
    sections.push("");
    sections.push(stateContext.worldStateSection);
  }

  if (ctx.featureNotes && ctx.featureNotes.length > 0) {
    sections.push("");
    sections.push("## Feature Activation Results");
    sections.push(ctx.featureNotes.join("\n"));
  }

  // Output schema section
  if (definition.outputSchema) {
    sections.push("");
    sections.push(formatOutputSchemaPrompt(definition.outputSchema));
  }

  sections.push("");
  sections.push(
    `Write all memory text in ${language}. Respond ONLY with the JSON object, no other text.`
  );

  const userPrompt = sections.join("\n");

  return `You are a tabletop horror RPG 7th Edition game state resolver. You output structured state changes only — no narrative, no prose.

${guidance}

---

${userPrompt}`;
}

// ===== Parser =====

export function parseStateResolution(raw: string): Record<string, any> {
  try {
    const jsonMatch =
      raw.match(/```json\s*([\s\S]*?)```/) ??
      raw.match(/```\s*([\s\S]*?)```/) ?? [null, null];
    const jsonStr =
      jsonMatch[1]?.trim() ?? raw.match(/\{[\s\S]*\}/)?.[0] ?? raw.trim();

    const parsed = JSON.parse(jsonStr);

    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

// ===== Validation =====

/**
 * Basic validation: ensure only declared types (and custom fields) appear in the resolution.
 */
export function validateResolution(
  resolution: Record<string, any>,
  config: OutputSchemaConfig
): boolean {
  const allowed = new Set<string>(config.use);
  if (config.custom) {
    for (const key of Object.keys(config.custom)) {
      allowed.add(key);
    }
  }

  for (const key of Object.keys(resolution)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

// ===== Async LLM call =====

export async function resolveState(
  ctx: ResolverContext,
  runtime: any
): Promise<Record<string, any>> {
  const prompt = buildResolverPrompt(ctx);

  try {
    const text = await generateText({
      runtime,
      customSystemPrompt: prompt,
      context: "",
      modelClass: ModelClass.MEDIUM,
      operation: "state-resolver",
    });

    const resolution = parseStateResolution(text);

    // Validate if definition has outputSchema
    if (ctx.definition.outputSchema) {
      if (!validateResolution(resolution, ctx.definition.outputSchema)) {
        // Strip undeclared keys
        const allowed = new Set<string>(ctx.definition.outputSchema.use);
        if (ctx.definition.outputSchema.custom) {
          for (const key of Object.keys(ctx.definition.outputSchema.custom)) {
            allowed.add(key);
          }
        }
        for (const key of Object.keys(resolution)) {
          if (!allowed.has(key)) delete resolution[key];
        }
      }
    }

    return resolution;
  } catch (error) {
    console.warn(
      "[StateResolver] LLM call failed, returning empty resolution:",
      error instanceof Error ? error.message : error
    );
    return {};
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/engine/resolver/__tests__/stateResolver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: StateResolver to definition-driven output schema, remove narrative"
```

---

### Task 7: Refactor applyStateResolution

**Files:**
- Modify: `src/engine/resolver/applyStateResolution.ts`
- Modify: `src/engine/resolver/__tests__/applyStateResolution.test.ts`

- [ ] **Step 1: Update tests for new signature**

Replace `src/engine/resolver/__tests__/applyStateResolution.test.ts`:

```typescript
import type { DynamicGameStateManager } from "../../../state/DynamicGameState.js";
import type { OutputSchemaConfig } from "../../types.js";
import { applyStateResolution } from "../applyStateResolution.js";

function makeMockDgsm(
  overrides: Partial<DynamicGameStateManager> = {}
): DynamicGameStateManager {
  const npcCharacters: any[] = [
    {
      id: "npc_1",
      name: "Alice",
      status: { hp: 10, sanity: 60, conditions: [] as string[] },
    },
  ];
  const npcStats: Record<string, { hp: number; san: number }> = {
    npc_1: { hp: 10, san: 60 },
  };
  const npcInventories: Record<string, any[]> = {
    npc_1: [{ id: "lantern", name: "Lantern", type: "other" }],
  };
  const scenes: Map<string, any> = new Map([
    [
      "scene_study",
      {
        id: "scene_study",
        name: "Study",
        items: [{ id: "book", name: "Old Book", type: "other" }],
      },
    ],
  ]);
  const scenarioConditions: Record<string, any[]> = {};
  const characterPositions: Record<string, any> = {};

  const state: any = {
    npcCharacters,
    npcStats,
    npcInventories,
    scenes,
    scenarioConditions,
    characterPositions,
  };

  const dgsm: Partial<DynamicGameStateManager> = {
    getState: () => state,
    updateNpcHp: vi.fn((npcId: string, delta: number) => {
      if (npcStats[npcId]) {
        npcStats[npcId].hp = Math.max(0, npcStats[npcId].hp + delta);
        const npc = npcCharacters.find((n) => n.id === npcId);
        if (npc) npc.status.hp = npcStats[npcId].hp;
      }
    }),
    updateNpcSan: vi.fn((npcId: string, delta: number) => {
      if (npcStats[npcId]) {
        npcStats[npcId].san = Math.max(0, npcStats[npcId].san + delta);
        const npc = npcCharacters.find((n) => n.id === npcId);
        if (npc) npc.status.sanity = npcStats[npcId].san;
      }
    }),
    setCharacterPosition: vi.fn(),
    getSceneConditions: vi.fn((scenarioId: string) => {
      return scenarioConditions[scenarioId] ?? [];
    }),
    replaceSceneConditions: vi.fn((scenarioId: string, conditions: any[]) => {
      scenarioConditions[scenarioId] = conditions;
    }),
    appendSceneCondition: vi.fn((scenarioId: string, condition: any) => {
      if (!scenarioConditions[scenarioId]) scenarioConditions[scenarioId] = [];
      scenarioConditions[scenarioId].push(condition);
    }),
    getNpcInventory: vi.fn((npcId: string) => {
      return npcInventories[npcId] ?? [];
    }),
    addItemToNpc: vi.fn((npcId: string, item: any) => {
      if (!npcInventories[npcId]) npcInventories[npcId] = [];
      npcInventories[npcId].push(item);
    }),
    removeItemFromNpc: vi.fn((npcId: string, itemId: string) => {
      if (!npcInventories[npcId]) return undefined;
      const idx = npcInventories[npcId].findIndex((i: any) => i.id === itemId);
      if (idx === -1) return undefined;
      return npcInventories[npcId].splice(idx, 1)[0];
    }),
    getScene: vi.fn((sceneId: string) => {
      return scenes.get(sceneId) ?? null;
    }),
    ...overrides,
  };

  return dgsm as DynamicGameStateManager;
}

describe("applyStateResolution (new schema-driven)", () => {
  const hpConfig: OutputSchemaConfig = { use: ["character.hp"] };
  const sanConfig: OutputSchemaConfig = { use: ["character.san"] };
  const condConfig: OutputSchemaConfig = { use: ["character.condition"] };
  const posConfig: OutputSchemaConfig = { use: ["character.position"] };
  const sceneConfig: OutputSchemaConfig = { use: ["scene.condition"] };
  const itemMoveConfig: OutputSchemaConfig = { use: ["item.move"] };
  const itemDestroyConfig: OutputSchemaConfig = { use: ["item.destroy"] };
  const itemModifyConfig: OutputSchemaConfig = { use: ["item.modify"] };

  it("applies character.hp delta", () => {
    const dgsm = makeMockDgsm();
    applyStateResolution(dgsm, {
      "character.hp": [{ characterId: "npc_1", delta: -3 }],
    }, hpConfig);

    expect(dgsm.updateNpcHp).toHaveBeenCalledWith("npc_1", -3);
  });

  it("applies character.san delta", () => {
    const dgsm = makeMockDgsm();
    applyStateResolution(dgsm, {
      "character.san": [{ characterId: "npc_1", delta: -5 }],
    }, sanConfig);

    expect(dgsm.updateNpcSan).toHaveBeenCalledWith("npc_1", -5);
  });

  it("adds conditions to a character", () => {
    const dgsm = makeMockDgsm();
    applyStateResolution(dgsm, {
      "character.condition": [
        { characterId: "npc_1", add: ["bleeding"] },
      ],
    }, condConfig);

    const npc = dgsm.getState().npcCharacters.find((n: any) => n.id === "npc_1");
    expect(npc?.status.conditions).toContain("bleeding");
  });

  it("removes conditions from a character", () => {
    const dgsm = makeMockDgsm();
    const npc = dgsm.getState().npcCharacters.find((n: any) => n.id === "npc_1");
    npc?.status.conditions.push("frightened");

    applyStateResolution(dgsm, {
      "character.condition": [
        { characterId: "npc_1", remove: ["frightened"] },
      ],
    }, condConfig);

    expect(npc?.status.conditions).not.toContain("frightened");
  });

  it("sets character position", () => {
    const dgsm = makeMockDgsm();
    applyStateResolution(dgsm, {
      "character.position": [
        { characterId: "npc_1", sceneId: "scene_hall" },
      ],
    }, posConfig);

    expect(dgsm.setCharacterPosition).toHaveBeenCalledWith("npc_1", {
      type: "scene",
      sceneId: "scene_hall",
    });
  });

  it("adds a condition to a scene", () => {
    const dgsm = makeMockDgsm();
    applyStateResolution(dgsm, {
      "scene.condition": [
        { sceneId: "scene_study", add: ["door is barricaded"] },
      ],
    }, sceneConfig);

    expect(dgsm.appendSceneCondition).toHaveBeenCalledWith("scene_study", {
      description: "door is barricaded",
    });
  });

  it("moves an item from NPC to scene", () => {
    const dgsm = makeMockDgsm();
    applyStateResolution(dgsm, {
      "item.move": [
        { itemId: "lantern", from: "npc_1", to: "scene:scene_study" },
      ],
    }, itemMoveConfig);

    expect(dgsm.removeItemFromNpc).toHaveBeenCalledWith("npc_1", "lantern");
    expect(dgsm.getScene).toHaveBeenCalledWith("scene_study");
  });

  it("destroys an item", () => {
    const dgsm = makeMockDgsm();
    applyStateResolution(dgsm, {
      "item.destroy": [{ itemId: "book", from: "scene_study" }],
    }, itemDestroyConfig);

    expect(dgsm.getScene).toHaveBeenCalledWith("scene_study");
    const scene = dgsm.getScene("scene_study");
    expect(scene?.items?.find((i: any) => i.id === "book")).toBeUndefined();
  });

  it("modifies item properties", () => {
    const dgsm = makeMockDgsm();
    applyStateResolution(dgsm, {
      "item.modify": [
        { itemId: "lantern", properties: { damaged: true } },
      ],
    }, itemModifyConfig);

    const inv = dgsm.getNpcInventory("npc_1");
    const lantern = inv.find((i: any) => i.id === "lantern");
    expect(lantern?.damaged).toBe(true);
  });

  it("does nothing when resolution is empty", () => {
    const dgsm = makeMockDgsm();
    applyStateResolution(dgsm, {}, { use: ["character.hp"] });

    expect(dgsm.updateNpcHp).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/engine/resolver/__tests__/applyStateResolution.test.ts`
Expected: FAIL — signature mismatch

- [ ] **Step 3: Rewrite applyStateResolution.ts**

Replace `src/engine/resolver/applyStateResolution.ts`:

```typescript
/**
 * Applies a state resolution object to DynamicGameStateManager.
 * Dispatches to type-specific appliers based on definition's outputSchema.
 * Pure code — no LLM calls.
 */

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { OutputSchemaConfig } from "../types.js";
import { applyByTypeId } from "./stateChangeAppliers.js";

/**
 * Apply state changes from a resolver response.
 *
 * @param dgsm - game state manager
 * @param resolution - parsed LLM response (typeId → changes[])
 * @param config - the definition's outputSchema config (controls which types are applied)
 */
export function applyStateResolution(
  dgsm: DynamicGameStateManager,
  resolution: Record<string, any>,
  config: OutputSchemaConfig
): void {
  applyByTypeId(dgsm, resolution, config);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/engine/resolver/__tests__/applyStateResolution.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: applyStateResolution to use typeId-based dispatch"
```

---

### Task 8: Update TickProcessor Integration

**Files:**
- Modify: `src/engine/runtime/tickProcessor.ts:498-570`

- [ ] **Step 1: Update the StateResolver call site**

In `tickProcessor.ts`, the section at lines 498-570 needs these changes:

1. `resolveState()` now returns `Record<string, any>` instead of `StateResolution`
2. `applyStateResolution()` now takes a third argument: `definition.outputSchema`
3. Remove `narrative` references from CharacterAction
4. Memory extraction changes from `stateResolution.memories` to reading memory type keys

Replace the section at lines 498-569 (inside the `else` block after skill check):

```typescript
          const stateResolution = await resolveState(
            {
              action: node.action,
              definition: definition!,
              outcomeSection,
              skillCheckResult: skillResult,
              stateContext: stateCtx,
              executionContext:
                buildExecutionContextPromptBlock(resolutionContext),
              language,
            },
            ctx.runtime
          );

          // Apply state changes using definition-driven dispatch
          const outputSchema = definition?.outputSchema;
          if (outputSchema) {
            applyStateResolution(dgsm, stateResolution, outputSchema);
          }

          // Feature overlay activation from custom fields
          // Check if any feature's planNodeSchema fields appear in the resolution
          for (const feature of registry.getAllFeatures()) {
            const schema = feature.planNodeSchema;
            if (!schema) continue;
            const allFields = [
              ...schema.requiredFields,
              ...(schema.optionalFields ?? []),
            ];
            for (const fieldDef of allFields) {
              if (stateResolution[fieldDef.field] !== undefined) {
                const syntheticNode = {
                  ...node,
                  [fieldDef.field]: stateResolution[fieldDef.field],
                };
                feature.activate?.(syntheticNode as any, dgsm);
                break;
              }
            }
          }

          // Write memories from resolution
          const memoryTypes = ["memory.event", "memory.witness", "memory.information"];
          if (memoryManager) {
            for (const memType of memoryTypes) {
              const memories = stateResolution[memType];
              if (!Array.isArray(memories)) continue;
              for (const mem of memories) {
                await memoryManager.add({
                  npcId: mem.characterId,
                  sessionId,
                  moduleId,
                  type: memType.split(".")[1] as any,
                  content: mem.content,
                  gameDay,
                  gameTime: tickStartTime,
                  location: locationId,
                });
              }
            }
          }

          action = {
            characterId: node.characterId,
            characterName: node.characterName,
            gameTime: tickStartTime,
            action: node.action,
            location: locationId,
            type: node.type,
            impact: step.impact,
            status: skillResult.status === "failed" ? "failed" : "completed",
            outcome: skillResult.outcomeDescription,
            successLevel: skillResult.successLevel,
            rollDetail: skillResult.rollDetail,
            perTargetResults: skillResult.perTargetResults,
          };
```

- [ ] **Step 2: Update imports at the top of tickProcessor.ts**

Ensure the import of `applyStateResolution` still works (same module, just new signature). No import changes needed since we're importing from the same path.

Remove `StateResolution` from any type imports if present (it's no longer used here).

- [ ] **Step 3: Run the full test suite to verify integration**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: tickProcessor to use schema-driven state resolution"
```

---

### Task 9: Clean Up Legacy Types

**Files:**
- Modify: `src/engine/types.ts:269-315`

- [ ] **Step 1: Add deprecation comments to legacy types**

Add `@deprecated` JSDoc to the old types that are no longer used by the new code path but may be referenced elsewhere:

```typescript
// In src/engine/types.ts, add deprecation comments:

/** @deprecated Use state change types from stateChangeTypes.ts instead */
export interface CharacterChange { ... }

/** @deprecated Use state change types from stateChangeTypes.ts instead */
export interface ItemChange { ... }

/** @deprecated Use state change types from stateChangeTypes.ts instead */
export interface SceneChange { ... }

/** @deprecated Use state change types from stateChangeTypes.ts instead */
export interface StateResolution { ... }
```

- [ ] **Step 2: Search for remaining references to old types**

Run: `grep -rn "StateResolution\|CharacterChange\|ItemChange\|SceneChange" src/ --include="*.ts" | grep -v "test" | grep -v "__tests__" | grep -v "node_modules"`

If any files still import the old types (e.g., legacy interaction resolvers), note them for future cleanup but don't change them now — they'll be migrated when those resolvers adopt the new system.

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: deprecate legacy StateResolution types"
```

---

### Task 10: End-to-End Verification

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Run type checking**

Run: `pnpm build:tsc`
Expected: No type errors

- [ ] **Step 3: Run linter**

Run: `pnpm check`
Expected: No lint errors (fix any that appear)

- [ ] **Step 4: Commit any fixes**

```bash
git commit -m "fix: resolve type/lint issues from output schema refactor"
```
