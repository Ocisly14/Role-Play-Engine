# Core Types + Registry Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define `EngineTool`, `EngineToolCall`, and related types, then add EngineTool registration and execution to the registry — the foundation for the four-layer architecture.

**Architecture:** Add new types alongside existing `NodeHandler`/`ActionTool` (no breaking changes). Registry gets new methods for EngineTool CRUD and execution. Existing handler/feature/tool code remains untouched — conversion happens in a later sub-project.

**Tech Stack:** TypeScript, Vitest, Biome (2-space indent, double quotes, semicolons, trailing commas ES5)

---

### Task 1: Define EngineTool type interfaces

**Files:**
- Modify: `src/engine/types.ts` (append new interfaces at end of file)

- [ ] **Step 1: Write the failing test**

Create `src/engine/__tests__/engineToolTypes.test.ts`:

```typescript
import type {
  EngineTool,
  EngineToolCall,
  EngineToolResult,
  EngineToolSchema,
  EngineNarrative,
} from "../types.js";

describe("EngineTool type contracts", () => {
  it("EngineToolCall has toolId and params", () => {
    const call: EngineToolCall = {
      toolId: "move",
      params: { destination: "scene_01" },
    };
    expect(call.toolId).toBe("move");
    expect(call.params.destination).toBe("scene_01");
  });

  it("EngineToolSchema declares required and optional params", () => {
    const schema: EngineToolSchema = {
      requiredParams: [
        { name: "destination", type: "string", description: "target scene" },
      ],
      optionalParams: [
        { name: "skill", type: "string", description: "skill to use" },
      ],
      example: { destination: "scene_01" },
    };
    expect(schema.requiredParams).toHaveLength(1);
    expect(schema.optionalParams).toHaveLength(1);
  });

  it("EngineNarrative carries outcome and optional memories", () => {
    const narrative: EngineNarrative = {
      outcome: "Moved to library",
      memories: [{ characterId: "npc_a", text: "I walked to the library." }],
    };
    expect(narrative.outcome).toBe("Moved to library");
    expect(narrative.memories).toHaveLength(1);
  });

  it("EngineToolResult pairs delta with narrative", () => {
    const result: EngineToolResult<{ moveTo: string }> = {
      delta: { moveTo: "scene_01" },
      narrative: { outcome: "Moved" },
    };
    expect(result.delta.moveTo).toBe("scene_01");
    expect(result.narrative.outcome).toBe("Moved");
  });

  it("EngineTool defines id, schema, execute, and applyDelta", () => {
    const tool: EngineTool<{ moveTo: string }> = {
      id: "move",
      description: "Move to a destination",
      schema: {
        requiredParams: [
          { name: "destination", type: "string", description: "target" },
        ],
        example: { destination: "scene_01" },
      },
      execute: async () => ({
        delta: { moveTo: "scene_01" },
        narrative: { outcome: "Moved" },
      }),
      applyDelta: () => {},
    };
    expect(tool.id).toBe("move");
    expect(tool.schema.requiredParams).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/__tests__/engineToolTypes.test.ts`
Expected: FAIL — types `EngineTool`, `EngineToolCall`, etc. do not exist yet.

- [ ] **Step 3: Add the type definitions to types.ts**

Append to the end of `src/engine/types.ts`:

```typescript
// ===== EngineTool: unified operation (replaces NodeHandler + ActionTool) =====

/** Parameter schema for an EngineTool — like an LLM function definition */
export interface EngineToolSchema {
  requiredParams: Array<{ name: string; type: string; description: string }>;
  optionalParams?: Array<{ name: string; type: string; description: string }>;
  example: Record<string, unknown>;
}

/** Narrative output from an EngineTool execution */
export interface EngineNarrative {
  /** Brief outcome description */
  outcome: string;
  /** Per-character memory entries */
  memories?: Array<{ characterId: string; text: string }>;
}

/** Result of executing an EngineTool */
export interface EngineToolResult<TDelta = unknown> {
  delta: TDelta;
  narrative: EngineNarrative;
}

/** EngineTool definition — registered in registry, invoked via EngineToolCall */
export interface EngineTool<TDelta = unknown> {
  /** Unique identifier (e.g. "move", "action", "item") */
  id: string;
  /** Human-readable description */
  description: string;
  /** Parameter schema — describes what params this tool accepts */
  schema: EngineToolSchema;
  /** Execute the tool with given params, producing a delta and narrative */
  execute(
    params: Record<string, unknown>,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext,
  ): Promise<EngineToolResult<TDelta>>;
  /** Apply the produced delta to state */
  applyDelta(dgsm: DynamicGameStateManager, delta: TDelta): void;
}

/** Tool call produced by the translation layer — like an LLM tool_call */
export interface EngineToolCall {
  toolId: string;
  params: Record<string, unknown>;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/__tests__/engineToolTypes.test.ts`
