# 卡森德拉场景描述重写 + 子场景扩充设计

## 问题

已生成的 40 个 DynamicScene JSON 文件的 description 字段存在以下问题：
1. 混入 NPC 秘密身份、背景故事（如"怀特实际上是混血深潜者"）
2. 混入线索结论（如"暗示着某种不寻常的活动"）
3. 混入游戏机制提示（如"调查员必须过检定"）
4. 混入事件内容（如"当...时会发生..."）
5. 部分大场景子场景数量不足（如五层大酒店只有1个"大厅"子场景）
6. 描述缺乏符合现实的建筑细节

## Description 规则

### 允许

- 五感描述（视觉布局、气味、声音、温度、触感）
- 公共知识（"这是镇上有名的酒吧"、"钟表全是手工制作"）
- 符合现实的建筑细节（楼层、房间、家具、陈设）
- 环境氛围（天气、光线、陈旧感）

### 禁止

- NPC 人物出现/存在（人物会自由移动，不应写死在场景描述中）
- NPC 秘密身份/背景故事
- 线索结论（"暗示着..."、"显然有人..."）
- 游戏机制（"需要过检定"、"调查员必须..."）
- 事件内容（"当...时会发生..."）

## 子场景扩充原则

- 根据建筑真实规模和功能分区拆分子场景
- 每个子场景应是一个**可独立进入和探索**的物理空间
- 扩充时参考 scene.md + Cassandra.md，补充符合 2003 年美国加州小镇的现实细节
- entry scene 始终为 `SCN_X_SUB_1`
- 单间小店/小屋不需要强行拆分，但描述需丰富
- 多层建筑/大型场所必须合理拆分

## 不变的部分

- `items`、`clues`、`conditions` 保持现有逻辑（线索信息在这些字段里）
- `events` 始终为空 `[]`
- ID 命名规则不变：`SCN_X_SUB_Y`
- `transport_network.json` 不变

## 执行方式

- 每个大场景分配 1 个 agent（共 21 个 agent）
- 每个 agent 读取 scene.md、Cassandra.md、NPC_Names.md、现有 JSON 文件
- Agent 职责：
  1. 判断是否需要新增子场景（根据建筑规模）
  2. 重写所有 description（纯感官+公共知识，无人物）
  3. 补充现实细节（建筑布局、家具陈设、环境氛围）
  4. 更新 connections
  5. 写出新的 JSON 文件
- 最后统一更新 `scenarios_outline.json` 的 `subSceneCount` 和 `entrySceneId`

## 输出

- 更新后的 `testmods/casssandra/Cassandra_Scenarios/*.json`
- 更新后的 `testmods/casssandra/scenarios_outline.json`
