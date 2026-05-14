# Planning Simplification & Skill Definition System

## Problem

当前 NPC Planning LLM 输出结构化字段（type, skill, difficulty, objectInteractionPayload），但这些都是引擎层的概念：
- `type` — GameInterpreter 已经在 tickProcessor 里重新分类，Planning 的输出被覆盖
- `skill` — 应该由 definition 决定，不需要 LLM 知道技能系统
- `difficulty` — 完全没用过，来自 ActionDefinition 而非 PlanNode

同时，现有 6 个通用 definition（action, character_interaction, item_modify 等）的 guidanceBody 过于泛化，StateResolver 无法给出精确的 state delta。比如 "撬锁" 和 "搜索房间" 都走 `action.md` 的同一套规则。

## Design

### 1. Skill Definition 体系

将每个 tabletop horror RPG skill 写成独立的 definition `.md` 文件，放在 `tool_definitions/skills/` 子目录。加上通用 definition，总共约 72 个文件。

#### 目录结构

```
tool_definitions/
  # 通用 definition（不需要 skill check）
  action.md                  — 通用无技能动作（休息、等待、观察）
  conversation.md            — 普通对话（无对抗）
  item_exchange.md           — 物品交换/给予
  movement.md                — 移动（不变，纯代码处理）
  item_modify.md             — 物品操作（检查、使用、捡起）
  item_assemble.md           — 物品组合
  item_disassemble.md        — 物品拆解

  # Skill definition（需要 skill check）
  skills/
    # 感知类
    perception.md            — Perception（发现隐藏物、观察细节）
    listen.md                — Listen（偷听、监听、辨别声音）
    track.md                 — Track（追踪足迹、痕迹）

    # 社交类（opposed）
    charm.md                 — Charm（魅惑、讨好）
    bluff.md                 — Bluff（快速欺骗、误导）
    intimidate.md            — Intimidate（威胁、恐吓）
    persuade.md              — Persuade（说服、论证）
    psychology.md            — Psychology（读心、测谎）

    # 知识类
    accounting.md            — Accounting
    anthropology.md          — Anthropology
    archaeology.md           — Archaeology
    art_and_craft.md         — Art and Craft
    history.md               — History
    law.md                   — Law
    research.md              — Research
    occult.md                — Occult
    natural_world.md         — Natural World
    criminology.md           — Criminology
    forbidden_lore.md        — Forbidden Lore

    # 科学类
    biology.md               — Biology
    chemistry.md             — Chemistry
    physics.md               — Physics
    appraise.md              — Appraise

    # 医疗类
    first_aid.md             — First Aid
    medicine.md              — Medicine
    psychoanalysis.md        — Psychoanalysis

    # 体能类
    climb.md                 — Climb
    dodge.md                 — Dodge
    jump.md                  — Jump
    swim.md                  — Swim
    throw.md                 — Throw
    ride.md                  — Ride

    # 潜行/欺骗类
    stealth.md               — Stealth
    disguise.md              — Disguise
    sleight_of_hand.md       — Sleight of Hand

    # 修理/技术类
    electrical_repair.md     — Electrical Repair
    mechanical_repair.md     — Mechanical Repair
    operate_heavy_machinery.md — Operate Heavy Machinery
    locksmith.md             — Locksmith

    # 驾驶/导航类
    drive_auto.md            — Drive Auto
    navigate.md              — Navigate
    pilot_aircraft.md        — Pilot (Aircraft)
    pilot_boat.md            — Pilot (Boat)

    # 近战（opposed）
    brawling.md              — Brawling（徒手）
    sword.md                 — Sword
    axe.md                   — Axe
    whip.md                  — Whip

    # 远程
    pistol.md                — Pistol
    rifle.md                 — Rifle
    submachine_gun.md        — Submachine Gun
    bow.md                   — Bow

    # 生存类
    survival_arctic.md       — Survival (Arctic)
    survival_desert.md       — Survival (Desert)
    survival_forest.md       — Survival (Forest)

    # 特殊
    forgery.md               — Forgery
    language_own.md          — Language (Own)
    language_other.md        — Language (Other)
```

