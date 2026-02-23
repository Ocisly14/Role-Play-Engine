# 角色体力系统设计草案（v1）

## 1. 目标

在现有 DynamicWorld 流程中新增“体力/疲劳”机制：

- 玩家在 **游戏内经过一定时间且未休息** 后进入疲劳状态。
- 疲劳状态下，技能骰判定“难度加倍”（v1 定义为：**有效技能值减半**）。
- 促使玩家主动选择“休息”行动，形成节奏上的风险-收益决策。

---

## 2. 当前实现审计（代码 + 数据）

## 2.1 当前“技能耗时”不是按技能固定配置

当前没有“每个技能固定耗时表”，而是每次行动由 Action Agent 估算耗时：

- 在 `src/dynamicworldagent/dynamicBasicAgent/action/actionTemplate.ts` 中，要求模型输出 `timeElapsedMinutes`。
- 同文件给出了估算区间参考：  
  - Quick：1-10 分钟  
  - Standard：10-30 分钟  
  - Extended：30-120 分钟  
  - Long：2-6 小时  
  - Very Long：6+ 小时

因此，现阶段“使用技能耗时”是 **按行动语义动态估算**，不是按 Skill 名称静态映射。

## 2.2 时间推进规则

- 玩家行动：`timeElapsedMinutes > 0` 会推进 `gameDay/timeOfDay`  
  代码位置：`src/dynamicworldagent/dynamicBasicAgent/action/actionAgent.ts`（`updateGameTime` 调用）
- NPC 反应行动：不会推进游戏时间（通常写入 `timeElapsedMinutes = 0`）
- 战斗流程：每回合默认约 1 分钟  
  代码位置：`src/dynamicworldagent/dynamicBasicAgent/combat/combatActionAgentATemplate.ts` 与 `combatActionAgentA.ts`

## 2.3 已有历史数据（本地库抽样）

抽样来源：`data/coc_game.db` 的 `game_turns.action_results`（JSON 数组）

- 记录中 `timeElapsedMinutes` 非空条目：87
- 其中 `timeConsumption` 分布：
  - `short`: 54（平均 5.22 分钟，范围 1-15）
  - `instant`: 33（平均 0 分钟）
- `timeElapsedMinutes > 0` 条目：54  
  - 中位数：5 分钟  
  - 分布：1(10次), 2(7次), 5(27次), 10(5次), 13(1次), 15(4次)

结论：当前实际运行里，“技能相关行动”大多落在 1-15 分钟区间，且以 5 分钟为主。

## 2.4 当前实现中的一个不一致点（需先修）

- 类型定义：`TimeConsumption = "instant" | "short" | "scene"`  
  文件：`src/shared/state/state.ts`
- 但 `actionTemplate.ts` 输出示例写的是：`"short" | "medium" | "long" | "very long"`

这会导致 `timeConsumption` 的部分值在 `DynamicGameState.updatePlayerTimeConsumption()` 里无法被正常归类。

---

## 3. 体力系统 v1 规则定义

## 3.1 状态字段（建议）

在 `DynamicGameState` 中新增：

```ts
staminaState: {
  minutesSinceLastRest: number;      // 距离上次有效休息累计经过的“玩家行动分钟数”
  fatigueActive: boolean;            // 是否疲劳
  fatigueStartedAtGameTime?: string; // 进入疲劳时的 Day/HH:MM（可选）
}
```

## 3.2 触发阈值（v1）

- `FATIGUE_TRIGGER_MINUTES = 360`（可配置，默认 6 小时）
- 每次玩家行动结束后：
  - 若 `timeElapsedMinutes > 0`，累加到 `minutesSinceLastRest`
  - 当累计值 `>= FATIGUE_TRIGGER_MINUTES`，`fatigueActive = true`

说明：v1 只做“二态”（正常/疲劳），先保证可用与可理解性。

## 3.2.1 统计来源（后端默认）

- `game time` 消耗累计以**后端状态**为准，不依赖前端本地计算。
- 后端在每次行动结算后默认更新：
  - `staminaState.minutesSinceLastRest`
  - `staminaState.fatigueActive`（是否达到 6H 阈值）
