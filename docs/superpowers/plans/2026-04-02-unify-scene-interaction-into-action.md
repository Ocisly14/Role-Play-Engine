# Unify `scene_interaction` into `action` — Implementation Plan

> Update: 当前实现已按“**不需要兼容旧 `scene_interaction` persisted node**”推进，直接执行原文中的 Phase B 终态。下面保留早期 Phase A 讨论，仅作设计记录，不再作为当前实现约束。

> **For agentic workers:** follow this plan task-by-task. Steps use checkbox (`- [ ]`) syntax so progress can be tracked in-place.

**Goal:** 把 planner-visible 的 `scene_interaction` 合并进更强的 `action`，让 `action` 成为统一的“当前地点动作”类型。合并后不再区分“纯叙事 action”和“场景交互 action”；所有 `action` 都进入同一条 LLM state resolver 流程，包含 `completed` 和 `interrupted` 两种执行结果。同时，把“被打断后的 resolver / post-process 处理”扩展为 engine 级契约，覆盖所有 handler。

**Final Shape:**
- 保留 `movement` 作为独立类型
- 保留 `object_interaction` 作为独立类型
- 保留 `character_interaction` 作为独立类型
- 删除 planner-visible 的 `scene_interaction`
- `action` 统一承载：
  - 当前场景内的普通动作
  - 当前场景内的环境搜索/调查/改造
  - 当前场景内的等待、休息、观察、发呆等低影响动作
- 所有 `completed` 或 `interrupted` 的 `action` 都调用统一的 LLM resolver
- 所有 resolver-backed handler 在 `interrupted` 时都进入对应的后处理路径
- 纯叙事动作通过“empty delta + memory”表达，而不是走单独的 no-op path

**Architecture:** 顶层 type 统一，执行路径也统一。`actionHandler` 只负责前置执行语义，LLM resolver 负责生成 action 之后的记忆和环境结果；如果动作没有真实世界改动，resolver 返回 memory-only / empty delta。动作若被打断，也仍走同一个 resolver，只是额外注入“已被打断”和“打断原因/经过时间”等执行上下文，让模型生成 partial 或 empty delta。这个“打断态上下文注入 + partial/empty delta”规则也要扩展到其他 handler family，只是每个 family 的 delta 契约不同；`movement` 为特殊情况，因为位置推进由 runtime 逐 tick 持有。

**Tech Stack:** TypeScript, Vitest

---

## Design Decisions

### 1. 只合并 `scene_interaction` 和 `action`

本次不合并 `movement`、`object_interaction`、`character_interaction`。

原因：
- `movement` 是 multi-tick route execution，不是单次 post-state resolve
- `object_interaction` 仍然需要 item existence pre-check、container/inventory 语义、item delta
- `character_interaction` 仍然需要 target presence、opposed roll、relationship / 双边 memory 更新

### 2. 不增加 `actionResolution` 之类的额外路由字段

统一后的设计里，`action` 不再区分：
- “纯叙事 action”
- “环境变化 action”

它们都走同一个 resolver。区别不由 planner 显式声明，而由 resolver 基于：
- action 文本
- 当前 scene state
- actor 状态
- tool / inventory / world state

来决定是否产生实际 delta。

### 3. 纯叙事动作由 resolver 返回 empty delta

例如：
- “Sit quietly and think”
- “Smoke by the window and watch the street”
- “Wait in the corridor for five minutes”

这些动作仍进入 resolver，但 resolver 应只返回：
- `memory`
- 不返回 scene/item/connection 变更

这样 planner 心智模型最统一，runtime 不需要再做 action 内部分流。

### 4. `interrupted` 也走同一个 resolver

统一后的 `action` 不应只在 `completed` 时走 resolver。

当 action 被 revise / replan 打断时，同一个 resolver 也应被调用，但要额外注入：
- `executionStatus: "interrupted"`
- `interruptionReason`
- `triggerDescription`
- `startedAt`
- `interruptedAt`
- `elapsedMinutes`
- `plannedMinutes`

