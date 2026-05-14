# Game Interpreter Skill Flow Harness — 完善设计

**日期**: 2026-04-16
**目标脚本**: `scripts/test-game-interpreter-skill-flow.ts`
**定位**: 诊断/报告工具（非 CI 守门）

## 背景

现有 `test-game-interpreter-skill-flow.ts` 跑完整链路 `interpretAction → skillCheck → resolveState → applyStateResolution`，用 20 个 fixture 过一遍 `Cassandra_zh` 模块。主要问题：

- 覆盖面薄：只覆盖 10 个 definition、7 个 output key；character.hp / character.san / character.position / item.move / item.destroy / memory.witness 完全没被触发
- skill check 分支靠随机掷骰，critical / extreme / fumble / failed+abort 不可控
- 执行位置硬编码为 scene；junction / road 未覆盖
- 长耗时（47 case × 2 次 LLM）中途崩溃会丢掉全部进度

此次完善仅扩大覆盖面 + 加中断恢复，不改变"诊断工具"定位（不加 CI 退出码逻辑、不替换真实 LLM）。

## 范围

### 覆盖面扩展（新增 ~27 case，共计 ~47）

| 组 | 用途 | 数量 |
|---|---|---|
| A | 技能类别代表性 | 12 |
| B | 冷门 output key 专项 | 7 |
| C | skill check 分支锁定（用 `forcedSkillStatus`） | 6 |
| D | 非 scene 执行位置 | 2 |

### 中断恢复

JSONL append 模式。`--report <path>` 指定的文件既是进度文件也是最终报告。

## 详细设计

### Group A — 技能类别代表性（12 case）

按 tabletop horror RPG skill 类别挑选，确保每类至少 2 个代表。不强求全 40 个技能全覆盖。

| ID | 类别 | skill / definition | 说明 |
|---|---|---|---|
| combat_brawling_fight | 战斗 | brawling | 对抗 NPC 肉搏 |
| combat_firearms_handgun | 战斗 | firearms | 开枪命中 |
| social_persuade_npc | 社交 | persuade | 说服让路 |
| social_intimidate_npc | 社交 | intimidate | 威胁逼供 |
| social_fast_talk_lie | 社交 | fast_talk | 谎报身份 |
| medical_first_aid_wound | 医疗 | first_aid | 现场止血 |
| medical_medicine_diagnose | 医疗 | medicine | 诊断病症 |
| medical_psychology_read | 医疗 | psychology | 观察心理 |
| academic_library_use_research | 学术 | library_use | 图书馆查线索 |
| academic_psychoanalysis_treat | 学术 | psychoanalysis | 心理疗愈（恢复 san） |
| academic_spot_hidden_trap | 学术 | spot_hidden | 发现隐蔽物 |
| special_track_footprint | 特殊 | track | 追踪足迹 |

### Group B — output key 专项（7 case）

每个 case 选一个最容易触发该 output key 的 definition + actionText。注意这里的"触发"不保证 100%——LLM 可能返回别的 key，但 `expectedOutputKeysAnyOf` 用来校验期望。

| ID | 期望 output key | definition | actionText 思路 |
|---|---|---|---|
| key_character_hp_first_aid | character.hp | first_aid | 给受伤 NPC 止血，期望 hp 上升 |
| key_character_san_occult | character.san | occult | 研究扭曲蛛网，期望 san 下降 |
| key_character_condition_medicine | character.condition | medicine | 给发烧的 NPC 下药，condition 移除 |
| key_character_position_stealth | character.position | stealth | 潜行从大厅到走廊，position 改变 |
| key_item_move_pickup | item.move | action | 捡起柜台上的登记簿揣进口袋 |
| key_item_destroy_brawling | item.destroy | brawling | 打碎桌椅阻挡追击 |
| key_memory_witness_spotting | memory.witness | spot_hidden | 远距离瞥见另一 NPC 的可疑行为 |