- 前端只负责展示后端下发的最终状态。

## 3.3 休息恢复规则（v1）

新增一个结构化输出字段（由 Action Agent 返回）：

```json
"restResult": {
  "isRestAction": true,
  "restMinutes": 240
}
```

恢复逻辑：

- **无效休息**：`restMinutes < 240`（4 小时以内）  
  - 无收益：不解除疲劳、不清零累计、不恢复 HP/SAN
- **短休（Short Rest）**：`240 <= restMinutes < 480`（4-8 小时）  
  - 解除疲劳：`fatigueActive = false`
  - 累计清零：`minutesSinceLastRest = 0`
  - 不恢复 HP/SAN
- **长休（Long Rest）**：`restMinutes >= 480`（8 小时及以上）  
  - 解除疲劳并清零累计
  - 基础恢复（8 小时基线）：
    - `HP基础恢复 = ceil(maxHP * 0.30)`
    - `SAN基础恢复 = ceil(initialSAN * 0.10)`
  - `8H+` 比例加成：每多 8 小时按比例增加恢复收益
    - `recoveryScale = restMinutes / 480`
    - `HP恢复量 = ceil(maxHP * 0.30 * recoveryScale)`
    - `SAN恢复量 = ceil(initialSAN * 0.10 * recoveryScale)`
  - 应用后都不能超过各自上限（clamp 到 `maxHP` / `initialSAN`）

建议实现口径（避免歧义）：

- `maxHP`：角色最大生命值（非当前 HP）
- `initialSAN`：角色初始理智值（开卡时基准值）
- 只有 `<4H` 才是无效休息；`=4H` 起算短休收益
- 长休后：
  - `recoveryScale = restMinutes / 480`
  - `newHP = min(maxHP, currentHP + ceil(maxHP * 0.30 * recoveryScale))`
  - `newSAN = min(initialSAN, currentSAN + ceil(initialSAN * 0.10 * recoveryScale))`
- 示例：
  - `4H`：短休（解除疲劳并清零累计）
  - `6H`：短休（仅解除疲劳）
  - `8H`：长休（1.0x 恢复）
  - `12H`：长休（1.5x 恢复）
  - `16H`：长休（2.0x 恢复）

## 3.4 疲劳判定修正（v1）

疲劳状态下，玩家相关技能检定统一采用：

- **判定难度提高一个等级**
  - `regular -> hard`
  - `hard -> extreme`
  - `extreme -> extreme`（封顶，不再继续上调）

适用范围：

- 普通行动检定（Action Agent）
- 战斗检定（Combat Action Agent A/B）

## 3.4.1 提示词注入硬规则（本次新增）

当 `staminaState.fatigueActive = true` 时，以下模板必须注入疲劳指示：

- `src/dynamicworldagent/dynamicBasicAgent/action/actionTemplate.ts`
- `src/dynamicworldagent/dynamicBasicAgent/combat/combatActionAgentATemplate.ts`
- `src/dynamicworldagent/dynamicBasicAgent/combat/combatActionAgentBTemplate.ts`

建议统一注入文案（可中英双语）：

- `当前角色状态：疲惫。所有玩家技能判定难度提高一个等级。`
- `Current player status: Fatigued. Increase player skill check difficulty by one level.`

## 3.5 休息后的时间推进与 Director 触发（本次新增）

休息动作执行成功后，必须满足以下行为：

- 自动推进游戏时间：`updateGameTime(restMinutes)`
- 自动触发一次 Director Agent 场景更新（scene/worldline 更新流程）
- 触发次数要求：每次休息动作 **仅触发一次**，避免重复执行

建议执行顺序：

1. Action Agent 产出 `restResult` 与 `timeElapsedMinutes = restMinutes`
2. 状态层推进 `gameDay/timeOfDay`
3. 进入当前回合既有的 `director` 节点，执行一次场景更新
4. 继续 keeper 输出

实现约束：

