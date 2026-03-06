# NPC Planning System Design

**Date:** 2026-03-05
**Branch:** multi
**Status:** Approved

## Overview

Replace the reactive NPC model (player acts → NPC reacts) with a proactive tick-plan system. NPCs have pre-generated plans that execute autonomously as game time advances. Players and NPCs are treated as the same type of actor, both producing `CharacterAction` outputs processed by the same pipeline.

## Core Concepts

### Two-Layer NPC State

| Layer | Name | Generated | Granularity | Stored |
|---|---|---|---|---|
| 1 | `NpcLongTermIntent` | Once at game start | Multi-day goals | DB table |
| 2 | `NpcDailyPlan` | Each in-game day | Time-stamped action nodes | DB table |

Daily plans are generated at each in-game midnight, driven by the NPC's long-term intent + world state at that time.

---

## Data Structures

### CharacterAction (Unified)

Both NPC plan nodes (after execution) and player actions produce the same structure:

```typescript
interface CharacterAction {
  characterId: string;           // NPC id or player character id
  characterName: string;
  gameTime: string;              // "HH:MM"
  action: string;
  location: string;              // scenarioId where action occurs
  type: NpcPlanNodeType;
  actionType?: ActionType;       // present = skill roll was performed
  impact: 0 | 1 | 2 | 3;        // see Impact Levels below
  status: "completed" | "failed";
  outcome: string;               // TickProcessor 拼接：成功="[action] 成功"，失败="[action] 失败: [failureReason]"
}
```

### NpcPlanNode (Pre-execution form)

```typescript
type NpcPlanNodeType =
  | "routine"               // 独立行动，不需判定
  | "movement"              // 移动到场景，检查是否 blocked
  | "character_interaction" // 人和人：物品/线索/信息转移
  | "object_interaction"    // 人和物：拾取/放置/使用/检查/销毁
  | "scene_interaction"     // 人和场景：搜索/改变场景状态

interface CharacterInteractionPayload {
  transferType: "item" | "clue" | "information";
  itemId?: string;              // transferType = "item"
  clueId?: string;              // transferType = "clue"
  informationContent?: string;  // transferType = "information": actual content shared
}

interface ObjectInteractionPayload {
  action: "pickup" | "place" | "use" | "inspect" | "destroy";
  itemId?: string;
}

interface SceneConnectionEffect {
  targetScenarioId: string;
  action: "block" | "unblock";
}

interface NpcPlanNode {
  nodeId: string;
  gameTime: string;              // "HH:MM" scheduled time
  action: string;
  location: string;              // expected scenarioId
  type: NpcPlanNodeType;
  actionType?: ActionType;       // present = requires skill roll; TickProcessor auto-selects skill
  impact: 0 | 1 | 2 | 3;
  targetCharacterId?: string;                            // character_interaction 用
  characterInteractionPayload?: CharacterInteractionPayload; // character_interaction 用
  objectInteractionPayload?: ObjectInteractionPayload;       // object_interaction 用
  sceneConnectionEffect?: SceneConnectionEffect;            // scene_interaction 用，可选：修改场景连接状态
  status: "pending" | "completed" | "failed";
  outcome?: string;              // TickProcessor 拼接字符串：成功="[action] 成功"，失败="[action] 失败: [failureReason]"；scene_interaction 成功时追加到场景 state
}
```

**TickProcessor 按类型自动处理副作用（status = "completed"）：**

| 节点类型 | 副作用 |
|---|---|
| `routine` / `movement` | 无 |
| `character_interaction` | 按 `characterInteractionPayload` 转移物品/线索/信息到 `targetCharacterId` |
| `object_interaction` | 按 `objectInteractionPayload.action` 增减 NPC inventory（pickup → 添加，place/destroy → 移除） |
| `scene_interaction` | 把 `outcome` 追加到 `location` 场景的 ScenarioCondition；若有 `sceneConnectionEffect`：更新连接 `blocked` 状态 + 把 `outcome` 追加到该连接的 `conditions` |

**character_interaction payload 处理：**

| transferType | On success |
|---|---|
| `item` | Remove itemId from NPC inventory → add to target inventory |
| `clue` | Remove clueId from NPC discoveredClues → add to target discoveredClues |
| `information` | Write `informationContent` to target NPC knowledge state → Small LLM yes/no gate: does this information meaningfully change target's plan? yes → `revisePlans(targetNpcId, impactTrigger)` |