### Group C — skill check 分支锁定（6 case）

用新字段 `forcedSkillStatus` 跳过真实掷骰，直接合成 ToolResult。SuccessLevel 真实类型只有 5 级：`critical / hard / regular / fail / fumble`。再加一个 `fail + failBehavior=abort` 组合验证 abort 路径。

| ID | forcedSkillStatus | definition | 说明 |
|---|---|---|---|
| branch_critical_perception | critical | perception | 大成功路径 |
| branch_hard_locksmith | hard | locksmith | 困难成功 |
| branch_regular_research | regular | research | 普通成功 |
| branch_fail_psychology | fail | psychology | 普通失败（`psychology.md` 的 failBehavior=partial，不 abort） |
| branch_fail_abort_intimidate | fail | intimidate | 失败+abort：`intimidate.md` 里 failBehavior=abort，验证 resolver 被跳过、apply 零变化 |
| branch_fumble_brawling | fumble | brawling | 大失败（brawling 也是 abort，叠加 fumble） |

已验证 `failBehavior: abort` 的 definition 包括：intimidate / charm / brawling / sword / bow / submachine_gun。

### Group D — 非 scene 执行位置（2 case）

真实 `CharacterPosition` 类型（`src/state/topologyTypes.ts:54`）：
- `{ type: "scene"; sceneId: string }`
- `{ type: "road"; roadId: string; position: number }` — position 为 0–1 的百分比
- `{ type: "junction"; junctionId: string }`

| ID | executionLocation | actionText 思路 |
|---|---|---|
| env_road_perception | `{ type: "road", roadId: "ROAD_1", position: 0.5 }` | 行走途中观察街景 |
| env_junction_listen | `{ type: "junction", junctionId: "<从 topology 里挑一个>" }` | 在路口偷听 |

junction id 需要在实现阶段从 `Cassandra_zh` 的 topology 里找（`DynamicGameState.townTopology.junctions`）。如果 Cassandra_zh 没有 junction，降级为两个 road case。

## 代码改动

### `scripts/fixtures/gameInterpreterSkillFlowCases.ts`

接口新增两个可选字段：

```ts
export interface GameInterpreterSkillFlowCase {
  // ... 现有字段 ...
  forcedSkillStatus?: "critical" | "hard" | "regular" | "fail" | "fumble";
  executionLocation?:
    | { type: "scene"; sceneId: string }
    | { type: "road"; roadId: string; position: number }
    | { type: "junction"; junctionId: string };
}
```

按 Group A/B/C/D 分节注释组织文件（仍保持单文件）。

### `scripts/test-game-interpreter-skill-flow.ts`

**CLI 参数**：
- `--fresh` 忽略已有 report，强制从头跑
- `--resume` 显式指定 session id（一般不需要——默认读 `--report` 指向的文件）

**`stageCaseState` 扩展**：识别 `executionLocation`，按类型调用 `dgsm.setCharacterPosition`。road/junction 需要传对应 position 结构。

**`runCase` 扩展**：`executeSkillCheck` 之后，如果 fixture 有 `forcedSkillStatus`，调本地 `buildForcedSkillResult(status, skill)` 合成一个 SkillCheckResult 覆盖 `skillResult`，保留真实 rollDetail 供对比（但标记 `forced: true`）。

**`buildForcedSkillResult`**（脚本内函数，不进 src）：
```ts
function buildForcedSkillResult(
  status: NonNullable<GameInterpreterSkillFlowCase["forcedSkillStatus"]>,
  skill: string | undefined
): ToolResult {
  // SuccessLevel real values: "critical" | "hard" | "regular" | "fail" | "fumble"
  // ToolResult.status: "completed" | "failed" | "interrupted"
  const mapping: Record<typeof status, { status: "completed" | "failed"; successLevel: SuccessLevel }> = {
    critical: { status: "completed", successLevel: "critical" },
    hard:     { status: "completed", successLevel: "hard" },
    regular:  { status: "completed", successLevel: "regular" },
    fail:     { status: "failed",    successLevel: "fail" },
    fumble:   { status: "failed",    successLevel: "fumble" },
  };
  const m = mapping[status];
  return {
    done: true,
    status: m.status,
    outcomeDescription: `Forced ${status} for diagnostic`,
    successLevel: m.successLevel,
    rollDetail: `forced:${status}`,
  };
}
```

