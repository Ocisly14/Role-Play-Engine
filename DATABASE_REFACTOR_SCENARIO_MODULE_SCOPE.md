# 数据库重构说明（Scenario 模块归属 + 游玩态隔离）

状态：Draft v1  
日期：2026-02-15  
目标：明确“模组基础内容”与“用户游玩态数据”的边界，并作为下一步代码与迁移实施依据。

---

## 1. 已确认目标

1. `scenario / scenario_snapshot / scenario_character / scenario_clue / scenario_condition` 归入**模组基础内容层**，按 `module_id` 归属，不再使用 `email_id` 作为归属键。  
2. `sessions / game_turns / game_checkpoints / player_memos` 归入**用户游玩态层**，保留 `email_id`，并带 `module_id`、`session_id`。  
3. 模组可见性与可用关系，继续通过：
   - `module_permissions(module_id, email_id, role, ...)`
   - `user_module_library(email_id, module_id, source, ...)`

---

## 2. 分层原则

### 2.1 基础内容层（只读基线）

- 表：`modules`、`module_backgrounds`、`scenario*`（场景及其子表）
- 主归属：`module_id`
- 约束：基础内容不应被游玩过程直接改写（仅通过模组创建/导入流程写入）

### 2.2 游玩态层（可变运行态）

- 表：`sessions`、`game_turns`、`game_checkpoints`、`player_memos` 等
- 主归属：`email_id`（用户域）+ `module_id`（模组域）+ `session_id`（会话域）
- 约束：所有运行时变化只写入游玩态层，不回写 `scenario*` 基础表

### 2.3 权限层

- 表：`module_permissions`、`user_module_library`
- 语义：
  - 谁有权限（owner/viewer）
  - 用户“已加入库”的产品状态

---

## 3. 目标模型（概念）

## 3.1 模组基础场景表（Scenario 主表）

- `scenario_id`（场景标识）
- `module_id`（FK -> `modules.module_id`）
- `name`、`description`、`tags`、`connections`、`metadata` ...

说明：
- `module_id` 是归属来源；
- `email_id` 不再作为基础内容归属字段。

## 3.2 场景子表

- `scenario_snapshots`：`snapshot_id`、`scenario_id`、`module_id`、...
- `scenario_characters`：`id`、`snapshot_id`、`module_id`、...
- `scenario_clues`：`clue_id`、`snapshot_id`、`module_id`、...
- `scenario_conditions`：`condition_id`、`snapshot_id`、`module_id`、...

说明：
- 子表同样以 `module_id` 归属；
- 不再依赖 `email_id` 做隔离。

## 3.3 游玩态表

- `sessions(session_id, module_id, email_id, ...)`
- `game_turns(turn_id, session_id, module_id, email_id, ...)`
- `game_checkpoints(checkpoint_id, session_id, module_id, email_id, game_state, ...)`
- `player_memos(memo_id, session_id, module_id, email_id, ...)`（建议补齐 `module_id`）

---

## 4. 读写规则

1. 基础场景读取：按 `module_id` 读取 `scenario*`。  
2. 游玩状态读取：按 `email_id + session_id`（必要时叠加 `module_id`）。  
3. 创建模组：写入 `modules` + `module_permissions(owner)` + `user_module_library(owned)`。  
4. 添加共享模组：写入 `module_permissions(viewer)` + `user_module_library(shared_added)`。  
5. 游玩进程写入 `game_turns/game_checkpoints/player_memos`，不改 `scenario*` 基线。

---

## 5. Scene ID 说明

当前出现 `email::SCN_1` 的原因是历史“用户作用域前缀”策略（防冲突）。  
目标架构下，归属应由 `module_id` 表达，而非 `email` 前缀表达。

实施建议：

1. 先完成 `scenario*` 的 `module_id` 归属改造；  
2. 再逐步去掉 `email` 前缀依赖（包括写入、查询、日志展示、模板注入）；  
3. 迁移期间允许兼容读取历史前缀 ID，避免旧存档失效。

---

## 6. 迁移计划（建议执行顺序）

### Phase A：Schema 变更

1. `scenario*` 增加 `module_id`（FK + 索引）。  
2. `player_memos` 增加 `module_id`（若尚未存在）。  
3. 逐步移除 `scenario*` 的 `email_id` 读写依赖（先代码，再视情况物理删列）。

### Phase B：数据回填

1. 按已有关系回填 `scenario*`.`module_id`。  
2. 按 `session_id` 回填 `player_memos`.`module_id`。  
3. 产出回填校验（NULL 数、孤儿 FK、重复关系、跨模块污染）。

### Phase C：代码路径切换

1. 所有 `scenario*` 查询改为 `module_id` 过滤。  
2. 所有 `scenario*` 写入改为携带 `module_id`。  
3. 去除 `scenario*` 中 `email_id` 条件分支。  
4. 游玩链路统一从 session/module 上下文传递 `module_id`。

### Phase D：收口与清理

1. 清理旧兼容逻辑（必要时保留只读回退窗口）。  
2. 更新校验脚本与部署文档。  
3. 验证共享模组添加/移除/恢复与游玩存档链路。

---

## 7. 验收标准

1. `scenario*` 基础表不再依赖 `email_id` 进行归属与查询。  
2. 任意用户游玩同一模组时，读取同一份基础场景基线。  
3. 用户游玩差异仅体现在 `sessions/game_turns/game_checkpoints/player_memos`。  
4. `module_permissions + user_module_library` 能准确回答“用户可用模组列表”。  
5. 迁移验证脚本输出 `FAIL=0`，历史数据仅允许可解释的 `WARN`。

---

## 8. 风险与兼容

1. 历史数据可能存在 `module_id` 缺失，需要一次性 backfill。  
2. 若旧逻辑仍按 `email_id` 查 `scenario*`，会产生“读不到场景”的回归风险。  
3. 去掉 `email` 前缀前，需要确认跨模组 ID 冲突策略（主键/唯一键/组合键）已明确。

---

## 9. 本文档结论

本次重构的核心不是“把所有数据都放到 email 下面”，而是：

- **基础内容**归 `module_id`；
- **游玩状态**归 `email_id + session_id`（并带 `module_id`）；
- **权限可见性**归 `module_permissions/user_module_library`。

这三层分开后，数据边界会稳定，后续扩展共享、存档、恢复和统计都会更清晰。