### NPCRelationship

```typescript
interface NPCRelationship {
  targetCharacterId: string;
  score: number;  // -100 到 100，每 20 分一个层级
  note: string;   // 动态维护的关系描述，初始由模组配置，每次 character_interaction 后由小 LLM 更新
}
```

| 分值 | 层级 | 行为含义 |
|---|---|---|
| 80 ~ 100 | 言听计从 | 无条件服从，愿意冒险帮助 |
| 60 ~ 79 | 深度信任 | 主动分享秘密，可靠盟友 |
| 40 ~ 59 | 友好 | 乐于帮助，会说实话 |
| 20 ~ 39 | 好感 | 愿意合作，但有保留 |
| 0 ~ 19 | 中立 | 不主动接触，正常应对 |
| -1 ~ -20 | 冷淡 | 敷衍，不愿提供帮助 |
| -21 ~ -40 | 戒备 | 主动回避，可能撒谎 |
| -41 ~ -60 | 厌恶 | 拒绝交流，可能举报 |
| -61 ~ -80 | 敌视 | 主动阻挠，散布谣言 |
| -81 ~ -100 | 死敌 | 寻机伤害，不择手段 |

**初始值：** 在模组里配置，格式：
```json
{
  "npcId": "dr_armitage",
  "relationships": [
    { "targetId": "wilbur_whateley", "score": -85, "note": "视为危险威胁" },
    { "targetId": "henry_rice",      "score": 65,  "note": "多年老友" }
  ]
}
```
`note` 仅供模组作者参考，不注入 LLM。

**更新时机：** `character_interaction` 节点完成后，独立触发一个小 LLM call：

```
Input:
  - 双方 NPC profile（性格、角色）
  - 当前 NPCRelationship { score, note }
  - 刚完成的 character_interaction outcome
Output:
  - scoreDelta: number     // 正负均可，累加后 clamp -100~100
  - note: string           // 更新后的关系描述（动态维护，反映最新状态）
```

`note` 从模组配置的静态描述变为动态维护的关系状态说明，随每次交互结果演变。

**偶遇触发（两 NPC 在同一场景，无预定 character_interaction 节点）：**
- score ≥ 60 → 主动接近，生成临时友好 `character_interaction` 节点
- score ≤ -60 → 生成临时对抗性 `character_interaction` 节点
- 中间区间 → 忽略彼此，不触发

---

### ScenarioConnectionState

场景间通行状态，存于 `DynamicGameState`，TickProcessor 读写：

```typescript
interface ScenarioConnectionState {
  fromScenarioId: string;
  toScenarioId: string;
  blocked: boolean;
  conditions: string[];   // 记录影响此连接的事件 outcome（谁、为何封锁/开启）
}
```

`movement` 节点判断 `location_blocked` 时读此状态。`scene_interaction` 成功且有 `sceneConnectionEffect` 时写此状态。

### NPC 当前位置

NPC 当前所在场景存于 `DynamicGameState.npcLocations: Record<npcId, scenarioId>`。

- 游戏初始化时按 NPC profile 设置初始位置
- `movement` 节点完成时更新
- TickProcessor 所有位置检查均读此字段

---

### Impact Levels

Single field drives both observability and effect propagation. Hearing = being affected.

| impact | Who perceives & is affected | KeeperAgent injection |
|---|---|---|
| 0 | Nobody (NPC only knows) | Never |
| 1 | Target character only | Only if target is player |
| 2 | All characters in current scene | If NPC in player scene or adjacent |
| 3 | All characters globally | Always |

Examples:
- NPC reads a book alone: `impact=0`
- NPC whispers to player: `impact=1`
- NPC fires a gun: `impact=2` (everyone in scene hears and reacts)
- NPC completes summoning ritual: `impact=3`

---

## Node Type Execution Logic

### TickProcessor (pure state machine, no LLM)

两个 RAG 查询表（均用 EmbeddingClient 做 semantic match）：
- **Skill RAG**：actionTypeSkillMap 候选技能 → 匹配 NPC 实际技能值
- **Horror RAG**：CoC 规则书 + 模组恐怖源条目（怪物/事件/场景）→ 每条含 `sanLossMin` / `sanLossMax`

