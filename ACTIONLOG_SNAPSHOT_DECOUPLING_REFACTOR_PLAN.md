# ActionLog 与 Snapshot 解耦重构计划

## 1. 背景与问题

当前 Director 在一次 LLM 调用中同时生成：
- `targetSnapshot`（完整场景快照）
- `npcActionLogUpdates`（按 NPC 分组的 actionLog）
- `globalTrigger`

这导致以下问题：
- actionLog 生成与 snapshot 生成强耦合，难以单独优化时间线逻辑。
- 输出结构按 NPC 分组，不利于保证“时间流”一致性与跨 NPC 事件对齐。
- 当 actionLog 质量不稳定时，会直接影响 snapshot 与 trigger 质量。

相关代码入口（仅定位，不在本次改动）：
- `src/dynamicworldagent/dynamicBasicAgent/director/directorAgent.ts`
- `src/dynamicworldagent/dynamicBasicAgent/director/directorTemplate.ts`

## 2. 重构目标

将流程拆成两段：

1. **Action Timeline Generation（第一段）**  
   让模型先按“时间序列”生成所有 NPC 的行动事件（非按 NPC 分组）。

2. **Snapshot + GlobalTrigger Generation（第二段）**  
   基于第一段产出的时间线，生成目标场景完整 snapshot，并按现有规则进行 `globalTrigger` 判断与更新。

核心要求：
- actionLog 先按时间流生成，覆盖 `previousSnapshotTime -> currentGameTime`。
- 保留你定义的关键约束：知识驱动、目标驱动、移动连接约束、失败动作、多人互动双视角、过滤日常琐事。
- 解析后再 merge 到对应 NPC 的 `actionLog`。

## 3. 目标链路（Scene Switch 主路径）

### 现状（单次调用）

`updateScenariosForSceneSwitch()`  
→ `getPlayerSceneSwitchTemplate()`  
→ 解析 `targetSnapshot + npcActionLogUpdates + globalTrigger`  
→ merge 到 NPC 与场景状态

### 目标（两次调用）

`updateScenariosForSceneSwitch()`  
→ **Template A: Action Timeline 模板**  
→ 解析 `time-sequenced action timeline`  
→ `group + validate + merge` 到 NPC  
→ **Template B: Snapshot+Trigger 模板**（输入 action timeline）  
→ 解析 `targetSnapshot (+ optional globalTrigger + optional connections)`  
→ 落库/入状态

## 4. 数据契约草案

## 4.1 第一段输出（时间序列，按时间桶组织）

```json
{
  "actionTimeline": [
    {
      "time": "Day 2, 14:00",
      "npcActionLogUpdates": [
        {
          "id": "npc-jack-harper",
          "actionLog": [
            {
              "time": "Day 2, 14:00",
              "location": "Town Hall",
              "summary": "Asked Dr. Chen about the ritual notes and was refused"
            }
          ],
          "statusDelta": {
            "sanity": -2
          }
        },
        {
          "id": "npc-dr-chen",
          "actionLog": [
            {
              "time": "Day 2, 14:00",
              "location": "Town Hall",
              "summary": "Was questioned by Jack Harper about ritual notes and chose to conceal key details"
            }
          ],
          "inventoryDelta": {
            "add": [{ "name": "archive key", "quantity": 1 }],
            "remove": [{ "name": "spare key" }]
          }
        }
      ]
    },
    {
      "time": "Day 2, 15:30",
      "npcActionLogUpdates": [
        {
          "id": "npc-jack-harper",
          "actionLog": [
            {
              "time": "Day 2, 15:30",
              "location": "Harbor",
              "summary": "Returned to the harbor and prepared diving gear to search for ritual traces"
            }
          ]
        }
      ]
    }
  ]
}
```

约束：
- `actionTimeline` 按 `time` 严格升序。
- 每个时间桶下是 `npcActionLogUpdates`（结构与现有 `{ id, actionLog }` 风格一致）。
- `npcActionLogUpdates` 可选携带动作后果增量字段：
  - `statusDelta?: Partial<CharacterStatus>`
  - `inventoryDelta?: { add?: InventoryItem[]; remove?: InventoryItem[] }`
