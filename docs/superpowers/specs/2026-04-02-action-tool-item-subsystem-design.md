# ActionTool Abstraction & Item Sub-System Design

## Problem

`object_interaction` 作为独立的 planner type 存在几个问题：

1. **物品操作是跨类型的** — `action` resolver 已经能输出 `items` delta，`character_interaction` resolver 也处理物品交换。物品操作本质上是 engine 能力，不是独立的 action 类型。
2. **混合动作分类困难** — "拿起刀搜索房间" 既涉及物品又涉及环境，planner 只能选一个 type。
3. **planner 心智模型过重** — 4 种 type 的分类规则复杂，减少到 3 种 + tool call 更自然。

## Solution

引入 **ActionTool** 抽象——与 `NodeHandler` 和 `WorldFeature` 平行的第三种 engine 扩展机制。物品操作作为第一个 ActionTool 实现，从独立 handler 降级为 engine 内部子系统。

Planner 通过显式 tool call（类似 LLM function calling）调用 engine 能力，而非选择 handler type。

### Engine 三层架构

| 层 | 职责 | 示例 |
|---|------|------|
| `NodeHandler` | 处理 action type 的前置执行（pre-check, skill roll） | action, movement, character_interaction |
| `WorldFeature` | 世界状态系统（被动 tick、传播） | fire, weather, stamina, sanity |
| `ActionTool` | 动作子系统（主动 tool call、LLM resolution） | item |

## Design

### 1. ToolCall 与 PlanNode

Planner 输出 tool call 作为独立声明，不污染 PlanNode 字段：

```ts
// src/planning/types.ts

export interface ToolCall {
  /** Tool ID, e.g. "item" */
  name: string;
  /** Tool-specific arguments */
  args: Record<string, unknown>;
}

export interface PlanNode {
  // ... 现有字段不变 ...
  /** Engine tool invocations — planner explicitly calls tools when needed */
  tools?: ToolCall[];
}
```

Planner 输出示例（`tools` 在 response level，和 `node` 平级）：

```json
{
  "node": {
    "nodeId": "a1",
    "startTime": "14:00",
    "endTime": "14:10",
    "type": "action",
    "action": "Move the petty cash box from the desk drawer into my briefcase",
    "impact": 1
  },
  "tools": [
    { "name": "item", "args": { "itemId": "petty_cash_box" } }
  ]
}
```

**解析时机：** planner output 解析阶段将 response-level `tools` copy 到 `PlanNode.tools`，使 engine 执行期可以直接从 node 读取。这和 `updatedShortTermIntent` 的处理方式类似——planner 输出在 response level，解析后各归各位。

### 2. ActionTool 接口

```ts
// src/engine/types.ts

export interface ToolResolutionResult<TDelta = unknown> {
  /** Concrete state changes to apply */
  delta: TDelta;
  /** Factual summary of what happened (injected into action resolver as context) */
  outcomeDescription: string;
}

export interface ToolPreCheckResult {
  passed: boolean;
  failureReason?: FailureReason;
  failureDetail?: string;
}

export interface ActionToolArgsSchema {
  requiredArgs: Array<{ name: string; type: string; description: string }>;
  optionalArgs?: Array<{ name: string; type: string; description: string }>;
}

export interface ActionTool<TDelta = unknown> {
  /** Unique identifier (e.g. "item") */
  id: string;

  /** Human-readable description */
  description: string;

  /** Describes the args this tool expects (for planning template auto-generation) */
  argsSchema: ActionToolArgsSchema;

  /** Example tool call (for planning template auto-generation) */
  exampleCall: { name: string; args: Record<string, unknown> };

  /** Static prompt describing when/how to use this tool */
  planningPrompt: string;

  /**
   * Fast deterministic pre-check before handler execution.
   * Called by actionHandler when this tool appears in node.tools.
   * Return { passed: false } to fast-fail the node.
   */
  preCheck(
    node: PlanNode,
    args: Record<string, unknown>,
    dgsm: DynamicGameStateManager
  ): ToolPreCheckResult;

  /**
   * LLM-based resolver. Called BEFORE the action resolver in postProcessing.
   * Returns delta + outcomeDescription for downstream context injection.
   */
  resolve(
    node: PlanNode,
    args: Record<string, unknown>,
    dgsm: DynamicGameStateManager,
    runtime: any,
    skillRollResult: { successLevel: SuccessLevel; detail: string } | null,
    locationId: string,
    language: string,
    resolutionContext: ActionResolutionContext,
    extras: {
      memoryManager?: NpcMemoryManager;
      sessionId?: string;
      registry?: GameEngineRegistry;
      featureNotes?: string[];
    }
  ): Promise<ToolResolutionResult<TDelta>>;

  /**
   * Deterministic apply. Mutates dgsm based on delta.
   * Called immediately after resolve().
   */
  apply(
    dgsm: DynamicGameStateManager,
    actorId: string,
    delta: TDelta,
    locationId: string
  ): void;
}
```

#### Key Design Decisions