Expected: PASS — all 5 type contract tests pass.

- [ ] **Step 5: Run biome check**

Run: `pnpm check`
Expected: No errors.

---

### Task 2: Add EngineTool registration to registry

**Files:**
- Modify: `src/engine/registry.ts` (add new Map + register/get/getAll methods)
- Test: `src/engine/__tests__/engineToolRegistry.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/engine/__tests__/engineToolRegistry.test.ts`:

```typescript
import { GameEngineRegistry } from "../registry.js";
import type { EngineTool } from "../types.js";

function makeMockEngineTool(id: string): EngineTool {
  return {
    id,
    description: `Mock ${id} tool`,
    schema: {
      requiredParams: [
        { name: "target", type: "string", description: "target" },
      ],
      example: { target: "x" },
    },
    execute: async () => ({
      delta: {},
      narrative: { outcome: "done" },
    }),
    applyDelta: () => {},
  };
}

describe("GameEngineRegistry — EngineTool registration", () => {
  it("registerEngineTool + getEngineTool", () => {
    const registry = new GameEngineRegistry();
    const tool = makeMockEngineTool("move");
    registry.registerEngineTool(tool);
    expect(registry.getEngineTool("move")).toBe(tool);
    expect(registry.getEngineTool("unknown")).toBeUndefined();
  });

  it("getAllEngineTools returns all registered tools", () => {
    const registry = new GameEngineRegistry();
    registry.registerEngineTool(makeMockEngineTool("move"));
    registry.registerEngineTool(makeMockEngineTool("action"));
    const all = registry.getAllEngineTools();
    expect(all).toHaveLength(2);
    expect(all.map((t) => t.id).sort()).toEqual(["action", "move"]);
  });

  it("warns on overwrite", () => {
    const registry = new GameEngineRegistry();
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    registry.registerEngineTool(makeMockEngineTool("move"));
    registry.registerEngineTool(makeMockEngineTool("move"));
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("Overwriting engine tool: move"),
    );
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/__tests__/engineToolRegistry.test.ts`
Expected: FAIL — `registerEngineTool` does not exist on `GameEngineRegistry`.

- [ ] **Step 3: Add EngineTool registration methods to registry**

In `src/engine/registry.ts`, update the import to include all new types:

```typescript
import type {
  ActionTool,
  ActivateResult,
  EngineTool,
  EngineNarrative,
  EngineToolCall,
  EngineToolResult,
  ExecutionContext,
  NodeHandler,
  NodeStartBlockedResult,
  ToolPreCheckResult,
  WorldFeature,
} from "./types.js";
```

Add a new private Map and methods to the `GameEngineRegistry` class (after the existing tool management section):

```typescript
  // ===== EngineTool management (new unified tools) =====

  private engineTools = new Map<string, EngineTool>();

  registerEngineTool(tool: EngineTool): void {
    if (this.engineTools.has(tool.id)) {
      console.warn(
        `[GameEngineRegistry] Overwriting engine tool: ${tool.id}`,
      );
    }
    this.engineTools.set(tool.id, tool);
  }

  getEngineTool(id: string): EngineTool | undefined {
    return this.engineTools.get(id);
  }

  getAllEngineTools(): EngineTool[] {
    return [...this.engineTools.values()];
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/__tests__/engineToolRegistry.test.ts`
Expected: PASS — all 3 tests pass.

- [ ] **Step 5: Run biome check**

Run: `pnpm check`
Expected: No errors.

---

### Task 3: Add tool call execution and delta application to registry

**Files:**
- Modify: `src/engine/registry.ts` (add executeToolCall, executeToolCalls, applyToolResult)
- Test: `src/engine/__tests__/engineToolRegistry.test.ts` (add execution tests)

- [ ] **Step 1: Write the failing tests**

Append to `src/engine/__tests__/engineToolRegistry.test.ts`:

