# 用 OpenAI Decisions API 和代码规则替换部分 LLM 判断（讨论稿）

> 状态：**讨论中，未定稿**。标「已定」的是讨论里确认过的；标「提议」的是起草时补的，尚未确认；「待讨论」列在文末。
> 关联：[2026-11-13-concealment-as-perception-design.md](2026-11-13-concealment-as-perception-design.md)——隐藏机制改为「还没被注意到」，第二层感知（谁注意到不起眼的东西）由那份设计交给 Decisions；候选路线也要按那份设计排除被挡住的通道。

## 1. 为什么做

每个 tick（游戏里 1 分钟）的判断几乎都走完整的 MEDIUM 模型调用。其中不少判断的答案是一个封闭集合里的选项（要不要行动、检定难度、走哪条路、谁感知到、清晰度、某个结算阶段要不要跑），用专门做选择的 OpenAI Decisions API 或代码规则就能给出，更快也更便宜。

目标：在**不改变游戏行为**的前提下，减少每个 tick 的 LLM 调用次数和输出 token，缩短 tick 的墙钟时间。

## 2. 现状：每个 tick 的 LLM 调用

全部为 MEDIUM 模型。

| # | 调用 | 何时 | 次数 | 作用 |
|---|---|---|---|---|
| ① | `world-action-engine:starts` | 本分钟有新命令 | 正常 1，会话上限 12 | 每条新命令的时长、检定难度、对抗方、移动路线；不判成败 |
| ② | 结算 5 阶段 `endings` → `characterChanges` → `itemChanges` → `sceneChanges` → `occurrences` | 有到期 / 替换 / 中断 | **总是跑满 5 个阶段**，正常 ≥5，上限 12 | 结果、各类变更、事件内容 + 谁感知到与清晰度 + 理智检定 |
| ③ | `weather-engine` | 区域天气变化 | 每区域 1–2 | 封路与户外地点状态 |
| ④ | renderer | 每个被决策的 NPC | 1，tag 出错再 1 | 结构化感知 → 第一人称段落 |
| ⑤ | `role-sim-agent` | 每个被决策的 NPC | 通常 1；被边界拒绝再跑一遍 | act / continue（+ writeMemory） |
| ⑥ | `memory-consolidate` / `perception-compact` | 超 80k token | 偶发 | 角色自己精简记忆 / 压缩感知 |

每 tick 最少 ≈ ①(0/1) + ②(0/5) + 2 × 被决策人数。

已查明的相关事实：

- **选谁决策**是纯代码（`npcActionController.ts` `processTickReport`）：感知到事件的、行动刚结束的、所有空闲的。忙且没感知到事件的人跳过。空闲的人每分钟都要走 ④⑤。
- **移动**：`act` 没有路线字段；路线由 ① 从行动描述里提取（只走角色说出的路），代码 `initMovementRuntime` 校验相邻、算时长并覆盖引擎时长，`advanceMovement` 逐分钟推进。到达后触发 ②，纯步行基本是 `no_change`。**一次无事发生的步行 = 1 + 5 次调用。**
- **物品**：代码没有物品规则。边界只查 id 存在；① 定时长 / 检定；② 的 `itemChanges`（create / move / destroy / set）和 `sceneChanges`（改写引用该物品的场景描述）由 LLM 写，代码只做一致性校验和写入。
- **对话**：一句纯说话的行动结束，也要跑满 5 个结算阶段；其中三个变更阶段按规则只能交 `[]`。
- **规则**已按阶段拆分（`worldResolutionStagePrompts.ts` 的 `PHASE_RULE_MODULES`），每阶段约 6k–12k token，放在逐字不变的系统提示里被缓存。

## 3. 目标 / 非目标 / 反目标

**目标**
- NPC 侧：判为「不动」的人不走 ④⑤。
- 开始判定：① 只在 Decisions API 拿不准时调用 LLM。
- 结算：没有内容要写的阶段不跑；只有对话、等待、到达的分钟，② 完全不调 LLM。
- 感知者与清晰度不再由 LLM 输出。

**非目标**（保持 LLM）
- 结果描述、事件内容的文字，物品 / 角色 / 场景变更的具体内容，renderer，NPC 决策本身，天气。
- 不按行动类别裁剪或注入规则（见 5 节）。
- 不引入行动类型；不让代码替角色补出没说过的路段。

