# Engine 操作总览

engine 处理的「操作」分四层，彼此不共享枚举：**演员发出的命令**（只有一种）、**触发一次 Engine 会话的原因**、**Engine 提交的 world operation**（18 个 kind）、**Applier 真正落地的 StateChange**（25 个 kind，其中 7 个只有代码能发）。

全局原则：**没有动作类型枚举**。所有开放式行为共用一个命令形状、一份规则文档（`src/engine/rules/world-action-resolution.md`）和一套 WorldDelta schema。

---

## 1. 输入侧：唯一的命令 `act`

演员（`RoleSimAgent`）只有 `act` 会产生进入 engine 的命令。`continue` 只是让在飞的动作继续跑，`writeMemory` 完全不进 engine。

**`ActToolArgs`**（`src/roleSim/tools/schemas.ts:28`，`src/engine/actions/types.ts:52`）

| 字段 | 必填 | 说明 |
|---|---|---|
| `description` | ✓ | 一两句第一人称的意图描述——只写「我尝试做什么、怎么做」，不写结果 |
| `objectRefs[]` | ✓ | `{id, role?}`。`role` ∈ `target` / `tool` / `destination` / `recipient`。**不带 `kind`**：id 本身说明它是人、物还是地方，边界自己推导 |
| `proposedDurationTicks` | ✓ | 演员愿意投入的分钟数，仅供参考；权威时长由 Engine 定 |
| `skillId` | | 枚举自 `SKILL_CATALOG`（17 个能力域）。不填是一个真实选择：不填 = 不吃训练加成 |
| `language` | | 仅当 `skillId === "Languages"` 时有意义 |
| `utterance` | | 逐字说出的话；沉默时省略 |

**信任边界**（`commandValidator.ts` → `commandBuilder.ts`）只做形状与存在性检查，拒绝码共 6 个：

`invalid_description` · `invalid_object_refs` · `unknown_ref` · `invalid_duration` · `invalid_skill` · `invalid_utterance`

边界只问「这个 id 是不是指向真实存在的东西」。**可达性、可行性、技能是否合适、有没有人抵抗，全部是 Engine 在完整上下文里的判断**，不在边界上做。陌生人以每 tick 别名（`stranger_a`）出现，边界在交给 Engine 前换回真实 id。

通过后包装成 `ActionCommand`（`types.ts:84`），加上模型永远无权书写的可信封套 `TrustedActionEnvelope`：`commandId` / `actorId` / `issuedAt` / `issuedSceneId` / `replacesActionId`。

---

## 2. 触发侧：什么时候开一次 Engine 会话

`tickOrchestrator.tick()` 收集触发器（`ResolutionTriggerReason`，`resolution/types.ts:145`）：

| reason | 何时产生 |
|---|---|
| `new_action` | 本 tick 收到了新命令 |
| `duration_reached` | 动作跑满了 `resolvedDurationTicks`，或移动腿已到达 |
| `replacement` | 新命令带 `replacesActionId`，且旧动作仍 active/queued。worklist 把旧动作列进 `ending` 和 `replaced`：它在本分钟被截断，Engine 只结算已做到的部分，代码按时长未满记为 interrupted |
| `interrupted` | 路线被堵、演员死亡等挂起的中断 |

**无触发 = 0 次模型调用**，这一 tick 只跑确定性部分。会话失败时，drain 掉的命令会退回 inbox、中断重新挂起——「这一 tick 什么也没发生」必须是真的，而不是「悄悄吃掉了两条命令」。

一次 tick 的顺序（`tickOrchestrator.ts:102`）：

1. 时钟推进 1 分钟
2. 移动 runtime 推进（确定性，无模型调用）；堵住→中断，到达→立即到期
3. 在飞动作 `progressMinutes += 1`（时长只由时钟消耗，Engine 从不被问「过了多久」）
4. drain 命令 inbox（死亡演员的命令直接 failed）
5. 收集触发器
6. `rollDueChecks` —— 骰子在这里掷，此时难度早已在动作开始时定好
7. 一次 World Action Engine 会话
8. anchor 子系统 + 脚本事件
9. 天气判断：读并消费 buffer 里的内部 `weather.transition` 信号，调用天气 engine（晴天同样调用），把结果并入同一次 flush（见 §2.1）；该信号不进入公开事件流
10. 单次 Applier flush
11. 提交动作生命周期，发 `TickReport`

