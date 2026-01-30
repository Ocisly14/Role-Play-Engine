# Terminology Migration Guide
## 从CoC术语迁移到独立品牌术语

### 核心概念替换

| CoC 7e 术语 | 替换术语（建议） | 使用场景 |
|------------|----------------|---------|
| **Investigator** | **Character** / **Explorer** | 玩家角色 |
| **Keeper** | **Game Master (GM)** / **Narrator** | 游戏主持人 |
| **Keeper Guidance** | **GM Notes** / **Director's Guide** | 模组指引 |
| **Scenario** | **Adventure** / **Module** / **Story** | 剧本 |
| **Session** | **Game Session** / **Play Session** | 游戏会话 |

### 技能名称重设计

#### 调查类技能
| CoC 7e | 新系统 | 说明 |
|--------|--------|------|
| Spot Hidden | **Perception** / **Notice** | 观察力 |
| Listen | **Hearing** / **Awareness** | 听觉 |
| Library Use | **Research** | 研究 |
| Track | **Tracking** | 追踪 |

#### 社交类技能
| CoC 7e | 新系统 | 说明 |
|--------|--------|------|
| Persuade | **Influence** / **Convince** | 说服 |
| Charm | **Charisma** / **Rapport** | 魅力 |
| Intimidate | **Intimidation** / **Threaten** | 威吓 |
| Fast Talk | **Bluff** / **Deceive** | 欺骗 |

#### 知识类技能
| CoC 7e | 新系统 | 说明 |
|--------|--------|------|
| Science (Marine) | **Marine Biology** / **Oceanography** | 海洋科学 |
| Occult | **Forbidden Lore** / **Esoteric Knowledge** | 神秘学 |
| History | **Historical Knowledge** | 历史 |
| Medicine | **Medical Training** | 医学 |

#### 体能类技能
| CoC 7e | 新系统 | 说明 |
|--------|--------|------|
| Dodge | **Evasion** / **Avoid** | 闪避 |
| Stealth | **Sneaking** / **Concealment** | 潜行 |
| Climb | **Climbing** | 攀爬 |
| Swim | **Swimming** | 游泳 |
| Jump | **Jumping** / **Leap** | 跳跃 |

#### 战斗类技能
| CoC 7e | 新系统 | 说明 |
|--------|--------|------|
| Fighting (Brawl) | **Unarmed Combat** / **Melee** | 徒手战斗 |
| Firearms (Handgun) | **Pistol** / **Sidearm** | 手枪 |
| Firearms (Rifle) | **Rifle** / **Long Gun** | 步枪 |
| Throw | **Throwing** | 投掷 |

### 机制术语替换

| CoC 7e | 新系统 | 说明 |
|--------|--------|------|
| **Regular Success** | **Success** | 普通成功 |
| **Hard Success** | **Strong Success** / **Good Result** | 困难成功 |
| **Extreme Success** | **Exceptional Success** / **Outstanding Result** | 极难成功 |
| **Critical Success** | **Perfect Success** / **Critical** | 大成功 |
| **Fumble** | **Critical Failure** / **Disaster** | 大失败 |
| **Pushed Roll** | **Second Attempt** / **Risky Retry** | 强制重投 |
| **Bonus Die** | **Advantage Die** | 奖励骰 |
| **Penalty Die** | **Disadvantage Die** | 惩罚骰 |

### 属性名称

| CoC 7e | 新系统 | 缩写 |
|--------|--------|-----|
| **STR** (Strength) | **Strength** | STR |
| **CON** (Constitution) | **Endurance** / **Vitality** | END |
| **SIZ** (Size) | **Build** / **Physique** | BLD |
| **DEX** (Dexterity) | **Agility** / **Dexterity** | AGI |
| **APP** (Appearance) | **Presence** / **Appearance** | PRE |
| **INT** (Intelligence) | **Intellect** / **Mind** | INT |
| **POW** (Power) | **Willpower** / **Resolve** | WIL |
| **EDU** (Education) | **Knowledge** / **Education** | KNW |
| **SAN** (Sanity) | **Mental Stability** / **Clarity** | STA |
| **Luck** | **Fortune** / **Luck** | LCK |
| **Magic Points** | **Essence** / **Focus Points** | ESS |

### 模组结构字段

#### module_digest.json
```json
{
  // ❌ CoC术语
  "keeperGuidance": "...",
  "moduleNotes": "Investigators should...",
  
  // ✅ 独立术语
  "gmNotes": "...",
  "playerGuidance": "Characters should...",
  "moduleDescription": "..."
}
```

### 实施步骤

1. **Phase 1: 核心术语替换**
   - [ ] 替换所有"Investigator" → "Character"
   - [ ] 替换所有"Keeper" → "Game Master" / "GM"
   - [ ] 更新`module_digest.json`字段名

2. **Phase 2: 技能系统重命名**
   - [ ] 更新技能名称映射表
   - [ ] 修改角色创建界面
   - [ ] 更新数据库schema

3. **Phase 3: 机制描述改写**
   - [ ] 重写规则说明（避免与CoC规则书文本相似）
   - [ ] 使用你自己的语言描述检定方式

4. **Phase 4: 品牌化**
   - [ ] 选择项目新名称（不含"CoC"）
   - [ ] 创建独立的游戏标识
   - [ ] 添加免责声明

## 免责声明模板

```markdown
## Legal Notice

This game is inspired by the cosmic horror fiction of H.P. Lovecraft, 
whose works are in the public domain. This is an independent product 
and is not affiliated with, endorsed by, or licensed by Chaosium Inc. 
or any other trademark or copyright holder.

本游戏受H.P.洛夫克拉夫特的宇宙恐怖文学启发，其作品属于公有领域。
本产品为独立创作，不隶属于Chaosium Inc.或其他商标/版权持有者，
未获得其认可或授权。

Game mechanics and content © 2025 [Your Company Name]. All rights reserved.
```

## 已完成的替换（2025-01 批量修改）

以下名称已在代码库中统一替换：

- **技能**: Spot Hidden → Perception, Fast Talk → Bluff, Credit Rating → Social Status, Cthulhu Mythos → Forbidden Lore, Library Use → Research, Science (Biology/Chemistry/Physics) → Biology/Chemistry/Physics, Fighting (Brawl) → Brawling, Firearms (Handgun) → Pistol, Firearms (Rifle/Shotgun) → Rifle 等
- **默认角色名**: Investigator → Character
- **提示/模板中的用语**: Keeper → GM, Investigator → Character（在面向玩家的模板中）

**注意**：若你已有 SQLite 数据库或旧模组 JSON，其中的技能名可能仍是旧版。需要时请重新执行 seed（或手动更新 DB/JSON）以使用新技能名。

## 检查清单

- [x] 技能名称已替换（见上）
- [ ] 所有模组文件中的"Investigator"已替换（仅剩用户自建模组需自查）
- [ ] 所有"Keeper"术语已改为"GM"或"Narrator"
- [ ] 技能名称使用独立体系
- [ ] 机制描述使用原创文字
- [ ] 添加了适当的免责声明
- [ ] 项目名称不含"Call of Cthulhu"或"CoC"
- [ ] 市场材料不暗示官方授权