- 不额外手动调用第二次 Director（避免“一次休息触发两次更新”）
- 若休息动作失败（例如被战斗/环境阻断），则不推进 `restMinutes`，也不触发本条强制更新

---

## 4. 接入点（按代码模块）

## 4.1 状态层

- `src/dynamicworldagent/state/DynamicGameState.ts`
  - 新增 `staminaState`
  - 新增方法：
    - `addFatigueMinutes(minutes: number)`
    - `applyRest(restMinutes: number)`
    - `isFatigued()`
    - `getEffectiveSkill(baseSkill: number)`
- `src/dynamicworldagent/state/DynamicGameStateLoader.ts`
  - 旧存档兼容默认值（缺字段时自动补齐）

## 4.2 普通行动链路

- `src/dynamicworldagent/dynamicBasicAgent/action/actionTemplate.ts`
  - 增加 `restResult` 输出约束
  - 注入疲劳硬指示（疲惫时判定难度提高一个等级）
- `src/dynamicworldagent/dynamicBasicAgent/action/actionAgent.ts`
  - 在构建上下文时注入 `fatigueActive` 和规则说明
  - 行动结算后先处理 `restResult`，再更新疲劳累计
  - 休息成功时确保 `timeElapsedMinutes = restMinutes`，由现有流程自动推进 game time
- `src/dynamicworldagent/graph/dynamicGraph.ts`
  - 休息动作走标准管线 `action -> director -> keeper`
  - 确保一次休息回合只经过一次 `director` 场景更新

## 4.3 战斗链路

- `src/dynamicworldagent/dynamicBasicAgent/combat/combatActionAgentATemplate.ts`
  - 注入疲劳硬指示（疲惫时判定难度提高一个等级）
- `src/dynamicworldagent/dynamicBasicAgent/combat/combatActionAgentBTemplate.ts`
  - 注入疲劳硬指示（疲惫时判定难度提高一个等级）
- `src/dynamicworldagent/dynamicBasicAgent/combat/combatActionAgentA.ts`
  - 注入疲劳状态到战斗上下文
  - 战斗回合结束按 `timeElapsedMinutes` 计入疲劳累计
- `src/dynamicworldagent/dynamicBasicAgent/combat/combatActionAgentB.ts`
  - 注入疲劳状态到战斗上下文，保证 A/B 行为一致

## 4.4 前端展示（必做）

- 在 sidebar 的角色状态 Tab 中新增/使用“状态效果”栏展示体力效果：
  - 当 `minutesSinceLastRest < 360`：不显示疲劳或显示 `Normal`
  - 当 `minutesSinceLastRest >= 360`：显示 `Fatigued`（疲劳）
- 状态效果数据来源必须是后端返回的 `staminaState`，不在前端自行推导。

---

## 5. 实施顺序（建议）

1. 先修正 `timeConsumption` 枚举/模板不一致（避免后续行为不可预测）  
2. 加入 `staminaState` 与基础更新方法（仅状态层）  
3. 普通行动接入疲劳判定与休息恢复  
4. 战斗链路接入同一规则  
5. 前端提示与文案优化

---

## 6. 验收标准（v1）

- 玩家连续行动累计达到阈值后，玩家技能判定难度提高一个等级（regular->hard->extreme）
- 玩家执行“有效短休”（>=4 小时）后恢复正常难度
- 自定义休息时长判定正确：
  - `<4H` 无收益
  - `4H-8H` 按短休
  - `>=8H` 按长休
  - `8H+` 每多 8H 恢复收益按比例增加
- 玩家执行休息后，`gameDay/timeOfDay` 按休息时长自动推进
- 每次休息动作会触发且仅触发一次 Director Agent 场景更新
- 当未休息累计超过 6H 时，sidebar 角色状态 Tab 的“状态效果”栏显示疲劳效果
- `actionTemplate`、`combatActionAgentATemplate`、`combatActionAgentBTemplate` 均包含疲劳硬指示注入
- 普通行动与战斗行动规则一致
- 旧存档加载不报错（缺失字段有默认值）
- `timeConsumption` 字段与实际枚举一致，不再出现无效值

---

