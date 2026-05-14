# Game Interpreter Skill Flow Harness — 诊断报告

**运行日期**: 2026-04-17
**数据源**: `reports/skillflow-20260416-2032.jsonl`（47 case × Cassandra_zh 模块）
**报告撰写**: 2026-04-17，基于完整运行数据 + 源码 trace 验证

---

## Executive Summary

全量 47 个诊断 case 跑完，0 运行错误，schema 校验 + apply 100% 通过。但：

- **primary definition 匹配率仅 64%**（30/47）
- **全 step 序列匹配率 43%**（20/47）
- **27 个 case mismatch**（原 20 fixture 占 9 个，新 27 fixture 占 18 个）
- **5 个 output key 完全零触发**：character.hp / character.san / character.position / item.destroy / memory.witness

mismatch 模式聚类后指向 **4 个引擎侧问题** + 1 个脚本侧假阳性。**不是脚本 bug**——诊断脚本正确执行了它被设计要做的事：暴露 interpreter/resolver 在实际多样输入下的行为缺口。

核心问题（按影响范围降序）：

| # | 问题 | 影响 case 数 | 占比 |
|---|---|---|---|
| 1 | Perception 成为"万能选项"，吞掉 research / occult / archaeology / law / track / listen | 11 | 41% |
| 2 | Resolver 默认退化到 `memory.event + character.fatigue`，不愿输出 character.hp / san / condition / position | 10 | 37% |
| 3 | 伞形 definition（action / character_interaction / item_exchange）盖过专门技能 | 6 | 22% |
| 4 | 非 scene 执行位置（road/junction）完全破坏 output 生成 | 2 | 7% |

---

## 问题 1：Perception 成为"万能选项"

### 症状

11 个 case 里 interpreter 把 research / occult / archaeology / law / track / listen 全部误识别成 **perception**：

| case id | actionText（节选） | 期望 | 实际 |
|---|---|---|---|
| single_research_repair_log | 翻查维修登记簿，找最近几天谁来送修过钟表 | research | perception |
| single_occult_web | 研究巨网和霜痕，判断这里是不是某种超自然通道 | occult | perception |
| multi_move_then_listen | …再贴在实验室门边仔细听… | listen | perception |
| multi_move_then_occult | …再研究巨网上的寒霜和异常光泽 | occult | perception |
| branch_regular_research | 翻查维修登记簿，找最近几天谁来送修过钟表 | research | perception |
| key_character_san_occult | 凑近研究那张诡异的巨网 | occult | perception |
| key_memory_witness_spotting | 远远看着布鲁诺在窗口做什么 | perception | perception（但 output key 错） |
| academic_law_interpret | 翻查工坊执照看能不能找出对方违规的地方 | law | perception |
| academic_archaeology_inspect | 仔细查看祭坛底座的刻痕判断年代 | archaeology | perception |
| special_track_footprint | 蹲下观察地上的脚印推断对方往哪走了 | track | perception |
| single_electrical_repair_monitor | 检查监控屏幕的线路… | electrical_repair | perception |

### 根因分析

查 `src/engine/tool_definitions/skills/perception.md`：

- **description**: `"Finding hidden objects, spotting clues, noticing details that others miss"` —— 语义极宽，基本覆盖所有"观察/查看/注意到"类动作
- **interpreter.examples**: `"Thoroughly search the room for clues"` / `"Look over the tabletop for anything out of the ordinary"` / `"Check the walls for a hidden door"` / `"Search the desk for hidden compartments"` —— 4 个示例都是通用"search/look"模式

对比更专门的技能：

- `track.md` 的 description: `"Following tracks and trails, reading signs of passage, tracking people or animals"` —— 但 examples 只有 `"Follow the footprints on the ground"` 等 3 个。中文"**蹲下观察地上的脚印**"里"**观察**"一词的语义匹配 perception 的 "noticing details" 比 track 的 "tracking" 更强
- `archaeology.md`: 只给了 3 个 examples，都是 "Determine the age of this ancient object" 模式，和中文"查看祭坛底座的刻痕**判断年代**"语义有距离
- `research.md`（经 git 验证）: description 偏向图书/资料查询，但"翻查登记簿"在 LLM 眼里更像 perception 的"search"