**反目标**（技术上能跑也算失败）
- 有人对着某个 NPC 说话或呼救，他却没被唤醒。
- 被闸门跳过的人这一分钟的事件**丢失**，而不是延后送达。
- 角色被带到他没说过要去的地方。
- 一个阶段被跳过，导致结果描述与世界状态对不上（写了「揣进兜里」，物品却没动）。
- 未经现有校验的 Decisions 输出直接写进世界状态。
- 角色的感知绕过 renderer。

## 4. 不变的原则

- NPC 自己决定做什么；闸门只决定**什么时候**唤醒他，不决定他看到什么。
- 没有 curator：被跳过的事件延后送达，由角色自己判断要不要在意。
- 只走角色说出的路：候选路线必须包含「只走到半路」，没有合适的就退回 LLM。
- 引擎输出照旧经过 `validatePhase` + `validateRawResolution` + `finalizeResolution`；Decisions 和代码产出的数据走同一道校验。
- 移动时长由代码从路线推出；骰子由代码掷。
- 规则文字和系统提示保持逐字不变，以保住前缀缓存。

## 5. 方案对比（已定）

| 问题 | 选项 | 选择 |
|---|---|---|
| 决策模型 | Jev（alpha、需排队、「要不要行动」类问题公开测得 52%）/ **OpenAI Decisions API**（GA、ZDR、支持缓存、可复用现有 OpenAI 接入） | OpenAI |
| 闸门位置 | **A：渲染之前，看结构化数据**（省 ④⑤）/ B：渲染之后，看段落（只省 ⑤） | A |
| 引擎里的角色 | 只当闸门 / **也直接填字段** | 也填字段 |
| 时长 | LLM 写整数 / **Decisions 从档位里选** | 档位 |
| 移动路线 | LLM 提取 / **代码列候选、Decisions 选** | Decisions |
| 结算优化 | 按行动类别注入规则 / **按需跳过阶段** | 跳过阶段 |
| 拿不准时 | a 全部退回 LLM / b 一律取最高概率 / **c 混合** | c |
| 范围 | 闸门与引擎分开 / **一起设计** | 一起 |

**为什么不按类别注入规则**：缓存按前缀匹配，请求顺序是系统提示（规则）→ 世界上下文 → 阶段指令。规则随类别变化，系统提示每次不同，规则和后面整段世界上下文的缓存一起失效，可能比现在更贵；放到不缓存的尾部，则每次全价。分错类时 LLM 看不到需要的规则，输出可能照样通过校验。真正贵的是调用次数和输出 token，所以改为用 Decisions 决定跑哪些阶段，规则原样不动。

**为什么问多个判断而不建类别表**：判断与阶段一一对应，不用维护「类别 → 阶段」映射；开放世界里类别表总会遇到分不进去的行动；也不重新引入行动类型。

## 6. 设计

### 6.0 Decisions 客户端（已定）

- 新模块（如 `src/models/decisions.ts`）：`POST /v1/decisions`，模型 `gpt-6-luna`，由 `DECISIONS_OPENAI_MODEL` 覆盖。项目里的 `openai` SDK 是 ^4.104，大概率没有这个端点，用 `fetch` 或 SDK 的通用 `post`。
- 无论 `MODEL_PROVIDER` 配的是谁，都需要 `OPENAI_API_KEY`。
- 用量记进 `tokenUsage`，operation 名：`decisions:wake-gate`、`decisions:starts`、`decisions:endings`、`decisions:phase-plan`、`decisions:perceivers`；`LLM_TRACE_DIR` 照样落盘。
- 短超时（如 3s）。超时或报错一律视为「拿不准」，走 6.5 的退回路径，不让 tick 失败。
- 稳定内容放在 `input` 前部以命中缓存（前缀 ≥1024 token），按 NPC 或引擎设 `prompt_cache_key`。引擎侧可复用 `renderContextSegments` 的稳定段，判断依据与 LLM 一致。
- 题目说明（`instructions`）用英文，与引擎现有的英文规则一致；状态内容照常是中文。中文判断质量由影子模式的一致率来看。
- 速率限制未公开：Decisions 请求单独限流（`DECISIONS_CONCURRENCY`）；被限流（429）视同拿不准，单独记日志，影子模式统计比例。

### 6.1 NPC 唤醒闸门（已定：A + c）

插在 `processTickReport` 算出 targets 之后、`decide()` 之前。

**硬规则直接唤醒，不问闸门：**
- 本 tick 自己的行动结束（completed / failed / interrupted / cancelled）。
- 某条 occurrence 的 participants 或 targetIds 里有他；speech 行 targetIds 为空（对整个房间说话）且他是 full 感知者。
- 没有任何感知历史（刚注入、刚恢复）。