**执行顺序：优先级队列**
```
所有到期节点（prevTime < node.gameTime <= newTime）放入优先级队列
排序规则：gameTime ASC，同时间则 DEX DESC
逐个出队执行，每次执行后立即更新世界状态
后续节点读取最新状态 → 冲突天然消解（先到先得，后到者 failed → revisePlans）
```

```
Node 出队
  → [所有类型] 有 actionType?
       Yes → 进入对应解析逻辑（见下方）
       No  → 直接执行

**actionType 解析逻辑：**

```
actionType = "combat" AND targetCharacterId:
  攻击方 d100 vs Skill RAG 匹配最佳战斗技能
  防御方 d100 vs Dodge
  比较成功等级 (critical > hard > regular > fail)
  攻击方等级 > 防御方 → 命中
    damage = 武器伤害骰 + damage bonus (STR+SIZ 查表)
    update target.HP；HP ≤ 0 → target 状态改为 incapacitated

actionType = "social" AND targetCharacterId:
  行动方 d100 vs Skill RAG 匹配最佳社交技能
  目标方 d100 vs Psychology
  比较成功等级，高者胜

actionType = "chase" AND targetCharacterId:
  双方各 d100 vs Skill RAG 匹配最佳移动技能
  比较成功等级，决定追逃结果

actionType = "mental":
  NPC d100 vs SAN 值
  Horror RAG: 用 node.action 描述 semantic match → 匹配最近恐怖源条目
    → 取 sanLossMin（成功时扣）/ sanLossMax（失败时扣）
  update NPC.SAN

其余 actionType (exploration / stealth / environmental / narrative):
  Skill RAG 匹配最佳技能 → d100 → 成功/失败
```

  → type = "routine"
       NPC at node.location? → completed
       NPC not at location?  → failed (reason: "location_mismatch") → trigger revisePlans

  → type = "movement"
       Target scene blocked? → failed (reason: "location_blocked") → trigger revisePlans
       Not blocked?          → completed, update NPC location

  → type = "character_interaction"
       NPC at node.location? No → failed (reason: "location_mismatch")
       targetCharacterId at node.location? No → failed (reason: "target_absent")
       luck-based random check (see below) → failed (reason: "bad_luck")
       Yes → apply characterInteractionPayload side effects → completed

  → type = "object_interaction"
       NPC at node.location? No → failed (reason: "location_mismatch")
       luck-based random check (see below) → failed (reason: "bad_luck")
       apply objectInteractionPayload side effects (inventory update) → completed

  → type = "scene_interaction"
       NPC at node.location? No → failed (reason: "location_mismatch")
       luck-based random check (see below) → failed (reason: "bad_luck")
       completed →
         append outcome to location ScenarioCondition
         sceneConnectionEffect present?
           Yes → update connection blocked state (location ↔ targetScenarioId)
                 append outcome to connection.conditions
```

**Luck-based failure rate（仅三种交互类型，无 actionType 时）：**

```
failure_rate = 0.025 + (100 - luck) * 0.0005

// luck=100 → 2.5%,  luck=50 → 5%,  luck=0 → 7.5%
// roll random [0,1), if < failure_rate → failed (reason: "bad_luck")
```

**Failure reasons generated by TickProcessor:**
- `location_mismatch` — NPC 不在预期场景
- `location_blocked` — 目标场景无法进入（movement）
- `target_absent` — 交互目标角色不在场景
- `object_not_found` — 目标物品已不存在于场景（被其他 NPC 先取走）
- `skill_roll_failed` — 技能骰未过（附带 skill name + roll value）
- `bad_luck` — luck-based 随机失败（附带 luck 值 + roll 值）

**节点失败后立即触发计划修订（小模型）：**

```
node.status = "failed"
  → NPCPlanningAgent.revisePlans(dgsm, npcId, {
      longTermIntent,
      currentDayPlan,
      trigger: FailureTrigger { type: "failure", failureReason, action, gameTime }
    })
```

---

## Turn Execution Flow