resolver 根据这些上下文决定：
- 没有产生任何状态变化
- 已经产生部分状态变化
- 留下了什么记忆、痕迹、环境变化

关键约束：
- `interrupted` 不等于 `completed`
- 只有在 action 文本和执行进度支持的情况下，才允许生成 partial delta
- 不能默认脑补“开始了就等于做完了”

### 5. 去掉 `rest` 特判，把疲惫改成“tick 缓慢积累 + resolver 额外修正”的 fatigue bar

当前 `actionHandler` 会直接处理 `routineSubtype:"rest"` 的疲劳恢复。这个特判和“所有 action 都进入统一 resolver”的方向冲突。

目标改为：
- 删除 `routineSubtype:"rest"` 这类恢复特判
- stamina / fatigue 改成更明确的数值条
- `tick` 按时间缓慢积累基础疲惫
- resolver 额外输出疲惫修正
- engine 负责基础 tick 累积、resolver 修正的 apply、约束、累加、截断和持久化

建议统一输出：

```ts
fatigueDelta: -3 | -2 | -1 | 0 | 1 | 2 | 3
fatigueReason: string
```

规则：
- 负数 = 恢复
- 正数 = 消耗
- 0 = 无明显变化

注意：
- 这次不改 item schema
- LLM 直接依据现有 action 文本、时长、scene/world context、inventory/item description 来判断 `fatigueDelta`
- engine 继续保留被动疲惫积累，只对 resolver 给出的 `fatigueDelta` 做 guardrail 和 apply

### 6. 两阶段 rollout，避免打断进行中的 session

系统通过 Prisma 持久化 simulation runtime，可能存在已生成但尚未执行的 `scene_interaction` node。

因此 rollout 仍建议两阶段：

**Phase A: Expand + Migrate**
- planner 停止产出 `scene_interaction`
- runtime 同时接受：
  - 新的 unified `action`
  - 旧的 `scene_interaction`
- 两者共用同一套 action-state resolver / apply pipeline

**Phase B: Remove**
- 清理 legacy `scene_interaction` prompt / handler / tests / exports
- 从 `BuiltinNodeType` 中移除 `scene_interaction`

### 7. “被打断后如何处理”是 engine 级契约，不是 `action` 特例

本次虽然主要改的是 `scene_interaction -> action`，但 interrupted 语义不应只加在 unified `action` 上。

目标形态：
- `action`：走 unified action resolver，允许 empty / partial / full scene delta
- `object_interaction`：走 object resolver，允许 empty / partial / full item delta
- `character_interaction`：走 character resolver，允许 empty / partial / limited bilateral delta
- `movement`：走 movement-specific interruption post-process，位置仍以 runtime 已推进状态为准，resolver 主要负责 memory / 叙述性后果

统一注入的 interruption metadata 应至少包括：
- `executionStatus`
- `interruptionReason`
- `triggerDescription`
- `startedAt`
- `interruptedAt`
- `elapsedMinutes`
- `plannedMinutes`

不要求所有 handler 共享同一个 delta schema，但要求它们共享同一种“被打断时也可生成状态后果”的执行契约。

---

## File Map