**问闸门的人：**
- 正在做事、本 tick 只旁观到与自己无关的事件。
- 空闲（上一次选了 `continue`）。空闲的人每分钟都问，因为时间流逝本身可能让他想动（到点回家）；闸门很便宜，所以不用「什么都没变就跳过」的纯代码规则。

**输入（已定）**：与 `role-sim-agent` 现在的输入保持一致——复用 `buildUserPromptSegments` 的各段（人物、技能、全部记忆、感知流、当前状态、正在做的事）。唯一的区别：闸门在渲染之前，这一 tick 的感知段落还不存在，所以「What you perceive now」那一段换成 renderer 这一 tick 收到的结构化输入（场景、在场的人、本 tick 和缓冲里的事件，带清晰度）；「Decide」那一段不要。
- 好处：判断依据与角色自己做决定时一致；不另造一套输入。
- 代价：记忆和感知流各自最多约 80k token，一次请求可能数万 token。按 $0.10 / 百万 token 仍远低于两次 MEDIUM 调用；稳定的前缀（人物、技能、记忆）可命中缓存。OpenAI 文档未写明上下文上限，实现时确认。

**问题**：一道 predicate——「此刻他会不会开始做新的事或改变正在做的事」。

**判定**：P(会) ≤ `WAKE_GATE_SKIP_MAX`（如 0.1）才跳过，否则唤醒。

**待送达缓冲（已定）**：
- 被跳过的人这一 tick 的 occurrence 进入每人一个的缓冲；下次被唤醒时合并进 `occurrencesForNpc` 交给 renderer。
- **持久化**，随运行时快照保存。只放内存的话，进程重启会丢事件，违背「只能延后、不能丢」。
- 每条带它发生的游戏时间交给 renderer，写成「几分钟前……」。
- 上限 10 条（可配置）。**缓冲满了就按硬规则唤醒**，把积压的事件交给他，所以不丢事件，缓冲也不会无限增长。

### 6.2 开始判定（已定：全部字段由 Decisions 填，LLM 只兜底）

本分钟的每条新命令都先交给 Decisions，一次请求多题。

**所有命令：**
- **是否移动**：predicate「这是不是在去别的地方」。引用了带 `destination` 角色的地点时，代码直接视为移动。

**不涉及移动的命令：**
- **时长**：choice，共 43 档（已定）；输入里带 actor 自报的 `proposedDurationTicks`。纯说话（有 utterance、无技能、只是说话）落在 1。
  - 60 分钟以内：1 / 2 / 3 / 5 / 10 / 15 / 30 / 60 分钟；
  - 1 小时到 1 天：每 60 分钟一档，2h … 24h；
  - 1 天到 3 天：每 6 小时一档，30h / 36h / … / 72h；
  - 3 天到 7 天：每天一档，4 天 / 5 天 / 6 天 / 7 天。最长 7 天。
  - 边界允许 actor 自报的时长目前最多 480 分钟（`commandValidator.ts` 的 `MAX_PROPOSED_DURATION_TICKS`），与 7 天的上限不一致。提高到 10080（已定），让 actor 能如实报出长时间的行动；`act` 工具的说明同步改。
  - OpenAI 文档没写 choice 题的选项数上限。43 个选项若超限或准确率差，改为两步：先判量级（分钟 / 小时 / 天），再判具体档。

**涉及移动的命令：**
- **路线**：代码列候选，Decisions 选一条。**代码不做任何寻路**——现有机制要求路线是一段段相邻地点，只报一个远处目的地会以 `unstatedHop`（「这两处之间并没有一条路」）失败，路要靠角色自己从地图记忆里说出来；代码替他算最短路就等于替他认路。候选完全从行动者引用的地点里拼：
  - 按引用顺序连成一条，逐段检查相邻；在第一处连不上的地方截断，截断后的前半段也作为一个候选（与现有「截断而非整体失败」一致）。
  - 允许省略「出门到街上」这一隐含的第一段（现有规则允许），作为一个候选。
  - 只引用了一个地点且它就在旁边：候选就是这一段。
  - 外加「都不是」：选中则退回 LLM。
  - 只用未被挡住的通道；被挡住的通道只在行动者明确说了要通过它时才进候选（见隐藏机制设计 5.6）。
  - 途经的每个地点都必须是行动者能引用的（见隐藏机制设计 5.4）；经过他不知道的地方的路线不进候选。