**结论**：perception 的 description + examples 形成了一张大网。当其他技能 description 太抽象或 examples 太少时，perception 总能以更高相似度胜出。

### 修复方向

- `perception.md`：把 description 收窄，比如 `"Noticing hidden physical objects or subtle sensory clues in the immediate vicinity"`，删除"spotting clues"这种过宽的短语
- 专门技能（research / occult / archaeology / law / track）：在 description 里明确"区别于 perception 的是…"；examples 增加中文化 / 高 relevance 的表述
- 或者：在 `gameInterpreter.ts` 的 prompt 里增加"**优先选择语义最具体的 definition；perception 仅用于无其他专门观察技能适用时**"的启发式

---

## 问题 2：Resolver 默认退化到 `memory.event + character.fatigue`

### 症状

10 个 case：interpreter 选对了 definition，但 resolver 没产出 definition 声明的 output key，而是退化到"安全兜底"输出：

| case id | definition | 期望 key | 实际 output |
|---|---|---|---|
| key_character_hp_first_aid | first_aid | character.hp, character.condition | memory.event |
| medical_first_aid_bleeding | action（已错域，见问题 3） | character.hp | character.fatigue, memory.event, scene.condition |
| key_character_san_occult | perception（已错域） | character.san | character.fatigue, memory.event |
| medical_medicine_diagnose | medicine | memory.information, character.condition | memory.event |
| medical_psychology_read | psychology | memory.information, relationship.change | memory.event |
| branch_fail_psychology | psychology | memory.information, relationship.change | memory.event |
| key_memory_witness_spotting | perception | memory.witness | memory.event |
| env_road_perception | perception | memory.information | character.fatigue, memory.event |
| env_junction_listen | listen | memory.information | character.fatigue, memory.event |
| single_perception_hospital_records | perception | memory.information, item.modify | character.fatigue, memory.event |

**5 个 output key 零触发**：character.hp / character.san / character.position / item.destroy / memory.witness —— 诊断脚本的 Group B 专门为这些 key 设计 fixture，结果全部没能在 47 次运行中被 LLM 输出。

### 根因分析

**根因 A：`default` preset 强制兜底 3 个 key**

查 `src/engine/outputSchema.ts:4`：

```ts
default: ["memory.event", "character.fatigue", "scene.condition"],
```

每个 definition 都用 `presets: [default]`（包括 `perception.md`、`medicine.md`、`first_aid.md` 等），这 3 个 key 自动进入 allowedOutputKeys。于是 resolver 即使知道 first_aid 允许 character.hp，也总能选择输出"安全兜底"3 件套来满足 schema 校验（schema pass=47/47）。

**根因 B：Skill check fail 时的叙事倾向**

上表 10 个 case 里 **9 个是 skill status = fail**（包括 forcedSkillStatus 的 Group C）。结合 `perception.md` 的 `## On Failure` 段落：

> "The actor finds nothing useful during their search. … On a partial failure, the actor may spend meaningful time searching without result — **apply character.fatigue** if the search was physically demanding or time-consuming."

definition 自己的 On Failure 段直接引导 LLM "**fail → 写 memory.event 记录'找不到'，加 fatigue**"。这是设计意图，但它意味着：**fail 分支几乎永远不会触发 character.hp / character.condition / memory.information** —— 对于 first_aid/medicine/psychology 这种技能，fail 时输出"什么也没发生" 是合理的叙事，但诊断脚本的 Group B fixture 期望 key 恰恰就是 character.hp / condition / information。

**根因 C：definition On Success 指令强度不足**

对比 `first_aid.md` 和 `action.md` 的 On Success：

- `first_aid.md` On Success (regular)：`"The target recovers 1 HP and the 'bleeding' condition is removed if present"` —— 明确数值 + 明确状态
- `action.md` On Success：极长的 narrative，列出 character.fatigue、memory.event/information 的使用场景 —— 对 character.hp/condition 没有专门引导