**checkpoint writer / loader**（脚本内，模块级 helper）：

```ts
// 文件格式（JSONL，每行一个 JSON 对象）：
// line 1: { type: "header", sessionId, moduleName, language, provider, startedAt, totalCases, caseIds }
// line 2..N+1: { type: "case", ...CaseExecutionResult }
// line N+2 (仅在全部完成时): { type: "summary", ...summary, finishedAt }

interface CheckpointState {
  header: HeaderRecord;
  completedCaseIds: Set<string>;
  results: CaseExecutionResult[];
  isComplete: boolean;
}

function loadCheckpoint(filePath: string): CheckpointState | null;
function appendCheckpointLine(filePath: string, record: unknown): void;
```

启动流程：
1. 解析 CLI。如果有 `--report <path>` 且文件存在且非 `--fresh`：
   - 读 JSONL
   - 如果最后一行 `type === "summary"` → 打印"该 session 已完成；加 --fresh 重跑"，退出
   - 否则 → 收集 `completedCaseIds`，过滤 `selectedCases` 到未完成的，打印 `resuming <sessionId>, X/Y done`
2. 如果文件不存在或 `--fresh`：覆盖写入 header
3. 每跑完一个 case 立刻 `appendCheckpointLine({ type: "case", ... })`
4. 全部跑完 append `{ type: "summary", ... }`

### 报告增强

`buildSummary` 新增字段：
```ts
{
  // 现有字段保留
  skillStatusCoverage: Record<"critical"|"hard"|"regular"|"fail"|"fumble", number>,
  executionLocationCoverage: { scene, road, junction },
  uncoveredSkillStatuses: SuccessLevel[],                // 一个都没命中的 level
  uncoveredOutputKeys: string[],                         // 预期 key 列表 vs 实际 key
  expectedVsActual: {
    primaryMatchRate: number,
    outputKeyMatchRate: number,
    missingCases: string[],
  }
}
```

`printSummary` 尾部新增：
```
Coverage Matrix
- Skill status: critical=2, hard=3, regular=8, fail=4, fumble=1
- Execution location: scene=40, road=2, junction=2
- Uncovered skill statuses: (none)
- Uncovered output keys: character.position
- Primary match rate: 85% | Output key match rate: 89%
- Mismatch cases: case_id_1, case_id_2
```

## 不在范围内

- CI 退出码/阈值：保持诊断定位，case 级失败不让脚本非零退出
- mock LLM：保留真实调用
- en 模块（simple_town）：本次不做
- LLM 稳定性采样（同 case 多跑）：本次不做
- 拆 fixture 文件：保持单文件分节

## 风险 / 注意

- **`forcedSkillStatus` 跳过真实 `executeSkillCheck`**：意味着 `executeSkillCheck` 本身的逻辑不被这个脚本验证（对抗 check、penalty 叠加等）。这是已知代价，由后续 `skillCheckTool` 的单元测试补上——不在本 spec 范围内
- **junction id 可能在 Cassandra_zh 里找不到**：实现时需要先探查，找不到降级为两个 road case
- **`fixture 的 forcedSkillStatus` 和 definition 的 `failBehavior`**：某些 definition 没有 `failBehavior: "abort"`，Group C 里的 `branch_failed_abort_occult` 要挑一个有 abort 的 definition；实现时需要扫 `tool_definitions/*.md` 确认
- **JSONL 中途损坏**：极小概率；读 checkpoint 时忽略最后一行解析失败的数据（当作没跑完），从损坏处重跑