| File | Change | Responsibility |
|------|--------|----------------|
| `src/planning/types.ts` | Modify | Phase A 保留 `scene_interaction` 兼容；Phase B 删除 built-in type；可新增 `ActionStateDelta` 或扩展现有 delta 语义 |
| `src/planning/npcPlanningTemplates.ts` | Modify | 重写 node type prompt；移除 planner-facing `scene_interaction`；定义 unified `action` 规则 |
| `src/engine/handlers/actionHandler.ts` | Modify | 改成 unified action 的 pre-resolution executor |
| `src/engine/runtime/actionPostProcessing.ts` | Modify | 所有 completed/interrupted `action` 都调用统一 action resolver，并在 resolver 后应用 deterministic side effect |
| `src/engine/handlers/sceneInteractionStateResolver.ts` | Modify or rename | 扩展为 unified action resolver；Phase B 可重命名为 `actionStateResolver.ts` |
| `src/engine/handlers/objectInteractionStateResolver.ts` | Modify | 扩展 interrupted object handling，支持 partial item delta / memory-only |
| `src/engine/handlers/interactionStateResolver.ts` | Modify | 扩展 interrupted character handling，支持 partial bilateral delta / memory-only |
| `src/engine/features/staminaFeature.ts` | Modify | 从“minutesSinceLastRest + restCharacter”迁移到 fatigue bar + passive tick accumulation + resolver modifier 模型 |
| `src/engine/handlers/sceneInteractionHandler.ts` | Phase A modify / Phase B delete | 作为 legacy shim 或删除 |
| `src/engine/handlers/index.ts` | Modify | Phase B 删除 `sceneInteractionHandler` export |
| `src/engine/registerDefaults.ts` | Modify | Phase B 取消注册 `sceneInteractionHandler` |
| `src/engine/runtime/tickProcessor.ts` | Verify / minor modify | 确认各 handler 的 interrupted action 都能进入后处理，不只 action |
| `src/engine/runtime/movementTick.ts` | Modify | 定义 movement interrupted 的 memory / outcome 生成方式，保持位置以 runtime 实际进度为准 |
| `src/engine/runtime/impactPipeline.ts` | Modify | 中断当前 node 时补齐 triggerDescription / interruption metadata，供各 family resolver 使用 |
| `src/engine/handlers/__tests__/actionHandler.test.ts` | Modify | 覆盖 unified action 的 pre-resolution 行为 |
| `src/engine/handlers/__tests__/objectInteractionHandler.test.ts` | Modify | 覆盖 interrupted object handling 的入口条件 |
| `src/engine/handlers/__tests__/characterInteractionHandler.test.ts` | Modify | 覆盖 interrupted character handling 的入口条件 |
| `src/engine/handlers/__tests__/sceneInteractionHandler.test.ts` | Phase A update / Phase B delete | legacy 覆盖或移除 |
| `src/engine/handlers/__tests__/sceneInteractionStateResolver.test.ts` | Modify | 改成验证 unified `action` resolver |
| `src/engine/handlers/__tests__/objectInteractionStateResolver.test.ts` | Modify | 增加 interrupted object resolver 覆盖 |
| `src/engine/handlers/__tests__/interactionStateResolver.test.ts` | Modify | 增加 interrupted character resolver 覆盖 |
| `src/planning/__tests__/npcPlanningTemplates.test.ts` | Modify | 更新 prompt 断言，删除 `scene_interaction` 输出要求 |
| `src/engine/__tests__/integration.test.ts` | Modify | 增加 unified action 的端到端执行覆盖 |

---

## Target Model

### Planner Output Semantics

目标规则：
- 去别的地方 -> `movement`
- 主要目标是便携物品 -> `object_interaction`
- 主要目标是人物 -> `character_interaction`
- 其余发生在当前位置的动作 -> `action`

也就是说，以下都统一产出 `action`：
- 等待、休息、观察、发呆
- 搜索房间、调查环境
- 拉窗帘、关灯、堵门、打开隐藏通路

不再需要 planner 显式声明 action 属于“纯叙事”还是“环境变更”。

### Action Delta Contract

统一后的 `action` 需要一个统一的 resolver 输出契约。建议目标形态如下：

```ts
export interface ActionStateDelta {
  addSceneConditions?: SceneCondition[];
  removeSceneConditions?: string[];
  connectionEffects?: Array<{
    targetId: string;
    action: "block" | "unblock" | "reveal" | "hide";
  }>;
  items?: ItemResult[];
  fatigueDelta?: -3 | -2 | -1 | 0 | 1 | 2 | 3;
  fatigueReason?: string;
  memory: string;
}
```

说明：
- 这是“当前地点 action”的结果契约
- 纯叙事动作只需要返回 `memory`
- 环境动作按需返回 scene / connection / item delta
- 疲惫变化由两部分组成：tick 的基础缓慢积累 + resolver 输出的 `fatigueDelta`
- Phase A 如需最小改造，也可以暂时保留 `SceneStateDelta` 名称，只把语义拓宽到全部 `action`