当 interpreter 错选成 action（比如 `medical_first_aid_bleeding`）时，resolver 读到 action.md 的 guidance，自然不会输出 character.hp —— action.md 压根没建议什么时候用它。

### 修复方向

- **短期**：在 `default` preset 里去掉 `character.fatigue`（挪到每个确实需要它的 definition 自己的 `use`），让 resolver 不能再"免费"输出 fatigue。预期影响：fatigue 出现频率会被逼迫地回到 definition.use 显式允许的地方
- **中期**：修改 `src/engine/resolver/stateResolver.ts` 的 prompt，在 fail 分支明确 "即使技能 fail，如果 definition 允许 character.hp/condition/memory.information 等特定 key，并且叙事暗示该 key 发生了变化，应当输出；不要因为 fail 就只写 memory.event"
- **长期**：考虑引入"output key 必需性"标注，比如 first_aid 的 On Success regular 标注 `require: [character.hp]`，让 resolver 显式检查"如果 skill 成功了但没输出必需 key，prompt 应增强引导"

---

## 问题 3：伞形 definition 盖过专门技能

### 症状

3 个极端 case，interpreter 不是选错相似技能，而是**换域**：

| case id | actionText | 期望 definition | 实际 definition |
|---|---|---|---|
| combat_brawling_fight | 揪住海伦按在桌上不让她走 | brawling | character_interaction |
| medical_first_aid_bleeding | 撕下衣角给布鲁诺绑紧伤口止血 | first_aid | action |
| key_character_condition_medicine | 给发烧的海伦喂退烧药 | medicine | item_exchange |

再加上问题 1 里有些 case（social_persuade_let_through → conversation、academic_psychoanalysis_calm → conversation）也是伞形吞掉专门技能 —— 合计约 6 个 case 属此类。

### 根因分析

查 3 个伞形 definition：

**`character_interaction.md`**:
- description：`"Interact with one or more characters — conversation, persuasion, intimidation, physical combat, item exchange, leading/escorting, or forcing someone to leave."`
- examples 含 `"Attack the cultist with my fists"` —— **直接和 brawling 的语义重叠**

**`action.md`**:
- description：`"…self-directed behavior, environmental interaction, basic item use or manipulation, searching, resting, listening, barricading, hiding in place."`
- examples 含 `"Search the study carefully for signs that someone opened the desk"`、`"Listen at the door"` —— **直接和 perception、listen 的语义重叠**
- description 还包括 `"basic item use or manipulation"` —— 会吸附 first_aid 的"用绷带"

**`item_exchange.md`**（未读但从 `key_character_condition_medicine` → item_exchange 推断）：description 大概率涉及"give/transfer/offer item"，`"喂退烧药"`动作被它套住

**根因**：3 个伞形 definition 的 description 和 interpreter.examples **本身就包含了专门技能的语义范围**，同时声明的 outputSchema.use 也很广（action.md 的 use 含 character.hp + character.condition + character.position，character_interaction.md 的 use 含 character.hp + san + condition + position + 4 种 item key），所以 LLM 选择"用伞形通吃"并没有明显的"不对"信号。

### 修复方向

- `action.md`：从 description 里删除 "searching, … listening, barricading, hiding in place"，这些都该由 perception / listen / stealth 等专门技能承担；相应地 interpreter.examples 只留真正的"点油灯/读日记/休息"这种无技能检定的常规行为
- `character_interaction.md`：删掉 "physical combat" 和 "Attack the cultist" 的例子 —— 物理攻击应该走专门武器技能（brawling/pistol/etc.）。保留非战斗性的社交/交接互动
- `gameInterpreter.ts`：prompt 里加显式优先级规则 "**If the action matches a specific skill definition (first_aid, brawling, persuade, etc.), prefer it over the umbrella definitions (action, character_interaction, item_exchange). Only fall back to umbrella when no specific skill fits.**"