- **车辆**：choice，「步行」+ 行动者所在车内的车辆。司机是否在车里仍由 `initMovementRuntime` 校验。
- **翻越被封通道**：choice，「无」+ 当前出口里被封的通道；有检定时不问（与现有规则一致）。
- 时长不问，仍由代码从路线推出。

**共同字段（声明了技能时才问）：**
- **检定难度**：choice，不检定 / regular / hard / extreme。没声明技能的由代码直接判不检定。
- **对抗方**：choice，「无人对抗」+ 在场的人 × 防御技能组合；没有检定时不问。

Decisions 的答案组装成 `RawActionStart` 行，走同一套 `validatePhase("starts")` → 全局校验 → `finalizeResolution` → `commitStarts`。

某条命令任一字段拿不准，或路线选了「都不是」：只把这些命令交给 LLM 走 ①（上下文只带这组命令），结果与 Decisions 组合并后一起校验。全部有把握时 ① 不调 LLM。

规则文字：从 `engine/rules/world-action-resolution.md`、`world/movement-and-position.md` 和技能参考里压缩出各题的 `instructions`（实现时整理）。

### 6.3 结算：按需跳过阶段（已定）

**第 0 步，到达直接收尾（代码规则）**：到期的行动同时满足以下条件时，代码直接写 `completed`、结束方式记为 `no_change`，不进 ②：
- 有移动 runtime 且本 tick 正常到达（不是被阻断、被替换或被中断）。
- 没有检定。
- 没有 utterance。

这些 transition 必须计入「已结算」，否则 orchestrator 的兜底 occurrence（`tickOrchestrator.ts` 约 358 行）会给 actor 补一条「行动结束了，没有留下可见的变化」。去掉它们后若再无触发，整个 ② 不跑。

**第 1 步，结束方式（Decisions 请求一）**：对其余每个结束的行动：

| 情况 | 结束方式 |
|---|---|
| 有检定 | `outcome`（规则要求，代码直接定） |
| 无检定、有 utterance | Decisions：「除了说话还做了别的、有新结果吗」→ `outcome` / `pure_speech` |
| 无检定、无 utterance | Decisions：「有新的客观结果吗」→ `outcome` / `no_change` |

输入里带 `diceRoll`（结算前已掷骰）。

**第 2 步，endings 阶段**：
- 全部是 `pure_speech` / `no_change` 且都有把握：代码直接组装 endings，不调 LLM。
- 否则：照常跑 LLM endings 阶段，由 LLM 决定所有行动的结束方式（与现在一致）。

**第 3 步，变更阶段计划（Decisions 请求二，已定）**：endings 确定后，对每个 `outcome` 行动，连同它的结果描述，问三道 predicate：会不会改变角色状态 / 物品 / 场景。
- 只在 endings 之后问：此时已有结果描述，判断更准；多一次 Decisions 请求（约几百毫秒），相对 LLM 阶段可以忽略。
- 某个阶段：所有 `outcome` 行动都有把握判为「不会」→ 跳过，草稿里记为已接受的 `[]`。拿不准 → 照常跑。
- 没有 `outcome` 行动时，三个变更阶段全部跳过（`no_change` 按校验器规则不能引出变更；`pure_speech` 只是说话）。纯代码，不需要 Decisions。

**跳过后的补跑规则（已定）**：
- 上游阶段的输出给被跳过的阶段带来义务时，代码把它改为必跑。例：`itemChanges` 把物品从一个场景移走或销毁，而该场景描述引用着它，则 `sceneChanges` 必须跑。
- 全局校验失败回退时，被回退到的阶段及其下游一律取消跳过，照常跑。

**第 4 步，occurrences 阶段**：
- 说话行由代码组装：引用该行动、`speech:true`、`targetIds` 取命令里 target / recipient 的人（没有则为空，表示对整个房间），台词由代码逐字附上，`content`（语气、伴随动作）不写。
- 没有 `outcome` 行动：不调 LLM，只用代码组装的说话行。
- 有 `outcome` 行动：照常跑 LLM，代码组装的说话行作为「已保留的行」预先放进去（复用现有 `MERGE_PHASES` / `retainedRows` 的合并机制），LLM 只写还欠的结果行。
- schema 去掉 `perceivers`，见第 5 步。

代价：
- 说话行的 `content` 丢失。
- 跳过 occurrences 的分钟里，LLM 不会顺带写进行中行动的可感知迹象（撬锁的声响）。没有任何行动结束的 tick 本来也不写，行为与之一致。