- `statusDelta/inventoryDelta` 仅在动作实际造成变化时输出；无变化则省略。
- 所有后果字段必须是“增量语义”，禁止全量覆盖 NPC 状态/背包。
- 多角色互动必须拆成多条（每个角色一条）。
- `summary` 必须包含对象（角色/物品/地点）信息。
- 时间必须落在 `[previousSnapshotTime, currentGameTime]`。

### 4.1.1 Action 推理与生成规范（CRITICAL）

- **IMPORTANT**: NPC actions must be based on what they know and what they want to do. NPCs can learn more about the world by taking actions. Actions across NPCs must remain coherent.
- Generate a **time-sequenced series of actions** for each NPC from previous snapshot time to current game time.
- Base each action on NPC **goals, personality, and secrets** (from full profile + knowledge matrix).
- Actions must be **chronologically ordered** with specific times progressing toward current game time.
- Include **only impactful actions** that affect:
  - scene/location
  - world state
  - other NPCs
- Include important **failed actions**.
- Exclude routine/mundane actions that do not affect story progression (e.g., eating, sleeping).
- **Scene movement constraints**:
  - NPCs can only move through **connected scenarios** (`connections`), unless they logically attempt to break blocked restrictions.
  - Movement must take realistic time based on distance/relationship type (`adjacent`, `nearby`, `distant`), time of day, and conditions.
  - Non-adjacent movement must pass through connected intermediate scenarios.
  - Time gaps must be realistic; no teleporting or impossible fast travel.
- Each `actionLog` entry format is strictly:
  - `{ time: "Day X, HH:MM", location: "specific location", summary: "what they did and its impact" }`
- If an action has a target (character/object/location), the target **must appear in summary**.
- For multi-character interactions, create **separate entries per character perspective**:
  - NPC A: `"Attacked NPC B with a knife, dealing 3 damage"`
  - NPC B: `"Was attacked by NPC A, taking 3 damage"`

## 4.2 第一段解析后内部结构

- `timelineBuckets: TimelineBucket[]`（按时间桶的原始结果）
- `actionLogByNpcId: Map<string, ActionLogEntry[]>`（用于 merge）
- `statusDeltaByNpcId: Map<string, Partial<CharacterStatus>>`（用于合并动作后果）
- `inventoryDeltaByNpcId: Map<string, { add?: InventoryItem[]; remove?: InventoryItem[] }>`（用于合并动作后果）
- `targetSceneTimeline: ActionLogEntry[]`（按目标场景过滤后的时间序日志，供第二段 snapshot 生成）

## 4.3 第二段输出（只做目标场景快照 + trigger）

```json
{
  "targetSnapshot": {
    "scenarioId": "SCN_3",
    "snapshot": {
      "id": "SCN_3_...",
      "name": "Harbor Warehouse",
      "location": "Harbor Warehouse",
      "description": "...",
      "gameTime": "Day 2, 18:00",
      "showMap": false,
      "characters": [
        {
          "id": "npc-officer-brannigan",
          "name": "Officer Brannigan",
          "status": "alive",
          "location": "Leaning against his patrol car near the statue",
          "notes": "He is watching the investigators' arrival with open hostility, hand resting near his holster. He intends to intimidate them immediately."
        }
      ],
      "clues": [],
      "conditions": [],
      "keeperNotes": "..."
    },
    "connections": []
  },
  "globalTrigger": {
    "timeRestriction": "Day 3, 08:00",
    "timeReason": "...",
    "events": ["..."],
    "eventReasons": ["..."]
  }
}
```

说明：
- 第二段不再生成 `npcActionLogUpdates`。
- 第二段 `snapshot.characters` 仅保留轻量在场信息：`id/name/status/location/notes`。
- 第二段不再生成角色增量字段（`actionLog/statusDelta/inventoryDelta/relationships`）。
- `snapshot.characters` 在场判定基于当前时间点 NPC 最新 actionLog 的 `location`（命中 target scene 才纳入）。
- `globalTrigger` 处理逻辑保持与当前一致（可选输出 + 现有校验/保存流程不变）。

