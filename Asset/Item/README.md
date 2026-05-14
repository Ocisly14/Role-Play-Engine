# Asset/Item 物品模板库

功能性物品模板库，供模组作者和世界生成器复用。每个 JSON 文件是一个数组，包含该类别的所有物品模板。

**非功能性物品**（纯装饰/氛围物品如画框、地毯、花瓶等）不在此库中，由 LLM 在运行时按场景需要自动生成。

---

## Item Schema

所有物品遵循 `src/dynamicworldagent/world_builder/types.ts` 中的 `Item` 接口：

```typescript
interface Item {
  id: string;
  name: string;
  description?: string;
  type?: "weapon" | "consumable" | "tool" | "lighting" | "container" | "key" | "document" | "other";
  era?: string;
  damaged?: boolean;
  damageDetails?: { damagedBy: string; damagedAt: string; reason: string };
  isLightSource?: boolean;
  lightLevel?: number;
  weaponStats?: WeaponStats;
  consumableStats?: ConsumableStats;
  containerStats?: ContainerStats;
}
```

---

## 文件结构

| 文件 | type 值 | ID 前缀 | 数量 | 说明 |
|---|---|---|---|---|
| `weapons.json` | `"weapon"` | `WPN_` | 105 | 从 seedData.ts 迁移的全部武器 |
| `consumables.json` | `"consumable"` | `CONS_` | 47 | 医疗、弹药、电子耗材、食物、烟草等 |
| `lighting.json` | `"lighting"` | `LIGHT_` | 32 | 所有光源（便携式 + 场景固定式） |
| `tools.json` | `"tool"` | `TOOL_` | 56 | 开锁、数码设备、通讯、测量等功能工具 |
| `containers.json` | `"container"` | `CONT_` | 39 | 保险箱、箱包、档案柜、证物容器等 |
| `documents.json` | `"document"` | `DOC_` | 46 | 报纸、日记、案件档案、电子时代信息载体等 |
| `keys.json` | `"key"` | `KEY_` | 20 | 钥匙、通行证、门禁卡、遥控器等 |
| `other.json` | `"other"` | `OTH_` | 9 | 可复用的公共基础设施与环境功能物件 |

---

## ID 命名规则

`{前缀}_{子类别}_{规范化名称}`

- 前缀对应物品类型（见上表）
- 子类别用于武器分类：`MELEE_`, `RANGED_`, `THROWN_`, `HANDGUN_`, `RIFLE_`, `SHOTGUN_`, `ASSAULT_`, `SMG_`, `MG_`, `EXPLOSIVE_`
- 名称大写，空格替换为 `_`，去除特殊字符

示例：
- `WPN_HANDGUN_45_AUTO` — .45 口径自动手枪
- `CONS_FIRSTAID_KIT` — 急救包
- `LIGHT_STREET_LAMP` — 路灯
- `CONT_SAFE_SMALL` — 小型保险箱
- `OTH_WARNING_SIGN` — 警示牌

非武器物品如需限制时代，使用顶层 `era` 字段；武器继续使用 `weaponStats.era`。

---

## 各类型字段标准

### 1. weapon（武器）

必填字段：`id`, `name`, `type: "weapon"`, `weaponStats`

```json
{
  "id": "WPN_HANDGUN_45_AUTO",
  "name": ".45 Auto Pistol",
  "description": ".45口径自动手枪（如柯尔特M1911），美军制式配枪。",
  "type": "weapon",
  "weaponStats": {
    "skill": "Pistol",
    "damage": "1d10+2",
    "range": "15 yards",
    "attacksPerRound": 3,
    "ammo": 7,
    "malfunction": 100,
    "era": "1920s,modern"
  }
}
```