**第 5 步，感知者与清晰度（Decisions 请求三）**：
1. 候选（已定）：事件数 × 角色数不超过一次请求的 400 题上限时，**所有活着的角色都是候选**，代码不划范围，远近完全由 Decisions 按感知规则判断（城那头的枪声也能被判到）。超过上限时退回按两跳划候选。
2. 代码规则：被引用行动的 actor → full。
3. Decisions 一次请求：每条事件 × 每个其余候选人一道 choice（没感知到 / trace / limited / full）。
4. 写回 perceivers 后再进全局校验。

**理智检定（已定）**：`consequence`（严重反应的状态描述和持续时间）是生成内容，Decisions 写不了。所以 `sanityChecks` 仍由 LLM 在 occurrences 阶段写；感知者判完后，代码删掉角色不是 full / limited 的那些检定；现有「必须是 full / limited」的校验改到这一步之后执行。没调 occurrences LLM 的分钟里不会有理智检定（纯说话、等待、到达本来也不该引发）。

### 6.4 一个对话分钟走完的样子

两人各说了一句话（无技能），都在这一分钟结束：

| 步骤 | 现在 | 设计后 |
|---|---|---|
| 开始判定 | 1 LLM | 1 Decisions |
| 结束方式 | （含在 endings） | 1 Decisions |
| endings | 1 LLM | 代码 |
| 三个变更阶段 | 3 LLM，都交 `[]` | 跳过 |
| occurrences | 1 LLM | 代码组装说话行 |
| 感知者 | （含在 occurrences） | 1 Decisions |
| 合计 | 6 LLM | 0 LLM + 3 Decisions |

### 6.5 拿不准时（已定：c）

| 环节 | 规则 |
|---|---|
| 唤醒闸门 | 照常唤醒 |
| 开始判定字段 / 路线 | 该命令交回 LLM 走 ① |
| 结束方式 | 跑 LLM endings 阶段 |
| 变更阶段计划 | 照常跑该阶段 |
| 感知者 | 不退回：取概率最高的一档，向更清楚的方向偏——前两档相邻且差距 < δ 时取更清楚的；最高档是「没感知到」但概率 < τ 时记为 trace |
| 客户端超时 / 报错 | 视同拿不准 |

阈值都由环境变量配置。初始值（已定，之后用影子数据调）：

| 环节 | 初始值 |
|---|---|
| 闸门跳过 | P(会行动) ≤ 0.1 |
| 开始判定各字段 | 最高选项概率 ≥ 0.8，否则退回 LLM |
| 跳过阶段 | P(不会改变) ≥ 0.9 |
| 感知者 | 前两档差 < 0.15 取更清楚的；「没感知到」需 ≥ 0.7，否则记 trace |
| 注意到（隐藏机制设计 5.3） | P(注意到) ≥ 0.6 才算注意到 |

### 6.6 开关与影子模式（已定）

每项一个开关，取值 `off | shadow | on`：

| 开关 | 管什么 |
|---|---|
| `DECISIONS_WAKE_GATE` | 6.1 |
| `DECISIONS_STARTS` | 6.2 |
| `ENGINE_ARRIVAL_SKIP` | 6.3 第 0 步（纯代码，也要验证） |
| `DECISIONS_PHASE_SKIP` | 6.3 第 1–4 步 |
| `DECISIONS_PERCEIVERS` | 6.3 第 5 步 |

shadow：Decisions / 代码规则照算并记录，实际用的仍是 LLM 结果。对比结果写 JSONL（如 `DECISIONS_SHADOW_LOG`），用 LLM 现有输出当标签：

| 开关 | 量什么 |
|---|---|
| 闸门 | 跳过率；漏醒率（闸门会跳过但 LLM 实际选了 act） |
| 开始判定 | 检定难度、时长档位、对抗方、路线、车辆的一致率；退回 LLM 的比例；路线比 LLM 走得更远的比例（违反「只走说出的路」） |
| 到达收尾 | LLM 对这类到达给出非 `no_change` 的比例 |
| 阶段跳过 | 结束方式一致率；判为「不会改变」而 LLM 实际交了非空数组的比例；可跳过阶段的占比 |
| 感知者 | 每对（事件, 角色）的一致率；清晰度混淆矩阵；漏掉感知者的比例；LLM 列出了候选范围外的人的比例 |

数据达标后逐项切到 `on`。影子模式要跑真实模拟，会花模型调用的钱，什么时候跑由人决定。

## 7. 预期效果（未测）