## 5. 模板重构方案

## 5.1 新增模板 A（建议）

新增例如：
- `getNpcActionTimelineTemplate()`

输入：
- 所有场景与连接关系
- 所有 NPC 的 goals/personality/secrets/inheritsKnowledge
- 所有 NPC 的**完整历史 actionLog**（从开局到当前，不截断）
- `previousSnapshotTime` 与 `currentGameTime`
- truth timeline
- **完整 knowledge matrix（不裁剪，原样注入）**

输出：
- 仅 `actionTimeline`

模板 A 必须强制执行 `4.1.1 Action 推理与生成规范（CRITICAL）`，并在提示词中明确：
- 生成范围为“后台世界推进”：仅生成**不在玩家当前场景**的 NPC 时间线。
- 不生成玩家 actionLog；不生成玩家当前场景内 NPC 的重复 actionLog（避免与主交互链路冲突）。
- 先做“knowledge/goals/personality/secrets → action intention”推理，再落到时间轴。
- 输出前做“时间连贯性 + 连接可达性 + 多角色视角完整性”自检。
- 历史 actionLog 是**只读事实**：不可改写、不可重述为新事件。
- 本轮输出必须是**窗口增量**：仅 `(previousSnapshotTime, currentGameTime]`。
- 若与历史重复（`time + location + summary` 相同）则必须丢弃。
- 新增首条动作需与该 NPC 历史最后状态在时间/地点上可衔接。
- knowledge 约束以完整 knowledge matrix 为准，禁止输出与 matrix 冲突的“超出已知信息”行动推理。

## 5.2 新增模板 B（建议）

新增例如：
- `getTargetSnapshotFromTimelineTemplate()`

输入：
- `actionTimeline`（或按目标场景过滤后的 timeline）
- 玩家在时间窗口内的 actionLog（`previousSnapshotTime -> currentGameTime`）
- target scene 当前快照 + clues + conditions + connections
- 与当前模板相同的 `endState / previousGlobalTrigger`

输出：
- `targetSnapshot`
- `connections`（可选）
- `globalTrigger`（可选）

规则：
- 模板 B 只负责目标场景快照（叙事与环境状态），不负责 NPC action/delta 推断。
- `targetSnapshot.characters` 使用轻量结构：`id/name/status/location/notes`。
- 角色在场判定由后端按 `currentGameTime` 之前最新 actionLog 的 `location` 先筛选，再写入 snapshot。
- `globalTrigger.timeRestriction` 若输出，仅要求为未来合理时间点（`Day X, HH:MM`），不要求“至少 12 小时后”。
- `targetSnapshot.clues` 必须生成，且基于以下来源综合推断：
  - 目标场景上一版 snapshot 的 clues 基线（含已发现状态）
  - 时间窗口内 **NPC + 玩家** action log 对目标场景产生的影响
  - `truthTimeline + knowledgeMatrix` 的一致性约束（禁止凭空新增超出世界事实的线索）
  - 场景 `conditions/connections` 变化对线索可见性/可达性的影响
- `targetSnapshot.conditions` 必须生成，基于时间窗口内 **NPC + 玩家** action log 共同判断环境状态变化及其持续效果。

### Global Trigger 更新依据
- `endState`（尤其 `pointOfNoReturn`）
- `previousGlobalTrigger`（若存在，作为当前链路位置参考）
- 新生成的 NPC actionLogs 与故事最新进展

### Global Trigger 更新指导
- 采用“渐进升级（Progressive Escalation）”
- 若当前行动未形成重要未来事件，可不输出 `globalTrigger`（可选字段）
- 若输出 `globalTrigger`，结构应包含：
  - `timeRestriction`
  - `timeReason`
  - `events[]`
  - `eventReasons[]`（与 `events[]` 一一对应）

## 5.3 新增模板 C（建议，后台非目标场景简化快照）

新增例如：
- `getBackgroundSimplifiedSnapshotsTemplate()`