### 2.1 天气 engine：第二个会话，另一个触发源

天气子系统只跑状态机和数值。区域的天气类型或强度一变（子系统每 120 分钟一次的转换、初始化、脚本 `weather.set`），它在 buffer 里放一条内部 `weather.transition` 信号；orchestrator 在脚本事件之后消费它，再调用 `engine/weather/weatherEngine.ts`。输入是该区域所有户外地点的 prose、候选通道（两端都在户外，id 形如 `weather:<a>|<b>`）和新天气，输出「关哪些通道、哪些地点挂什么条件」。代码做记账：模型给完整集合，和 `WeatherRegionState.judgedBlockIds` 做差，多出的设、少掉的撤；条件按 `featureId: "weather"` 整体替换，技能减值由代码按类型和强度挂上。晴天同样调模型：晴天不封路，但它仍然改变户外地点的样子（光线、影子、干燥的地面、传得远的声音），上一次的天气条件是被替换而不是被删掉。失败（模型报错或一轮修补后仍不合法）只打警告，封锁和条件保持上次的；唯一例外是晴天——晴天判定失败时仍然套用空判定，否则暴风雪的封路和条件会活得比暴风雪还久。

---

## 3. Engine 会话内可用的工具

**确定性代码工具只剩一个**（`registerDefaults.ts:createDefaultCodeToolRegistry`）：

| 工具 | 文件 | 为什么留 |
|---|---|---|
| `damageRoll` | `engine/tools/diceTools.ts` | 掷骰绝不能归模型 |

原先还有三个，已删除——**一次工具调用要花掉一整轮、即一次约 60k 上下文的往返**，所以工具只有在回答「请求里说不出来的东西」时才值这个价：

- `pathfinding` / `movementCost`：World Graph 段本来就渲染了每个顶层地点的出边和每条路的步行分钟，两者都是在替模型搜索它已经拿着的数据；而且都改变不了结果——演员陈述的路线是唯一路线，某一跳存不存在由代码（`placesAdjacent`）裁决。实测一次 10-tick 跑里它们占了 14 次工具调用中的 11 次、约全程 prompt 预算的三分之一，只为逐跳核对一条路线。
- `inventoryValidation`：改成把答案直接放进请求——命令点名了谁、或点名了谁手里的东西，`contextBuilder` 就把那个人的口袋一并注入 Items 段。几百 token，而且在问题被提出之前就答完了。
- `opposedRoll`：定义了但从未注册，也没有任何代码调用。对抗掷骰的真实路径是 Engine 在 `starting` 里声明 `opposedBy`，`skillRollService` 到期时掷两边。已连同上面三个一起删除。

**终止工具**：`submit_resolution`。输出经 `worldDeltaValidator` 校验，最多 `MAX_CORRECTION_ROUNDS = 3` 轮完整重提（没有独立的 patch 工具，修正轮仍调用 `submit_resolution` 提交整份结果）；仍不合法则整个 tick 不应用任何结果。

---

## 4. `submit_resolution` 的四块内容

### 4.1 `starting[]` —— 本 tick 开始的动作（`RawActionStart`）

| 字段 | 说明 |
|---|---|
| `resolvedDurationTicks` | 权威时长；演员的估计只是建议 |
| `timingReason` | 为什么是这个时长 |
| `check` | `{requiredLevel: regular\|hard\|extreme, basis}` —— **在任何骰子存在之前**定下的难度，写一次即不可改 |
| `opposedBy[]` | `{characterId, skillId}`，主动抵抗；两边由代码掷骰比等级，平手防守方赢 |
| `movement` | `{route: string[], vehicleId?, passBlockedConnectionId?}` —— **演员自己说出的**路线，逐段拓扑相邻。Engine 从不替他补一段没说过的腿。`passBlockedConnectionId` 是“这个人能通过、但障碍还在”的一次性放行：值必须是 `exitsFromHere` 中那条被封通道的精确 id，只在匹配边消费，后续边照常检查；它不能与尚未掷骰的 `check` 同时出现。障碍被清除则用 `connectionBlock {blocked:false}`。 |

### 4.2 `ending[]` —— 本 tick 结束的动作（`RawActionEnd`）

| 字段 | 说明 |
|---|---|
| `outcome` | `success` / `partial` / `failure` / `blocked`。**只有在动作没有 check 时必填**；有 check 时成败已由掷骰决定，此字段会被拒绝 |
| `reason` | 客观发生了什么 |
| `occurrence` | 必带，就地内联（不跨数组引用），source 即本动作 |
| `resolvedDurationTicks` / `timingReason` | 事后修订的时长估计 |