### Engine-wide Interruption Contract

本次需要补一个跨 handler 的统一中断上下文：

```ts
interface ResolutionExecutionContext {
  executionStatus: "completed" | "interrupted";
  interruptionReason?: "revise_replan" | "character_dead";
  triggerDescription?: string;
  startedAt?: string;
  interruptedAt?: string;
  elapsedMinutes?: number;
  plannedMinutes?: number;
}
```

应用原则：
- `action` / `object_interaction` / `character_interaction` 都把这组 metadata 注入各自 resolver
- `movement` 也拿到这组 metadata，但位置状态不由 resolver 重算
- `failed` 仍不默认进入 resolver，除非后续单独设计

---

## Phase A: Expand + Migrate

### Task 1: 先把 planner 语义统一到 `action`

**Files:**
- Modify: `src/planning/npcPlanningTemplates.ts`

- [ ] **Step 1: 重写 `DEFAULT_NODE_GUARDRAILS_PROMPT`**

把旧规则：
- 环境搜索/调查/修改 -> `scene_interaction`

改成：
- 当前位置的环境搜索/调查/修改 -> `action`

- [ ] **Step 2: 重写 `DEFAULT_DETAILED_NODE_TYPE_REF`**

新定义应明确：
- `action` = any current-location action that is not movement, object-targeted, or character-targeted
- 纯叙事动作和环境动作都用 `action`
- engine 会在 action 执行后统一解析其后果

- [ ] **Step 3: 更新输出 schema 示例**

示例应同时覆盖：

```json
{
  "action": "Sit quietly and think about the missing ledger",
  "type": "action",
  "impact": 0
}
```

以及：

```json
{
  "action": "Pull the curtains shut and darken the room",
  "type": "action",
  "impact": 1
}
```

- [ ] **Step 4: 删除 prompt 中对 planner 输出 `scene_interaction` 的要求**

Phase A runtime 仍兼容旧节点，但 planner 不再生成它。

---

### Task 2: 引入 unified action delta 语义

**Files:**
- Modify: `src/planning/types.ts`

- [ ] **Step 1: Phase A 暂时保留 `scene_interaction` 在 `BuiltinNodeType` 中**

原因：兼容旧 session 的 persisted node。

- [ ] **Step 2: 为 unified action 明确 delta 契约**

二选一：
- 新增 `ActionStateDelta`
- 或保留 `SceneStateDelta` 名称，但补注释说明它现在用于所有 `action`

建议偏向新增 `ActionStateDelta`，语义更清晰。

- [ ] **Step 3: 不新增 action 路由字段**

这次不增加 `actionResolution`、`sceneToolItemId` 等新的 planner 路由字段，先让 unified action 只靠现有 action 文本和注入上下文运行。

- [ ] **Step 4: 不改 item schema**

fatigue 判断先不依赖新的 item 属性，直接使用现有注入的 item 名称、描述、inventory、scene context 让 LLM 推断。

---

### Task 3: 把 `actionHandler` 改成统一前置执行器

**Files:**
- Modify: `src/engine/handlers/actionHandler.ts`

- [ ] **Step 1: 更新 `description`**

从“纯叙事、无状态动作”改成“当前地点动作”，并明确：
- 该 handler 只负责执行前置语义
- 后果解析统一由 action resolver 完成

- [ ] **Step 2: 保留 skill roll、location 解析、penalty 计算**

`actionHandler.execute()` 仍负责：
- 当前位置解析
- scene / character penalties
- optional skill roll
- 失败时返回 failed action

- [ ] **Step 3: 移除 handler 内的世界状态突变**

特别是：
- 不再在 handler 内直接 `restCharacter()`

因为 unified action resolver 需要读到 pre-action state。

- [ ] **Step 4: 删除 `routineSubtype:"rest"` 的执行语义**

如需兼容旧节点，Phase A 可以临时读取但不再作为主语义；长期目标是删除。

---

### Task 4: 所有 completed / interrupted `action` 都进入统一 resolver

