# 数据库重构设计（详细版，子表方案）

> 状态：Draft v4  
> 日期：2026-02-15  
> 适用范围：CoC-AI-agent（Prisma + PostgreSQL）

## 1. 背景与目标

当前数据模型中，模组标识存在 `module_name` 与 `module_id` 并行使用的问题，权限与库关系也分散在多个表中。该方案目标是统一模组主键、明确权限边界、隔离用户游玩数据，并保证基础模组内容不可变。

## 2. 已确认决策

1. `module_id` 统一使用 `UUID`。
2. 基础模组内容不可被游玩流程修改（只读）。
3. `share=true` 仅表示“可在 Share Library 看见”。
4. 用户必须手动添加共享模组，添加后才获得权限。
5. 本次不设计模组更新/版本演进功能。

## 3. 非目标（本次不做）

1. 不引入模组版本系统（如 `module_versions`）。
2. 不改变现有业务语义（仅重构存储与关联）。
3. 不一次性重写所有历史接口（分阶段兼容迁移）。

## 4. 架构分层

1. `modules`：模组主表（标识、归属、共享状态）
2. `module_*`：模组基础内容子表（背景、场景、NPC、线索等）
3. `module_permissions`：权限关系（谁能使用）
4. `user_module_library`：库关系（用户是否已添加）
5. `users + game_*`：用户账号与游玩状态

核心原则：

1. 基础模组内容与游玩状态严格分离。
2. 所有内容读取先定位 `module_id`。
3. 权限判断不依赖展示关系，展示关系不替代权限判断。

## 5. 目标数据模型

### 5.1 模组主表 `modules`

用途：保存模组唯一标识与共享元信息。

字段建议：

- `module_id` `UUID` PK
- `module_name` `TEXT NOT NULL`
- `owner_email_id` `TEXT NOT NULL`
- `share` `BOOLEAN NOT NULL DEFAULT false`
- `status` `TEXT NOT NULL DEFAULT 'active'`
- `created_at` `TIMESTAMP NOT NULL DEFAULT now()`
- `updated_at` `TIMESTAMP NOT NULL DEFAULT now()`

索引建议：

1. `INDEX idx_modules_owner_email (owner_email_id)`
2. `INDEX idx_modules_share (share)`
3. `UNIQUE INDEX uq_modules_owner_name (owner_email_id, module_name)`（可选，防同 owner 重名）

约束：

1. `module_id` 全局唯一，不可变。
2. `owner_email_id` 必须对应有效用户。
3. `share` 只能由 owner 或系统管理流程修改。

### 5.2 模组内容子表 `module_*`

用途：保存结构化基础内容，全部外键到 `module_id`。

建议子表（可按现有域模型映射）：

1. `module_backgrounds(module_id, introduction, module_notes, tags, ...)`
2. `module_scenarios(module_id, scenario_id, name, description, connections, ...)`
3. `module_npcs(module_id, npc_id, name, profile, stats, ...)`
4. `module_clues(module_id, clue_id, clue_text, difficulty, ...)`

统一约束：

1. 每张表必须有 `module_id UUID NOT NULL`。
2. `FOREIGN KEY (module_id) REFERENCES modules(module_id) ON DELETE CASCADE`。
3. 业务查询必须显式带 `module_id` 条件。
4. 游玩接口禁止写入这些表（只允许导入/生成发布流程写入）。

索引建议：

1. 每张子表至少 `INDEX(module_id)`。
2. 高频查询字段建立组合索引，例如：
3. `module_scenarios(module_id, scenario_id)`。
4. `module_npcs(module_id, npc_id)`。

### 5.3 权限子表 `module_permissions`

用途：权限真相来源（谁可使用模组）。

字段建议：

- `module_id` `UUID NOT NULL`
- `email_id` `TEXT NOT NULL`
- `role` `TEXT NOT NULL`（`owner`/`viewer`）
- `can_play` `BOOLEAN NOT NULL DEFAULT true`
- `can_manage` `BOOLEAN NOT NULL DEFAULT false`
- `granted_at` `TIMESTAMP NOT NULL DEFAULT now()`

主键与索引：

1. `PRIMARY KEY (module_id, email_id)`
2. `INDEX idx_module_permissions_email (email_id)`

约束：

1. 创建模组时自动插入 owner 权限：`role=owner, can_manage=true`。
2. 普通“添加共享模组”仅授予 `viewer`。
3. 权限校验必须查本表，不得查展示表替代。

### 5.4 用户模组库关系表 `user_module_library`

用途：记录用户“已添加到我的库”的模组。

字段建议：

- `email_id` `TEXT NOT NULL`
- `module_id` `UUID NOT NULL`
- `source` `TEXT NOT NULL`（`owned`/`shared_added`）
- `added_at` `TIMESTAMP NOT NULL DEFAULT now()`

主键与索引：

1. `PRIMARY KEY (email_id, module_id)`
2. `INDEX idx_user_module_library_module (module_id)`

约束：

1. 该表只代表“已加入我的库”，不代表拥有管理权限。
2. 若存在此记录，通常应存在对应 `module_permissions`（至少 `viewer`）。