> 既不在 `starting` 也不在 `ending` 里的动作＝仍在继续。沉默已经表示「继续跑」。

### 4.3 三类 world change

每条是 `{sourceActionId, causalBasis, operation}` + 域 id。`causalBasis` 会被审计：validator 拒绝无法因果追溯到输入的 delta。

### 4.4 `occurrences[]`

`{locationId?, facts[{type, content, entityRefs}], participants[{characterId, role: actor|target|directly_affected}], perceivers[{characterId, clarity: full|limited|trace}], signals[{factIndexes?, channel, originLocationId?, intensity?}]}`

`channel` ∈ `visual` / `sound` / `smell` / `touch` / `direct`。Engine 只列出「谁在感官上够得着」，**每个人实际感知到什么是 Renderer 的事**。fact 的 `entityRefs` 用 engine 词汇，可以引用 connection（演员不能引用它，渲染时不打标签）。

---

## 5. WorldDelta operation 全表（19 个 kind）

来源：`worldDeltaSchema.ts` 的 `CHARACTER_OPS` / `SCENE_OPS` / `ITEM_OPS`。**同一张表既渲染给模型看（`renderOps`），又生成 validator 的接受集合（`opKinds`），还生成提供方强制的 `anyOf` 语法（`opSchema`），所以三者不可能对不上。** 两个引擎工具都是 `strict: true`，schema 保持在 Anthropic strict 子集内（每个对象 `additionalProperties: false`，不用 `minimum`/`maximum`/`maxItems`）；数值上下界写在描述里并由 validator 执行。

### character（7）

| kind | 字段 |
|---|---|
| `hp` `fatigue` | `delta: number, reason: string` —— 没有 `san`：SAN 只经 occurrence 的 `sanityChecks` 由代码掷骰写入 |
| `position` | `position: {type: "scene", sceneId}` —— 只用于"不是走过去"的位移：上下载具（进出其内部场景），或动作后果造成的无路线位移（翻窗跳到院子、昏迷被抬走、被拖走、摔穿地板）。凡是走、跑、潜行、骑车到另一个地方，一律用动作上的 `movement.route`，由代码按拓扑和路程推进；实测一晚上三次角色被这条操作"送"过没进过的房间、绕过没看见的人。路是走出来的，直接放到路上会缺沿路分数，曾让下一次规划算出 NaN 炸掉整个 tick |
| `spot` | `spot: string` —— 在这个地方的哪儿，一句短语；`""` 清空（换地点时代码自动清） |
| `addCondition` | `condition: {id, description}` |
| `removeCondition` | `conditionId: string` |

### scene（8）

| kind | 字段 |
|---|---|
| `addCondition` | `condition: {description, featureId?}`（`mechanicalEffect` 是技能减值映射，strict 语法表达不了，也从不由引擎写，只有 sun/stamina 子系统在代码里设） |
| `removeCondition` | `predicate: {id?, featureId?}` —— 至少给一个；`featureId` 删掉该 feature 拥有的全部条件 |
| `setDescription` | `description: string` —— **整段替换**；保留所有仍然为真的 `[reference-id]` 引用，删掉已不在场之物的引用 |
| `connectionBlock` | `connectionId, blocked: boolean, reason` |
| `connectionDiscovered` | `connectionId, characterIds: string[]` —— 这些人发现了暗道；列出所有能看到的人。只对 hidden 的连接有效 |
| `connectionHidden` | `connectionId, hidden: boolean`（`false` 是揭示） |
| `environmentContribute` | `quantity: temperature\|illumination\|oxygen\|noise, value: number` |
| `environmentHazard` | `add?: string[], remove?: string[]` |

### item（4）

| kind | 字段 |
|---|---|
| `create` | `name, location(<"scene:<placeId>"\|characterId>), description?, id?`（非拉丁名必须自带 id） |
| `move` | `from, to`（同一套持有者语法）。**若原地点的 prose 引用了这件物品，同一次提交必须一并改写该 scene 的 `setDescription`** |
| `destroy` | 无字段。同上的 prose 改写要求 |
| `set` | `description`（整段替换）· `appendDescription`（追加一句，损伤就是这么记的）· `hidden`（`false` 是揭示）· `isLightSource` · `lightLevel` |

