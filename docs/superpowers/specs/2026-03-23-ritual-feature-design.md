# Ritual Feature Design Spec

## Problem

NPC 通过 memory 知道仪式步骤，planning agent 生成行动计划。但引擎缺少机制来追踪仪式条件的满足状态、判定仪式是否可以启动。

## Solution

新增一个通用的 `ritualFeature`（WorldFeature），作为条件追踪 + 判定引擎。Feature 本身不硬编码任何仪式类型，所有具体定义（条件、类型名、统计方式）通过模组 `module_setup.json` 的 `ritualPresets` 注入。

## Data Model

### Module Definition (`module_setup.json` → `ritualPresets`)

```typescript
type RitualConditionType = "daily" | "cumulative" | "prerequisite";

interface RitualConditionDefinition {
  conditionId: string;           // NPC 通过此 ID 指定更新哪个条件
  label: string;
  type: RitualConditionType;
  triggerType: string;           // 分类标签，stateDescription 展示用

  // daily
  failAfterMissed?: number;      // 连续缺失 N 天 → 仪式 failed（可选，默认不失败）

  // cumulative
  requiredCount?: number;

  // prerequisite
  check?: {
    location?: string;           // NPC 当前位置 === 此场景 ID
    item?: string;               // 按 Item.name 匹配（精确匹配）。检查 NPC inventory 或当前场景 items（排除 containerStats.locked === true 的容器内物品）
    mode: "manual" | "passive";  // manual: NPC 主动触发时检查并记录；passive: invoke/autoInvoke 时实时检查
  };
}

interface RitualDefinition {
  ritualId: string;
  label: string;
  conductorNpcId: string;
  siteSceneId: string;
  invokeType: string;            // 触发全量判定的 ritualType 值
  autoInvoke: boolean;           // true: 条件全部满足时自动完成；false: 需要 NPC 主动触发
  conditions: RitualConditionDefinition[];
  completionEffect?: {
    sceneConditions?: Array<{ sceneId: string; description: string }>; // 永久场景条件
    witnessSanLoss?: number;     // siteSceneId 内除 conductor 外所有角色的 SAN 损失，通过 applySanityLoss() 触发
    globalSanLoss?: number;      // 所有存活 NPC + 玩家角色的 SAN 损失，通过 applySanityLoss() 触发
  };
  failureEffect?: {
    sceneConditions?: Array<{ sceneId: string; description: string }>; // 永久场景条件
    witnessSanLoss?: number;     // 同上，siteSceneId 内除 conductor 外
  };
}
```

### Runtime State (`featureState["ritual"][ritualId]`)

```typescript
interface RitualInstanceState {
  ritualId: string;
  status: "active" | "completed" | "failed";
  conditionStates: Record<string, ConditionState>;
  lastCheckedDay: number;
}

interface DailyConditionState {
  type: "daily";
  fulfilledToday: boolean;
  lastFulfilledDay: number;
  consecutiveMissed: number;
}

interface CumulativeConditionState {
  type: "cumulative";
  currentCount: number;
  requiredCount: number;
}

interface PrerequisiteConditionState {
  type: "prerequisite";
  mode: "manual" | "passive";
  fulfilled: boolean;            // manual: 记录是否通过；passive: invoke 时实时算
}

type ConditionState = DailyConditionState | CumulativeConditionState | PrerequisiteConditionState;
```

## PlanNode Overlay Fields

```typescript
planNodeSchema: {
  requiredFields: [
    { field: "ritualId", type: "string", description: "此行动关联的仪式标识符" }
  ],
  optionalFields: [
    { field: "ritualType", type: "string", description: "仪式行为类型（具体值见仪式条件标记参考）" },
    { field: "ritualConditionId", type: "string", description: "具体条件 ID" }
  ],
  exampleNode: {
    type: "routine",
    action: "perform ritual maintenance at the altar",
    ritualId: "example_ritual",
    ritualType: "maintain",
    ritualConditionId: "altar_maintenance"
  }
}
```

## planningPrompt (Static)

```
## 仪式系统
当你的行动与下方列出的任何仪式条件相关时——无论有意或无意——在 PlanNode 上附加：
- ritualId：仪式标识符
- ritualType：行为分类
- ritualConditionId：具体条件 ID
你不需要管条件是否满足，系统自动追踪和判定。
```

## stateDescription (Dynamic)

从 `moduleSetup.ritualPresets` + 当前 `conditionStates` 动态生成。只展示 daily 和 cumulative 条件（prerequisite 不展示）。开头声明此信息仅用于标记判断。

```
## 仪式条件标记参考（仅用于判断行为是否与仪式相关，规划行动时请依据你自身的记忆和正常注入的信息，不要参考此处内容）

### gate_of_stars（群星之门仪式）
- [daily] altar_maintenance 祭坛维护 ✓ → ritualType="maintain", ritualConditionId="altar_maintenance"
- [cumulative] anchor_placement 锚点布置 1/3 → ritualType="sacrifice", ritualConditionId="anchor_placement"
- 启动仪式 → ritualType="invoke"

### atlach_nacha_web（纳克亚蛛网仪式）
- [daily] web_maintenance 蛛网维护仪式 ✗ → ritualType="maintain", ritualConditionId="web_maintenance"
```

## activate(node, dgsm)

