# Item Schema 扩展 + Asset/Item 功能物品库

## 概述

扩展现有 `Item` interface，增加 type 分类、weaponStats、consumableStats、containerStats 嵌套属性。在 `Asset/Item/` 下建立按类别组织的功能性物品模板库，作为模组作者复用的通用物品源。武器数据从 seedData.ts 迁移至 Asset/Item/weapons.json，成为唯一 source of truth。

## 现状

### 三套并行的物品表示

| 层 | 接口 | 位置 |
|---|---|---|
| 场景物品 | `Item` (id, name, description, isLightSource, lightLevel) | world_builder/types.ts |
| 角色武器 | `WeaponData` (name, skill, damage, range, attacksPerRound, ammo, malfunction, era) | gameTypes.ts |
| 角色背包 | `InventoryItem` (name, quantity, properties: Record) | gameTypes.ts |

- 武器数据 ~120 条存在 DB `weapons` 表（seedData.ts）
- 消耗品系统完全不存在
- `Item` 只有 isLightSource/lightLevel 两个功能字段

## Item Schema 扩展

```typescript
export interface Item {
  // 基础字段（现有）
  id: string;
  name: string;
  description?: string;
  damaged?: boolean;
  damageDetails?: { damagedBy: string; damagedAt: string; reason: string };

  // 新增：分类
  type: "weapon" | "consumable" | "tool" | "lighting" | "container" | "key" | "document" | "other";

  // 照明（现有字段保留）
  isLightSource?: boolean;
  lightLevel?: number;

  // 新增：武器属性
  weaponStats?: {
    skill: string;            // "Handgun", "Rifle", "Fighting (Brawl)"
    damage: string;           // "1d10", "1d6+DB"
    range: string;            // "15 yards", "touch"
    attacksPerRound: number;
    ammo?: number;            // 弹容量
    malfunction?: number;     // 故障率 %
    era?: string;             // "1920s", "modern", "1920s,modern"
  };

  // 新增：消耗品属性
  consumableStats?: {
    uses?: number;            // 可用次数（如急救包 3 次）
    effect?: string;          // 效果描述："恢复 1d3 HP", "照明 4 小时"
    duration?: number;        // 效果持续时间（分钟），0 = 即时
  };

  // 新增：容器属性
  containerStats?: {
    capacity?: number;        // 可容纳物品数量
    locked?: boolean;         // 是否上锁
    lockDifficulty?: string;  // 开锁难度："easy" | "regular" | "hard" | "extreme"
    contents?: string[];      // 预设内容物 item ID 列表
  };
}
```

## Asset/Item 目录结构

```
Asset/Item/
├── weapons.json        # 枪械、近战武器、投掷武器
├── consumables.json    # 急救包、药品、弹药、食物
├── lighting.json       # 手电筒、蜡烛、油灯、火柴
├── tools.json          # 开锁工具、绳索、望远镜
├── containers.json     # 保险箱、箱子、背包、抽屉
├── documents.json      # 地图、笔记本、报纸
└── keys.json           # 钥匙、ID卡、通行证
```

每个文件是一个 JSON 数组，内含该类所有物品模板。

### 物品模板示例

**weapons.json（部分）：**
```json
[
  {
    "id": "WPN_HANDGUN_COLT_1911",
    "name": "Colt M1911",
    "description": ".45口径半自动手枪，美军制式配枪，可靠耐用。",
    "type": "weapon",
    "weaponStats": {
      "skill": "Handgun",
      "damage": "1d10+2",
      "range": "15 yards",
      "attacksPerRound": 1,
      "ammo": 7,
      "malfunction": 100,
      "era": "1920s,modern"
    }
  }
]
```

**consumables.json（部分）：**
```json
[
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
]
```

**lighting.json（部分）：**
```json
[
  {
    "id": "LIGHT_CANDLE",
    "name": "蜡烛",
    "description": "普通蜡烛，提供微弱的照明。",
    "type": "lighting",
    "isLightSource": true,
    "lightLevel": 1,
    "consumableStats": {
      "uses": 1,
      "effect": "照明半径 2 米",
      "duration": 240
    }
  }
]
```

**containers.json（部分）：**
```json
[
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
]
```

## ID 命名规则

| 类型 | 前缀 | 示例 |
|---|---|---|
| 武器 | WPN_ | WPN_HANDGUN_COLT_1911 |
| 消耗品 | CONS_ | CONS_FIRSTAID_KIT |
| 照明 | LIGHT_ | LIGHT_FLASHLIGHT |
| 工具 | TOOL_ | TOOL_LOCKPICK_SET |
| 容器 | CONT_ | CONT_SAFE_SMALL |
| 文件 | DOC_ | DOC_NEWSPAPER |
| 钥匙 | KEY_ | KEY_MASTER |

## 与现有系统的关系

### 迁移 seedData 武器

seedData.ts 中 ~120 条武器 → 迁移到 weapons.json，字段一一对应：
- `[name, skill, damage, range, attacksPerRound, ammo, malfunction, era]` → `weaponStats`
- 补充 `id`（WPN_ 前缀 + 规范化名称）和 `description`

### 不改的部分

- DB `weapons` 表和 Prisma model（后续迁移）
- `InventoryItem` 背包系统
- combat 弹药消耗逻辑
- 前端 UI
- seedData.ts（保留兼容，weapons.json 为新的 source of truth）

## 物品覆盖范围

### weapons.json
- 手枪（~20 种）：Colt M1911, Webley, Luger, S&W 等
- 步枪（~15 种）：Springfield, Lee-Enfield, Mosin 等
- 霰弹枪（~8 种）：Remington M870, Winchester 等
- 冲锋枪（~8 种）：Thompson, MP18 等
- 近战武器（~15 种）：刀、棍棒、斧头、剑等
- 投掷武器（~5 种）：手雷、燃烧瓶、飞刀等
- 迁移自 seedData.ts 的全部 ~120 条

### consumables.json
- 医疗：急救包、绷带、吗啡、解毒剂
- 弹药：各口径弹药补给
- 食物/饮品：口粮、水壶、酒
- 化学品：酸液、氯仿、闪光粉

### lighting.json
- 蜡烛、火柴、打火机、油灯、手电筒、火把、灯笼

### tools.json
- 开锁工具、绳索、望远镜、指南针、撬棍、铁锹、照相机、录音机

### containers.json
- 保险箱、木箱、手提箱、背包、抽屉、信封、锁盒

### documents.json
- 报纸、笔记本、地图、信件、日记、护照、证件

### keys.json
- 钥匙、ID卡、通行证、密码条、令牌