**Files:**
- Modify: `src/engine/runtime/actionPostProcessing.ts`
- Modify or rename: `src/engine/handlers/sceneInteractionStateResolver.ts`

- [ ] **Step 1: 抽象 `shouldResolveActionState(node, action)`**

建议规则：

```ts
const shouldResolveActionState =
  (action.status === "completed" || action.status === "interrupted") &&
  (node.type === "action" || node.type === "scene_interaction");
```

Phase A 里 legacy `scene_interaction` 也走同一条分支。

- [ ] **Step 2: 把现有 scene resolver 扩成 unified action resolver**

让下面两种 node 共用同一逻辑：
- new `action`
- legacy `scene_interaction`

- [ ] **Step 3: 把 prompt 从 “Scene Interaction Node” 改成更通用的 action resolver prompt**

它必须支持两类结果：
- memory-only / no world change
- memory + scene / connection / item delta
- completed / interrupted 两种执行状态
- fatigue 增减

- [ ] **Step 4: 注入执行状态和打断元数据**

对 unified action resolver，至少注入：
- `executionStatus`
- `interruptionReason`
- `triggerDescription`
- `startedAt`
- `interruptedAt`
- `elapsedMinutes`
- `plannedMinutes`

其中：
- `completed` 时只注入完成态相关字段
- `interrupted` 时补齐打断态字段

- [ ] **Step 5: prompt 中加入明确的 empty-delta / partial-delta 约束**

例如要求：
- 如果动作没有造成任何环境、连接、物品变化，则不要编造状态变化
- 只返回 `memory`
- `interrupted` 时默认偏向 empty delta 或 partial delta，除非上下文足以支持更明确的变化
- `fatigueDelta` 必须是 `-3..3` 的整数，非法值视为 `0`
- 在判断疲惫时，可依据动作内容、执行时长、环境、现有物品描述和当前疲惫状态，但不要编造不存在的工具属性

- [ ] **Step 6: 注入 unified action 所需的上下文**

至少包括：
- actor conditions
- current scene block
- visible items
- inventory
- connected locations
- world state block
- feature notes

这样纯叙事动作和环境动作都能在一个 prompt 内被处理。

- [ ] **Step 7: 定义 interrupted action 的 apply 语义**

规则建议：
- `completed` 和 `interrupted` 都允许 apply delta
- `interrupted` 产生的 delta 允许是 partial
- `failed` 仍不进入 unified action resolver
- `character_dead` 的打断可先只支持 memory-only，如果后续需要再放开 partial delta

---

### Task 5: 把 interrupted resolver 语义扩展到所有 handler

**Files:**
- Modify: `src/engine/runtime/actionPostProcessing.ts`
- Modify: `src/engine/handlers/objectInteractionStateResolver.ts`
- Modify: `src/engine/handlers/interactionStateResolver.ts`
- Modify: `src/engine/runtime/movementTick.ts`
- Modify: `src/engine/runtime/impactPipeline.ts`

- [ ] **Step 1: 抽出统一的 execution context 计算逻辑**

至少为 resolver/post-process 计算：
- `executionStatus`
- `interruptionReason`
- `triggerDescription`
- `startedAt`
- `interruptedAt`
- `elapsedMinutes`
- `plannedMinutes`

- [ ] **Step 2: `object_interaction` 在 interrupted 时也进 object resolver**

约束：
- 默认允许 memory-only 或 partial item delta
- 不能把 interrupted 自动当成完成了整个 object operation

- [ ] **Step 3: `character_interaction` 在 interrupted 时也进 character resolver**

约束：
- 默认允许 memory-only 或 limited bilateral delta
- 只有上下文明确支持时，才允许部分人物状态变化
- 关系变化应更保守，避免把“未完成的互动”误算成完整 social outcome

- [ ] **Step 4: `movement` 使用 movement-specific interrupted post-process**

规则：
- 位置以 runtime 已推进的真实位置为准
- 不让 resolver 重新 author 位置
- 允许生成 memory / outcome / 少量叙述性后果

- [ ] **Step 5: `impactPipeline` 构造 interrupted action 时补齐 triggerDescription**

