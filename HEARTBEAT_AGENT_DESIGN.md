# Heartbeat Agent 设计文档（草案）

## 1. 目标

新增一个 `Heartbeat Agent`，实现两件事：

1. `Action Agent` 在玩家与 NPC 形成“约定后续行动”时，返回结构化 `heartbeatAction`。
2. 每轮开始时，`Heartbeat Agent` 基于当前 `gameTime` 判断哪些约定已进入“约定前 10 分钟内”或“已超时”，并把这些约定注入到 `Action Agent` 上下文，让本轮 `actionLog` 明确考虑这些约定。
3. 只要有 heartbeat 被激活（`due`/`overdue`），回查该 heartbeat 对应来源回合的 `keeperNarrative`，并同步注入 `Keeper template` 作为叙事上下文。

---

## 2. 现状与接入点

当前主图入口在 `src/dynamicworldagent/graph/dynamicGraph.ts`：

1. `entry` 节点负责“新回合清理 temporaryInfo”。
2. `action` 节点执行 `ActionAgent.processAction(...)`。
3. `Action Agent` 已支持通过 prompt + JSON 输出更新状态、写 actionLog、推进时间（`timeElapsedMinutes`）。

因此本方案建议：

1. 在 `entry`（新玩家回合开始）调用 `Heartbeat Agent` 做到期检查。
2. 在 `Action Agent` 输出协议中新增 `heartbeatActions`，并在 `buildContext` 注入“到期/超时 heartbeat”。

---

## 3. 数据结构设计

### 3.1 新增类型

建议在 `src/dynamicworldagent/state/DynamicGameState.ts` 新增：

```ts
export interface HeartbeatAction {
  heartbeatId: string; // uuid
  scheduledGameTime: string; // "Day N, HH:MM"
  npcId: string;
  npcName: string;
  task: string; // 具体事项
  location: string;
  status: "scheduled" | "due" | "overdue" | "completed" | "cancelled";
  createdAtGameTime: string;
  triggeredAtGameTime?: string; // 首次进入 due/overdue 的时间
  sourceTurnId: string; // 该约定由哪个 turn 创建（用于回查 keeperNarrative）
}
```

### 3.2 状态挂载

`DynamicGameState` 顶层新增：

```ts
heartbeatActions: HeartbeatAction[];
```

`temporaryInfo.contextualData` 使用固定 key：

1. `heartbeatDueActions`: `HeartbeatAction[]`（本轮注入给 Action Agent 的列表）
2. `heartbeatActivatedNarratives`: `HeartbeatActivatedNarrative[]`（注入 Keeper 的上下文）

说明：`heartbeatActions` 放在顶层（持久状态），避免被每轮清理逻辑清掉。

建议新增：

```ts
export interface HeartbeatActivatedNarrative {
  heartbeatId: string;
  sourceTurnId: string;
  sourceTurnNumber?: number | null;
  sourceTurnNarrative: string; // 来源 turn 的 keeperNarrative
  scheduledGameTime: string;
  status: "due" | "overdue";
  npcId: string;
  npcName: string;
  task: string;
  location: string;
}
```

---

## 4. Action Agent 输出协议扩展

在 `actionTemplate.ts` 的 JSON 输出中新增字段（玩家动作时可返回）：

```json
"heartbeatActions": [
  {
    "scheduledGameTime": "Day 2, 18:20",
    "npcId": "npc-guard-01",
    "npcName": "Officer Hale",
    "task": "Meet at back alley and exchange key",
    "location": "Riverside Back Alley"
  }
]
```

约束：

1. 无新约定时返回空数组 `[]` 或省略字段。
2. `scheduledGameTime` 必须使用统一格式 `Day N, HH:MM`。
3. `npcId` 必须是 state 中存在的 NPC id。

`ActionAgent` 在 `buildFinalResult` 中解析并 `upsert` 到 `dynamicGameState.heartbeatActions`。

附加要求：

1. `sourceTurnId` 不由 LLM 生成，由服务端在写入时强制填当前 `turnId`（避免污染）。

---

## 5. Heartbeat Agent 判定逻辑

新增 `src/dynamicworldagent/dynamicBasicAgent/heartbeat/heartbeatAgent.ts`，提供：

```ts
evaluateTurnStart(
  dgsm: DynamicGameStateManager,
  deps: { db: CoCDatabase | CoCDatabaseAdapter }
): {
  dueActions: HeartbeatAction[];
  activatedNarratives: HeartbeatActivatedNarrative[];
}
```

逻辑：

1. 读取当前时间：`Day ${gameDay}, ${timeOfDay}`。
2. 遍历 `heartbeatActions`，只处理状态为 `scheduled|due|overdue` 的项。
3. 计算 `deltaMinutes = scheduled - now`。
4. 命中规则：
   1. `0 <= deltaMinutes <= 10` -> `due`
   2. `deltaMinutes < 0` -> `overdue`