**weaponStats 字段说明：**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `skill` | string | 是 | 使用技能：`Brawling`, `Pistol`, `Rifle`, `Submachine Gun`, `Machine Gun`, `Bow`, `Axe`, `Sword`, `Spear`, `Whip`, `Throw`, `Demolitions`, `Heavy Weapon`, `Artillery`, `Flamethrower`, `Electrical Repair` |
| `damage` | string | 是 | 伤害公式，如 `"1d10+2"`, `"2d6+DB"`, `"4d6/2d6/1d6"`（霰弹枪近/中/远距离伤害） |
| `range` | string | 是 | 射程：`"touch"`（近战）, `"15 yards"`, `"STR feet"`（投掷）, `"placed"`（布设） |
| `attacksPerRound` | number | 是 | 每轮攻击次数。`1` = 单发, `3` = 半自动/速射, `999` = 全自动持续射击 |
| `ammo` | number | 否 | 弹匣/弹仓容量。近战武器省略此字段 |
| `malfunction` | number | 否 | 故障阈值（百分骰）。投出 ≥ 此值时武器故障。`100` = 极可靠, `93` = 故障率 7%。省略表示不会故障 |
| `era` | string | 否 | 可用时代：`"1920s"`, `"modern"`, `"1920s,modern"`, `"rare"`, `"WWII+"` |

**武器子类别标准：**

| 子类别 | 判断依据 |
|---|---|
| `MELEE_` | skill 为 Brawling/Axe/Sword/Spear/Whip，range 为 touch |
| `RANGED_` | skill 为 Bow |
| `THROWN_` | skill 为 Throw |
| `HANDGUN_` | skill 为 Pistol |
| `RIFLE_` | skill 为 Rifle，damage 不含 `/`（非霰弹枪），attacksPerRound ≤ 2 |
| `SHOTGUN_` | skill 为 Rifle，damage 含 `/`（近/中/远距离伤害格式） |
| `ASSAULT_` | skill 为 Rifle，attacksPerRound ≥ 3，era 含 modern |
| `SMG_` | skill 为 Submachine Gun |
| `MG_` | skill 为 Machine Gun |
| `EXPLOSIVE_` | skill 为 Demolitions/Heavy Weapon/Artillery/Flamethrower/Throw（投掷爆炸物）/Electrical Repair，或 range 为 placed |

---

### 2. consumable（消耗品）

必填字段：`id`, `name`, `type: "consumable"`, `consumableStats`

```json
{
  "id": "CONS_FIRSTAID_KIT",
  "name": "急救包",
  "description": "标准急救包，包含绷带、消毒液和止痛药。",
  "type": "consumable",
  "consumableStats": {
    "uses": 3,
    "effect": "急救检定成功恢复 1d3 HP",
    "duration": 0
  }
}
```

**consumableStats 字段说明：**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `uses` | number | 否 | 可使用次数。省略表示无限使用 |
| `effect` | string | 否 | 效果描述（中文），说明使用后的游戏机制效果 |
| `duration` | number | 否 | 效果持续时间（分钟）。`0` = 即时效果，省略同 `0` |

**消耗品子类别：**

| 子类别 | 包含 |
|---|---|
| 医疗 | 急救包、绷带、吗啡、解毒剂、嗅盐、手术包、输血套件、草药 |
| 药物 | 鸦片酊、镇静剂、兴奋剂、毒药、乙醚、氯仿 |
| 弹药 | 手枪/步枪/霰弹枪弹药盒、箭矢、弩箭、信号弹 |
| 化学品 | 酸液、闪光粉、烟雾弹、圣水、煤油 |
| 烟草 | 香烟、烟斗烟草 |
| 食物/饮品 | 口粮、水壶、威士忌、咖啡 |
| 杂项 | 墨水、粉笔、线香、电池 |

---

### 3. lighting（照明）

必填字段：`id`, `name`, `type: "lighting"`, `isLightSource: true`, `lightLevel`