输入（与模板 B 不同，偏批处理）：
- **完整** `actionTimeline`（不按 target scene 过滤）
- 玩家时间窗口 actionLog（仅当可能影响其他场景时注入）
- 待更新场景列表（排除 target scene，可优先本轮被 timeline 涉及场景）
- 各待更新场景的上一版 baseline snapshot（至少含 `description/clues/connections/gameTime`）
- 时间上下文：`previousSnapshotTime`、`currentGameTime`
- 一致性上下文：`truthTimeline`、`knowledgeMatrix`

输出：
- `updatedSimplifiedSnapshots[]`（每个场景仅含 `description/clues/connections/gameTime`）

规则：
- 模板 C 不生成 `globalTrigger`，不处理 target scene 专属内容。
- 模板 C 不生成角色增量字段（`actionLog/statusDelta/inventoryDelta/relationships`）。
- 每个输出场景必须写入 `gameTime = currentGameTime`。

## 6. Director 侧重构步骤（分阶段）

### Phase 0：护栏准备
- 抽离统一 JSON parse + schema validate 工具（避免模板切分后重复代码）。
- 复用现有 `mergeCharacterDeltaToNPC()` 去重/排序逻辑。

### Phase 1：接入 Timeline 生成
- 在 `updateScenariosForSceneSwitch()` 中先调用模板 A。
- 先按当前场景过滤 NPC 生成范围：排除玩家与玩家当前场景内 NPC。
- 增加 timeline 解析器：
  - 时间格式校验
  - 必填字段校验（`time/id/actionLog[].time/actionLog[].location/actionLog[].summary`）
  - 可选字段校验（`statusDelta`、`inventoryDelta.add/remove`）
  - 时间窗口过滤
  - 按时间桶升序整理
  - 与历史 actionLog 去重（`time + location + summary`）
  - 拉平并按 `id` 聚合 `actionLog + statusDelta + inventoryDelta`

### Phase 2：merge 到 NPC
- 将分组结果 merge 到 `dynamicState.npcCharacters[*]`：
  - `actionLog` 追加并去重排序
  - `statusDelta` 按差量应用
  - `inventoryDelta` 按 `add/remove` 应用
- 保留现有去重键：`time + location + summary`。
- 记录 “未匹配 NPC ID” 日志与统计。

### Phase 3：接入 Snapshot + Trigger 生成
- 调用模板 B，输入 timeline 与目标场景上下文。
- 仅处理 `targetSnapshot/connections/globalTrigger`。
- 向模板 B 注入玩家时间窗口 actionLog，作为 clues/conditions 推断依据之一。
- 写入 `targetSnapshot` 前，按 `currentGameTime` 计算各 NPC 最新 actionLog location，筛选 target scene 在场 NPC。
- 用筛选结果构建 `targetSnapshot.characters`（轻量字段：`id/name/status/location/notes`）。
- 保留原有连接更新与 `setGlobalTrigger()` 行为。

### Phase 4：后台简化快照更新（非目标场景）
- 在主链路（Phase 1-3）完成后，后台异步执行一轮非目标场景简化 snapshot 更新。
- 更新范围：除 `target scene` 外的其他场景（可优先处理本轮 `actionTimeline` 涉及到的场景）。
- 调用模板 C（批处理模式），注入完整 timeline + 待更新场景 baseline + 时间上下文 + truth/knowledge 约束。
- 简化 snapshot 仅更新：
  - `description`
  - `clues`
  - `connections`
- 简化 snapshot 必须更新 `gameTime = currentGameTime`，用于标识该场景快照已推进到当前时间点。
- 不更新角色增量字段（`actionLog/statusDelta/inventoryDelta/relationships`）。
- 若场景在时间窗口内无有效变化，可跳过更新以控制成本。

### Phase 5：兼容与灰度
- 增加开关（如 `DIRECTOR_DECOUPLED_TIMELINE=true`）：
  - `false`：走旧链路
  - `true`：走新链路
- 便于快速回滚。