---

## 问题 4：非 scene 执行位置破坏 output 生成

### 症状

Group D 的 2 个 case（`env_road_perception` / `env_junction_listen`）interpreter 选对了 definition（perception / listen），但 resolver 没产出 memory.information，只给 `[character.fatigue, memory.event]`。

### 根因分析

查 `src/engine/resolver/stateContextBuilder.ts`（本次 review 里曾指出此文件 328 行 + 零单测），grep `type === "road"` / `type === "junction"` / `roadId` / `junctionId`：

```
No matches found
```

**`buildStateContext` 对 actor 位置是 road 或 junction 的情况完全没有专门处理**。它假设 actor 在 scene 里，然后把 scene 数据（conditions / items / connections）喂给 resolver。road/junction 上下文下：

1. `dgsm.getState().currentScene` 或相关 scene 字段可能为空或不对应 actor 实际位置
2. resolver prompt 看不到周围"可观察的东西"（街道街景、路口行人…），自然没东西可写成 memory.information
3. 只能退化到"memory.event: 我在路边看了看" + "character.fatigue: +1"

这也部分解释了问题 2 里 env_* case 的出现 —— 问题 4 是问题 2 的一个特例，但根因不同（问题 2 是 resolver prompt 引导弱，问题 4 是 context 里根本没信息）。

### 修复方向

- `stateContextBuilder.ts`：添加分支处理：
  - `type === "road"`: 注入 road 两端的 scene ID、road 的环境描述（街景/自然景观）、road 上的其他角色
  - `type === "junction"`: 注入 junction 连接的所有 scene（对 listen / perception 特别有意义 —— 路口能听/看到多个方向）
- 给 `stateContextBuilder.ts` 加单测（本次 review 指出它 328 行零测试）
- fixture 一致性：考虑给 `env_*` case 加 `notes` 说明这个路径当前是已知缺口，以免将来误当成回归

---

## 假阳性 / 脚本层不是真问题

以下 mismatch 不是引擎问题：

1. **`branch_fumble_brawling`** —— interpreter 返回 `movement:0 → brawling:1`，脚本 `pickPrimaryStep` 只取第一个非 movement step 得到 brawling（primaryMatch=yes），但 `expectedSteps=["brawling"]` 比严格相等 → fullStepMatch=false。这是 LLM 在对"冲上去抱摔"之类动作时自动加了 movement 前缀，和引擎行为无关。
2. **`multi_move_then_*` 系列**（4 个）—— 同样的 LLM 额外加 movement 前缀问题。primaryMatch 都是 yes，只是 fullStepMatch 被严格匹配打穿。

**脚本层优化建议（P5 低优）**：`expectedSteps` 匹配时忽略开头的 movement step 前缀，或 fixture 定义一个新字段 `expectedStepsIgnoreMovementPrefix: true`。

---

## Group C（forcedSkillStatus）验证

- **5 级 skill status 全部覆盖** ✓（critical=1, hard=1, regular=19, fail=24, fumble=2）
- **abort 分支验证通过**：`branch_fail_abort_intimidate` 和 `branch_fumble_brawling` 的 resolver 被 runner 正确跳过（`resolver.ran=false`、`resolver.skippedReason="skill_failed_abort"`），apply 零变化
- Group C 的 6 个 case 有 2 个 mismatch（`branch_regular_research`、`branch_fail_psychology`），但都是 interpreter/resolver 的上游问题，不是 forcedSkillStatus 机制本身的问题
- **结论**：`buildForcedSkillResult` + runner 注入逻辑工作正确

---

## 新旧 fixture mismatch 率对比

| | case 数 | mismatch 数 | 占比 |
|---|---|---|---|
| 原 20 fixture（single_* / multi_*） | 20 | 9 | 45% |
| 新 27 fixture（branch_* / env_* / key_* / combat_* / social_* / medical_* / academic_* / special_*） | 27 | 18 | 67% |
| 合计 | 47 | 27 | 57% |

