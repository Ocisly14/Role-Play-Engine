# ActionTool & Item Sub-System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `ActionTool` abstraction and migrate `object_interaction` into an engine-internal item tool, reducing planner types from 4 to 3 with explicit tool calls.

**Architecture:** New `ActionTool` interface sits alongside `NodeHandler` and `WorldFeature` in the registry. Planner outputs `tools: [{ name, args }]` alongside the node. Engine runs tool pre-checks in tickProcessor, tool resolution (LLM #1) then action resolution (LLM #2) in postProcessing. Item manipulation is the first ActionTool implementation.

**Tech Stack:** TypeScript, Vitest

---

## Task 1: Define ActionTool types and ToolCall on PlanNode

**Files:**
- Modify: `src/engine/types.ts`
- Modify: `src/planning/types.ts`

- [ ] **Step 1: Add ActionTool interfaces to `src/engine/types.ts`**

Add these after the existing `WorldFeature` interface (after line 245):

```ts
// ===== Action Tool: action sub-system invoked by planner tool calls =====

export interface ActionToolArgsSchema {
  requiredArgs: Array<{ name: string; type: string; description: string }>;
  optionalArgs?: Array<{ name: string; type: string; description: string }>;
}

export interface ToolPreCheckResult {
  passed: boolean;
  failureReason?: import("../planning/types.js").FailureReason;
  failureDetail?: string;
}

export interface ToolResolutionResult<TDelta = unknown> {
  delta: TDelta;
  outcomeDescription: string;
}

export interface ActionTool<TDelta = unknown> {
  id: string;
  description: string;
  argsSchema: ActionToolArgsSchema;
  exampleCall: { name: string; args: Record<string, unknown> };
  planningPrompt: string;
  preCheck(
    node: import("../planning/types.js").PlanNode,
    args: Record<string, unknown>,
    dgsm: DynamicGameStateManager
  ): ToolPreCheckResult;
  resolve(
    node: import("../planning/types.js").PlanNode,
    args: Record<string, unknown>,
    dgsm: DynamicGameStateManager,
    runtime: any,
    skillRollResult: {
      successLevel: import("../planning/types.js").SuccessLevel;
      detail: string;
    } | null,
    locationId: string,
    language: string,
    resolutionContext: import("../planning/types.js").ActionResolutionContext,
    extras: {
      memoryManager?: import("../memory/NpcMemoryManager.js").NpcMemoryManager;
      sessionId?: string;
      registry?: import("./registry.js").GameEngineRegistry;
      featureNotes?: string[];
    }
  ): Promise<ToolResolutionResult<TDelta>>;
  apply(
    dgsm: DynamicGameStateManager,
    actorId: string,
    delta: TDelta,
    locationId: string
  ): void;
}
```

- [ ] **Step 2: Add `ToolCall` and `tools` to PlanNode in `src/planning/types.ts`**

After the `ObjectInteractionPayload` interface (line 103), add:

```ts
export interface ToolCall {
  /** Tool ID, e.g. "item" */
  name: string;
  /** Tool-specific arguments */
  args: Record<string, unknown>;
}
```

Add `tools` field to `PlanNode` interface (after the `objectInteractionPayload` field, around line 165):

```ts
  /** Engine tool invocations parsed from planner output */
  tools?: ToolCall[];
```

- [ ] **Step 3: Modify `ObjectStateDelta` — rename `memory` to `outcome`, remove `FatigueEffectDelta` inheritance**

In `src/planning/types.ts`, change:

```ts
export interface ObjectStateDelta extends FatigueEffectDelta {
```

to:

```ts
export interface ObjectStateDelta {
```

And change the `memory` field:

```ts
  /** First-person memory for the actor. */
  memory: string;
```

to:

```ts
  /** Factual outcome description of what happened to items. */
  outcome: string;
```

- [ ] **Step 4: Export new types from `src/engine/index.ts`**

Add to the type export list:

```ts
export type {
  ActionTool,
  ActionToolArgsSchema,
  ToolPreCheckResult,
  ToolResolutionResult,
} from "./types.js";
```

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit 2>&1 | head -30`

Expected: Type errors in files that reference `ObjectStateDelta.memory` (objectInteractionStateResolver.ts, its tests, actionPostProcessing.ts). These will be fixed in later tasks. No errors in the new type definitions themselves.

---

## Task 2: Registry tool management

**Files:**
- Modify: `src/engine/registry.ts`
- Create: `src/engine/__tests__/registryTools.test.ts`

- [ ] **Step 1: Write tests for registry tool methods**

Create `src/engine/__tests__/registryTools.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { GameEngineRegistry } from "../registry.js";
import type { ActionTool, ToolPreCheckResult } from "../types.js";
import type { PlanNode } from "../../planning/types.js";

function makeMockTool(
  id: string,
  preCheckResult: ToolPreCheckResult = { passed: true }
): ActionTool {
  return {
    id,
    description: `Mock ${id} tool`,
    argsSchema: {
      requiredArgs: [{ name: "targetId", type: "string", description: "target" }],
    },
    exampleCall: { name: id, args: { targetId: "x" } },
    planningPrompt: `Use ${id} tool when needed.`,
    preCheck: () => preCheckResult,
    resolve: async () => ({ delta: {}, outcomeDescription: "done" }),
    apply: () => {},
  };
}

function makeNode(tools?: Array<{ name: string; args: Record<string, unknown> }>): PlanNode {
  return {
    nodeId: "n1",
    characterId: "npc_a",
    characterName: "A",
    startTime: "10:00",
    endTime: "10:05",
    action: "do something",
    type: "action",
    impact: 0,
    status: "pending",
    executionMeta: { remainingMinutes: 5 },
    tools,
  } as PlanNode;
}

describe("GameEngineRegistry — tool management", () => {
  it("registerTool + getTool", () => {
    const registry = new GameEngineRegistry();
    const tool = makeMockTool("item");
    registry.registerTool(tool);
    expect(registry.getTool("item")).toBe(tool);
    expect(registry.getTool("unknown")).toBeUndefined();
  });

  it("getActiveTools returns matching tools with args", () => {
    const registry = new GameEngineRegistry();
    registry.registerTool(makeMockTool("item"));
    registry.registerTool(makeMockTool("craft"));

    const node = makeNode([{ name: "item", args: { targetId: "knife" } }]);
    const active = registry.getActiveTools(node);
    expect(active).toHaveLength(1);
    expect(active[0].tool.id).toBe("item");
    expect(active[0].args).toEqual({ targetId: "knife" });
  });

  it("getActiveTools returns empty when node has no tools", () => {
    const registry = new GameEngineRegistry();
    registry.registerTool(makeMockTool("item"));
    expect(registry.getActiveTools(makeNode())).toHaveLength(0);
    expect(registry.getActiveTools(makeNode([]))).toHaveLength(0);
  });

  it("getActiveTools ignores unregistered tool names", () => {
    const registry = new GameEngineRegistry();
    const node = makeNode([{ name: "unknown_tool", args: {} }]);
    expect(registry.getActiveTools(node)).toHaveLength(0);
  });

  it("runToolPreChecks returns null when all pass", () => {
    const registry = new GameEngineRegistry();
    registry.registerTool(makeMockTool("item", { passed: true }));
    const node = makeNode([{ name: "item", args: { targetId: "x" } }]);
    expect(registry.runToolPreChecks(node, {} as any)).toBeNull();
  });

  it("runToolPreChecks returns first failure", () => {
    const registry = new GameEngineRegistry();
    registry.registerTool(
      makeMockTool("item", {
        passed: false,
        failureReason: "object_not_found",
        failureDetail: "knife not found",
      })
    );
    const node = makeNode([{ name: "item", args: { targetId: "knife" } }]);
    const result = registry.runToolPreChecks(node, {} as any);
    expect(result).not.toBeNull();
    expect(result!.passed).toBe(false);
    expect(result!.failureReason).toBe("object_not_found");
  });

  it("runToolPreChecks returns null when no tools on node", () => {
    const registry = new GameEngineRegistry();
    registry.registerTool(makeMockTool("item"));
    expect(registry.runToolPreChecks(makeNode(), {} as any)).toBeNull();
  });

  it("buildToolPrompt generates Available Tools section", () => {
    const registry = new GameEngineRegistry();
    registry.registerTool(makeMockTool("item"));
    const prompt = registry.buildToolPrompt();
    expect(prompt).toContain("Available Tools");
    expect(prompt).toContain("item");
    expect(prompt).toContain("targetId");
  });

  it("buildToolPrompt returns empty when no tools", () => {
    const registry = new GameEngineRegistry();
    expect(registry.buildToolPrompt()).toBe("");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/engine/__tests__/registryTools.test.ts`

Expected: FAIL — `registerTool`, `getTool`, `getActiveTools`, `runToolPreChecks`, `buildToolPrompt` do not exist.

- [ ] **Step 3: Implement registry tool methods**

In `src/engine/registry.ts`, add a `tools` map alongside the existing `handlers` and `features` maps:

```ts
private tools = new Map<string, ActionTool>();
```

Add imports at the top:

```ts
import type { ActionTool, ToolPreCheckResult } from "./types.js";
```

Add methods to the class:

```ts
registerTool(tool: ActionTool): void {
  if (this.tools.has(tool.id)) {
    console.warn(
      `[GameEngineRegistry] Overwriting tool: ${tool.id}`
    );
  }
  this.tools.set(tool.id, tool);
}

getTool(id: string): ActionTool | undefined {
  return this.tools.get(id);
}

getAllTools(): ActionTool[] {
  return [...this.tools.values()];
}

getActiveTools(
  node: import("../planning/types.js").PlanNode
): Array<{ tool: ActionTool; args: Record<string, unknown> }> {
  if (!node.tools?.length) return [];
  const results: Array<{ tool: ActionTool; args: Record<string, unknown> }> = [];
  for (const call of node.tools) {
    const tool = this.tools.get(call.name);
    if (tool) results.push({ tool, args: call.args });
  }
  return results;
}

runToolPreChecks(
  node: import("../planning/types.js").PlanNode,
  dgsm: DynamicGameStateManager
): ToolPreCheckResult | null {
  for (const { tool, args } of this.getActiveTools(node)) {
    const result = tool.preCheck(node, args, dgsm);
    if (!result.passed) return result;
  }
  return null;
}

buildToolPrompt(): string {
  if (this.tools.size === 0) return "";
  const sections: string[] = [
    "## Available Tools",
    "",
    'When your action needs an engine capability, add a tool call to the `"tools"` array in your response.',
    "",
  ];
  for (const tool of this.tools.values()) {
    sections.push(`**${tool.id}** — ${tool.description}`);
    sections.push("Args:");
    for (const arg of tool.argsSchema.requiredArgs) {
      sections.push(`- \`"${arg.name}"\`: (REQUIRED, ${arg.type}) ${arg.description}`);
    }
    if (tool.argsSchema.optionalArgs) {
      for (const arg of tool.argsSchema.optionalArgs) {
        sections.push(`- \`"${arg.name}"\`: (optional, ${arg.type}) ${arg.description}`);
      }
    }
    sections.push("Example:");
    sections.push("```json");
    sections.push(JSON.stringify(tool.exampleCall, null, 2));
    sections.push("```");
    sections.push("");
    sections.push(tool.planningPrompt);
    sections.push("");
  }
  return sections.join("\n");
}
```

Also extend `buildOutputSchemaPrompt()` to include `tools` in the response structure. In the existing method, find where the response structure JSON is built (around the `JSON.stringify` call for node structure) and add `"tools"` as an optional field. Also append the tool prompt to the output schema if tools are registered.

In `buildOutputSchemaPrompt()`, after the existing `updatedShortTermIntent` line in the response structure JSON object, add:

```ts
const toolsAvailable = this.tools.size > 0;
```

Change the response structure JSON to include tools when available:

```ts
const responseStructure: Record<string, unknown> = {
  node: { /* existing fields */ },
  ...(toolsAvailable
    ? {
        tools: [
          { name: "tool_name", args: { "...": "tool-specific args" } },
        ],
      }
    : {}),
  updatedShortTermIntent: "optional — update your current focus if it changed",
};
```

Add after the response structure:

```ts
if (toolsAvailable) {
  sections.push(
    "- `tools`: (optional) array of engine tool calls. Only include when your action needs a registered tool. See Available Tools below."
  );
}
```

At the end of the method, before the return, append the tool prompt:

```ts
const toolPrompt = this.buildToolPrompt();
if (toolPrompt) {
  sections.push("");
  sections.push(toolPrompt);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/engine/__tests__/registryTools.test.ts`

Expected: All PASS.

- [ ] **Step 5: Run existing registry tests to check nothing broke**

Run: `npx vitest run src/engine/ 2>&1 | tail -20`

Expected: Some failures in files referencing `ObjectStateDelta.memory` (expected from Task 1 changes). Registry's existing tests should still pass.

---

## Task 3: Item tool implementation

**Files:**
- Create: `src/engine/tools/itemTool.ts`
- Modify: `src/engine/handlers/objectInteractionStateResolver.ts` (rename `memory` → `outcome` in resolver; move to `src/engine/tools/itemStateResolver.ts`)
- Create: `src/engine/tools/__tests__/itemTool.test.ts`

- [ ] **Step 1: Move and rename the resolver file**

Move `src/engine/handlers/objectInteractionStateResolver.ts` to `src/engine/tools/itemStateResolver.ts`.

Update the internal JSDoc at line 1-7:

```ts
/**
 * LLM-based state resolver for the item ActionTool.
 *
 * After the handler determines success/failure via dice,
 * this module asks a MEDIUM-class LLM to produce concrete
 * state deltas (item locations, item updates, scene conditions)
 * for the actor.
 */
```

In the resolver's system prompt (inside `buildSystemPrompt`), change the memory section:

```
## Outcome
Always required. Write a factual third-person description of what happened to the items: what moved, what changed, what was discovered. This is NOT the actor's memory — it is an objective summary for the engine.
- Keep it concise: 1-2 sentences.
- Write in English (always English, regardless of game language).
```

Remove the fatigue section from the system prompt entirely (lines containing `fatigueDelta` guidance).

In the output JSON example in the system prompt, change:

```json
{
  "items": [...],
  "newItems": [...],
  "addSceneConditions": [...],
  "outcome": "Factual description of item changes (REQUIRED)"
}
```

In the `resolveObjectInteractionState` function, rename to `resolveItemState` and update the return to use `outcome`:

```ts
return {
  items: parsed.items ?? [],
  newItems: parsed.newItems,
  addSceneConditions: parsed.addSceneConditions,
  outcome: parsed.outcome ?? node.action,
};
```

Also update the fallback return:

```ts
return {
  items: [],
  outcome: node.action,
};
```

Update all import paths in this file to reflect the new location (e.g., `../../models/index.js` stays the same since depth doesn't change from `tools/` vs `handlers/`; verify and adjust as needed).

Keep `applyItemResults` and `applyObjectDelta` exported from this file — they are reused by actionStateResolver and the item tool.

- [ ] **Step 2: Update imports across the codebase**

Files that import from `objectInteractionStateResolver`:

1. `src/engine/runtime/actionPostProcessing.ts` — update import path:
   ```ts
   import {
     applyObjectDelta,
     resolveItemState,
   } from "../tools/itemStateResolver.js";
   ```
   (Temporarily alias or keep `resolveObjectInteractionState` until Task 5.)

2. `src/engine/handlers/actionStateResolver.ts` — update import path:
   ```ts
   import { applyItemResults } from "../tools/itemStateResolver.js";
   ```

3. `src/engine/handlers/__tests__/objectInteractionStateResolver.test.ts` — move to `src/engine/tools/__tests__/itemStateResolver.test.ts` and update import:
   ```ts
   import {
     applyObjectDelta,
     resolveItemState,
   } from "../itemStateResolver.js";
   ```
   Update all test references from `resolveObjectInteractionState` to `resolveItemState`, and from `delta.memory` to `delta.outcome`.

- [ ] **Step 3: Write item tool pre-check tests**

Create `src/engine/tools/__tests__/itemTool.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { PlanNode } from "../../../planning/types.js";
import { itemTool } from "../itemTool.js";

function createMockDgsm() {
  const scenes = new Map<string, any>();
  const npcInventories: Record<string, any[]> = {};
  const characterPositions: Record<string, any> = {};

  return {
    getCharacterPosition(id: string) {
      return characterPositions[id] ?? null;
    },
    resolveLocationId(pos: any) {
      return pos?.sceneId ?? "";
    },
    getScene(id: string) {
      return scenes.get(id) ?? null;
    },
    findNpcItem(npcId: string, itemId: string) {
      return npcInventories[npcId]?.find((i: any) => i.id === itemId);
    },
    getNpcInventory(npcId: string) {
      return npcInventories[npcId] ?? [];
    },
    _addScene(id: string, items: any[]) {
      scenes.set(id, { id, name: id, items });
    },
    _addInventory(npcId: string, items: any[]) {
      npcInventories[npcId] = items;
    },
    _setPosition(npcId: string, sceneId: string) {
      characterPositions[npcId] = { type: "scene", sceneId };
    },
  };
}

function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "n1",
    characterId: "npc_a",
    characterName: "A",
    startTime: "10:00",
    endTime: "10:05",
    action: "Pick up the knife",
    type: "action",
    impact: 0,
    status: "pending",
    executionMeta: { remainingMinutes: 5 },
    ...overrides,
  } as PlanNode;
}

describe("itemTool.preCheck", () => {
  it("passes when itemId is found in scene", () => {
    const dgsm = createMockDgsm();
    dgsm._setPosition("npc_a", "room1");
    dgsm._addScene("room1", [{ id: "knife", name: "Knife" }]);
    const result = itemTool.preCheck(
      makeNode(),
      { itemId: "knife" },
      dgsm as any
    );
    expect(result.passed).toBe(true);
  });

  it("passes when itemId is found in inventory", () => {
    const dgsm = createMockDgsm();
    dgsm._setPosition("npc_a", "room1");
    dgsm._addScene("room1", []);
    dgsm._addInventory("npc_a", [{ id: "knife", name: "Knife" }]);
    const result = itemTool.preCheck(
      makeNode(),
      { itemId: "knife" },
      dgsm as any
    );
    expect(result.passed).toBe(true);
  });

  it("fails when itemId is not found anywhere", () => {
    const dgsm = createMockDgsm();
    dgsm._setPosition("npc_a", "room1");
    dgsm._addScene("room1", []);
    const result = itemTool.preCheck(
      makeNode(),
      { itemId: "knife" },
      dgsm as any
    );
    expect(result.passed).toBe(false);
    expect(result.failureReason).toBe("object_not_found");
  });

  it("passes when no itemId in args", () => {
    const dgsm = createMockDgsm();
    const result = itemTool.preCheck(makeNode(), {}, dgsm as any);
    expect(result.passed).toBe(true);
  });

  it("passes when itemId is in a scene container", () => {
    const dgsm = createMockDgsm();
    dgsm._setPosition("npc_a", "room1");
    dgsm._addScene("room1", [
      {
        id: "box",
        name: "Box",
        containerStats: {
          storedItems: [{ id: "key", name: "Key" }],
        },
      },
    ]);
    const result = itemTool.preCheck(
      makeNode(),
      { itemId: "key" },
      dgsm as any
    );
    expect(result.passed).toBe(true);
  });
});
```

- [ ] **Step 4: Run pre-check tests to verify they fail**

Run: `npx vitest run src/engine/tools/__tests__/itemTool.test.ts`

Expected: FAIL — `itemTool` module does not exist.

- [ ] **Step 5: Create `src/engine/tools/itemTool.ts`**

```ts
import type { PlanNode } from "../../planning/types.js";
import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import type { ActionTool, ToolPreCheckResult, ToolResolutionResult } from "../types.js";
import type { ObjectStateDelta } from "../../planning/types.js";
import { applyObjectDelta, resolveItemState } from "./itemStateResolver.js";

function findItemAnywhere(
  dgsm: DynamicGameStateManager,
  actorId: string,
  locationId: string,
  itemId: string
): boolean {
  // Actor inventory
  if (dgsm.findNpcItem(actorId, itemId)) return true;

  // Scene items
  const scene = dgsm.getScene(locationId);
  if (scene?.items?.find((i) => i.id === itemId)) return true;

  // Scene containers
  if (scene?.items) {
    for (const si of scene.items) {
      if (si.containerStats?.storedItems?.some((s) => s.id === itemId)) {
        return true;
      }
    }
  }

  // Inventory containers
  const inv = dgsm.getNpcInventory(actorId);
  for (const ii of inv) {
    if (ii.containerStats?.storedItems?.some((s) => s.id === itemId)) {
      return true;
    }
  }

  return false;
}

export const itemTool: ActionTool<ObjectStateDelta> = {
  id: "item",

  description:
    "Item manipulation sub-system. Handles picking up, moving, modifying, " +
    "destroying, disassembling, combining, and inspecting items in the scene " +
    "or actor inventory.",

  argsSchema: {
    requiredArgs: [
      {
        name: "itemId",
        type: "string",
        description: "Exact item ID being targeted",
      },
    ],
  },

  exampleCall: {
    name: "item",
    args: { itemId: "petty_cash_box" },
  },

  planningPrompt: `## Item Manipulation Tool
When your action primarily targets a specific portable item (pick up, inspect,
open, combine, disassemble, use), call the "item" tool:

\`\`\`json
{ "name": "item", "args": { "itemId": "exact_item_id" } }
\`\`\`

SKILL GUIDANCE: Do NOT set \`skill\` for routine actions — picking up items,
opening unlocked containers, inspecting objects. Only set \`skill\` when genuinely
difficult: picking a lock (Locksmith), disarming a trap (Mechanical Repair),
forcing open a stuck container (STR).

Do NOT call the item tool for:
- Actions targeting the environment (searching a room, barring a door) — plain action
- Actions targeting a character (giving an item to someone) — character_interaction
- Examining the scene generally — plain action`,

  preCheck(
    node: PlanNode,
    args: Record<string, unknown>,
    dgsm: DynamicGameStateManager
  ): ToolPreCheckResult {
    const itemId = args.itemId as string | undefined;
    if (!itemId) return { passed: true };

    const pos = dgsm.getCharacterPosition(node.characterId);
    const locationId = pos ? dgsm.resolveLocationId(pos) : "";

    if (!findItemAnywhere(dgsm, node.characterId, locationId, itemId)) {
      return {
        passed: false,
        failureReason: "object_not_found",
        failureDetail: `${itemId} not found`,
      };
    }
    return { passed: true };
  },

  async resolve(node, args, dgsm, runtime, skillRollResult, locationId, language, resolutionContext, extras) {
    const delta = await resolveItemState(
      node,
      dgsm,
      runtime,
      skillRollResult,
      locationId,
      language,
      extras.memoryManager,
      extras.sessionId,
      extras.registry,
      extras.featureNotes,
      resolutionContext
    );
    return {
      delta,
      outcomeDescription: delta.outcome,
    };
  },

  apply(dgsm, actorId, delta, locationId) {
    applyObjectDelta(dgsm, actorId, delta, locationId);
  },
};
```

- [ ] **Step 6: Run pre-check tests**

Run: `npx vitest run src/engine/tools/__tests__/itemTool.test.ts`

Expected: All PASS.

- [ ] **Step 7: Register item tool in defaults**

In `src/engine/registerDefaults.ts`:

Add import:
```ts
import { itemTool } from "./tools/itemTool.js";
```

Remove:
```ts
import {
  ...
  objectInteractionHandler,
} from "./handlers/index.js";
```

And remove:
```ts
registry.registerHandler(objectInteractionHandler);
```

Add after the feature registrations:
```ts
registry.registerTool(itemTool);
```

---

## Task 4: Execution pipeline — tickProcessor tool pre-check

**Files:**
- Modify: `src/engine/runtime/tickProcessor.ts`

- [ ] **Step 1: Add tool pre-check in tickProcessor before handler.execute()**

In `tickProcessor.ts`, inside the scene node execution loop (around line 400, where `handler.execute()` is called), add the tool pre-check before the handler dispatch:

```ts
// Tool pre-checks (e.g. item existence)
const toolPreCheckFailure = registry.runToolPreChecks(node, dgsm);
if (toolPreCheckFailure) {
  const pos = dgsm.getCharacterPosition(node.characterId);
  const failedLocation = pos ? dgsm.resolveLocationId(pos) : "";
  const failedAction: CharacterAction = {
    characterId: node.characterId,
    characterName: node.characterName,
    gameTime: tickStartTime,
    action: node.action,
    location: failedLocation,
    type: node.type,
    impact: node.impact ?? 0,
    status: "failed",
    failureReason: toolPreCheckFailure.failureReason ?? "prerequisite_not_met",
    outcome: toolPreCheckFailure.failureDetail ?? "Tool pre-check failed",
  };
  tickActions.push(failedAction);
  logNodeExecutionResult(node, failedAction);
  continue;
}
```

This goes right before the existing `let action = await handler.execute(node, dgsm, ctx);` line.

- [ ] **Step 2: Verify build**

Run: `npx tsc --noEmit 2>&1 | head -20`

Expected: Remaining type errors only in files not yet updated (objectInteractionStateResolver references).

---

## Task 5: Execution pipeline — postProcessing tool resolution

**Files:**
- Modify: `src/engine/runtime/actionPostProcessing.ts`
- Modify: `src/engine/handlers/actionStateResolver.ts`

- [ ] **Step 1: Remove `objectInteractionAttempted` branch from postProcessing**

In `src/engine/runtime/actionPostProcessing.ts`, delete the entire `objectInteractionAttempted` block (lines 349-385 approximately):

```ts
// DELETE this entire block:
const objectInteractionAttempted =
  node.type === "object_interaction" && shouldRunResolver(action);

if (objectInteractionAttempted) {
  // ... all the object interaction resolution code ...
}
```

- [ ] **Step 2: Add tool resolution pipeline to the action branch**

Replace the `sceneLikeActionAttempted` variable and add tool resolution before the action resolver. The new action branch becomes:

```ts
const actionAttempted =
  node.type === "action" && shouldRunResolver(action);

if (actionAttempted) {
  // --- Tool resolution (LLM #1, if any tools are active) ---
  const activeTools = registry.getActiveTools(node);
  const toolOutcomes: string[] = [];

  for (const { tool, args } of activeTools) {
    const sceneSkillRollResult = action.successLevel
      ? {
          successLevel: action.successLevel,
          detail: action.rollDetail ?? "",
        }
      : null;

    const toolResult = await tool.resolve(
      node,
      args,
      dgsm,
      ctx.runtime,
      sceneSkillRollResult,
      locationId,
      language,
      resolutionContext,
      { memoryManager, sessionId, registry, featureNotes }
    );
    tool.apply(dgsm, node.characterId, toolResult.delta, locationId);
    toolOutcomes.push(toolResult.outcomeDescription);
  }

  // --- Action resolution (LLM #2) ---
  const sceneSkillRollResult = action.successLevel
    ? {
        successLevel: action.successLevel,
        detail: action.rollDetail ?? "",
      }
    : null;

  const sceneDelta = await resolveActionState(
    node,
    dgsm,
    ctx.runtime,
    sceneSkillRollResult,
    locationId,
    language,
    registry,
    featureNotes,
    resolutionContext,
    toolOutcomes
  );

  const appliedSceneDelta = applyActionSceneDelta(
    dgsm,
    sceneDelta,
    locationId,
    node.characterId
  );
  applyIncidentalActionMove({
    dgsm,
    characterId: node.characterId,
    moveTo: sceneDelta.moveTo,
  });
  applyFatigueDelta(
    dgsm,
    node.characterId,
    sanitizeFatigueDelta(sceneDelta.fatigueDelta, resolutionContext)
  );

  if (
    memoryManager &&
    appliedSceneDelta.revealedHiddenConnections.length > 0
  ) {
    // ... existing hidden connection logic unchanged ...
  }

  action.outcome = sceneDelta.memory;
  eventOutcome = appendItemContext(action.outcome, itemContext);
  action.stateMemories = {
    [node.characterId]: sceneDelta.memory,
  };
}
```

- [ ] **Step 3: Update imports in actionPostProcessing**

Remove the import of `resolveObjectInteractionState` and `applyObjectDelta` from objectInteractionStateResolver — both are now called indirectly through `itemTool.resolve()` / `itemTool.apply()`:

```ts
// DELETE this entire import:
import {
  applyObjectDelta,
  resolveObjectInteractionState,
} from "../handlers/objectInteractionStateResolver.js";
```

The import of `resolveActionState` and `applyActionSceneDelta` stays unchanged.

Also update `getItemActionContext` (around line 70) to detect tool calls instead of `object_interaction` type:

```ts
function getItemActionContext(
  dgsm: DynamicGameStateManager,
  node: PlanNode,
  locationId: string
): ItemActionContext | null {
  const itemToolCall = node.tools?.find((t) => t.name === "item");
  if (itemToolCall?.args?.itemId) {
    const itemId = itemToolCall.args.itemId as string;
    const item = findKnownItem(dgsm, node, locationId, itemId);
    return {
      itemId,
      itemName: item?.name,
    };
  }
  return null;
}
```

- [ ] **Step 4: Add `toolOutcomes` parameter to `resolveActionState`**

In `src/engine/handlers/actionStateResolver.ts`, update the `resolveActionState` function signature to accept `toolOutcomes`:

```ts
export async function resolveActionState(
  node: PlanNode,
  dgsm: DynamicGameStateManager,
  runtime: any,
  skillRollResult: { successLevel: SuccessLevel; detail: string } | null,
  locationId: string,
  language: string,
  registry?: GameEngineRegistry,
  featureNotes?: string[],
  resolutionContext?: ActionResolutionContext,
  toolOutcomes?: string[]
): Promise<SceneStateDelta> {
```

In the same function, after `featureNotes` injection (around line 419), inject tool outcomes:

```ts
if (toolOutcomes && toolOutcomes.length > 0) {
  userPrompt +=
    "\n\n## Pre-Resolution Results\n" +
    toolOutcomes.join("\n") +
    "\n\nNote: Item changes listed above have already been applied to the game state. " +
    "Do NOT output item changes in your response. " +
    "Focus on scene conditions, connection effects, memory, and fatigue.";
}
```

- [ ] **Step 5: Verify build**

Run: `npx tsc --noEmit 2>&1 | head -20`

Expected: Remaining errors only in old test files referencing deleted code.

---

## Task 6: Planning templates and NPC planner output parsing

**Files:**
- Modify: `src/planning/npcPlanningTemplates.ts`
- Modify: `src/planning/NPCPlanningAgent.ts`

- [ ] **Step 1: Update `DEFAULT_DETAILED_NODE_TYPE_REF` in npcPlanningTemplates**

In `src/planning/npcPlanningTemplates.ts`, replace the node type reference section (lines 146-211). Remove `object_interaction` type entirely. Update `action` description and skill guidance:

Change:

```ts
  If your action involves:
  - Moving/hiding/using/modifying a physical item → use "object_interaction"
  - Talking to, persuading, threatening, or observing (with a skill) another character → use "character_interaction"
  - Going to a different location on purpose, such as walking to the courtyard or heading upstairs → use "movement"
```

to:

```ts
  If your action involves:
  - Talking to, persuading, threatening, or observing (with a skill) another character → use "character_interaction"
  - Going to a different location on purpose, such as walking to the courtyard or heading upstairs → use "movement"
  - Manipulating a specific item → use "action" and call the item tool (see Available Tools)
```

Remove the `object_interaction` bullet entirely:

```ts
// DELETE:
- **"object_interaction"**: Interact with a physical object — pick up, hide, move, use, combine, lock, unlock, destroy, etc. Describe what you do in \`action\`. Set \`objectInteractionPayload.itemId\` to the primary item. An LLM resolver handles all state changes.
```

In the skill use section, change:

```ts
- Skill targeting an **object** (Locksmith to pick a lock, Mechanical Repair to fix something, Sleight of Hand to hide an item) → "object_interaction"
```

to:

```ts
- Skill targeting an **object** (Locksmith to pick a lock, Mechanical Repair to fix something, Sleight of Hand to hide an item) → "action" with item tool call
```

- [ ] **Step 2: Update `defaultDetailedOutputSchema`**

In the output schema function (around line 213), change the type enum from `"action|movement|character_interaction|object_interaction"` to `"action|movement|character_interaction"`.

Note: when the registry-generated `outputSchemaPrompt` is provided via params (which it is in practice), this default is not used. But it should be consistent. The registry's `buildOutputSchemaPrompt()` already generates the type list from registered handlers, so after removing `objectInteractionHandler` it will automatically exclude `object_interaction`.

- [ ] **Step 3: Update node guardrails**

In `DEFAULT_NODE_GUARDRAILS_PROMPT` (line 139), change:

```ts
- For object interactions, you may only target items that already appear in \`Items You Can See\` or \`What You're Carrying\`.
```

to:

```ts
- When calling the item tool, you may only target items that already appear in \`Items You Can See\` or \`What You're Carrying\`.
```

- [ ] **Step 4: Parse `tools` from planner output in NPCPlanningAgent**

In `src/planning/NPCPlanningAgent.ts`, at line 599, update the parsed type:

```ts
const parsed = parseJsonResponse<{
  node: Record<string, unknown>;
  tools?: Array<{ name: string; args: Record<string, unknown> }>;
  updatedShortTermIntent?: string;
}>(response);
```

Then after `normalizePlanNode` (around line 626), add:

```ts
// Copy tool calls from response to PlanNode
if (parsed.tools?.length) {
  enrichedNode.tools = parsed.tools;
}
```

- [ ] **Step 5: Update `normalizeNodeTimeRange` for object_interaction duration default**

In `src/planning/NPCPlanningAgent.ts`, find the `normalizeNodeTimeRange` function (around line 77). If there's a `case "object_interaction"` in the default duration logic, change it to fall through to the default case or remove it.

Check line 67:

```ts
case "object_interaction":
```

This can be removed — it will fall through to the default duration.

---

## Task 7: Cleanup — remove objectInteractionHandler and update references

**Files:**
- Delete: `src/engine/handlers/objectInteractionHandler.ts`
- Delete: `src/engine/handlers/__tests__/objectInteractionHandler.test.ts`
- Modify: `src/engine/handlers/index.ts`
- Modify: `src/engine/index.ts`
- Modify: `src/engine/shared/nodeHelpers.ts`
- Modify: `src/engine/runtime/discoveryPipeline.ts`
- Modify: `src/engine/runtime/__tests__/autoActionRecovery.test.ts`
- Modify: `src/planning/types.ts`

- [ ] **Step 1: Remove `object_interaction` from `BuiltinNodeType`**

In `src/planning/types.ts`, change:

```ts
export type BuiltinNodeType =
  | "action"
  | "movement"
  | "character_interaction"
  | "object_interaction";
```

to:

```ts
export type BuiltinNodeType =
  | "action"
  | "movement"
  | "character_interaction";
```

- [ ] **Step 2: Delete `objectInteractionHandler` files**

Delete:
- `src/engine/handlers/objectInteractionHandler.ts`
- `src/engine/handlers/__tests__/objectInteractionHandler.test.ts`

- [ ] **Step 3: Update `src/engine/handlers/index.ts`**

Remove the `objectInteractionHandler` export:

```ts
export { actionHandler } from "./actionHandler.js";
export { movementHandler } from "./movementHandler.js";
export { characterInteractionHandler } from "./characterInteractionHandler.js";
```

- [ ] **Step 4: Update `src/engine/index.ts`**

Remove `objectInteractionHandler` from the handler exports:

```ts
export {
  actionHandler,
  movementHandler,
  characterInteractionHandler,
} from "./handlers/index.js";
```

- [ ] **Step 5: Update `src/engine/shared/nodeHelpers.ts`**

Remove the `object_interaction` payload context (lines 36-41):

```ts
  // DELETE:
  if (node.type === "object_interaction" && node.objectInteractionPayload) {
    const p = node.objectInteractionPayload;
    if (p.itemId) {
      base += " " + t("outcome_item", language, { item: p.itemId });
    }
  }
```

Replace with tool-based context:

```ts
  // Append item context from tool calls
  const itemToolCall = node.tools?.find((t) => t.name === "item");
  if (itemToolCall?.args?.itemId) {
    base += " " + t("outcome_item", language, { item: itemToolCall.args.itemId as string });
  }
```

- [ ] **Step 6: Update `src/engine/runtime/discoveryPipeline.ts`**

At line 76, change:

```ts
if (
  node.type !== "action" &&
  node.type !== "object_interaction"
) {
```

to:

```ts
if (node.type !== "action") {
```

- [ ] **Step 7: Update `autoActionRecovery.test.ts`**

In `src/engine/runtime/__tests__/autoActionRecovery.test.ts`, change test nodes from `type: "object_interaction"` to `type: "action"` with `tools`:

```ts
function makeNode(overrides: Partial<PlanNode> = {}): PlanNode {
  return {
    nodeId: "node-1",
    characterId: "npc-1",
    characterName: "Alice",
    startTime: "08:00",
    endTime: "08:10",
    action: "Fetch the brass key",
    type: "action",
    impact: 1,
    status: "pending",
    tools: [{ name: "item", args: { itemId: "brass_key" } }],
    executionMeta: {
      remainingMinutes: 0,
    },
    ...overrides,
  } as PlanNode;
}

function makeFailedAction(
  overrides: Partial<CharacterAction> = {}
): CharacterAction {
  return {
    characterId: "npc-1",
    characterName: "Alice",
    gameTime: "08:10",
    action: "Fetch the brass key",
    location: "office",
    type: "action",
    impact: 1,
    status: "failed",
    outcome: "brass_key not found",
    failureReason: "object_not_found",
    ...overrides,
  };
}
```

- [ ] **Step 8: Update registry fallback type string**

In `src/engine/registry.ts`, update the fallback type names string (around line 369):

```ts
: "action|movement|character_interaction";
```

- [ ] **Step 9: Verify build and all tests**

Run: `npx tsc --noEmit`

Expected: PASS — no type errors.

Run: `npx vitest run`

Expected: All tests pass (some integration tests may need updates — see Task 8).

---

## Task 8: Update integration tests

**Files:**
- Modify: `src/engine/__tests__/integration.test.ts`
- Move: `src/engine/handlers/__tests__/objectInteractionStateResolver.test.ts` → `src/engine/tools/__tests__/itemStateResolver.test.ts` (if not done in Task 3)

- [ ] **Step 1: Update integration test section "4. object_interaction handler"**

In `src/engine/__tests__/integration.test.ts`, find the `describe("4. object_interaction handler")` section (around line 554). Change it to test the tool pre-check flow:

Change:

```ts
describe("4. object_interaction handler", () => {
  it("returns failed action when item not in scene or inventory", () => {
    const handler = registry.getHandler("object_interaction")!;
```

to:

```ts
describe("4. item tool pre-check", () => {
  it("returns failure when item not in scene or inventory", () => {
    const tool = registry.getTool("item")!;
```

Update the test to call `tool.preCheck()` instead of `handler.execute()`, and adjust the assertion to check `ToolPreCheckResult` instead of `CharacterAction`.

Update the node type from `"object_interaction"` to `"action"` and add `tools` field.

- [ ] **Step 2: Update integration test section "13. real LLM — object_interaction resolver"**

Find the `describe("13. real LLM — object_interaction resolver")` section (around line 903). Update node types and descriptions:

Change node `type: "object_interaction"` to `type: "action"` with `tools: [{ name: "item", args: { itemId: "..." } }]`.

Update to call `resolveItemState` instead of `resolveObjectInteractionState`, and check `delta.outcome` instead of `delta.memory`.

- [ ] **Step 3: Update itemStateResolver test assertions**

In `src/engine/tools/__tests__/itemStateResolver.test.ts` (moved from objectInteractionStateResolver.test.ts), update:

- All `delta.memory` references → `delta.outcome`
- All `resolveObjectInteractionState` → `resolveItemState`
- All `type: "object_interaction"` → `type: "action"`

- [ ] **Step 4: Run all tests**

Run: `npx vitest run`

Expected: All PASS.

- [ ] **Step 5: Run type check and lint**

Run: `npx tsc --noEmit && pnpm check`

Expected: All PASS.

---

## Verification

- [ ] `pnpm build:tsc` passes
- [ ] `pnpm test` passes (all tests)
- [ ] `pnpm check` passes (biome lint + format)
- [ ] Registry no longer has `object_interaction` handler
- [ ] Registry has `item` tool registered
- [ ] `buildOutputSchemaPrompt()` includes `tools` field and "Available Tools" section
- [ ] Planning template no longer mentions `object_interaction`
- [ ] `PlanNode` has `tools?: ToolCall[]` field
- [ ] `ObjectStateDelta` uses `outcome` instead of `memory`, no `fatigueDelta`