```
Player Input
  ↓
[ActionAgent] (rewritten)
  - Resolve player action + player-NPC direct interactions
  - Advance gameTime
  - Output: CharacterAction (player)

  ↓ after gameTime advances

[TickProcessor]
  - Scan all NPC daily plans for due nodes
  - Execute each node (routine / movement / character_interaction / object_interaction / scene_interaction)
  - Apply side effects per type (inventory, scene state)
  - On failure: generate failureReason string → immediately call NPCPlanningAgent.revisePlans()
  - Output: CharacterAction[] (NPCs)

  ↓

[NPCPlanningAgent.revisePlans()] — failure-driven, per failed NPC
  trigger: FailureTrigger { failureReason, action, gameTime }
  - Revise remaining pending nodes based on failure
  - Does NOT modify completed/failed history

  ↓

[Impact Propagation + Revision Gate]
  For each CharacterAction (player + NPC):
    impact=1 → targetCharacterId is candidate
    impact=2 → all NPCs in same scene are candidates
    impact=3 → all NPCs globally are candidates

  For each candidate NPC:
    → Small LLM yes/no gate:
        Input: NPC long-term intent + remaining pending nodes + triggering CharacterAction
        Question: "Does this event meaningfully change what this NPC should do next?"
        yes → call NPCPlanningAgent.revisePlans(dgsm, npcId, { trigger: ImpactTrigger })
        no  → skip

  ↓

[Day change check]
  gameTime crossed midnight?
    → NPCPlanningAgent.generateDailyPlans(nextDay) for all NPCs

  ↓

[KeeperAgent]
  - Player CharacterAction results
  - NPC CharacterActions where:
      impact=2 and NPC in player scene or adjacent scene
      impact=3 always
  → Narrative output
```

---

## Game Initialization

```
Game starts
  → NPCPlanningAgent.generateLongTermIntents()
      For each NPC: multi-day goal driven by truth timeline + NPC profile
      Stored in NpcLongTermIntent DB table

  → NPCPlanningAgent.generateDailyPlans(day=1)
      For each NPC: time-stamped node sequence for day 1
      Driven by long-term intent + current world state
      Stored in NpcDailyPlan DB table
```

---

## Character Memory Model

Each character's complete cognitive state is composed of three layers:

```
Character Memory =
  Initial state  (NPC profile: personality, goals, relationships, skills, inventory)
  + Action log   (actionLog: string[] — outcome 字符串列表，按时间顺序追加)
  + Pending plan (pending nodes: what they intend to do next)
```

**actionLog 格式：**
```
"Day1 08:00 [图书馆] - 前往图书馆查阅古籍 成功"
"Day1 10:30 [图书馆] - 尝试说服馆长 失败: skill_roll_failed (Persuade 45, rolled 67)"
```

- 节点执行完成/失败后，outcome 追加到 NPC 档案的 `actionLog`
- `NpcDailyPlan.nodes` 只保留 pending 节点，执行后移除
- `revisePlans` 和 `generateDailyPlans` 读 `actionLog` 作为历史上下文
- KeeperAgent 读 `actionLog` 描述 NPC 行为

**Relationship updates** are handled inside `revisePlans`: the agent reads `actionLog`, infers relationship changes (trust/hostility/dependency), and updates `NPCRelationship[]` in the same LLM call. No separate relationship trigger mechanism needed.

---

## NPC Planning Agent Responsibilities

- `generateLongTermIntents(dgsm)` — one-time, all NPCs
- `generateDailyPlans(dgsm, gameDay)` — all NPCs, called at day change
- `revisePlans(dgsm, npcId, trigger)` — single NPC; revises pending nodes AND updates NPCRelationship[] based on completed history

```typescript
type FailureTrigger = {
  type: "failure";
  failureReason: string;   // "location_mismatch" | "location_blocked" | "target_absent" | "skill_roll_failed" | "bad_luck"
  action: string;
  gameTime: string;
}

type ImpactTrigger = {
  type: "impact";
  triggeringAction: CharacterAction;
}

// revisePlans 统一入参
revisePlans(dgsm, npcId: string, context: {
  longTermIntent: NpcLongTermIntent;
  actionLog: string[];          // NPC 档案里的 actionLog，作为历史上下文
  pendingNodes: NpcPlanNode[];  // 当前剩余 pending 节点
  trigger: FailureTrigger | ImpactTrigger;
})
```

`revisePlans` output:
- 修订后的 pending 节点（替换原有 pending 节点）
- 更新 NPCRelationship[]（仅在 impact 触发时推断关系变化；character_interaction 后的关系更新由独立小 LLM call 处理）
- 是否更新 NpcLongTermIntent（同一 LLM call 判断：此次事件是否从根本上改变 NPC 目标？是 → 输出新 intent 字符串）
- 不修改 actionLog