**为什么 item 是 create/move/destroy + set 这么分**：东西「在哪」和「还在不在」是结构性的——perception 列的是 `scene.items` 和背包里的 id，引用边界正好只认这些 id；只写在散文里的「已被摧毁」会继续可见、可引用、可操作。而东西「什么样」是散文加两个照明数字，`set` 全包了。它取代了旧的 `modify` 和 `damage`：damage 从来只是往描述后面追加一句，而且没法把它刚砸碎的那盏灯灭掉——`sun.ts` 会继续按亮着算。

---

## 6. Applier 落地的 StateChange 全表

`src/engine/core/types.ts:127`。是上表的超集：子系统和移动 runtime 也发这些。

**由 WorldDelta 映射而来**：`character.hp` `character.san` `character.fatigue` `character.addCondition` `character.removeCondition` `character.position` `character.spot` · `scene.addCondition` `scene.removeCondition` `scene.setDescription` `connection.setBlock` `connection.setHidden` `environment.contribute` `environment.hazard` · `item.create` `item.move` `item.destroy` `item.set`

`connection.setBlock` 是一条边一个标志：天气 engine、脚本事件、WAE 三个来源各写各的，最后写的人说了算，任何一个都可以清掉别人设的。没有投票表、没有引用计数。

**只有代码能发（LLM 无对应 operation）**：

| kind | 谁发 / 做什么 |
|---|---|
| `feature.setState` / `feature.removeState` | 子系统持久化自己的状态 |
| `event.emit` | 子系统发 `FeatureEvent` |
| `environment.cap` | 只支持 `illumination`：给照明设上限 |
| `vehicle.position` | 移动整辆载具；乘客位置是载具的内部场景，骑乘期间不变 |
| `memory.event` / `memory.witness` | Applier 里是 no-op，由 `NpcActionController.routeStateChangeMemories` 消费 |

---

## 7. 完全确定性、不经 LLM 的部分

**注册的子系统**（`registerDefaults.ts:createDefaultSubsystemRegistry`，anchor 按 priority 升序跑）：

`weather`（只管状态机与数值贡献；封锁和条件由天气 engine 写） · `sun` · `stamina` · `itemDamage` · `characterConditionExpiry` · `sceneConditionExpiry`

> `subsystem/movement.ts` **不是**注册的子系统，它是纯路线库（`planMovementRoute` / `interpolateMovementPosition`），被 `actions/movementRuntime.ts` 调用。

**其余确定性逻辑**：

- 移动推进 `actions/movementRuntime.ts`（每 tick 沿路线插值，堵住→中断，到达→到期）
- 技能掷骰 `actions/skillRollService.ts` + `actions/adjudication/`：`SKILL_SUCCESS_LEVELS` = critical / extreme / hard / regular / failure / fumble，永不重掷（重试和快照还原都复用同一条 `checkOutcome`）
- 动作生命周期 `EngineActionStatus`：`queued` → `active` → `completed` / `failed` / `interrupted` / `cancelled`。状态转换由代码从时钟推导：有结果块＝结束（时长跑满是 completed，被截断是 interrupted），沉默＝保持 active
- 脚本事件 `core/scriptedEventRunner.ts`
- 时钟 `state/gameClock.ts`（单一 ISO 8601 `gameDateTime` 字段）

---

## 8. 明确「不存在」的操作

这些是被删掉、且不应重新引入的：

| 不存在的东西 | 原因 |
|---|---|
| character `relationship` operation | Engine 只报告发生了什么，别人怎么看是各自用 `writeMemory` 写的。它曾经存在：被要求记录「Nancy 对 Philip 起了戒心」时，applier 把**同一个分数和同一句话**也写到了 Philip 那一行，凭空捏造了他对她的看法 |
| item `modify` / `damage` | 并入 `set`（见 §5） |
| connection 作为可引用实体 | 通道只是拓扑记账。散文引用通道**通向的地方**（`[SCN_*]`）；真正作为物件存在的门（可锁、可破）应当作为 item 编写 |
| 动作类型枚举 / 每类动作的 prompt | 一份规则文档管所有事 |
| 中央调度器 / 每日计划生成 | 管线就是 `perception → NPC agent → trust boundary → command inbox → engine` |
| recall 工具 | 记忆整块注入 prompt；不在 prompt 里的记忆对该角色就不存在 |
| 渲染失败时的上帝视角兜底 | renderer 失败就返回 null |