```typescript
describe("GameEngineRegistry — EngineTool execution", () => {
  it("executeToolCall invokes tool.execute with params", async () => {
    const registry = new GameEngineRegistry();
    const executeSpy = vi.fn().mockResolvedValue({
      delta: { moveTo: "scene_01" },
      narrative: { outcome: "Moved" },
    });
    const tool = {
      ...makeMockEngineTool("move"),
      execute: executeSpy,
    };
    registry.registerEngineTool(tool);

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = {} as any;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const ctx = {} as any;
    const result = await registry.executeToolCall(
      { toolId: "move", params: { destination: "scene_01" } },
      dgsm,
      ctx,
    );

    expect(executeSpy).toHaveBeenCalledWith(
      { destination: "scene_01" },
      dgsm,
      ctx,
    );
    expect(result.delta).toEqual({ moveTo: "scene_01" });
    expect(result.narrative.outcome).toBe("Moved");
  });

  it("executeToolCall throws on unknown toolId", async () => {
    const registry = new GameEngineRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = {} as any;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const ctx = {} as any;
    await expect(
      registry.executeToolCall(
        { toolId: "nonexistent", params: {} },
        dgsm,
        ctx,
      ),
    ).rejects.toThrow("Unknown engine tool: nonexistent");
  });

  it("executeToolCalls runs multiple calls sequentially", async () => {
    const registry = new GameEngineRegistry();
    const order: string[] = [];

    const moveTool: EngineTool = {
      ...makeMockEngineTool("move"),
      execute: async () => {
        order.push("move");
        return { delta: { moveTo: "s1" }, narrative: { outcome: "Moved" } };
      },
    };
    const actionTool: EngineTool = {
      ...makeMockEngineTool("action"),
      execute: async () => {
        order.push("action");
        return { delta: { searched: true }, narrative: { outcome: "Searched" } };
      },
    };
    registry.registerEngineTool(moveTool);
    registry.registerEngineTool(actionTool);

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = {} as any;
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const ctx = {} as any;
    const results = await registry.executeToolCalls(
      [
        { toolId: "move", params: { destination: "s1" } },
        { toolId: "action", params: { action: "search" } },
      ],
      dgsm,
      ctx,
    );

    expect(results).toHaveLength(2);
    expect(order).toEqual(["move", "action"]);
    expect(results[0].toolId).toBe("move");
    expect(results[1].toolId).toBe("action");
  });

  it("applyToolResult calls tool.applyDelta", () => {
    const registry = new GameEngineRegistry();
    const applySpy = vi.fn();
    const tool = { ...makeMockEngineTool("move"), applyDelta: applySpy };
    registry.registerEngineTool(tool);

    // biome-ignore lint/suspicious/noExplicitAny: test stub
    const dgsm = {} as any;
    registry.applyToolResult("move", dgsm, { moveTo: "scene_01" });
    expect(applySpy).toHaveBeenCalledWith(dgsm, { moveTo: "scene_01" });
  });

  it("applyToolResult throws on unknown toolId", () => {
    const registry = new GameEngineRegistry();
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    expect(() => registry.applyToolResult("nope", {} as any, {})).toThrow(
      "Unknown engine tool: nope",
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/engine/__tests__/engineToolRegistry.test.ts`
Expected: FAIL — `executeToolCall`, `executeToolCalls`, `applyToolResult` do not exist.

- [ ] **Step 3: Add execution and apply methods to registry**

Add these methods to `GameEngineRegistry` class in `src/engine/registry.ts`, inside the `// ===== EngineTool management` section after `getAllEngineTools()`:

```typescript
  async executeToolCall(
    call: EngineToolCall,
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext,
  ): Promise<EngineToolResult> {
    const tool = this.engineTools.get(call.toolId);
    if (!tool) {
      throw new Error(`Unknown engine tool: ${call.toolId}`);
    }
    return tool.execute(call.params, dgsm, ctx);
  }

  async executeToolCalls(
    calls: EngineToolCall[],
    dgsm: DynamicGameStateManager,
    ctx: ExecutionContext,
  ): Promise<Array<{ toolId: string; delta: unknown; narrative: EngineNarrative }>> {
    const results: Array<{
      toolId: string;
      delta: unknown;
      narrative: EngineNarrative;
    }> = [];
    for (const call of calls) {
      const result = await this.executeToolCall(call, dgsm, ctx);
      results.push({
        toolId: call.toolId,
        delta: result.delta,
        narrative: result.narrative,
      });
    }
    return results;
  }

  applyToolResult(
    toolId: string,
    dgsm: DynamicGameStateManager,
    delta: unknown,
  ): void {
    const tool = this.engineTools.get(toolId);
    if (!tool) {
      throw new Error(`Unknown engine tool: ${toolId}`);
    }
    tool.applyDelta(dgsm, delta);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/engine/__tests__/engineToolRegistry.test.ts`
Expected: PASS — all 8 tests pass (3 from Task 2 + 5 new).

- [ ] **Step 5: Run biome check**

Run: `pnpm check`
Expected: No errors.

---

### Task 4: Update exports

**Files:**
- Modify: `src/engine/index.ts` (add new type exports)

- [ ] **Step 1: Add new type exports to index.ts**

Add to the existing type export block in `src/engine/index.ts`:

```typescript
export type {
  EngineTool,
  EngineToolCall,
  EngineToolResult,
  EngineToolSchema,
  EngineNarrative,
} from "./types.js";
```

- [ ] **Step 2: Run all engine tests to verify nothing is broken**

Run: `npx vitest run src/engine/__tests__/`
Expected: PASS — all tests pass (existing + new).

- [ ] **Step 3: Run biome check**

Run: `pnpm check`
Expected: No errors.