**观察**：
- 原 20 fixture 45% 的 mismatch 说明**一部分问题早就存在**，本次诊断只是第一次量化暴露。不是本次改动引入的回归。
- 新 27 fixture mismatch 率更高（67%）符合预期：它们是**有针对性地**选冷门 skill / 冷门 output key / 非 scene 位置，专门"查缺"。查到了 ≠ 坏事，反而是诊断脚本的价值所在。

---

## 推荐后续动作（按投资回报排序）

| 优先级 | 改动 | 影响 case 数 | 代价 |
|---|---|---|---|
| **P1** | 修 `outputSchema.ts` 的 default preset 和 resolver prompt（问题 2） | 10 | 中 — 改 prompt + 跑 47 case 回归 |
| **P2** | 收窄 `perception.md` description + examples（问题 1） | 11 | 小 — 单文件编辑 |
| **P3** | `gameInterpreter.ts` 加"优先选具体技能" 启发（问题 1+3） | 10（问题 1 一部分 + 问题 3 全部） | 小 — prompt 追加 |
| **P4** | `action.md` / `character_interaction.md` description 收窄（问题 3） | 6 | 小 — 两文件编辑 |
| **P5** | `stateContextBuilder.ts` 添加 road/junction 支持（问题 4） | 2 | 大 — 架构改动 + 单测补齐 |
| **P6** | 脚本层放宽 movement 前缀匹配（假阳性） | 5 | 极小 — 改 1 个 fixture 字段 |

理论上，P1+P2+P3+P4 做完，47 case 的 primary match rate 可望从 64% → 85%+，output key match rate 从 60% → 80%+。届时再重跑诊断确认。

---

## 验证清单

所有结论都可从 `reports/skillflow-20260416-2032.jsonl` 独立复验。常用命令：

**看总 summary**：
```bash
tail -1 reports/skillflow-20260416-2032.jsonl | python3 -m json.tool
```

**查特定 case 全记录**：
```bash
grep '"id":"key_character_hp_first_aid"' reports/skillflow-20260416-2032.jsonl | python3 -m json.tool
```

**按 mismatch 类别筛选**：
```bash
# Category A: primaryMatch=false 的 case
python3 -c 'import json; [print(r["id"], r["interpreter"]["primaryDefinitionId"], "!=", r["expectedPrimaryDefinitionId"]) for r in (json.loads(l) for l in open("reports/skillflow-20260416-2032.jsonl")) if r.get("type")=="case" and not r["interpreter"]["primaryMatch"]]'

# Category B: primary 对、outputKey 错
python3 -c 'import json; [print(r["id"], r["resolver"]["outputKeys"], "expected any of", r["expectedOutputKeysAnyOf"]) for r in (json.loads(l) for l in open("reports/skillflow-20260416-2032.jsonl")) if r.get("type")=="case" and r["interpreter"]["primaryMatch"] and r["resolver"]["ran"] and not r["resolver"]["outputKeyMatch"]]'
```

**找所有 output key=memory.event 单键结果**：
```bash
grep -c '"outputKeys":\["memory.event"\]' reports/skillflow-20260416-2032.jsonl
```

---

## 关键依据文件清单

- 原始数据：`reports/skillflow-20260416-2032.jsonl`
- 脚本：`scripts/test-game-interpreter-skill-flow.ts`
- fixture：`scripts/fixtures/gameInterpreterSkillFlowCases.ts`
- spec：`docs/superpowers/specs/2026-04-16-game-interpreter-skill-flow-harness-design.md`
- plan：`docs/superpowers/plans/2026-04-16-game-interpreter-skill-flow-harness.md`
- trace 读过的引擎源码：
  - `src/engine/outputSchema.ts`（default preset 定义）
  - `src/engine/resolver/stateContextBuilder.ts`（road/junction 处理缺失）
  - `src/engine/tool_definitions/skills/perception.md` / `track.md` / `archaeology.md` / `first_aid.md` / `medicine.md`
  - `src/engine/tool_definitions/action.md` / `character_interaction.md`（伞形 definition）