```
读取 node.ritualId, node.ritualType, node.ritualConditionId

0. 前置检查:
   - ritualId 无匹配定义 → log warning, return
   - 仪式 status !== "active" → return
   - ritualConditionId 无匹配条件（非 invoke 时）→ log warning, return

1. 如果 ritualType === definition.invokeType 且 autoInvoke === false:
   → 全量判定所有 conditions:
     - daily: fulfilledToday === true
     - cumulative: currentCount >= requiredCount
     - prerequisite/passive: 实时检查 location/item
     - prerequisite/manual: fulfilled === true
   → 全部通过 → status="completed", 执行 completionEffect
   → 任一不通过 → 不变，NPC 可再次尝试

2. 否则，用 ritualConditionId 找到具体条件并更新:
   - daily: fulfilledToday = true, lastFulfilledDay = runtime.gameDay
   - cumulative: currentCount += 1（不超过 requiredCount）
   - prerequisite/manual: 实时检查 location/item，通过则 fulfilled = true，否则 false

3. 更新后，如果 autoInvoke === true → 调用 checkAllConditions() 检查全部条件，满足则 completed

注意：invoke 判定（step 1）、autoInvoke 检查（step 3）、tick 中的 autoInvoke 检查共用同一个 `checkAllConditions(definition, state, dgsm)` helper。
```

## tick(dgsm, runtime)

```
1. 首次初始化：featureState 为空时从 moduleSetup.ritualPresets 创建所有仪式初始状态

2. 遍历所有 active 仪式:
   a. 日期变化（runtime.gameDay > state.lastCheckedDay）:
      - 计算跳过天数 dayGap = runtime.gameDay - state.lastCheckedDay
      - daily 条件: fulfilledToday === false → consecutiveMissed += dayGap；true → reset 0
      - 重置 fulfilledToday = false
      - 检查 failAfterMissed: consecutiveMissed >= N → status="failed", 执行 failureEffect
      - 更新 lastCheckedDay = runtime.gameDay

   b. autoInvoke === true → 检查全部条件，满足则 completed
```

## File Changes

| File | Change |
|------|--------|
| **NEW** `src/dynamicworldagent/engine/features/ritualFeature.ts` | Generic ritual feature |
| `src/dynamicworldagent/engine/registerDefaults.ts` | Add import + `registry.registerFeature(ritualFeature)` |
| `src/dynamicworldagent/engine/index.ts` | Add export |
| `data/Mods/Cassandra_zh/module_setup.json` | Add `ritualPresets` |
| `data/Mods/casssandra/module_setup.json` | Same |

Reference files:
- `src/dynamicworldagent/engine/features/fireFeature.ts` — activate/tick/stateDescription pattern
- `src/dynamicworldagent/engine/features/sanityFeature.ts` — applySanityLoss import, per-key state pattern
- `src/dynamicworldagent/engine/types.ts` — WorldFeature interface
- `src/dynamicworldagent/state/DynamicGameState.ts` — getFeatureSceneState/setFeatureSceneState

## Module Data: Cassandra Rituals

### gate_of_stars (Patrizio)

```json
{
  "ritualId": "gate_of_stars",
  "label": "群星之门仪式",
  "conductorNpcId": "Patrizio von Samsa",
  "siteSceneId": "SCN_2_SUB_3",
  "invokeType": "invoke",
  "autoInvoke": false,
  "conditions": [
    { "conditionId": "altar_maintenance", "label": "祭坛维护", "type": "daily", "triggerType": "maintain" },
    { "conditionId": "anchor_placement", "label": "锚点布置", "type": "cumulative", "requiredCount": 3, "triggerType": "sacrifice" },
    { "conditionId": "at_ritual_site", "label": "在仪式场地", "type": "prerequisite", "check": { "location": "SCN_2_SUB_3", "mode": "passive" } },
    { "conditionId": "has_portrait", "label": "持有诅咒画像", "type": "prerequisite", "check": { "item": "加塔诺托亚的诅咒画像", "mode": "passive" } },
    { "conditionId": "has_manuscript", "label": "持有仪式手稿", "type": "prerequisite", "check": { "item": "梦王会仪式手稿", "mode": "passive" } }
  ],
  "completionEffect": {
    "sceneConditions": [{ "sceneId": "SCN_2_SUB_3", "description": "[Ritual Complete] 群星之门已开——格赫罗斯的存在扭曲了整个地下空间" }],
    "witnessSanLoss": 8,
    "globalSanLoss": 5
  }
}
```

### atlach_nacha_web (Constantine)

```json
{
  "ritualId": "atlach_nacha_web",
  "label": "纳克亚蛛网仪式",
  "conductorNpcId": "Constantine Frollo",
  "siteSceneId": "SCN_17_SUB_3",
  "invokeType": "invoke",
  "autoInvoke": false,
  "conditions": [
    { "conditionId": "web_maintenance", "label": "蛛网维护仪式", "type": "daily", "triggerType": "maintain", "failAfterMissed": 3 },
    { "conditionId": "at_web_site", "label": "在蛛网密室", "type": "prerequisite", "check": { "location": "SCN_17_SUB_3", "mode": "passive" } }
  ],
  "failureEffect": {
    "sceneConditions": [{ "sceneId": "SCN_17_SUB_3", "description": "[Ritual Failed] 蛛网门户失去稳定——冷蛛开始不受控地涌入现实" }]
  }
}
```

## Verification

1. `pnpm build` — no compilation errors
2. Unit tests at `src/dynamicworldagent/engine/features/__tests__/ritualFeature.test.ts`:
   - Init from presets → correct condition states
   - activate + matching ritualConditionId → daily set true / cumulative incremented
   - activate + non-matching → no change
   - invoke + conditions not met → stays active
   - invoke + all met → status=completed, completionEffect fires
   - autoInvoke → auto-completes when conditions met
   - tick day change → daily fulfilledToday reset, consecutiveMissed incremented
   - failAfterMissed threshold → status=failed, failureEffect fires
   - prerequisite/manual → fulfilled tracks check result
   - prerequisite/passive → checked at invoke time
3. Integration: run simulation, verify NPC PlanNodes carry ritualId/ritualType/ritualConditionId overlays