当前只是简单 build interrupted action，不足以支撑 resolver 判断部分结果。

- [ ] **Step 6: `tickProcessor` 确保所有 interrupted action 都能进入相应后处理**

目标：
- 不只是 unified `action`
- 而是所有 handler family 都有 interrupted post-process 入口

---

### Task 6: 把 stamina 从 rest 特判改成 fatigue bar + tick accumulation + resolver modifier

**Files:**
- Modify: `src/engine/runtime/actionPostProcessing.ts`
- Modify: `src/engine/features/staminaFeature.ts`
- Modify: `src/planning/npcPlanningTemplates.ts`

- [ ] **Step 1: 把 stamina state 改成更明确的 fatigue bar**

目标：
- 去掉 `restCharacter()` 这种 action-handler 特判恢复路径
- 改成更直接的 fatigue 数值状态
- 保留 tick 驱动的基础疲惫累积
- 仍可保留疲惫条件和 skill penalty 映射

- [ ] **Step 2: 让 `tick()` 按时间缓慢积累基础疲惫**

要求：
- 基础累积继续由 stamina feature 持有
- 速度应偏保守，避免和 resolver 修正叠加后过快爆表
- 现有环境加速逻辑可以保留，但要重新校准为“基础缓慢积累”语义

- [ ] **Step 3: 让 unified action resolver 输出 `fatigueDelta`**

规则：
- 范围固定为 `-3..3`
- resolver 负责判断
- 这是对基础 tick 累积的额外修正，不是唯一来源

- [ ] **Step 4: engine apply fatigue delta**

至少包括：
- 非法值回退为 `0`
- 按上下限 clamp
- 写回 stamina feature state
- 根据 bar 区间更新疲惫 condition / skill penalty

- [ ] **Step 5: planning prompt 去掉“rest 特判”心智模型**

NPC 仍然会计划休息，但休息不再依赖 `routineSubtype:"rest"`，而是一个普通 `action`，其恢复效果由 resolver 输出的 `fatigueDelta < 0` 表达。

- [ ] **Step 6: 不改物品 schema**

fatigue 推断只依赖已有注入上下文，不给 item 加新字段。

---

### Task 7: 让 legacy `scene_interaction` 在 Phase A 继续可执行

**Files:**
- Modify: `src/engine/handlers/sceneInteractionHandler.ts`
- Verify: `src/engine/registerDefaults.ts`
- Verify: `src/engine/handlers/index.ts`

- [ ] **Step 1: Phase A 保留 handler 注册**

原因：历史 pending node / persisted session 仍可能存在。

- [ ] **Step 2: 将 `sceneInteractionHandler` 标注为 legacy shim**

它的职责应退化为：
- 兼容旧类型输入
- 把执行结果导入 unified action resolver / apply pipeline

- [ ] **Step 3: 确认旧节点与新 `action` 的后处理语义一致**

不能因 planner 停止生成旧类型而让旧 session 执行结果发生分叉。

---

## Phase B: Remove Legacy `scene_interaction`

### Task 8: 从类型系统和注册中心移除 `scene_interaction`

**Files:**
- Modify: `src/planning/types.ts`
- Modify: `src/engine/handlers/index.ts`
- Modify: `src/engine/registerDefaults.ts`
- Delete: `src/engine/handlers/sceneInteractionHandler.ts`

- [ ] **Step 1: 从 `BuiltinNodeType` 删除 `"scene_interaction"`**

- [ ] **Step 2: 删除 `sceneInteractionHandler` export**

- [ ] **Step 3: 删除默认注册**

- [ ] **Step 4: 删除 legacy handler 文件**

前提：确认不再需要兼容进行中的 persisted node。

---

### Task 9: 清理 tests 和 prompt 断言

**Files:**
- Modify/Delete: `src/engine/handlers/__tests__/sceneInteractionHandler.test.ts`
- Modify: `src/engine/handlers/__tests__/sceneInteractionStateResolver.test.ts`
- Modify: `src/engine/handlers/__tests__/objectInteractionStateResolver.test.ts`
- Modify: `src/engine/handlers/__tests__/interactionStateResolver.test.ts`
- Modify: `src/engine/handlers/__tests__/movementHandler.test.ts`
- Modify: `src/planning/__tests__/npcPlanningTemplates.test.ts`
- Modify: `src/engine/__tests__/integration.test.ts`

