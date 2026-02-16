# 模组生成链路对齐场景转换机制的优化方案

## 1. 目标与范围

本文基于当前代码实现，对以下两条链路做对比并提出可落地优化：

1. 模组生成链路（重点：NPC 生成、场景生成）
2. 场景转换链路（Director 的 Scene Switch）

目标是回答：是否可以把“场景转换”里已经验证有效的生成范式迁移到模组生成，并给出实施方案。

---

## 2. 当前实现检查结果

### 2.1 模组生成主流程（World Builder）

入口：`src/dynamicworldagent/world_builder/worldBuilderService.ts`

当前顺序：

1. MacroScene（世界骨架）
2. ScenarioBuilder（场景纲要）
3. NPCBuilder（NPC 批量）
4. Starting Scene Snapshot（起始场景快照 + 其他场景 NPC 分配）
5. ModuleDigest（模组摘要）
6. 持久化 JSON + DB

关键特点：

1. 已有阶段化流程，但每一阶段大多是“一次生成 + 基础解析/告警”，缺少系统化修复回路。
2. 生成质量保障主要依赖 Prompt 约束和日志告警，不是强一致“校验-修复-再校验”。

### 2.2 NPC 生成现状

实现：`src/dynamicworldagent/world_builder/npcBuilderAgent.ts`  
模板：`src/dynamicworldagent/world_builder/npcBuilderTemplate.ts`

当前设计：

1. Step 1a：从知识持有者实例化 NPC 基础信息
2. Step 1b：生成 goals/secrets/relationships/mythosAwareness
3. Step 2：属性骰点（程序化）
4. Step 3：技能分配（程序化）
5. Step 4：身份、物品、线索（LLM）

优点：

1. “叙事字段 + 数值字段”分离，数值部分可控。
2. 已引入知识矩阵约束，避免纯自由发挥。
3. 并发处理（worker）提高吞吐。

主要问题：

1. Step1 和 Step2 通过“数组顺序”合并，顺序漂移会导致错配。
2. 对 relationships、clues、relatedTo 的结构合法性校验不足，多为解析失败才报错。
3. 缺少“校验失败后的定向修复生成”，通常是整步失败而非局部修复。

### 2.3 场景生成现状

实现：`src/dynamicworldagent/world_builder/scenarioBuilderAgent.ts`  
模板：`src/dynamicworldagent/world_builder/scenarioBuilderTemplate.ts`

当前设计：

1. Scenario outlines 一次生成
2. 生成后做覆盖率和连通性检查（告警为主）
3. 起始场景快照单独一次生成，并做部分 fallback（如默认首场景）

优点：

1. 已有不少后处理检查（PLACE 覆盖、连接合法性、NPC 是否被分配等）。
2. 起始场景阶段具备一定“兜底”能力（缺字段时补默认值）。

主要问题：

1. 发现问题后多数只 `warn`，不自动修复。
2. 连接与命名仍强依赖 LLM 输出文本一致性，ID 对齐策略不够强。
3. 与 NPC、知识矩阵的一致性验证不完整（例如 clues 到 truth/event 的强约束）。

---

## 3. 场景转换（Scene Switch）机制可借鉴点

核心实现：`src/dynamicworldagent/dynamicBasicAgent/director/directorAgent.ts`  
模板：`src/dynamicworldagent/dynamicBasicAgent/director/sceneSwitchFlowTemplates.ts`

该链路的关键工程特征：

1. 明确三阶段（Phase 1/2/3）分工，不让单次调用承担全部责任。
2. 每阶段有结构化输出 schema，并在代码侧做解析与清洗（`parseModelJson` + sanitize 逻辑）。
3. 只在满足窗口与时序约束时合并数据（如 actionLog 时间窗过滤、增量合并）。
4. 数据写回前有二次规范化与守卫（连接更新、角色定位、fallback 字段补齐）。
5. 失败有 provider fallback（例如切换 OpenAI 重试），稳定性高于一次性生成。

结论：该机制不是“Prompt 更长”，而是“多阶段 + 可验证 + 可恢复”的工程化生成模式。

---

## 4. 对模组生成的可迁移优化（建议）

结论：可以，且建议以“场景转换同款范式”升级模组生成链路。

### 4.1 总体方案：从一次性生成改为“生成-校验-修复”闭环

建议把 NPC/场景生成改造成以下统一模式：

1. Phase A 生成：产出结构化草稿
2. Phase B 程序校验：输出 violation 列表（可机器处理）
3. Phase C 定向修复：只修复 violation，不重写全量内容
4. Phase D 最终规范化：ID 对齐、默认值填补、去重、排序

### 4.2 场景生成优化（优先级 P0）

建议新增 `ScenarioGenerationValidator`，检查并可自动修复：