#### Skill Definition 文件格式

```yaml
---
id: perception
title: Perception
description: Finding hidden objects, spotting clues, noticing details that others miss

skillCheck:
  skill: Perception
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor]
    fields:
      actor: [id, name, conditions]
  scene:
    inject: [current]
    fields: [id, name, description, conditions, items, connections]
  item:
    inject: [sceneItems]

outputSchema:
  use:
    - scene.condition
    - item.modify
    - memory.event
    - character.fatigue

interpreter:
  examples:
    - "仔细搜查房间寻找线索"
    - "观察桌面上有没有异常"
    - "检查墙壁是否有暗门"
---

# Perception Resolution Guidance

## On Success
- 发现一个或多个隐藏线索、物品或环境细节
- regular success: 发现比较明显的隐藏物
- hard success: 发现需要仔细观察才能注意到的细节
- extreme success: 发现关键证据或隐藏通道

## On Failure
- 未发现任何隐藏物品或线索
- 不确定是真的没有还是没找到
- 不产生任何场景变更或物品变更
```

社交类（opposed）示例：

```yaml
---
id: persuade
title: Persuade
description: Convincing others through logical argument, negotiation, and reasoning

skillCheck:
  skill: Persuade
  difficulty: regular
  type: opposed
  opposedDefense: [Psychology, Persuade]
  failBehavior: abort

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, occupation, personality, conditions]
      targets: [id, name, occupation, personality, conditions, relationship]
  scene:
    inject: [current]
    fields: [id, name, description]

outputSchema:
  use:
    - character.condition
    - memory.event
    - memory.information
    - relationship.change

interpreter:
  examples:
    - "说服医生让我查看病历"
    - "劝海伦说出真相"
    - "试图用道理说服他改变主意"
---

# Persuade Resolution Guidance

## On Success
- 目标被说服，态度发生转变
- regular success: 目标勉强同意，可能附带条件
- hard success: 目标被完全说服
- extreme success: 目标不仅同意，还主动提供额外帮助或信息
- 更新 relationship（正面变化）

## On Failure
- 目标拒绝，态度可能变差
- 可能产生负面 relationship 变化
- 目标可能变得警惕或防备
```

战斗类示例：

```yaml
---
id: brawling
title: Brawling
description: Hand-to-hand combat — punching, kicking, grappling

skillCheck:
  skill: Brawling
  difficulty: regular
  type: opposed
  opposedDefense: [Dodge, Brawling]
  failBehavior: abort

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, stats, conditions, inventory]
      targets: [id, name, stats, conditions]
  scene:
    inject: [current]
    fields: [id, name, description, conditions]

outputSchema:
  use:
    - character.hp
    - character.condition
    - character.fatigue
    - character.position
    - memory.event
    - memory.witness

interpreter:
  examples:
    - "挥拳攻击他"
    - "用拳头打他的脸"
    - "扑上去把他按倒"
---

# Brawling Resolution Guidance

## On Success
- Actor wins: 对目标造成 1d3 + DB 伤害（HP delta）
- regular success: 正常伤害
- hard success: 可以选择击退目标或造成额外效果
- extreme success: 伤害翻倍或造成严重状态（如 knocked_down）

## On Failure
- Actor loses opposed roll: 目标反击机会
- 无伤害输出
- 可能被目标反击（由 GM/系统决定）
```

### 2. Definition Loader 改造

`loadActionDefinitions()` 修改为同时加载根目录和 `skills/` 子目录的 `.md` 文件：

```typescript
export function loadActionDefinitions(): ActionDefinition[] {
  const rootFiles = readdirSync(__dirname).filter(f => f.endsWith(".md"));
  const skillsDir = join(__dirname, "skills");
  const skillFiles = existsSync(skillsDir)
    ? readdirSync(skillsDir).filter(f => f.endsWith(".md"))
    : [];

  const allFiles = [
    ...rootFiles.map(f => ({ file: f, dir: __dirname })),
    ...skillFiles.map(f => ({ file: f, dir: skillsDir })),
  ];

  return allFiles.map(({ file, dir }) => {
    // 现有解析逻辑不变
  });
}
```