1. **`outcomeDescription` 而非 `memory`** — tool 不产出最终记忆，只产出事实性描述（如 "Moved knife_01 from desk to inventory. Container was unlocked."），注入给 action resolver 作为上下文。最终的第一人称 memory 由 action resolver 统一生成。

2. **`fatigueDelta` 由 action resolver 统一处理** — tool 不输出疲劳。action resolver 看到完整上下文（包括 tool 结果），由它统一判断。

3. **泛型 `TDelta`** — 每个 tool 定义自己的 delta 类型（item tool 用 `ObjectStateDelta`），保持类型安全。

### 3. Registry 集成

```ts
// src/engine/registry.ts 新增

private tools = new Map<string, ActionTool>();

registerTool(tool: ActionTool): void {
  this.tools.set(tool.id, tool);
}

/** 从 node.tools 中找到匹配的注册 tool + 对应 args */
getActiveTools(node: PlanNode): Array<{ tool: ActionTool; args: Record<string, unknown> }> {
  if (!node.tools?.length) return [];
  return node.tools
    .map(call => {
      const tool = this.tools.get(call.name);
      return tool ? { tool, args: call.args } : null;
    })
    .filter(Boolean);
}

/** handler 阶段调用，任何 tool preCheck 失败就返回 failure */
runToolPreChecks(
  node: PlanNode,
  dgsm: DynamicGameStateManager
): ToolPreCheckResult | null {
  for (const { tool, args } of this.getActiveTools(node)) {
    const result = tool.preCheck(node, args, dgsm);
    if (!result.passed) return result;
  }
  return null;
}

/** 生成 Available Tools section，注入 planning template */
buildToolPrompt(): string {
  // 遍历注册的 tools，生成：
  // ## Available Tools
  // **item** — description
  // Args: requiredArgs 列表
  // Example: exampleCall JSON
  // 每个 tool 还追加其 planningPrompt
}

/** buildOutputSchemaPrompt() 扩展：在 Response Structure 中渲染 tools 字段 */
// "tools" 作为可选顶层字段出现在 output schema 中：
// { "node": { ... }, "tools": [ { "name": "...", "args": { ... } } ], "updatedShortTermIntent": "..." }
```

### 4. 执行流水线

```
tickProcessor
    │
    ▼
actionHandler.execute()
    ├─ location, penalties
    ├─ registry.runToolPreChecks(node, dgsm)  ← NEW: tool pre-check
    │    └─ itemTool.preCheck() → item existence check
    ├─ skill roll
    └─ return CharacterAction (completed / failed)
    │
    ▼
postProcessExecutedNodeAction()
    │
    ├─ character_interaction → interactionResolver (不变)
    │
    └─ action:
         │
         ├─ registry.getActiveTools(node)
         │
         ├─ 有 active tools?
         │    │
         │    ▼
         │  for each { tool, args }:
         │    tool.resolve(node, args, ...)  ← LLM #1
         │    tool.apply(dgsm, ...)
         │    收集 outcomeDescription
         │
         ▼
       resolveActionState(             ← LLM #2
         ...,
         toolOutcomes                  ← 注入 tool 结果作为上下文
       )
         │
         ▼
       applyActionSceneDelta()
       applyFatigueDelta()
       memory / discovery / ...
```

#### Action Resolver Context Injection

当 toolOutcomes 非空时，在 action resolver 的 user prompt 尾部追加：

```
## Pre-Resolution Results

### Item Manipulation
Moved knife_01 from the desk to actor inventory.
The desk drawer container was unlocked and opened.

Note: Item changes have already been applied to the game state.
Do NOT output item changes in your response.
Focus on scene conditions, connection effects, memory, and fatigue.
```

action resolver 的 output schema 在有 tool 结果时去掉 `items` 字段，避免重复处理。

### 5. Item Tool 实现

第一个（当前唯一的）ActionTool：

```ts
// src/engine/tools/itemTool.ts

export const itemTool: ActionTool<ObjectStateDelta> = {
  id: "item",

  description:
    "Item manipulation sub-system. Handles picking up, moving, modifying, " +
    "destroying, disassembling, combining, and inspecting items.",

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
- Actions targeting the environment (searching a room, barring a door) → plain action
- Actions targeting a character (giving an item to someone) → character_interaction
- Examining the scene generally → plain action`,

  preCheck(node, args, dgsm) {
    // Item existence pre-check
    // Logic migrated from objectInteractionHandler lines 84-128
    const itemId = args.itemId as string;
    if (!itemId) return { passed: true };
    const pos = dgsm.getCharacterPosition(node.characterId);
    const locationId = pos ? dgsm.resolveLocationId(pos) : "";
    const found = findItemAnywhere(dgsm, node.characterId, locationId, itemId);
    if (!found) {
      return {
        passed: false,
        failureReason: "object_not_found",
        failureDetail: `${itemId} not found`,
      };
    }
    return { passed: true };
  },

  async resolve(node, args, dgsm, runtime, skillRollResult, locationId, language, resolutionContext, extras) {
    // Logic migrated from resolveObjectInteractionState()
    // Key change: LLM outputs "outcome" (factual) instead of "memory" (first-person)
    // Key change: no fatigueDelta in output (action resolver handles it)
    const delta = await resolveItemState(
      node, args, dgsm, runtime, skillRollResult,
      locationId, language, resolutionContext, extras
    );
    return {
      delta,
      outcomeDescription: delta.outcome,
    };
  },

  apply(dgsm, actorId, delta, locationId) {
    // Reuse existing applyObjectDelta()
    applyObjectDelta(dgsm, actorId, delta, locationId);
  },
};
```

#### Item Resolver LLM Output Schema Change

| 现有 ObjectStateDelta | Item Tool resolver output |
|---|---|
| `items` | 保留 |
| `newItems` | 保留 |
| `addSceneConditions` | 保留 |
| `memory` (first-person) | 改为 `outcome` (factual description) |
| `fatigueDelta` | 移除（action resolver 统一处理） |

### 6. Planner 心智模型

**之前（4 类型）：**
```
去别的地方        → movement
主要目标是物品     → object_interaction + objectInteractionPayload
主要目标是人物     → character_interaction
其余当前位置动作   → action
```

**之后（3 类型 + tool calls）：**
```
去别的地方        → movement
主要目标是人物     → character_interaction
其余当前位置动作   → action
  └─ 涉及特定物品？ → call item tool