### 5.5 用户与游玩数据表 `users + game_*`

用途：用户账号与可变游玩状态。

示例：

1. `users(email_id PK, password_hash, username, role, is_active, created_at, updated_at)`
2. `sessions(session_id PK, email_id, module_id, created_at, ...)`
3. `game_turns(turn_id PK, session_id, email_id, module_id, turn_number, ...)`
4. `game_checkpoints(checkpoint_id PK, session_id, email_id, module_id, game_state, ...)`
5. `player_profiles(character_id PK, email_id, module_id, profile, ...)`

统一原则：

1. 游玩数据必须可按 `email_id + module_id` 追踪。
2. 游玩数据可更新、可删除、可归档。
3. 游玩数据更新不允许回写 `module_*`。

## 6. 权限与共享规则

### 6.1 规则定义

1. 模组创建者：`module_permissions.role=owner`。
2. `share=false`：仅已有权限用户可见/可用。
3. `share=true`：仅在 Share Library 可见，不自动授权。
4. 用户手动添加后才写入 viewer 权限并加入个人库。

### 6.2 Share Library 手动添加流程

1. 用户在 Share Library 看到 `share=true` 模组。
2. 用户点击“添加到我的模组库”。
3. 事务内执行：
4. `UPSERT user_module_library(email_id, module_id, source='shared_added')`
5. `UPSERT module_permissions(module_id, email_id, role='viewer', can_play=true, can_manage=false)`
6. 不修改任何 `module_*` 基础内容子表。

### 6.3 权限检查顺序（服务端）

1. 先确认 `module_id` 存在且未归档。
2. 再确认 `(module_id, email_id)` 在 `module_permissions` 存在并具备所需能力。
3. 最后执行业务逻辑。

## 7. 基础模组不可变策略

### 7.1 应用层策略

1. 所有游玩相关 API 禁止调用 `module_*` 写操作。
2. 仅导入/生成发布流程可写 `module_*`。

### 7.2 数据层策略（推荐）

1. 在 `module_*` 上增加触发器，阻止非白名单角色 `UPDATE/DELETE`。
2. 或通过数据库角色权限控制，游玩服务账号只授予 `SELECT`。

### 7.3 审计策略（推荐）

1. 记录每次 `module_*` 写操作的操作者、来源流程、时间。
2. 若发现游玩流程触发写操作，直接告警。

## 8. 迁移方案（分阶段）

### Phase 1：并行建模（不破坏现网）

1. 新增 `modules`（若已有同名表则补字段与约束）。
2. 新增 `module_permissions`、`user_module_library`。
3. 给现有 `module_*` 表补齐 `module_id` 外键与索引。

### Phase 2：数据回填

1. 从现有 `mod_catalog` 迁移到 `modules`。
2. 从 `user_mods` 迁移到 `user_module_library`。
3. 根据 owner 与 user_mods 回填 `module_permissions`。
4. 将按 `module_name` 关联的数据映射为 `module_id`。

### Phase 3：读路径切换

1. 接口入参改为 `module_id` 优先（暂兼容 `module_name`）。
2. 查询统一由 `module_id` 驱动。
3. 权限校验统一查 `module_permissions`。

### Phase 4：写路径收口

1. 游玩流程禁止写 `module_*`。
2. 仅保留导入/发布流程写 `module_*`。
3. 对旧写路径下线或改造。

### Phase 5：清理与收敛

1. 移除 `module_name` 驱动的旧关联逻辑。
2. 下线临时兼容代码与重复字段。
3. 保留只读兼容视图（如有历史查询需求）。

## 9. 与当前项目映射建议

当前已有（from `prisma/schema.prisma`）：

1. `module_backgrounds(module_id, email_id, ...)`
2. `mod_catalog(module_name, owner_email, shared, ...)`
3. `user_mods(email_id, module_name, ...)`
4. 多个游玩相关表已有 `email_id` 字段。

落地建议：

1. 先补 `modules` 并建立 `module_id <-> module_name` 映射。
2. 新增 `module_permissions` 作为唯一权限来源。
3. `shared` 语义迁移到 `modules.share`。
4. `user_mods` 迁移为 `user_module_library`。
5. 历史业务先兼容 `module_name` 入参，内部转 `module_id`。

## 10. 验收标准

1. 所有模组内容读取 API 均可仅凭 `module_id` 查询。
2. 用户无 `module_permissions` 时无法进入模组游玩流程。
3. `share=true` 但未“手动添加”的用户无法直接游玩。
4. 游玩流程对 `module_*` 的写操作为 0。
5. 历史模组与用户库数据迁移后抽样一致率 100%。

## 11. 风险与缓解

1. 风险：`module_name` 到 `module_id` 映射歧义。  
缓解：迁移前先做重名扫描，必要时 owner 维度去重。
2. 风险：旧接口仍按 `module_name` 写入。  
缓解：服务层统一封装解析器，逐步禁用旧入口。
3. 风险：权限与库关系不一致。  
缓解：新增巡检任务，校验 `user_module_library` 与 `module_permissions` 对齐。

