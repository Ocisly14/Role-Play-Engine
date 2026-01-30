# 技能名称版权风险分析
## 详细分类：哪些技能名称需要修改

### 🟢 Level 1: 通用技能（无需修改，零风险）

这些技能名称是**通用的**，任何TRPG/RPG都会使用，不存在侵权风险：

#### 体能类
- ✅ Swimming / Swim（游泳）
- ✅ Climbing / Climb（攀爬）
- ✅ Running（跑步）
- ✅ Jumping / Jump（跳跃）
- ✅ Riding（骑术）
- ✅ Driving（驾驶）
- ✅ Piloting（飞行）

#### 战斗类
- ✅ Melee Combat（近战）
- ✅ Unarmed Combat（徒手战斗）
- ✅ Shooting（射击）
- ✅ Archery（弓术）
- ✅ Throwing（投掷）

#### 知识类
- ✅ History（历史）
- ✅ Medicine（医学）
- ✅ Biology（生物学）
- ✅ Chemistry（化学）
- ✅ Physics（物理）
- ✅ Astronomy（天文学）
- ✅ Geology（地质学）
- ✅ Archaeology（考古学）
- ✅ Anthropology（人类学）
- ✅ Law（法律）
- ✅ Accounting（会计）
- ✅ Art（艺术）
- ✅ Music（音乐）

#### 社交类
- ✅ Persuasion（说服）
- ✅ Intimidation（威吓）
- ✅ Deception（欺骗）
- ✅ Negotiation（谈判）

#### 感知类
- ✅ Listening / Hearing（听觉）
- ✅ Observation（观察）
- ✅ Tracking（追踪）

**结论**：这些可以**保持不变**，因为它们是游戏界的通用词汇。

---

### 🟡 Level 2: CoC特色命名（建议修改，中风险）

这些技能虽然概念通用，但**CoC使用了独特的命名方式**：

| CoC 7e 名称 | 风险分析 | 建议替换 | 理由 |
|------------|---------|---------|------|
| **Spot Hidden** | 🟡 中风险 | Perception / Notice / Search | "Spot Hidden"是CoC独创的命名方式，其他游戏通常用"Perception" |
| **Fast Talk** | 🟡 中风险 | Bluff / Quick Talk / Smooth Talk | "Fast Talk"是CoC特有术语 |
| **Credit Rating** | 🟡 中风险 | Social Status / Wealth / Reputation | CoC特有的社会地位系统 |
| **Fighting (Brawl)** | 🟡 低-中风险 | Brawling / Unarmed Combat | 格式是CoC特有的技能分类方式 |
| **Firearms (Handgun)** | 🟡 低-中风险 | Pistol / Handgun Shooting | 同上 |
| **Library Use** | 🟡 中风险 | Research / Library Research / Information Gathering | "Library Use"是CoC特色表述 |
| **Psychoanalysis** | 🟡 低风险 | Psychoanalysis / Psychology | 可保留，但如果与CoC的SAN恢复机制绑定则需改 |
| **Mechanical Repair** | 🟡 低风险 | Mechanics / Repair / Engineering | 可改可不改 |
| **Electrical Repair** | 🟡 低风险 | Electronics / Electrical Engineering | 可改可不改 |

**关键点**：
- 如果只是偶尔使用1-2个相似名称，风险很低
- 如果**整个技能系统都照搬CoC的命名**，风险较高
- 建议至少修改**标志性的CoC术语**（如Spot Hidden、Fast Talk、Credit Rating）

---

### 🔴 Level 3: CoC专有术语（必须修改，高风险）

这些是**CoC系统特有的**，其他游戏基本不会用：

| CoC 7e 名称 | 风险等级 | 说明 |
|------------|---------|------|
| **Cthulhu Mythos** | 🔴 高风险 | CoC的核心技能，代表对邪神知识的了解。必须改名。 |
| **Sanity (SAN)** | 🔴 高风险 | "Sanity"作为可量化的属性是CoC的标志性机制。 |
| **Magic Points (MP)** | 🟡 中风险 | 虽然很多游戏有MP，但在CoC语境下与POW绑定。 |
| **Luck** | 🟡 低-中风险 | CoC 7e引入的特殊属性，可保留但建议重命名。 |

#### 必须修改的技能和属性：

```typescript
// ❌ CoC专有术语
"Cthulhu Mythos"  → ✅ "Forbidden Knowledge" / "Eldritch Lore" / "Dark Secrets"
"Sanity (SAN)"    → ✅ "Mental Stability" / "Clarity" / "Composure" / "Sanity Points"
"Magic Points"    → ✅ "Essence" / "Focus" / "Willpower Reserve"

// 注意："Sanity"这个词本身是通用的，但作为"可量化的游戏属性"则与CoC强关联
// 建议：
// - 可以用"Mental Stability"等替代词
// - 如果坚持用"Sanity"，确保机制描述与CoC不同
```

---

### 🔵 Level 4: 技能分类和格式（建议调整）

CoC使用了**特定的技能分类格式**：

```typescript
// CoC 7e 的格式：
"Firearms (Handgun)"
"Firearms (Rifle)"
"Firearms (Shotgun)"
"Science (Biology)"
"Science (Chemistry)"
"Art/Craft (Photography)"

// 这种"技能(专精)"的格式是CoC的标志性设计
```

**建议**：
- 可以保留分类概念，但改变格式
- 或者直接用独立技能名