## 7. 前端交互变更（仅设计，不执行代码）

目标：在发送框区域新增“休息”入口，降低玩家触发休息行为的操作成本。

## 7.1 位置与布局

- 在输入区底部操作行（当前“发送消息”按钮所在行）新增 `休息` 按钮。
- 按钮放在发送按钮左侧，二者同一行对齐：
  - 左：`休息`
  - 右：`发送消息`

## 7.2 交互流程

1. 点击 `休息` 按钮  
2. 弹出时长选择面板（Popover / 小弹层）  
3. 玩家选择休息时长后，生成一条休息指令并进入现有发送流程

建议选项（v1）：

- `4 小时（短休）`
- `8 小时（长休）`
- `自定义`（可选，范围建议 1-24 小时；按 3.3 分段规则结算）

## 7.3 指令发送口径（复用现有消息通道）

为避免改动 API 协议，v1 前端直接发送自然语言指令文本，例如：

- `我休息4小时`
- `我休息8小时`
- `我休息{N}小时`（自定义）

由现有 Orchestrator/Action 流程解析为休息行为并返回 `restResult`。

休息成功后预期效果：

- 立即推进对应 `gameTime`
- 当前回合进入一次 Director 场景更新，再返回 Keeper 叙事

## 7.4 禁用与状态规则

`休息` 按钮在以下状态禁用：

- `isSending = true`
- `isPolling = true`
- `isGameEnded = true`
- （可选）战斗进行中 `isBattle = true` 时禁用，并提示“战斗中无法休息”

## 7.5 文案与国际化

在 `game` i18n 增加键值：

- `input.rest`
- `input.restDuration`
- `input.rest4h`
- `input.rest8h`
- `input.restCustom`
- `input.restInCombatDisabled`（可选）

## 7.6 涉及文件（预估）

- `client/src/components/gamechat/InputArea.tsx`
- `client/src/components/GameChat.tsx`（如果需要把“快速休息发送”handler向下传递）
- `client/src/i18n/locales/en/game.json`
- `client/src/i18n/locales/zh/game.json`

说明：本节是交互设计说明，当前回合仅写入文档，不进行实现。

---

## 8. TimeConsumption 定义统一方案（并入本设计）

## 8.1 问题

当前存在类型与提示词输出不一致：

- 类型定义（`src/shared/state/state.ts`）  
  `TimeConsumption = "instant" | "short" | "scene"`
- Action 提示词示例（`src/dynamicworldagent/dynamicBasicAgent/action/actionTemplate.ts`）  
  `"short" | "medium" | "long" | "very long"`

当模型返回 `medium/long/very long` 时，`DynamicGameState.updatePlayerTimeConsumption()` 现有分支无法正确归类。

## 8.2 目标

- 让模型输出值与类型一致
- 保持“短动作计数”逻辑可用

## 8.3 建议类型定义（实施时）

```ts
export type TimeConsumption =
  | "instant"
  | "short"
  | "medium"
  | "long"
  | "very long";
```

说明：不保留 legacy 值，统一使用新分级。

## 8.4 归类规则（实施时）

- `instant`：不增加 `totalShortActions`
- `short`：`totalShortActions += 1`
- `medium` / `long` / `very long`：按“场景级消耗”处理，直接把 `totalShortActions` 推进到 `shortActionCap`

## 8.5 涉及文件（实施时）

- `src/shared/state/state.ts`（更新 `TimeConsumption` 类型）
- `src/dynamicworldagent/state/DynamicGameState.ts`（更新 `updatePlayerTimeConsumption()` 分支）
- `src/dynamicworldagent/dynamicBasicAgent/action/actionAgent.ts`（落库前做 normalize）
- `src/dynamicworldagent/dynamicBasicAgent/action/actionTemplate.ts`（确保示例与类型一致）
- `src/shared/agents/action/example.ts`（把 `scene` 描述替换为新分级）

## 8.6 验收点

- 模型输出 `medium/long/very long` 时不会丢分支
- 中长时动作可正确触发场景级时间消耗效果
- TypeScript 编译无新增类型错误