**`generateDailyPlans` 输入（注入 LLM 的上下文）：**
- NPC profile（角色、性格、secret、技能、inventory）
- NpcLongTermIntent
- actionLog（历史行动记录）
- NPCRelationship[]（与其他 NPC 的关系分值）
- 其他 NPC 当前位置（`npcLocations`，避免计划目标不可达）
- 场景地图矩阵（哪些场景连通，哪些连接 blocked）
- 活动范围内场景的 ScenarioConditions（当前世界状态）
- 当前游戏日期 + 时间

`NPCPlanningAgent` optionally sets `actionType` when a node clearly requires a skill check. Skill selection happens at tick time via RAG, not at plan generation time. Nodes without `actionType` succeed automatically if location/target conditions are met.

---

## ActionType → Skill Mapping (actionTypeSkillMap.ts)

Static mapping used by TickProcessor when `actionType` is present on any node type:

```typescript
const ACTION_TYPE_SKILL_MAP: Record<ActionType, string[]> = {
  exploration: [
    "Spot Hidden", "Listen", "Library Use", "Research",
    "Archaeology", "History", "Occult", "Natural World", "Anthropology",
    "Science (Astronomy)", "Science (Biology)", "Science (Chemistry)",
    "Science (Cryptography)", "Science (Forensics)", "Science (Geology)",
    "Science (Mathematics)", "Science (Pharmacy)", "Science (Physics)",
    "Navigate", "Track", "Appraise", "Accounting",
    "Locksmith",                    // 开锁以搜索上锁区域
    "Computer Use",                 // 现代背景下的数字调查
    "Art/Craft (Photography)",      // 记录证据
    "Language (Other)",             // 解读外文资料
  ],
  social: [
    "Charm", "Fast Talk", "Persuade", "Intimidate",
    "Psychology", "Credit Rating", "Disguise",
    "Language (Own)", "Language (Other)",
    "Art/Craft (Acting)",
    "Law",                          // 援引法律权威施压
    "Accounting",                   // 金融谈判
  ],
  combat: [
    "Fighting (Brawl)", "Fighting (Sword)", "Fighting (Axe)",
    "Fighting (Spear)", "Fighting (Flail)", "Fighting (Whip)",
    "Fighting (Chainsaw)", "Fighting (Garrote)",
    "Firearms (Handgun)", "Firearms (Rifle/Shotgun)", "Firearms (Submachine Gun)",
    "Firearms (Machine Gun)", "Firearms (Heavy Weapons)", "Firearms (Flamethrower)",
    "Throw", "Dodge", "First Aid",
    "Electrical Repair",            // 即兴武器/陷阱
    "Mechanical Repair",            // 即兴武器
  ],
  stealth: [
    "Stealth", "Sleight of Hand", "Disguise",
    "Locksmith", "Spot Hidden", "Listen",
    "Electrical Repair", "Mechanical Repair",
    "Art/Craft (Forgery)",          // 伪造文件证件
    "Computer Use",                 // 现代背景入侵系统
    "Psychology",                   // 读懂警卫行为规律
  ],
  chase: [
    "Drive Auto", "Pilot (Aircraft)", "Pilot (Boat)",
    "Ride", "Swim", "Climb", "Jump", "Dodge", "Throw",
    "Operate Heavy Machinery",      // 驾驶重型载具追逃
    "Mechanical Repair",            // 追逃中紧急维修
  ],
  mental: [
    "Psychology", "Psychoanalysis",
    "Occult", "Cthulhu Mythos",
    "History", "Science (Astronomy)",
    "Medicine",                     // 处理精神创伤
    "Art/Craft (Fine Art)",         // 以创作疏导恐惧
    "Language (Other)",             // 解读神话文本
  ],
  environmental: [
    "Survival (Desert)", "Survival (Forest)", "Survival (Arctic)", "Survival (Sea)",
    "First Aid", "Medicine", "Navigate",
    "Natural World", "Track", "Climb", "Swim", "Jump",
    "Science (Biology)", "Science (Geology)",
    "Science (Chemistry)",          // 处理有毒物质
    "Science (Meteorology)",        // 预判极端天气
    "Science (Pharmacy)",           // 野外急救用药
    "Electrical Repair", "Mechanical Repair",  // 野外修复设备
    "Operate Heavy Machinery",      // 操作救援设备
  ],
  narrative: [
    "Language (Own)", "Language (Other)",
    "History", "Occult", "Library Use", "Research", "Anthropology",
    "Charm", "Persuade", "Fast Talk",
    "Art/Craft (Writing)", "Art/Craft (Acting)", "Art/Craft (Fine Art)",
    "Psychology", "Law", "Accounting",
    "Science (Cryptography)", "Science (Mathematics)",
  ],
}
```

