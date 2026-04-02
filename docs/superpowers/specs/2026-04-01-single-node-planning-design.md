# Single-Node Planning with Short-Term Intent

## Context

当前 NPC 规划系统采用两层结构：Tier 1 日程（每日生成一次）→ Tier 2 详细节点（按需一次性展开一个 schedule entry 为 5-10 个 node）。问题：批量生成的 node 容易因世界状态变化而过时，需要复杂的 revision 机制（revisePlans + revisionPipeline）来修补。

**目标**：将 Tier 2 从"一次展开多个 node"改为"一次只生成 1 个 node + 短期意图"，从根源上消除 revision 需求。

**已确认的设计决策**：
- 保留 Schedule（Tier 1）— 提供每日行为连贯性
- 新增 Short-term Intent — 跟踪当前阶段的聚焦点
- 每次只生成 1 个 PlanNode
- 删除 `revisePlans()` 和 revision pipeline
- Impact gate 改造：`shouldRevise` → `shouldUpdateIntent` + `shouldInterruptCurrentNode`
- 完整 schedule 注入 planning prompt，LLM 自行判断进度

## Part 1: Target 暂停机制（已实现）

以下改动已在 `src/engine/runtime/tickProcessor.ts` 中完成：

### 1a. `engagedTargets` — 多 tick 交互暂停

在 `allNodes` 构建后，扫描 `in_progress` 的 `character_interaction` node（impact >= 1），收集 target IDs。主循环中跳过这些 NPC 的 node 执行。

### 1b. `sceneEngaged` — 同 tick 交互暂停

场景执行循环中，高 DEX 的交互发起者先执行。交互 resolve 成功后，把 target 加入 `sceneEngaged`，后续 target 的 node 被跳过。

### 1c. DEX 排序 + 按实际位置分组

同场景内 `nodesReadyToExecute` 按 DEX 降序排序，高 DEX 先行动。场景分组改为从 `dgsm.getCharacterPosition()` 取 NPC 当前实际位置（而非 `node.location`），确保被移走的 NPC 按真实位置分组。

### 1d. Impact gate 判断

交互 resolve 后，现有 impact pipeline 自动对 target 运行 impact gate，决定是否 revise。（后续将改造为 `shouldUpdateIntent`）

## Part 2: 数据模型

### 2a. 新建 `NpcShortTermIntent` 表

**File:** `prisma/schema.prisma`

```prisma
model NpcShortTermIntent {
  id        String   @id @default(uuid()) @db.Uuid
  sessionId String   @map("session_id")
  npcId     String   @map("npc_id")
  intent    String
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@unique([sessionId, npcId])
  @@map("npc_short_term_intents")
}
```

### 2b. NPCPlanningAgent 中增加 Intent CRUD

**File:** `src/planning/NPCPlanningAgent.ts`

- `getShortTermIntent(sessionId, npcId): Promise<string | null>`
- `setShortTermIntent(sessionId, npcId, intent): Promise<void>`
- `clearShortTermIntent(sessionId, npcId): Promise<void>`

## Part 3: `generateNextAction()` — 替代 `generateDetailedNodes()`

### 3a. 改造 `buildDetailedNodesPrompt()`

**File:** `src/planning/npcPlanningTemplates.ts`

在现有 `buildDetailedNodesPrompt()` 上修改，不新建函数。改动点：

**新增输入参数**：
- `shortTermIntent`（可为 null — 表示刚开始新阶段）
- `lastActionOutcome`（上一个 action 的结果，成功/失败/被打断 + outcome 文本）

**Prompt 改动**：
- 系统指令从"分解下一个 schedule step 为多个原子动作"改为"决定你接下来的**一个**动作"
- 注入完整 schedule（已有）+ shortTermIntent（新增）+ lastActionOutcome（新增）
- 输出从 `PlanNode[]` 改为单个对象

**输出 schema 改动**：

```json
{
  "node": {
    "nodeId": "unique-id",
    "startTime": "HH:MM",
    "endTime": "HH:MM",
    "action": "描述",
    "location": "目标位置",
    "type": "movement|action|character_interaction|object_interaction|scene_interaction",
    "skill": "可选",
    "impact": 0-5,
    "targetCharacterIds": ["可选"]
  },
  "updatedShortTermIntent": "可选，如果当前意图需要调整"
}
```

**保留不变**：node type 定义、skill check 规则、impact 级别规则、handler/feature prompt 注入

### 3b. `generateNextAction()` 函数

**File:** `src/planning/NPCPlanningAgent.ts`

替代 `generateDetailedNodes()`。逻辑：

1. 获取 shortTermIntent
2. 获取完整 schedule
3. 获取上一个 action 的 outcome（从最近的 completed/failed/interrupted node）
4. 构建 prompt 调用 LLM
5. 解析返回值：
   - 将 node 追加到 `NpcDailyPlan.nodes`
   - 如果 `updatedShortTermIntent` → 更新 `NpcShortTermIntent`
   - Schedule 始终保持完整不消耗，LLM 通过 memory 自行判断进度

### 3c. 改造 `ensureNpcNodesAvailable()`

**File:** `src/planning/NPCPlanningAgent.ts`

现有逻辑：
```
无 open node? → generateDetailedNodes()（生成多个 node）
```

改造后：
```
无 open node? → generateNextAction()（生成 1 个 node）
```

其余逻辑（检查 schedule 是否存在、按需生成 schedule）保持不变。

## Part 4: Impact Gate 改造