```json
{
  "id": "LIGHT_OIL_LAMP",
  "name": "油灯",
  "description": "煤油灯，提供稳定温暖的照明，需要定期补充燃料。",
  "type": "lighting",
  "isLightSource": true,
  "lightLevel": 3,
  "consumableStats": {
    "uses": 1,
    "effect": "照明半径 5 米",
    "duration": 480
  }
}
```

**lightLevel 等级标准（1-5）：**

场景最终光照等级 = 场景内所有光源 lightLevel 的**最大值**。

| Level | 标签 | 含义 | 技能惩罚 | 分配给 |
|---|---|---|---|---|
| **1** | Pitch black（漆黑） | 完全无光 | 感知 -40%, 射击 -40%, 导航 -30%, 研究 -50% | **不分配给任何光源**——代表"没有光源" |
| **2** | Dark（昏暗） | 微弱光线，仅能看清近处轮廓 | 感知 -20%, 射击 -20%, 导航 -15%, 研究 -20% | 蜡烛、火柴、打火机、煤油暖炉 |
| **3** | Normal（正常） | 标准室内/傍晚照明 | **无惩罚** | 烛台、油灯、煤气灯、手电筒、火把、提灯、壁灯、台灯、落地灯、煤气路灯、壁炉、篝火、霓虹灯 |
| **4** | Bright（明亮） | 充足光线，白天/强电灯 | **无惩罚** | 吊灯、顶灯、日光灯管、路灯、车头灯 |
| **5** | Blinding（致盲） | 极强光源，刺目难以直视 | 感知 -15%, 射击 -15% | 照明弹 |

**便携 vs 固定光源：**

- **便携光源**（可携带/点燃/熄灭）：需要 `consumableStats`，指定 `uses`（使用次数）和 `duration`（持续分钟数）
- **固定光源**（建筑设施）：不需要 `consumableStats`，如台灯、吊灯、路灯等。这些光源可被 `damaged: true` 标记为损坏（灯泡碎了、电线断了）

---

### 4. tool（工具）

必填字段：`id`, `name`, `type: "tool"`

```json
{
  "id": "TOOL_LOCKPICK_SET",
  "name": "开锁工具套件",
  "description": "专业的开锁工具套件，包含各种撬锁针和扭力扳手。",
  "type": "tool"
}
```

工具类物品通常没有额外的嵌套属性。功能性效果由 LLM 在游戏运行时根据上下文判断（如使用开锁工具 → 触发 Locksmith 检定）。

**工具子类别：**

| 子类别 | 包含 |
|---|---|
| 破拆/进入 | 撬棍、开锁工具、钢丝钳、十字镐 |
| 绳索/攀爬 | 绳索、抓钩、梯子 |
| 观察/调查 | 望远镜、放大镜、镜子 |
| 记录/通讯 | 照相机、录音机、电话、收音机、打字机 |
| 约束 | 手铐、铁链、挂锁 |
| 计时/导航 | 怀表、闹钟、指南针 |
| 通用工具 | 工具箱、锤子、锯子、钳子、扳手、铁锹 |
| 其他 | 哨子、铃铛、雨伞、缝纫工具、钓鱼竿 |

---

### 5. container（容器）

必填字段：`id`, `name`, `type: "container"`, `containerStats`

```json
{
  "id": "CONT_SAFE_SMALL",
  "name": "小型保险箱",
  "description": "一个沉重的金属保险箱，需要密码或钥匙才能打开。",
  "type": "container",
  "containerStats": {
    "capacity": 5,
    "locked": true,
    "lockDifficulty": "hard",
    "contents": []
  }
}
```

**containerStats 字段说明：**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `capacity` | number | 否 | 可容纳物品数量 |
| `locked` | boolean | 否 | 是否上锁。`true` 需要钥匙或开锁检定 |
| `lockDifficulty` | string | 否 | 开锁难度（当 `locked: true` 时设置） |
| `contents` | string[] | 否 | 预设内容物的 item ID 列表。模板中通常为空数组，实际使用时填充 |