```

Planning template output schema 变化：

```json
{
  "node": {
    "nodeId": "unique-id",
    "startTime": "HH:MM",
    "endTime": "HH:MM",
    "action": "description of what the character does",
    "type": "action|movement|character_interaction",
    "skill": "exact skill name (OMIT if no check needed)",
    "impact": 0
  },
  "tools": [
    { "name": "item", "args": { "itemId": "target_id" } }
  ],
  "updatedShortTermIntent": "optional"
}
```

`tools` 字段可选。不涉及任何 tool 时省略。

## File Map

### Delete

| File | Reason |
|------|--------|
| `src/engine/handlers/objectInteractionHandler.ts` | Handler 逻辑拆到 actionHandler (skill roll) + itemTool (preCheck) |
| `src/engine/handlers/__tests__/objectInteractionHandler.test.ts` | 跟随 handler 删除 |

### Create

| File | Content |
|------|---------|
| `src/engine/tools/itemTool.ts` | ActionTool 实现，逻辑从 objectInteractionStateResolver 迁移 |

### Modify

| File | Change |
|------|--------|
| `src/planning/types.ts` | 从 `BuiltinNodeType` 删除 `"object_interaction"`；新增 `ToolCall` 接口；`PlanNode` 新增 `tools?: ToolCall[]`；`ObjectStateDelta` 停止继承 `FatigueEffectDelta`，`memory` 字段改为 `outcome`（factual description） |
| `src/engine/types.ts` | 新增 `ActionTool` / `ActionToolArgsSchema` / `ToolPreCheckResult` / `ToolResolutionResult` 接口 |
| `src/engine/registry.ts` | 新增 `tools` Map + `registerTool()` / `getActiveTools()` / `runToolPreChecks()` / `buildToolPrompt()`；`buildOutputSchemaPrompt()` 渲染 tools 字段和 Available Tools section |
| `src/engine/registerDefaults.ts` | 删除 `objectInteractionHandler` 注册；新增 `itemTool` 注册 |
| `src/engine/handlers/index.ts` | 删除 `objectInteractionHandler` export |
| `src/engine/handlers/actionHandler.ts` | `execute()` 内新增 `registry.runToolPreChecks()` 调用 |
| `src/engine/runtime/actionPostProcessing.ts` | 删除 `objectInteractionAttempted` 分支；action 分支内新增 tool resolve/apply 流水线；把 toolOutcomes 注入 action resolver |
| `src/engine/handlers/objectInteractionStateResolver.ts` | 重命名/移动到 `src/engine/tools/itemStateResolver.ts`；prompt 改为输出 `outcome`（factual）而非 `memory`（first-person）；移除 `fatigueDelta` 输出 |
| `src/engine/handlers/actionStateResolver.ts` | `resolveActionState()` 新增 `toolOutcomes` 参数；user prompt 支持注入 tool 结果；有 tool 结果时 output schema 去掉 `items` 字段 |
| `src/planning/npcPlanningTemplates.ts` | 删除 `object_interaction` type 引导；物品操作改为 "action + call item tool" |
| `src/planning/revisionHelpers.ts` | 如有 `object_interaction` 引用，改为 `action` |

### Keep (reuse)

| File | Reason |
|------|--------|
| `applyItemResults()` / `applyObjectDelta()` in objectInteractionStateResolver | 纯 apply 逻辑不变，被 itemTool.apply() 调用 |
| `characterInteractionHandler` + `interactionStateResolver` | 人物交互保持独立 |
| `movementHandler` | 不涉及 |

## Out of Scope

- 把 `character_interaction` 也改为 tool call 模式（人物交互仍保留为独立 handler）
- 新增其他 ActionTool（crafting, trap 等留给后续设计）
- 修改 item schema / 新增 item 属性
- 改变 feature overlay 机制（fire 等仍用现有 overlay field 模式）