- [ ] **Step 1: 删除对 planner 输出 `scene_interaction` 的断言**

- [ ] **Step 2: 将 resolver 测试入口切到 unified `action`**

- [ ] **Step 3: 为 unified `action` 增加以下集成覆盖**

至少覆盖：
- `action` 触发 memory-only / empty delta
- `action` 触发 scene delta 并修改 scene state
- `action` 通过 `fatigueDelta < 0` 恢复疲劳
- `action` 通过 `fatigueDelta > 0` 增加疲劳
- `object_interaction` 被打断后进入 object resolver，并只产生合理的 partial / empty item delta
- `character_interaction` 被打断后进入 character resolver，并只产生合理的 partial / empty bilateral delta
- `movement` 被打断后保留 runtime 实际位置，并生成合理的 interruption outcome / memory
- legacy `scene_interaction` 在 Phase A 仍可执行

---

## Verification

- [ ] `pnpm build:tsc`
- [ ] `pnpm test`
- [ ] 手动 smoke test: 运行一个 simulation session，验证 planner 不再输出 `scene_interaction`
- [ ] 手动 smoke test: 纯叙事 `action` 会进入 resolver，但不会编造 scene delta
- [ ] 手动 smoke test: 环境类 `action` 可以修改 scene conditions / connections / items
- [ ] 手动 smoke test: `tick` 会按时间缓慢积累基础疲惫
- [ ] 手动 smoke test: 恢复性 `action` 能通过 `fatigueDelta < 0` 正确恢复疲劳
- [ ] 手动 smoke test: 劳动/负重/激烈 `action` 能通过 `fatigueDelta > 0` 正确增加疲劳
- [ ] 手动 smoke test: 被 revise 打断的 `action` 会进入同一个 resolver，并只产生合理的 partial / empty delta
- [ ] 手动 smoke test: 被 revise 打断的 `object_interaction` 会进入 object resolver，并只产生合理的 partial / empty item delta
- [ ] 手动 smoke test: 被 revise 打断的 `character_interaction` 会进入 character resolver，并只产生合理的 partial / empty bilateral delta
- [ ] 手动 smoke test: 被 revise 打断的 `movement` 不会回滚 runtime 已推进的位置
- [ ] 若做 Phase B，验证旧 session 不会因缺少 `scene_interaction` handler 而崩溃

---

## Acceptance Criteria

以下条件全部成立，才算完成：

1. planner 不再生成 `scene_interaction`
2. `action` 可以表达当前地点的纯叙事动作和环境动作
3. 所有完成或被打断的 `action` 都会进入统一 LLM resolver
4. 纯叙事动作不会因为统一 resolver 而编造不真实的世界变化
5. `movement`、`object_interaction`、`character_interaction` 的边界不被打乱
6. 被打断的 `action` / `object_interaction` / `character_interaction` 都可以根据执行进度生成合理的 partial / empty delta
7. `movement` 被打断时保持 runtime 已推进的位置状态，不由 resolver 重写
8. fatigue 不再依赖 `rest` 特判，而由 `tick` 的基础累积加上 resolver 输出的 `fatigueDelta` 共同驱动
9. fatigue 结算不要求修改 item schema
10. 旧的 scene delta apply 语义保持不变
11. rollout 过程不会打断已持久化的进行中 simulation session

---

## Out of Scope

本计划暂不处理以下内容：
- 把 `object_interaction` 继续并入 `action`
- 把 `character_interaction` 继续并入 `action`
- 重写 `movement` 的 multi-tick 执行模型
- 重新设计 impact level 体系
- 为物品新增 fatigue 专用 schema 字段，除非后续验证显示现有描述上下文不足

如果后续要继续“所有非 movement 都统一成 action”，那会是下一份设计文档，不应和这次改动混在一起。