以 10 个 NPC、某一分钟 2 人行动结束（1 人纯步行到达、1 人说完一句话）、2 人提交新命令、3 人空闲、其余在忙为例：

| | 现在 | 设计后（假设空闲 3 人里有 2 人判为不动，Decisions 都有把握） |
|---|---|---|
| ① 开始判定 | 1 LLM | 1 Decisions |
| ② 结算 | 5 LLM | 0 LLM + 2 Decisions |
| ④⑤ NPC | 10 LLM | 6 LLM + 3 Decisions |
| 合计 | 16 LLM | 6 LLM + 6 Decisions |

有检定、有实际结果的分钟省得少：endings、occurrences 仍是 LLM，变更阶段视情况跳过。实际收益取决于影子模式测出的比例。

## 8. 改动范围（初估）

- `src/models/`：Decisions 客户端、用量与 trace。
- `src/roleSim/npcActionController.ts`：硬规则、闸门调用、待送达缓冲；新增 `src/roleSim/wakeGate.ts`。
- `src/engine/core/tickOrchestrator.ts`：开始判定的 Decisions / LLM 分组、到达收尾、兜底 occurrence 的排除。
- `src/engine/resolution/worldActionEngine.ts`：会话按阶段计划跳过阶段、跳过后的补跑与回退规则、结束方式和说话行的代码组装。
- `src/engine/resolution/`：开始字段与路线候选的组装；occurrences schema 和阶段校验去掉 perceivers；感知者判定与理智检定过滤；全局校验顺序调整。
- `src/engine/resolution/worldResolutionStagePrompts.ts`：occurrences 阶段的提示去掉感知者部分。
- CLAUDE.md：管线描述更新。

## 9. 待讨论

- 暂无设计上的待定项。实现前要实测的见 6.6；实现时要确认的：Decisions 的上下文上限、choice 题的选项数上限（6.2）。

## 9.1 实现状态（2026-11-13）

已实现：
- `src/engine/shared/fastPath.ts`：全部开关（含 `DECISIONS_WAKE_GATE`、`DECISIONS_NOTICING`、`DECISIONS_STARTS`、`DECISIONS_PERCEIVERS`），默认 `off`。
- `src/models/decisions.ts`：Decisions 客户端（限流、超时、429、用量、trace）。线上请求格式按公开指南写成，`toWire` / `fromWire` 两处，需对照 API reference 核实。
- 到达收尾（6.3 第 0 步）、开始判定（6.2，`decideStarts`，接入 orchestrator）、结束方式与变更阶段计划（6.3 第 1–3 步）、无「有新结果」分钟里由代码拼说话行 + Decisions 判感知者（6.3 第 4–5 步的子集）。
- `src/roleSim/wakeGate.ts`：硬规则、闸门请求、注意到的判断、待送达缓冲（含序列化）——**模块已写，未接入 controller**。

与设计的偏差（实现时的取舍）：
- 有「有新结果」的分钟（`DECISIONS_PERCEIVERS=on`）：occurrences 阶段改用不含 `perceivers` 的工具变体（`OCCURRENCES_TOOL_CODE_PERCEIVERS`），LLM 只写内容；提交后由 Decisions 补感知者，再删掉不是 full / limited 的人的理智检定，然后照常校验。Decisions 失败时，本会话剩余部分退回完整工具，重问一次 occurrences。**新 schema 需先跑 `scripts/probe-strict-schema.ts` 再打开开关。**
- 有「有新结果」的分钟，说话行仍由 LLM 写（没有做「代码拼说话行预先放进去」）。
- 感知者候选超过 400 题时不退回两跳，而是整段交回 LLM。

已接入（2026-11-13，与「单人游玩」会话的改动并存，定点修改）：
- `npcActionController`：硬规则唤醒、闸门、待送达缓冲、注意到；「感知流 + 记忆里的 tag」作为 `CitationScope` 同时传给 renderer 和 `buildActionCommand`。
- `commandBuilder`：给了 `CitationScope` 时，物品和地点必须在范围内（目录按需计算）。
- `commandValidator` 与 `act` 工具：自报时长上限 10080。
- `userPromptBuilder`：整理记忆的提示补了「保留 tag」（压缩感知原本已有）。
- `SimulationRunner` / `client/server/simulation/service.ts`：待送达缓冲存于 `_pendingDelivery`。
## 10. 参考

- OpenAI Decisions API guide：https://developers.openai.com/api/docs/guides/decisions
- REFLEX（Jev 作为 LLM 前的决策层）：https://arxiv.org/pdf/2609.26532