### 3. Planning LLM 输出简化

#### 现在输出

```json
{
  "node": {
    "nodeId": "xxx",
    "startTime": "19:00",
    "endTime": "19:30",
    "action": "去酒吧找海伦问昨晚的事",
    "type": "character_interaction",
    "skill": "Persuade",
    "targetCharacterIds": ["npc_helen"],
    "destination": null
  },
  "updatedShortTermIntent": "调查昨晚的事件"
}
```

#### 改后输出

```json
{
  "node": {
    "startTime": "19:00",
    "endTime": "19:30",
    "action": "去酒吧找海伦，问她昨晚酒吧里发生了什么",
    "targetCharacterIds": ["npc_helen"],
    "destination": "scene_bar"
  },
  "updatedShortTermIntent": "调查昨晚的事件"
}
```

**去掉：** `nodeId`（引擎生成）、`type`（interpreter 推断）、`skill`（definition 自带）、`difficulty`（definition 自带，从未使用）、`objectInteractionPayload`（narrative 足够描述）

**保留：** `action`、`startTime`/`endTime`、`targetCharacterIds`（可选）、`destination`（可选）、`updatedShortTermIntent`

#### Planning prompt 简化

去掉 type 枚举说明、skill 列表、difficulty 说明。Planning LLM 只需关注：
- NPC 的状态、位置、意图
- 当前时间和场景
- 输出一个自然语言的行动描述 + 时间 + 目标/目的地（如有）

### 4. GameInterpreter 增强

#### 现在

```typescript
interpretAction(actionText, definitions) → { steps: [{ definitionId, impact }] }
// definitions: 6 个通用 definition
```

#### 改后

```typescript
interpretAction(actionText, definitions) → { steps: [{ definitionId, impact }] }
// definitions: ~72 个（通用 + skill）
```

接口不变，但输入的 definition 列表扩大。每个 definition 提供给 interpreter prompt 的信息：

```
- id: perception
  title: Perception
  description: Finding hidden objects, spotting clues
  examples: ["仔细搜查房间寻找线索", "检查墙壁是否有暗门"]

- id: persuade
  title: Persuade
  description: Convincing others through logical argument
  examples: ["说服医生让我查看病历", "劝海伦说出真相"]

- id: action
  title: General Action
  description: Non-skill actions — resting, waiting, observing
  examples: ["休息一会儿", "在窗边观察街道"]
```

Interpreter 从 ~72 个选项中选最匹配的 definitionId。选完后 skill check 配置全在 definition 的 `skillCheck` 字段里，不需要额外推断。

#### Interpreter prompt 优化

~72 个 definition 的列表较长。优化方式：
- 只注入 `id`、`title`、`description`、`examples`（不注入 guidanceBody 或 skillCheck 细节）
- 按类别分组呈现（感知、社交、战斗、知识...），便于 LLM 定位
- 对于复合动作（"撬开柜子搜查文件"），返回多个 steps

### 5. TickProcessor 适配

#### Skill check 改造

现在 `executeSkillCheck()` 使用 `node.skill` 和 `definition.skillCheck`。改后：
- `node.skill` 不再存在
- skill 完全来自 `definition.skillCheck.skill`
- `resolveSkillRoll()` 使用 `definition.skillCheck.skill` 作为 skill 名

```typescript
// 现在
const skillResult = executeSkillCheck(
  definition?.skillCheck,
  node.characterId,
  node.skill,           // ← 从 PlanNode 取
  dgsm, locationId, registry, targetIds
);

// 改后
const skillResult = executeSkillCheck(
  definition?.skillCheck,
  node.characterId,
  definition?.skillCheck?.skill,  // ← 从 definition 取
  dgsm, locationId, registry, targetIds
);
```