### 4a. 改造 `runImpactGateForNpc()` 返回值

**File:** `src/planning/NPCPlanningAgent.ts`

现有返回：
```ts
{ shouldRevise: boolean, shouldReviseSchedule: boolean, witnessEntry: string }
```

改造后：
```ts
{ shouldUpdateIntent: boolean, updatedIntent?: string, shouldInterruptCurrentNode: boolean, shouldReviseSchedule: boolean, witnessEntry: string }
```

### 4b. 改造 Impact Gate Prompt

**File:** `src/planning/npcPlanningTemplates.ts` (`buildImpactGatePrompt`)

- 将 "should you revise your detailed plans?" 改为 "should you change what you're currently focused on?"
- 增加 shortTermIntent 作为上下文
- 输出增加 `shouldInterruptCurrentNode` 和 `updatedIntent`

### 4c. 改造 `processImpactPipeline()`

**File:** `src/engine/runtime/impactPipeline.ts`

现有逻辑（line 302-320）：
```
if shouldRevise → revisePlans()
if shouldReviseSchedule → reviseSchedule()
```

改造后：
```
if shouldUpdateIntent → setShortTermIntent(updatedIntent)
if shouldInterruptCurrentNode → interruptNode() + 记录 memory
if shouldReviseSchedule → reviseSchedule()（保留不变）
```

不再调用 `revisePlans()`。

## Part 5: 删除项

| 组件 | 文件 | 处理 |
|---|---|---|
| `generateDetailedNodes()` | NPCPlanningAgent.ts | 替换为 `generateNextAction()` |
| `buildDetailedNodesPrompt()` | npcPlanningTemplates.ts | **改造**（改为单 node 输出 + intent） |
| `revisePlans()` | NPCPlanningAgent.ts | **删除** |
| `buildRevisePlansPrompt()` | npcPlanningTemplates.ts | **删除** |
| `processPendingRevisionRequests()` | revisionPipeline.ts | **删除** |
| `mergeRevisedNodesWithHistory()` | revisionHelpers.ts | **删除**（保留 `interruptNode()`） |
| `PendingRevisionRequest` 类型 | actionPostProcessing.ts | **删除** |
| `RevisePlansContext` / `RevisePlansResult` | types.ts | **删除** |
| `FailureTrigger` / `ImpactTrigger` 类型 | types.ts | **删除**（revision 不再需要 trigger） |
| `pendingRevisionRequests` 收集逻辑 | tickProcessor.ts | **删除** |
| `processPendingRevisionRequests()` 调用 | tickProcessor.ts | **删除** |
| failure 后的 revision request 逻辑 | actionPostProcessing.ts | **删除**（failure 通过 memory 自然传递给 `generateNextAction`） |
| `reviseSchedule()` | NPCPlanningAgent.ts | **保留** |
| `interruptNode()` | revisionHelpers.ts | **保留** |

## Part 6: Tick Processor 改动

**File:** `src/engine/runtime/tickProcessor.ts`

- 删除 `pendingRevisionRequests` 数组及其收集逻辑
- 删除 `processPendingRevisionRequests()` 调用
- 保留 `engagedTargets` + `sceneEngaged` 暂停机制（Part 1，已实现）
- 保留 `processImpactPipeline()` 调用（但 pipeline 内部逻辑已改造）
- Impact pipeline 中打断 node 后，下个 tick `ensureNpcNodesAvailable()` 自然触发 `generateNextAction()`

## Files to modify (ordered)

1. `prisma/schema.prisma` — 新建 `NpcShortTermIntent` 表
2. `src/planning/types.ts` — 删除 `FailureTrigger`、`ImpactTrigger`、`RevisePlansContext`、`RevisePlansResult`
3. `src/planning/npcPlanningTemplates.ts` — 改造 `buildDetailedNodesPrompt`（单 node + intent）；删除 `buildRevisePlansPrompt`；改造 `buildImpactGatePrompt`
4. `src/planning/NPCPlanningAgent.ts` — 替换 `generateDetailedNodes` → `generateNextAction`；改造 `ensureNpcNodesAvailable`；删除 `revisePlans`；增加 intent CRUD；改造 `runImpactGateForNpc` 返回值
5. `src/planning/revisionHelpers.ts` — 删除 `mergeRevisedNodesWithHistory`，保留 `interruptNode`
6. `src/engine/runtime/actionPostProcessing.ts` — 删除 `PendingRevisionRequest` 及 failure revision 逻辑
7. `src/engine/runtime/revisionPipeline.ts` — **删除整个文件**
8. `src/engine/runtime/impactPipeline.ts` — 改造：`shouldRevise` → `shouldUpdateIntent` + `shouldInterruptCurrentNode`；不再调用 `revisePlans`
9. `src/engine/runtime/tickProcessor.ts` — 删除 `pendingRevisionRequests` 相关逻辑

## Verification

1. `prisma db push` — schema 变更应用
2. `pnpm prisma:generate` — 重新生成 Prisma client
3. `pnpm build:tsc` — 类型检查通过
4. `pnpm check` — biome lint/format 通过
5. `pnpm test` — 现有测试通过（部分 revision 相关测试需删除/更新）
6. 手动测试：运行模拟，验证：
   - NPC 每次只生成 1 个 node
   - action 完成后自动生成下一个
   - scheduleEntryCompleted 正确推进 schedule
   - impact gate 正确更新 intent 和打断 node
   - failure 后下一个 action 合理应对