技能可跨类型出现。TickProcessor 用 `node.action` 描述对候选列表做 semantic match，选取匹配度最高且 NPC 实际拥有的技能进行 d100 判定。NPC 不拥有任何候选技能时，退回使用对应基础属性（STR / DEX / INT / POW）。

---

## Database Schema

```prisma
model NpcLongTermIntent {
  id        String   @id @default(uuid()) @db.Uuid
  sessionId String   @map("session_id")
  moduleId  String   @map("module_id") @db.Uuid
  npcId     String   @map("npc_id")
  npcName   String   @map("npc_name")
  intent    String
  updatedAt DateTime @updatedAt @map("updated_at")
  createdAt DateTime @default(now()) @map("created_at")

  session   Session  @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)
  module    Module   @relation(fields: [moduleId], references: [moduleId], onDelete: Cascade)

  @@index([sessionId])
  @@map("npc_long_term_intents")
}

model NpcDailyPlan {
  id          String   @id @default(uuid()) @db.Uuid
  sessionId   String   @map("session_id")
  moduleId    String   @map("module_id") @db.Uuid
  npcId       String   @map("npc_id")
  npcName     String   @map("npc_name")
  gameDay     Int      @map("game_day")
  nodes       Json     // NpcPlanNode[] — pending 节点only，执行后移除
  generatedAt DateTime @default(now()) @map("generated_at")

  session     Session  @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)
  module      Module   @relation(fields: [moduleId], references: [moduleId], onDelete: Cascade)

  @@unique([sessionId, npcId, gameDay])
  @@index([sessionId, gameDay])
  @@map("npc_daily_plans")
}

model NpcActionLog {
  id        String   @id @default(uuid()) @db.Uuid
  sessionId String   @map("session_id")
  npcId     String   @map("npc_id")
  gameDay   Int      @map("game_day")
  gameTime  String   @map("game_time")   // "HH:MM"
  location  String                       // scenarioId
  entry     String                       // "Day1 08:00 [图书馆] - 前往图书馆查阅古籍 成功"
  createdAt DateTime @default(now()) @map("created_at")

  session   Session  @relation(fields: [sessionId], references: [sessionId], onDelete: Cascade)

  @@index([sessionId, npcId])
  @@map("npc_action_logs")
}
```

`NpcDailyPlan.nodes` only stores **pending** nodes. On execution, node is removed and outcome is written as a new `NpcActionLog` row.

---

## Files Changed

### New Files
```
src/dynamicworldagent/dynamicBasicAgent/npcPlanning/
├── NPCPlanningAgent.ts      # LLM: generate intents, daily plans, revise plans
├── NPCPlanningTemplate.ts   # prompt templates
├── actionTypeSkillMap.ts    # static ActionType → skills mapping
├── horrorSourceData.ts      # CoC 规则书恐怖源条目（sanLossMin/Max），供 Horror RAG 使用
└── tickProcessor.ts         # pure state machine; uses Skill RAG + Horror RAG
```

### Rewritten
- `action/actionAgent.ts` — output `CharacterAction`, handle player-NPC interactions, remove passive NPC response generation

### Modified
- `state/DynamicGameState.ts` — remove `heartbeatActions`; add `npcLocations: Record<npcId, scenarioId>`; add `connectionStates: ScenarioConnectionState[]`; no in-memory plan storage (plans live in DB)
- `prisma/schema.prisma` — add `NpcLongTermIntent`, `NpcDailyPlan`, `NpcActionLog` tables
- `director/directorAgent.ts` — major simplification: remove NPC timeline generation, scene snapshot generation, global RAG trigger checks; keep only game ending condition checks

### Deleted
- `heartbeat/heartbeatAgent.ts`

---

## What DirectorAgent No Longer Does

| Removed | Replaced by |
|---|---|
| NPC action timeline generation | NPCPlanningAgent daily plans |
| Scene entry snapshot generation | NPC locations read from plan state |
| Global trigger RAG checks | `impact=3` node execution (explicit, not inferred) |
| Heartbeat evaluation | TickProcessor |

**DirectorAgent retains:** game ending condition checks only.