1. PLACE 覆盖完整性（缺失则自动补场景骨架）
2. 连接图可达性（断联时自动补最小连接边）
3. `sourcePlaceId/sourcePlaceName` 双向一致
4. clues 与 evidence 对齐（缺 clue 自动补基础 clue）
5. 场景命名冲突与 ID 冲突处理

并增加“修复模板”而非重跑主模板：

1. 输入：原始 scenarios + violation 列表 + 不可变字段约束
2. 输出：仅修复项（patch）

### 4.3 NPC 生成优化（优先级 P0）

建议新增 `NPCGenerationValidator`，并改合并策略：

1. Step1/Step2 改为按 `name + instantiatedFrom` 或显式 `draftId` 对齐，不再按 index。
2. 关系 target 必须能映射到已存在 NPC（不可映射则标记并修复）。
3. `relatedTo` 必须落在 `inheritsKnowledge` 或 holder 可知集合中。
4. inventory/clues/status 字段做结构规范化（空值补齐、非法值回退）。

并增加局部重试策略：

1. 仅对失败 NPC 重试，不重跑全部 NPC。
2. 每个 NPC 限定最大修复轮次，超过则降级为“最小可用配置”。

### 4.4 跨实体一致性阶段（新增 P1）

在 `ScenarioBuilder + NPCBuilder + StartingScene` 之后增加 `Consistency Pass`：

1. NPC 分布一致性：每个 NPC 必须且仅在一个场景起始状态可定位。
2. 线索闭环：scenario clues、npc clues 与 truth timeline 引用可追溯。
3. 场景连接一致性：连接目标必须能映射到 scenarioId。
4. 起始快照合法性：角色/线索/条件字段完整且可落库。

输出形式：

1. `consistencyReport`（机器可读）
2. `autoFixPatch`（可选）
3. `finalQualityScore`

### 4.5 运行稳定性增强（P1）

借鉴 Director：

1. 统一 `parseModelJson` 与 sanitize 工具到 world_builder 公共层。
2. 增加 provider fallback（模型失败时切备用 provider）。
3. 增加原始响应日志标签化，便于离线回放与评估。

---

## 5. 建议的代码落点

建议新增/改造如下文件：

1. `src/dynamicworldagent/world_builder/validators/scenarioGenerationValidator.ts`
2. `src/dynamicworldagent/world_builder/validators/npcGenerationValidator.ts`
3. `src/dynamicworldagent/world_builder/validators/moduleConsistencyValidator.ts`
4. `src/dynamicworldagent/world_builder/repair/scenarioRepairTemplate.ts`
5. `src/dynamicworldagent/world_builder/repair/npcRepairTemplate.ts`
6. `src/dynamicworldagent/world_builder/utils/modelJson.ts`（抽取解析与清洗）
7. `src/dynamicworldagent/world_builder/scenarioBuilderAgent.ts`（接入 validate/repair）
8. `src/dynamicworldagent/world_builder/npcBuilderAgent.ts`（改 key-based merge + 局部重试）
9. `src/dynamicworldagent/world_builder/worldBuilderService.ts`（编排新阶段）

---

## 6. 分阶段实施计划

### Iteration 1（低风险高收益）

1. 场景与 NPC 增加程序化 validator（先不做 LLM repair）。
2. 将 warn 升级为“可统计错误码”。
3. 在服务返回中附带 `generationQualityReport`。

验收标准：

1. PLACE 覆盖率 100%
2. 场景连接可达率 100%
3. NPC 关系 target 可映射率 > 95%

### Iteration 2（引入修复回路）

1. 接入 scenario/npc repair prompts。
2. 只修复失败项，保留已通过项。
3. 引入局部重试上限与降级策略。

验收标准：

1. 结构化解析失败率明显下降
2. 生成成功率和稳定性提升
3. 平均重试轮次可控

### Iteration 3（全链路一致性）

1. 新增 consistency pass。
2. 统一质量评分与日志指标。
3. 支持回放与回归测试样例集。

---

## 7. 风险与注意事项

1. 生成成本会上升：多阶段会增加 token 与时延，需要通过“局部修复”控制成本。
2. 修复阶段不能放开创作自由度：必须限制为 patch 模式，避免重写造成漂移。
3. 强约束字段要先定义清楚：哪些可改、哪些不可改（如 ID、sourcePlaceId 等）。

---

## 8. 结论

可以用“场景转换”的方式优化模组生成，而且建议尽快做。

推荐优先落地：

1. 先把 NPC/场景改为“可验证、可修复”的阶段化闭环（P0）
2. 再补上跨实体一致性阶段（P1）

这会显著提升模组生成的稳定性、可调试性与长期可维护性，并减少目前“有 warning 但继续写入”的隐性质量风险。