#### Step 执行循环

TickProcessor 已有多 step 执行逻辑。改后每个 step 对应一个 skill definition，逐步执行：
1. GameInterpreter 返回 `steps: [{ definitionId: "locksmith", impact: 1 }, { definitionId: "perception", impact: 0 }]`
2. Step 1: 加载 `locksmith` definition → skill check → state resolve → apply
3. 如果 step 1 的 `failBehavior: "abort"` 且失败 → 跳过后续 steps
4. Step 2: 加载 `perception` definition → skill check → state resolve → apply

### 6. PlanNode 类型变更

```typescript
// 去掉的字段
interface PlanNode {
  // type: PlanNodeType;                    // 删除
  // skill?: string;                        // 删除
  // difficulty?: "regular" | "hard" | "extreme"; // 删除（从未使用）
  // objectInteractionPayload?: {...};      // 删除

  // 保留的字段
  nodeId: string;                           // 引擎生成
  characterId: string;                      // 引擎赋值
  characterName: string;                    // 引擎赋值
  startTime: string;                        // LLM 输出
  endTime: string;                          // LLM 输出
  action: string;                           // LLM 输出（narrative）
  targetCharacterIds?: string[];            // LLM 输出（可选）
  destination?: string;                     // LLM 输出（可选）
  status: PlanNodeStatus;                   // 引擎管理
  executionMeta: PlanNodeExecutionMeta;     // 引擎管理
  outcome?: string;                         // 引擎赋值
  [key: string]: unknown;                   // feature overlay
}
```

### 7. 完整数据流

```
Planning LLM
  输入: NPC 状态、场景、意图
  输出: { action, startTime, endTime, targetCharacterIds?, destination? }
       │
       ▼
  存入 DB → PlanNode (pending)
       │
       ▼ (tick 到达 endTime)

GameInterpreter
  输入: node.action + 所有 definitions (~72 个)
  输出: { steps: [
           { definitionId: "locksmith", impact: 1 },
           { definitionId: "perception", impact: 0 },
         ]}
       │
       ▼ (逐步执行)

Step 1: locksmith.md
  ├─ skillCheck: { skill: "Locksmith", difficulty: "regular", type: "single", failBehavior: "abort" }
  ├─ executeSkillCheck() → success/fail
  ├─ 如果 abort + fail → 跳过后续 steps
  ├─ StateResolver(guidanceBody + outputSchema) → state delta
  └─ applyStateResolution(typeId dispatch)

Step 2: perception.md
  ├─ skillCheck: { skill: "Perception", difficulty: "regular", type: "single", failBehavior: "partial" }
  ├─ executeSkillCheck()
  ├─ StateResolver → state delta
  └─ applyStateResolution()
       │
       ▼
CharacterAction 记录
```

### 与现状对比

| | 现在 | 改后 |
|---|---|---|
| Planning 输出 | action + type + skill + difficulty + payload | action + time + targets + destination |
| Definition 数量 | 6 个通用 | ~72 个（7 通用 + ~65 skill） |
| Skill 决策 | Planning LLM 决定 | Definition 自带 |
| GameInterpreter | 从 6 个选 1 个 | 从 ~72 个选 1+ 个 |
| Resolver guidance | 通用（action.md 覆盖所有） | 专属（每个 skill 有自己的规则） |
| PlanNode 字段 | 12+ 字段 | 7 字段（更精简） |
| movement | 纯代码 | 不变 |

### 迁移策略

1. 创建全部 ~65 个 skill definition 文件（用多个 subagent 并行，按类别分组批量生成）
2. 修改 loader 支持 `skills/` 子目录
3. 修改 GameInterpreter prompt 适配扩大的 definition 列表
4. 简化 Planning prompt 和 PlanNode 类型
5. 修改 TickProcessor 的 skill check 调用
6. 旧字段（type, skill, difficulty）标记 deprecated，逐步清理