5. 将命中项写入 `temporaryInfo.contextualData.heartbeatDueActions`。
6. 对命中项按 `sourceTurnId` 查询 turn（`db.getTurn(sourceTurnId)`）并提取 `keeperNarrative`：
   1. 有 narrative 才加入 `heartbeatActivatedNarratives`
   2. 无 narrative 时跳过该条 narrative 注入（但 `dueActions` 仍保留）
7. 将结果写入 `temporaryInfo.contextualData.heartbeatActivatedNarratives`。

时间比较建议新增通用函数（`src/dynamicworldagent/utils/gameTime.ts`）：

1. `toAbsoluteMinutes("Day N, HH:MM")`
2. `diffGameTimeMinutes(from, to)`

---

## 6. 图流程改造（最小侵入）

在主图 `entry` 节点中增加一步：

1. 对“真实玩家新回合”（非 simulated、非 rest、非 resume）执行 `heartbeatAgent.evaluateTurnStart(...)`。
2. 将结果存入 `contextualData.heartbeatDueActions`。
3. 同时存入 `contextualData.heartbeatActivatedNarratives`（给 Keeper 使用）。

注意：

1. `resumeFromInterrupt === true` 时不重复计算，保留首次进入该回合时的 due 列表。
2. 继续保持原有清理逻辑，但不要清理 `dynamicGameState.heartbeatActions`（持久层）。

---

## 7. 注入到 Action Agent 的方式

在 `ActionAgent.buildContext(...)` 增加块：

```text
=== HEARTBEAT DUE ACTIONS ===
[...]
=== END HEARTBEAT DUE ACTIONS ===
```

提示词要求补充：

1. 如果存在 `HEARTBEAT DUE ACTIONS`，本轮 `actionLog` 需要体现是否赴约、迟到、错过、改约或无视该约定。
2. 不强制玩家执行该约定，但叙事和结果必须与约定时间状态一致。

---

## 7.1 注入到 Keeper Template 的方式（新增）

在 `KeeperAgent.generateNarrative(...)` 的 templateContext 增加：

1. `hasHeartbeatActivatedNarratives`
2. `heartbeatActivatedNarrativesJson`

在 `keeperTemplate.ts` 增加上下文块：

```text
### Activated Heartbeat Source Narratives
{{heartbeatActivatedNarrativesJson}}
```

规则要求：

1. 当该块存在时，本轮 narrative 必须与这些“历史约定来源叙事”保持连续性（不能前后矛盾）。
2. 若 heartbeat 已 `overdue`，叙事中应体现迟到/错过后的后果倾向（由 Keeper 自然表达）。
3. 该信息用于叙事约束，不直接改写事实状态；状态变更仍由 action/director 流程负责。

---

## 8. 生命周期建议

建议后续补一个可选更新字段（v1.1）用于收口：

```json
"heartbeatUpdates": [
  {
    "heartbeatId": "xxx",
    "status": "completed",
    "note": "Met NPC and completed exchange"
  }
]
```

这样可避免同一条 `overdue` 约定在每回合持续注入。

---

## 9. 兼容性与默认值

需要补齐默认值的位置：

1. `initialDynamicGameState(...)`：`heartbeatActions: []`
2. `DynamicGameState.deserialize(...)`：缺字段时回退 `[]`
3. `initializeCompleteDynamicGameState(...)`：旧存档兼容默认 `[]`
4. `sourceTurnId` 缺失的旧 heartbeat：标记为不可回查 narrative（仅保留普通 due 注入）

---

## 10. 实施步骤（建议顺序）

1. 扩展 `DynamicGameState` 类型与默认值。
2. 新增 `Heartbeat Agent` + 时间差工具函数。
3. 在 `entry` 注入 `Heartbeat Agent` 执行（产出 due + activatedNarratives）。
4. 扩展 `actionTemplate` 输出协议（`heartbeatActions`）。
5. `ActionAgent` 解析并写入 `gameState.heartbeatActions`。
6. `ActionAgent.buildContext` 注入 `heartbeatDueActions`。
7. `KeeperAgent` + `keeperTemplate` 注入 `heartbeatActivatedNarratives`。
8. 手工回归测试。

---

## 11. 验收清单

1. 玩家说“今晚 18:20 在码头和 NPC 碰头”，`Action Agent` 返回结构化 heartbeat 并保存到 state。
2. 当时间到 `18:10~18:20` 任一回合开始，`heartbeatDueActions` 出现该项。
3. 当时间 `>18:20`，该项状态变为 `overdue` 并继续注入。
4. `actionLog` 能体现赴约/迟到/错过等叙事后果。
5. heartbeat 激活时，能通过 `sourceTurnId` 找到来源 turn 的 `keeperNarrative`，并在同回合 Keeper 生成时成功注入模板。
6. 不影响原有战斗流、技能选择中断恢复、scene change 流程。