**lockDifficulty 等级：**

| 等级 | 说明 | 对应 Locksmith 检定 |
|---|---|---|
| `"easy"` | 简单锁（抽屉、邮箱） | 普通成功即可 |
| `"regular"` | 标准锁（文件柜、锁盒、储物柜） | 需要普通成功 |
| `"hard"` | 困难锁（保险箱、证物柜） | 需要困难成功 |
| `"extreme"` | 极难锁（大型保险箱、银行金库） | 需要极难成功 |

---

### 6. document（文件）

必填字段：`id`, `name`, `type: "document"`

```json
{
  "id": "DOC_POLICE_REPORT",
  "name": "警察报告",
  "description": "官方警察报告，记录了案件详情和调查进展。",
  "type": "document"
}
```

文件类物品是信息载体。模板只定义物品的通用形态，具体内容（报纸写了什么、日记记录了什么）由 LLM 在模组生成或游戏运行时填充到 `description` 中。

**注意：** 神秘典籍（`DOC_OCCULT_GRIMOIRE`）等可能触发理智检定的文件，其效果由游戏逻辑处理，不在 Item schema 中定义。

---

### 7. key（钥匙/通行凭证）

必填字段：`id`, `name`, `type: "key"`

```json
{
  "id": "KEY_ROOM",
  "name": "房间钥匙",
  "description": "旅馆或建筑的房间钥匙，附有房号标牌。",
  "type": "key"
}
```

钥匙类物品用于解锁 `locked: true` 的容器或场景连接。模板定义通用形态，具体对应哪把锁由模组数据决定。

---

## 通用字段说明

### damaged（损坏状态）

任何物品都可以被标记为损坏：

```json
{
  "damaged": true,
  "damageDetails": {
    "damagedBy": "fire",
    "damagedAt": "SCN_5_SUB_1",
    "reason": "被火灾烧毁"
  }
}
```

- 损坏的光源（`damaged: true` + `isLightSource: true`）不再提供照明
- 损坏的武器无法使用
- 损坏的容器可能无法正常开关

### description（描述）

- 模板中的 description 是**通用描述**，说明物品的外观和基本用途
- 实际场景中可由 LLM 替换为更具体的场景化描述
- 武器描述使用中文
- description 是可选字段，但建议始终提供

### era（时代标签）

- 非武器物品可使用顶层 `era` 字段，如 `"1920s"`、`"modern"`、`"1920s,modern"`、`"2000s"`
- 武器仍使用 `weaponStats.era`，不要重复在顶层填写
- `2000s` 用于明确带有数码化、电子门禁、移动通讯或当代办公特征的物品
- 若物品横跨多个时代可写逗号分隔值，如 `"1920s,modern"`

### 2000 年代扩充原则

- 优先收录调查、追踪、通讯、出行、取证中高频出现的功能性物品
- “设备”归入 `tool`，如手机、笔记本电脑、GPS、读卡器
- “信息载体”归入 `document`，如打印邮件、监控录像光盘、银行对账单
- “电子门禁/通行凭证”归入 `key`，如门禁卡、房卡、遥控器
- “箱包/收纳载体”归入 `container`，如电脑包、证物袋、硬盘收纳盒
- “会被消耗或替换的耗材”归入 `consumable`，如存储卡、墨盒、SIM 卡、电池组

---

## 使用方式

### 模组作者

在场景 JSON 的 `items` 数组中引用模板，可按需修改 `id`、`description` 和属性值：

```json
{
  "items": [
    {
      "id": "ITEM_SCN5_LAMP",
      "name": "台灯",
      "description": "书桌上一盏老旧的铜质台灯，灯罩边缘有烧焦的痕迹。",
      "type": "lighting",
      "isLightSource": true,
      "lightLevel": 3
    }
  ]
}
```

### 世界生成器

生成场景时从模板库中选择合适的物品，根据场景上下文调整 `description` 和具体参数。