```typescript
// 替代方案1：改变格式
"Handgun Shooting"
"Rifle Shooting"
"Shotgun Use"

// 替代方案2：更自然的命名
"Pistol"
"Rifle"
"Shotgun"

// 替代方案3：保留但改名
"Shooting: Handgun"
"Shooting: Rifle"
```

---

## 🎓 特殊情况：知识技能

### 通用知识（可直接使用）

```typescript
// ✅ 完全安全的知识技能：
"Biology" / "Marine Biology"
"Chemistry"
"Physics"
"Geology"
"History"
"Medicine"
"Law"
"Engineering"
"Anthropology"
"Archaeology"
```

这些是**真实学科名称**，任何人都可以在游戏中使用。

### CoC特色知识（建议调整）

```typescript
// ⚠️ CoC特有的知识技能格式和内容：
"Cthulhu Mythos"           → ❌ 必须改（CoC专有）
"Occult"                   → ⚠️ 可保留（通用词汇，但在CoC语境下有特殊含义）
"Science (Parapsychology)" → ✅ 可保留（真实学科）

// 建议替换：
"Cthulhu Mythos" → "Forbidden Lore" / "Eldritch Knowledge" / "Dark Secrets"
```

---

## 📊 实际建议：分层修改策略

### 策略A：最小修改（快速商业化）

**只改必须改的**，降低80%风险：

```typescript
// 第一优先级：修改这些标志性术语
const mustChange = {
  "Spot Hidden": "Perception",
  "Fast Talk": "Bluff",
  "Credit Rating": "Social Status",
  "Cthulhu Mythos": "Forbidden Lore",
  "Sanity": "Mental Stability"
};

// 其他通用技能保持不变
const keepAsIs = [
  "Swimming", "Climbing", "Medicine", "History", 
  "Persuasion", "Intimidation", "Biology", "Chemistry"
];
```

**风险评估**：从 6/10 降至 2/10

---

### 策略B：全面独立（长期品牌）

**创建完全独立的技能系统**：

1. 重新设计技能分类
2. 所有技能使用你自己的命名
3. 创建独特的机制绑定

```typescript
// 示例：你自己的技能系统
const yourSkillSystem = {
  // 观察类
  awareness: ["Perception", "Hearing", "Investigation"],
  
  // 社交类
  influence: ["Charm", "Intimidate", "Deceive", "Bargain"],
  
  // 知识类
  sciences: ["Biology", "Chemistry", "Physics", "Medicine"],
  lore: ["History", "Anthropology", "Forbidden Knowledge"],
  
  // 体能类
  athletics: ["Running", "Climbing", "Swimming", "Acrobatics"],
  
  // 战斗类
  combat: ["Brawling", "Pistol", "Rifle", "Knife"]
};
```

**风险评估**：接近 0/10

---

## ✅ 你当前项目的风险评估

让我检查你的代码中使用了哪些技能名称：

### 在你的模组中：

```json
// 从你的模组摘要中看到的技能：
"Swim"              → ✅ 通用，无需改
"Dive"              → ✅ 通用，无需改  
"Spot Hidden"       → ⚠️ CoC特色，建议改为"Perception"
"Persuade"          → ✅ 通用，可保留
"Charm"             → ✅ 通用，可保留
"Science (Marine)"  → ⚠️ CoC格式，建议改为"Marine Biology"
"Biology"           → ✅ 通用，无需改
```

**当前风险**：3/10（主要是"Spot Hidden"和技能格式）

### 快速修改脚本

如果你想批量替换，我可以帮你写一个：

```typescript
// 批量替换技能名称的映射表
const skillNameMapping = {
  // 必须改的
  "Spot Hidden": "Perception",
  "Fast Talk": "Bluff",
  "Credit Rating": "Social Status",
  "Cthulhu Mythos": "Forbidden Lore",
  "Sanity": "Mental Stability",
  
  // 建议改的（CoC格式）
  "Science (Marine)": "Marine Biology",
  "Science (Biology)": "Biology",
  "Firearms (Handgun)": "Pistol",
  "Fighting (Brawl)": "Brawling",
  
  // 通用的（可选改）
  "Persuade": "Persuasion",
  "Charm": "Charisma"
};
```

---

## 🎯 最终答案

### 你的问题："技能知识都算（侵权）？"

**答案**：

1. **技能概念本身** → ✅ 不侵权（游戏机制不受版权保护）
2. **通用技能名称**（如Swimming、Medicine）→ ✅ 不侵权
3. **CoC特色命名**（如Spot Hidden、Fast Talk）→ ⚠️ 建议修改
4. **CoC专有术语**（如Cthulhu Mythos、Sanity作为属性）→ ❌ 必须修改

### 知识技能：

- ✅ **真实学科名称**（Biology、Chemistry、History）→ 完全安全
- ⚠️ **CoC特有格式**（"Science (Marine)"）→ 建议改为"Marine Biology"
- ❌ **CoC专有知识**（"Cthulhu Mythos"）→ 必须改名

---

## 💡 我的建议

**最划算的做法**：

1. ✅ 保留所有通用技能名称（如Swimming、Biology、Medicine）
2. ⚠️ 修改5-10个标志性CoC术语（如Spot Hidden → Perception）
3. ❌ 移除"Cthulhu Mythos"技能，改为"Forbidden Lore"
4. 📝 在机制描述中使用你自己的语言

这样既能保持游戏可玩性，又能大幅降低法律风险。

需要我帮你：
1. 写一个自动化脚本批量替换技能名称？
2. 生成完整的独立技能系统设计？
3. 检查你代码中所有的技能引用？