### Phase 6：扩展到 `updateNonPlayerScenarios()`
- 复用模板 A 先生成统一时间线。
- 再按场景生成 simplified snapshot（可继续拆为“按场景生成模板”或批量模板）。

## 7. 验收标准（DoD）

- 结构目标：
  - actionLog 不再由 snapshot 直接承载生成，改为“先时间线，后 merge”。
  - 第二段模板不再输出 `npcActionLogUpdates`。

- 行为目标：
  - 第一段输入包含每个 NPC 的完整历史 actionLog。
  - 第一段仅生成“非玩家当前场景 NPC”的后台 action timeline。
  - 第一段不生成玩家 actionLog，不重复生成当前场景 NPC actionLog。
  - 第一段输出仅包含窗口增量 actionLog，不重放历史。
  - 第一段可输出 NPC 动作后果增量（`statusDelta/inventoryDelta`），并被正确合并到 NPC 档案。
  - 第二段 `targetSnapshot.characters` 按“当前时间点最新 actionLog location”判定在场 NPC。
  - 第二段角色信息仅为轻量字段（`id/name/status/location/notes`）。
  - 第二段 `clues/conditions` 基于时间窗口内 NPC + 玩家 action log 联合推断。
  - 第四阶段后台会为非目标场景生成简化 snapshot，更新 `description/clues/connections`。
  - 第四阶段生成的每个简化 snapshot 都会写入最新 `gameTime`（等于 `currentGameTime`）。
  - 生成的 actionLog 在时间上连续、可排序、可追溯。
  - 多角色互动双方均有日志条目。
  - 非连接场景间移动不会“瞬移”（除非有合理破坏/突破说明）。
  - `globalTrigger` 生成与保存行为与当前一致。

- 稳定性目标：
  - JSON 解析失败可回退或安全退出，不污染状态。
  - NPC 匹配失败不会中断整轮流程。

## 8. 测试计划（手工优先）

最小回归用例：
- 历史连续性：给定长历史 actionLog，验证模型不改写历史且只产出窗口内新增。
- 生成范围：验证第一段不包含玩家和玩家当前场景 NPC，仅包含非当前场景 NPC。
- 场景切换：A -> B，跨两个中间节点移动（验证时间与连接约束）。
- 在场判定：`targetSnapshot.characters` 仅包含最新 actionLog.location 命中 target scene 的 NPC。
- clues/conditions 推断：玩家动作触发的线索可见性变化、环境变化可正确反映在目标 snapshot。
- 后台简化快照：非目标场景在有事件影响时可更新 `description/clues/connections`，并写入最新 `gameTime`；无变化场景可跳过。
- 双人互动：攻击/对话事件，验证双方日志都有记录。
- 失败动作：例如调查失败仍被写入 timeline。
- 动作后果：验证 `statusDelta`（hp/sanity 变化）和 `inventoryDelta`（add/remove）被正确应用且不覆盖全量字段。
- Trigger：存在 `previousGlobalTrigger` 与不存在两种情况。
- 异常输出：缺字段、乱序时间、未知 NPC ID。

建议观察指标：
- 每轮新增 actionLog 条数
- 被过滤的无效条数
- 未匹配 NPC ID 数量
- 模型输出 JSON 解析失败率

## 9. 风险与缓解

- 风险：三阶段调用增加延迟与成本  
  缓解：先在 scene switch 路径灰度；后台简化快照阶段异步执行，并仅处理受影响场景。

- 风险：时间线过长导致 token 膨胀  
  缓解：限制窗口（仅 `previousSnapshotTime -> currentGameTime`），并压缩已知静态上下文。

- 风险：timeline 到 snapshot 语义损耗  
  缓解：模板 B 明确输入“原始 timeline + 目标场景过滤 timeline + 当前快照基线”。

## 10. 实施顺序建议

1. 先改 `updateScenariosForSceneSwitch()`（影响面最小，且与你当前目标完全一致）。  
2. 验证稳定后，再迁移 `updateNonPlayerScenarios()`。  
3. 最后删除旧模板中的耦合段落，收敛到统一模板规范。

---

本文件是重构计划草案，当前不包含任何代码逻辑改动。
