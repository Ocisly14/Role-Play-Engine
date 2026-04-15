# Skill Definitions & Interpreter Enhancement — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create ~65 skill definition `.md` files, update the loader to read them from `skills/` subdirectory, and enhance GameInterpreter to select from ~72 definitions (7 general + ~65 skill).

**Architecture:** Each CoC 7e skill becomes an ActionDefinition with its own skillCheck config, outputSchema, interpreter examples, and resolution guidance. The loader scans both root and `skills/` directories. The interpreter prompt is restructured to handle the larger definition set by grouping definitions by category.

**Tech Stack:** TypeScript, YAML frontmatter, Vitest

**Note:** This is Plan A of 2. Plan B (planning simplification + PlanNode cleanup) will be written after this is complete.

---

## File Structure

**New files (~65):**
- `src/engine/tool_definitions/skills/*.md` — one per CoC 7e skill

**New general definitions (3):**
- `src/engine/tool_definitions/conversation.md` — plain conversation (no skill check)
- `src/engine/tool_definitions/item_exchange.md` — give/receive items (no skill check)

**Modified files:**
- `src/engine/tool_definitions/loader.ts` — scan `skills/` subdirectory
- `src/engine/interpreter/gameInterpreter.ts` — restructure prompt for ~72 definitions
- `src/engine/interpreter/__tests__/gameInterpreter.test.ts` — update tests

**Note:** Existing definitions (`action.md`, `character_interaction.md`, `item_modify.md`, `item_assemble.md`, `item_disassemble.md`, `movement.md`) remain unchanged for now. They will be cleaned up in Plan B when planning simplification removes the `type` field.

---

### Task 1: Create Skill Definition Files — Interpersonal (5 files)

**Files:**
- Create: `src/engine/tool_definitions/skills/charm.md`
- Create: `src/engine/tool_definitions/skills/bluff.md`
- Create: `src/engine/tool_definitions/skills/intimidate.md`
- Create: `src/engine/tool_definitions/skills/persuade.md`
- Create: `src/engine/tool_definitions/skills/psychology.md`

All interpersonal skills are **opposed** rolls. They share the same stateDomains and outputSchema pattern.

- [ ] **Step 1: Create `skills/` directory**

Run: `mkdir -p src/engine/tool_definitions/skills`

- [ ] **Step 2: Create charm.md**

```markdown
---
id: charm
title: Charm
description: Being likeable, making friends, seduction — winning someone over with personality

skillCheck:
  skill: Charm
  difficulty: regular
  type: opposed
  opposedDefense: [Psychology, Charm]
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
    - "用魅力说服她帮忙"
    - "尝试用个人魅力赢得他的好感"
    - "Try to charm the receptionist into letting me pass"
---

# Charm Resolution Guidance

## On Success
- 目标对行动者产生好感，态度改善
- regular success: 目标变得友好，愿意提供基本帮助
- hard success: 目标对行动者产生信任，愿意做出超出日常的帮助
- extreme success: 目标完全被行动者吸引，主动提供信息或额外帮助
- 更新 relationship（正面 delta）

## On Failure
- 目标未被打动，可能觉得行动者虚伪
- 可能产生轻微负面 relationship 变化
- 不产生信息交换
```

- [ ] **Step 3: Create bluff.md**

```markdown
---
id: bluff
title: Bluff
description: Quick deception, misdirection, verbal tricks — lying convincingly in the moment

skillCheck:
  skill: Bluff
  difficulty: regular
  type: opposed
  opposedDefense: [Psychology, Perception]
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
    - "撒谎说自己是警察"
    - "编造一个理由骗过守卫"
    - "Bluff my way past the guard by pretending to be a doctor"
---

# Bluff Resolution Guidance

## On Success
- 目标相信了行动者的谎言
- regular success: 目标暂时相信，但可能事后起疑
- hard success: 目标完全相信
- extreme success: 目标不仅相信，还主动帮助行动者维持谎言
- 行动者获得 memory.information（记住自己说了什么谎）

## On Failure
- 目标识破谎言，态度变差
- relationship 负面变化
- 目标可能变得警惕或敌对（addConditions: ["suspicious"]）
```

- [ ] **Step 4: Create intimidate.md**

```markdown
---
id: intimidate
title: Intimidate
description: Frightening or coercing others through threats — physical or verbal intimidation

skillCheck:
  skill: Intimidate
  difficulty: regular
  type: opposed
  opposedDefense: [Psychology, Intimidate]
  failBehavior: abort

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, occupation, personality, stats, conditions]
      targets: [id, name, occupation, personality, stats, conditions, relationship]
  scene:
    inject: [current]
    fields: [id, name, description]

outputSchema:
  use:
    - character.condition
    - character.san
    - memory.event
    - memory.witness
    - relationship.change

interpreter:
  examples:
    - "威胁他说出真相"
    - "用拳头敲桌子恐吓对方"
    - "Threaten the shopkeeper to hand over the key"
---

# Intimidate Resolution Guidance

## On Success
- 目标被恐吓，服从行动者的要求
- regular success: 目标勉强服从，内心恐惧
- hard success: 目标完全屈服，可能颤抖或哭泣
- extreme success: 目标崩溃，可能丧失 1 点 SAN
- 目标获得 condition "frightened"
- relationship 负面变化

## On Failure
- 目标不为所动，可能变得愤怒或敌对
- relationship 负面变化
- 目标可能反过来对抗行动者
```

- [ ] **Step 5: Create persuade.md**

```markdown
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
    - "用道理劝他改变主意"
    - "Try to convince the officer to let me examine the crime scene"
---

# Persuade Resolution Guidance

## On Success
- 目标被说服，同意行动者的请求
- regular success: 目标勉强同意，可能附带条件
- hard success: 目标被完全说服
- extreme success: 目标不仅同意，还主动提供额外帮助或信息
- relationship 正面变化

## On Failure
- 目标拒绝，态度不变或轻微恶化
- 不产生信息交换
- 可能需要换一种方式尝试
```

- [ ] **Step 6: Create psychology.md**

```markdown
---
id: psychology
title: Psychology
description: Understanding human behavior, detecting lies, reading emotions and intentions

skillCheck:
  skill: Psychology
  difficulty: regular
  type: single
  failBehavior: partial

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, conditions]
      targets: [id, name, occupation, personality, conditions, relationship]
  scene:
    inject: [current]
    fields: [id, name, description]

outputSchema:
  use:
    - memory.event
    - memory.information

interpreter:
  examples:
    - "观察他说话时的表情判断是否在说谎"
    - "分析她的行为动机"
    - "Read the suspect's body language to see if they're hiding something"
---

# Psychology Resolution Guidance

## On Success
- 行动者对目标的心理状态获得洞察
- regular success: 判断出目标的基本情绪状态（紧张、放松、恐惧）
- hard success: 判断出目标是否在说谎或隐瞒
- extreme success: 深入理解目标的动机和意图
- 产生 memory.information（行动者的心理分析结论）

## On Failure
- 无法判断目标的心理状态
- 可能得出错误结论（产生错误的 memory.information）
```

- [ ] **Step 7: Verify definitions load correctly**

Run: `npx vitest run src/engine/resolver/__tests__/stateChangeTypes.test.ts`
Expected: PASS (definitions parseable)

- [ ] **Step 8: Commit**

```bash
git commit -m "feat: add interpersonal skill definitions (charm, bluff, intimidate, persuade, psychology)"
```

---

### Task 2: Create Skill Definition Files — Perception & Investigation (3 files)

**Files:**
- Create: `src/engine/tool_definitions/skills/perception.md`
- Create: `src/engine/tool_definitions/skills/listen.md`
- Create: `src/engine/tool_definitions/skills/track.md`

- [ ] **Step 1: Create perception.md**

```markdown
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
    - "Search the desk for hidden compartments"
---

# Perception Resolution Guidance

## On Success
- 发现一个或多个隐藏线索、物品或环境细节
- regular success: 发现比较明显的隐藏物
- hard success: 发现需要仔细观察才能注意到的细节
- extreme success: 发现关键证据或隐藏通道
- 可以通过 item.modify 更新物品的 discovered 状态
- 可以通过 scene.condition 添加新发现的环境细节

## On Failure
- 未发现任何隐藏物品或线索
- 不确定是真的没有还是没找到
- 不产生任何场景变更或物品变更
```

- [ ] **Step 2: Create listen.md**

```markdown
---
id: listen
title: Listen
description: Hearing sounds, eavesdropping, detecting noises from adjacent areas

skillCheck:
  skill: Listen
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
    fields: [id, name, description, conditions, connections]

outputSchema:
  use:
    - memory.event
    - memory.information
    - character.fatigue

interpreter:
  examples:
    - "贴在门上偷听里面的对话"
    - "仔细听周围有没有脚步声"
    - "Listen at the door to hear what they're saying"
---

# Listen Resolution Guidance

## On Success
- 听到有意义的声音或对话片段
- regular success: 听到模糊的声音或部分对话
- hard success: 清楚听到完整对话内容
- extreme success: 听到额外细节（如说话者的语气、第三方的存在）
- 产生 memory.information（听到的内容）

## On Failure
- 什么都没听到，或只听到无意义的噪音
- 不产生任何信息
```

- [ ] **Step 3: Create track.md**

```markdown
---
id: track
title: Track
description: Following tracks and trails, reading signs of passage, tracking people or animals

skillCheck:
  skill: Track
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
    fields: [id, name, description, conditions, connections]

outputSchema:
  use:
    - memory.event
    - memory.information
    - character.fatigue

interpreter:
  examples:
    - "追踪地上的脚印"
    - "寻找他离开时留下的痕迹"
    - "Follow the tracks in the snow"
---

# Track Resolution Guidance

## On Success
- 发现并辨认出痕迹或踪迹
- regular success: 确定方向和大致路线
- hard success: 判断出时间、人数、行进速度
- extreme success: 发现试图隐藏的踪迹或伪装的路线
- 产生 memory.information（追踪发现）

## On Failure
- 未发现有用的痕迹
- 可能跟错方向
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: add perception skill definitions (perception, listen, track)"
```

---

### Task 3: Create Skill Definition Files — Knowledge (11 files)

**Files:**
- Create: `src/engine/tool_definitions/skills/accounting.md`
- Create: `src/engine/tool_definitions/skills/anthropology.md`
- Create: `src/engine/tool_definitions/skills/archaeology.md`
- Create: `src/engine/tool_definitions/skills/art_and_craft.md`
- Create: `src/engine/tool_definitions/skills/history.md`
- Create: `src/engine/tool_definitions/skills/law.md`
- Create: `src/engine/tool_definitions/skills/research.md`
- Create: `src/engine/tool_definitions/skills/occult.md`
- Create: `src/engine/tool_definitions/skills/natural_world.md`
- Create: `src/engine/tool_definitions/skills/criminology.md`
- Create: `src/engine/tool_definitions/skills/forbidden_lore.md`

All knowledge skills are **single** rolls with **partial** failBehavior. They share the same pattern: actor + scene context, output is primarily memory.information + memory.event.

- [ ] **Step 1: Create all 11 knowledge skill files**

Each follows this template (varying id, title, description, skill name, interpreter examples, and guidance body):

```yaml
---
id: <skill_id>
title: <Skill Name>
description: <one-line description>

skillCheck:
  skill: <Exact Skill Name>
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
    fields: [id, name, description, conditions, items]
  item:
    inject: [sceneItems, actorInventory]

outputSchema:
  use:
    - memory.event
    - memory.information
    - character.fatigue

interpreter:
  examples:
    - <example 1 in Chinese>
    - <example 2 in Chinese>
    - <example 3 in English>
---
```

**Specific files:**

**accounting.md**: `skill: Accounting`, description: "Understanding financial records, detecting embezzlement, analyzing budgets", examples: ["检查账本寻找异常", "分析财务记录", "Examine the ledger for discrepancies"]. Guidance: On Success — discover financial anomalies, hidden transactions. On Failure — records seem normal.

**anthropology.md**: `skill: Anthropology`, description: "Knowledge of human cultures, rituals, social structures and customs", examples: ["分析这个仪式的文化背景", "判断这些符号的文化含义", "Identify the cultural origin of this artifact"]. Guidance: On Success — identify cultural significance, ritual meaning. On Failure — cannot determine cultural context.

**archaeology.md**: `skill: Archaeology`, description: "Knowledge of ancient cultures, artifacts, excavation techniques", examples: ["鉴定这件古物的年代", "分析遗迹的历史", "Date this artifact based on its construction"]. Guidance: On Success — determine age, origin, purpose of artifact. On Failure — cannot identify.

**art_and_craft.md**: `skill: Art and Craft`, description: "Artistic skills, craftsmanship, evaluating art and handmade objects", examples: ["鉴定这幅画的真伪", "用手工制作一个简单工具", "Evaluate whether this painting is authentic"]. Guidance: On Success — identify authenticity, create item, understand artistic technique. On Failure — cannot determine or craft fails.

**history.md**: `skill: History`, description: "Knowledge of historical events, periods, and their significance", examples: ["回忆这座建筑的历史", "分析这个事件的历史背景", "Recall what happened at this location historically"]. Guidance: On Success — recall relevant historical facts. On Failure — cannot remember or recalls incorrectly.

**law.md**: `skill: Law`, description: "Knowledge of legal systems, procedures, rights, and regulations", examples: ["判断这个行为是否违法", "利用法律知识找到漏洞", "Determine the legal implications of this evidence"]. Guidance: On Success — identify legal relevance, rights, loopholes. On Failure — uncertain about legality.

**research.md**: `skill: Research`, description: "Research in libraries, archives, databases — finding specific information in records", examples: ["在图书馆查阅相关资料", "搜索档案寻找线索", "Search the archives for records of the incident"]. Guidance: On Success — find relevant documents or records. On Failure — nothing found or irrelevant results.

**occult.md**: `skill: Occult`, description: "Knowledge of supernatural beliefs, magic traditions, folklore, and mystical practices", examples: ["辨认这些神秘符号", "分析这个仪式的用途", "Identify the occult significance of these symbols"]. Guidance: On Success — identify occult meaning, ritual purpose, supernatural connection. On Failure — symbols seem meaningless. Note: extreme success may trigger SAN check if knowledge is disturbing.

**natural_world.md**: `skill: Natural World`, description: "Knowledge of flora, fauna, natural phenomena, weather patterns", examples: ["辨认这种植物是否有毒", "根据天气判断接下来的情况", "Identify whether this plant is poisonous"]. Guidance: On Success — correctly identify species, predict natural events. On Failure — cannot identify.

**criminology.md**: `skill: Criminology`, description: "Understanding criminal behavior, investigation techniques, forensic analysis", examples: ["分析犯罪现场的线索", "推断凶手的作案手法", "Analyze the crime scene for behavioral clues"]. Guidance: On Success — deduce motive, method, or suspect profile. On Failure — no useful deductions.

**forbidden_lore.md**: `skill: Forbidden Lore`, description: "Knowledge of forbidden truths, cosmic horrors, and things humanity was not meant to know", examples: ["试图回忆关于这个远古存在的知识", "分析这些禁忌文字的含义", "Recall what is known about this ancient entity"]. Guidance: On Success — recall dangerous knowledge (may cost SAN). On Failure — memory is blank. Add `character.san` to outputSchema.use.

- [ ] **Step 2: Commit**

```bash
git commit -m "feat: add knowledge skill definitions (11 skills)"
```

---

### Task 4: Create Skill Definition Files — Science & Medical (6 files)

**Files:**
- Create: `src/engine/tool_definitions/skills/biology.md`
- Create: `src/engine/tool_definitions/skills/chemistry.md`
- Create: `src/engine/tool_definitions/skills/physics.md`
- Create: `src/engine/tool_definitions/skills/appraise.md`
- Create: `src/engine/tool_definitions/skills/first_aid.md`
- Create: `src/engine/tool_definitions/skills/medicine.md`
- Create: `src/engine/tool_definitions/skills/psychoanalysis.md`

- [ ] **Step 1: Create science skills (biology, chemistry, physics, appraise)**

Same knowledge template as Task 3. Key differences:

**biology.md**: `skill: Biology`. Examples: ["分析这种生物样本", "Identify this biological specimen"]. Guidance: identify species, biological processes, toxins.

**chemistry.md**: `skill: Chemistry`. Examples: ["分析这种化学物质", "Analyze this chemical substance"]. Guidance: identify chemicals, predict reactions, detect poisons.

**physics.md**: `skill: Physics`. Examples: ["计算这个结构的承重能力", "Figure out the trajectory"]. Guidance: solve physics problems, evaluate structural integrity.

**appraise.md**: `skill: Appraise`. Examples: ["估算这件古董的价值", "Appraise the value of this jewelry"]. Guidance: determine value, authenticity, rarity.

- [ ] **Step 2: Create medical skills (first_aid, medicine, psychoanalysis)**

Medical skills output `character.hp` or `character.san` changes:

**first_aid.md**:
```yaml
skillCheck:
  skill: First Aid
  difficulty: regular
  type: single
  failBehavior: partial
stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, conditions, inventory]
      targets: [id, name, stats, conditions]
outputSchema:
  use:
    - character.hp
    - character.condition
    - memory.event
    - character.fatigue
```
Examples: ["给伤者包扎伤口", "Bandage the wound"]. Guidance: On Success — restore 1 HP, remove "bleeding". On Failure — no improvement, may worsen.

**medicine.md**:
```yaml
skillCheck:
  skill: Medicine
  difficulty: hard
  type: single
  failBehavior: partial
outputSchema:
  use:
    - character.hp
    - character.condition
    - memory.event
    - character.fatigue
```
Examples: ["进行手术治疗", "Perform medical treatment"]. Guidance: On Success — restore 1d3 HP, treat serious conditions. On Failure — no improvement.

**psychoanalysis.md**:
```yaml
skillCheck:
  skill: Psychoanalysis
  difficulty: hard
  type: single
  failBehavior: partial
outputSchema:
  use:
    - character.san
    - character.condition
    - memory.event
    - character.fatigue
```
Examples: ["为精神受创的人进行心理治疗", "Treat the patient's mental trauma"]. Guidance: On Success — restore SAN, remove mental conditions (e.g. "terrified"). On Failure — no improvement.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add science and medical skill definitions (7 skills)"
```

---

### Task 5: Create Skill Definition Files — Physical & Stealth (9 files)

**Files:**
- Create: `src/engine/tool_definitions/skills/climb.md`
- Create: `src/engine/tool_definitions/skills/dodge.md`
- Create: `src/engine/tool_definitions/skills/jump.md`
- Create: `src/engine/tool_definitions/skills/swim.md`
- Create: `src/engine/tool_definitions/skills/throw.md`
- Create: `src/engine/tool_definitions/skills/ride.md`
- Create: `src/engine/tool_definitions/skills/stealth.md`
- Create: `src/engine/tool_definitions/skills/disguise.md`
- Create: `src/engine/tool_definitions/skills/sleight_of_hand.md`

- [ ] **Step 1: Create physical skills**

Physical skills share: single roll, partial failBehavior, output `character.hp` (fall damage), `character.fatigue`, `character.position` (if involves relocation), `memory.event`.

**climb.md**: `skill: Climb`. Examples: ["爬上围墙", "Climb the wall to reach the window"]. Guidance: On Success — reach destination. On Failure — fall, take 1d6 damage per 3 meters. outputSchema adds `character.hp`.

**dodge.md**: `skill: Dodge`, `type: opposed`, `failBehavior: abort`. Examples: ["闪避攻击", "Dodge the incoming blow"]. Guidance: reactive skill, typically auto-selected as defense.

**jump.md**: `skill: Jump`. Examples: ["跳过缺口", "Jump across the gap"]. Guidance: similar to climb — success crosses, failure may take fall damage.

**swim.md**: `skill: Swim`. Examples: ["游过河流", "Swim across the river"]. Guidance: On Success — cross water. On Failure — begins drowning, fatigue.

**throw.md**: `skill: Throw`. Examples: ["把石头扔向窗户", "Throw the rock at the window"]. Guidance: On Success — hit target. On Failure — miss.

**ride.md**: `skill: Ride`. Examples: ["骑马追赶", "Ride the horse through the forest"]. Guidance: On Success — maintain control. On Failure — fall off.

- [ ] **Step 2: Create stealth/deception skills**

**stealth.md**: `skill: Stealth`, single roll, partial. Examples: ["悄悄溜进房间", "Sneak past the guard"]. Guidance: On Success — undetected. On Failure — detected. Output: `memory.event`, `character.fatigue`.

**disguise.md**: `skill: Disguise`, single roll, partial. Examples: ["伪装成医生混进医院", "Disguise myself as a nurse"]. Guidance: On Success — disguise holds. On Failure — someone notices.

**sleight_of_hand.md**: `skill: Sleight of Hand`, single roll, partial. Examples: ["偷偷拿走桌上的钥匙", "Secretly palm the key from the desk"]. Guidance: On Success — item obtained unnoticed (item.move). On Failure — caught in the act. outputSchema adds `item.move`.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add physical and stealth skill definitions (9 skills)"
```

---

### Task 6: Create Skill Definition Files — Technical & Vehicle (7 files)

**Files:**
- Create: `src/engine/tool_definitions/skills/electrical_repair.md`
- Create: `src/engine/tool_definitions/skills/mechanical_repair.md`
- Create: `src/engine/tool_definitions/skills/operate_heavy_machinery.md`
- Create: `src/engine/tool_definitions/skills/locksmith.md`
- Create: `src/engine/tool_definitions/skills/drive_auto.md`
- Create: `src/engine/tool_definitions/skills/navigate.md`
- Create: `src/engine/tool_definitions/skills/pilot_aircraft.md`
- Create: `src/engine/tool_definitions/skills/pilot_boat.md`

- [ ] **Step 1: Create repair/technical skills**

Repair skills share: single roll, partial failBehavior, output `item.modify`, `memory.event`, `character.fatigue`.

**electrical_repair.md**: `skill: Electrical Repair`. Examples: ["修理坏掉的收音机", "Repair the broken radio"]. Guidance: On Success — device repaired. On Failure — no fix, extreme failure may worsen damage.

**mechanical_repair.md**: `skill: Mechanical Repair`. Examples: ["修理汽车引擎", "Fix the jammed lock mechanism"]. Guidance: similar to electrical.

**operate_heavy_machinery.md**: `skill: Operate Heavy Machinery`. Examples: ["操作起重机", "Operate the crane"]. Guidance: On Success — machinery works as intended. On Failure — machinery malfunctions.

**locksmith.md**: `skill: Locksmith`. Examples: ["撬开锁", "Pick the lock on the cabinet"]. Guidance: On Success — lock opens. On Failure — lock jams, tools may break. outputSchema includes `scene.condition` (for door/container state changes).

- [ ] **Step 2: Create vehicle/navigation skills**

Vehicle skills share: single roll, partial failBehavior, output `character.hp` (crash damage), `character.fatigue`, `memory.event`.

**drive_auto.md**: `skill: Drive Auto`. Examples: ["高速驾车逃离", "Drive through the narrow alley"]. Guidance: On Success — reach destination safely. On Failure — crash, possible HP damage.

**navigate.md**: `skill: Navigate`. Examples: ["在森林中找到方向", "Use the map to find the way"]. Guidance: On Success — find correct route. On Failure — get lost.

**pilot_aircraft.md**: `skill: Pilot (Aircraft)`. Examples: ["驾驶飞机", "Pilot the plane through the storm"]. Guidance: similar to drive_auto but higher stakes.

**pilot_boat.md**: `skill: Pilot (Boat)`. Examples: ["驾驶船只穿过风暴", "Navigate the boat through rough waters"]. Guidance: similar.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add technical and vehicle skill definitions (8 skills)"
```

---

### Task 7: Create Skill Definition Files — Combat (8 files)

**Files:**
- Create: `src/engine/tool_definitions/skills/brawling.md`
- Create: `src/engine/tool_definitions/skills/sword.md`
- Create: `src/engine/tool_definitions/skills/axe.md`
- Create: `src/engine/tool_definitions/skills/whip.md`
- Create: `src/engine/tool_definitions/skills/pistol.md`
- Create: `src/engine/tool_definitions/skills/rifle.md`
- Create: `src/engine/tool_definitions/skills/submachine_gun.md`
- Create: `src/engine/tool_definitions/skills/bow.md`

- [ ] **Step 1: Create melee combat skills (brawling, sword, axe, whip)**

All melee skills are **opposed** rolls with `failBehavior: abort`. They output `character.hp`, `character.condition`, `character.fatigue`, `memory.event`, `memory.witness`.

**brawling.md**:
```yaml
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
    - memory.event
    - memory.witness
```
Examples: ["挥拳攻击他", "Punch the cultist"]. Guidance: On Success — deal 1d3+DB damage. On Failure — miss, target may counterattack.

**sword.md**, **axe.md**, **whip.md**: Same pattern, different weapon damage (sword: 1d8+DB, axe: 1d8+1+DB, whip: 1d3). Different examples.

- [ ] **Step 2: Create ranged combat skills (pistol, rifle, submachine_gun, bow)**

Ranged skills are **single** rolls (not opposed) with `failBehavior: abort`.

**pistol.md**:
```yaml
skillCheck:
  skill: Pistol
  difficulty: regular
  type: single
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
    - memory.event
    - memory.witness
```
Examples: ["用手枪射击", "Fire the pistol at the target"]. Guidance: On Success — hit, deal 1d10 damage. On Failure — miss. Extreme success — headshot or vital hit, double damage.

**rifle.md**: 2d6+4 damage. **submachine_gun.md**: 1d10, burst fire possible. **bow.md**: 1d6+half DB.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add combat skill definitions (8 skills)"
```

---

### Task 8: Create Skill Definition Files — Survival & Special (8 files)

**Files:**
- Create: `src/engine/tool_definitions/skills/survival_arctic.md`
- Create: `src/engine/tool_definitions/skills/survival_desert.md`
- Create: `src/engine/tool_definitions/skills/survival_forest.md`
- Create: `src/engine/tool_definitions/skills/forgery.md`
- Create: `src/engine/tool_definitions/skills/language_own.md`
- Create: `src/engine/tool_definitions/skills/language_other.md`

- [ ] **Step 1: Create survival skills**

All survival skills share: single roll, partial failBehavior, output `memory.event`, `memory.information`, `character.fatigue`, `character.hp` (exposure damage on failure).

**survival_arctic.md**: `skill: Survival (Arctic)`. Examples: ["在暴风雪中搭建避难所", "Find shelter in the blizzard"]. Guidance: On Success — find shelter/food/route. On Failure — exposed to elements, fatigue, possible HP loss.

**survival_desert.md**: `skill: Survival (Desert)`. Similar pattern for desert.

**survival_forest.md**: `skill: Survival (Forest)`. Similar pattern for forest.

- [ ] **Step 2: Create special skills**

**forgery.md**: `skill: Forgery`, single, partial. Examples: ["伪造一份通行证", "Forge the document"]. Guidance: On Success — convincing forgery. On Failure — obvious fake. Output: `item.create`, `memory.event`.

**language_own.md**: `skill: Language (Own)`, single, partial. Examples: ["阅读这份古老的本国文献", "Read the archaic text in my native language"]. Guidance: On Success — understand text. On Failure — cannot decipher.

**language_other.md**: `skill: Language (Other)`, single, partial. Examples: ["翻译这段外文", "Translate this foreign inscription"]. Guidance: On Success — translate correctly. On Failure — mistranslation or cannot understand.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add survival and special skill definitions (6 skills)"
```

---

### Task 9: Create General Definition Files (2 files)

**Files:**
- Create: `src/engine/tool_definitions/conversation.md`
- Create: `src/engine/tool_definitions/item_exchange.md`

- [ ] **Step 1: Create conversation.md**

```markdown
---
id: conversation
title: Conversation
description: Ordinary conversation with another character — chatting, asking casual questions, sharing information without persuasion or deception

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, occupation, personality, conditions]
      targets: [id, name, occupation, personality, conditions, relationship, knowledge]
  scene:
    inject: [current]
    fields: [id, name, description]

outputSchema:
  use:
    - memory.event
    - memory.information
    - relationship.change

interpreter:
  examples:
    - "和她聊聊天"
    - "问问他今天过得怎么样"
    - "Have a casual chat with the bartender"
    - "Ask him what he knows about the neighborhood"

impactHint:
  default: 1
  range: "0-1"
  examples: "whispering=0, casual conversation=1"
---

# Conversation Resolution Guidance

## Execution Status
- **completed**: resolve the conversation normally.
- **failed**: not applicable (no skill check).
- **interrupted**: the conversation was cut short.

## Rules
- No skill check required — this is a friendly or neutral exchange
- Information exchange depends on the relationship and target's knowledge
- The target will share information they know and are willing to share
- The target will NOT share secrets or sensitive information without persuasion
- Both characters form memories of the conversation
- Relationship may change slightly based on conversation topic
```

- [ ] **Step 2: Create item_exchange.md**

```markdown
---
id: item_exchange
title: Item Exchange
description: Giving, receiving, or trading items between characters without skill checks

stateDomains:
  character:
    inject: [actor, targets]
    fields:
      actor: [id, name, conditions, inventory]
      targets: [id, name, conditions, inventory, relationship]
  scene:
    inject: [current]
    fields: [id, name, description]

outputSchema:
  use:
    - item.move
    - memory.event
    - relationship.change

interpreter:
  examples:
    - "把钥匙交给他"
    - "给她一杯水"
    - "Hand the key to Officer Harlow"
    - "Give her the medicine"

impactHint:
  default: 1
  range: "0-1"
  examples: "discreet handoff=0, open exchange=1"
---

# Item Exchange Resolution Guidance

## Execution Status
- **completed**: resolve the exchange normally.
- **interrupted**: exchange was interrupted — item may not have been transferred.

## Rules
- No skill check required — willing exchange between characters
- The target must be willing to accept the item (check relationship)
- If the target refuses, no item.move occurs
- Both characters form memories of the exchange
- Relationship may change based on the value/significance of the item
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: add conversation and item_exchange general definitions"
```

---

### Task 10: Update Definition Loader

**Files:**
- Modify: `src/engine/tool_definitions/loader.ts`
- Test: `src/engine/tool_definitions/__tests__/loader.test.ts`

- [ ] **Step 1: Update loader to scan skills/ subdirectory**

Replace `loadActionDefinitions()` in `src/engine/tool_definitions/loader.ts`:

```typescript
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type {
  ActionDefinition,
  ActionDefinitionImpactHint,
  ActionDefinitionInterpreter,
  ActionDefinitionSkillCheck,
  StateDomainSpec,
} from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ==================== YAML frontmatter parsing ====================

interface YamlFrontmatter {
  id?: string;
  title?: string;
  description?: string;
  interpreter?: ActionDefinitionInterpreter;
  skillCheck?: ActionDefinitionSkillCheck;
  stateDomains?: Record<string, StateDomainSpec>;
  outputSchema?: import("../types.js").OutputSchemaConfig;
  featureOverlay?: Record<string, unknown>;
  impactHint?: ActionDefinitionImpactHint;
}

function splitFrontmatter(raw: string): {
  frontmatter: YamlFrontmatter;
  body: string;
} {
  if (!raw.startsWith("---")) {
    throw new Error(
      "Definition file must have YAML frontmatter (start with ---)"
    );
  }
  const endIndex = raw.indexOf("\n---", 3);
  if (endIndex === -1) {
    throw new Error(
      "Definition file frontmatter not closed (missing closing ---)"
    );
  }
  const yamlStr = raw.slice(4, endIndex);
  const body = raw.slice(endIndex + 4).trim();
  const frontmatter = parseYaml(yamlStr) as YamlFrontmatter;
  return { frontmatter, body };
}

function parseTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : "Unknown";
}

function loadDefinitionFile(filePath: string, fallbackId: string): ActionDefinition {
  const raw = readFileSync(filePath, "utf-8");
  const { frontmatter, body } = splitFrontmatter(raw);
  const title = frontmatter.title ?? parseTitle(body) ?? fallbackId;
  return {
    id: frontmatter.id ?? fallbackId,
    title,
    description: frontmatter.description ?? title,
    content: raw,
    guidanceBody: body,
    skillCheck: frontmatter.skillCheck,
    stateDomains: frontmatter.stateDomains,
    outputSchema: frontmatter.outputSchema,
    interpreter: frontmatter.interpreter,
    featureOverlay: frontmatter.featureOverlay,
    impactHint: frontmatter.impactHint,
  };
}

// ==================== Main loader ====================

export function loadActionDefinitions(): ActionDefinition[] {
  const definitions: ActionDefinition[] = [];

  // Load root-level definitions
  const rootFiles = readdirSync(__dirname).filter((f) => f.endsWith(".md"));
  for (const file of rootFiles) {
    const id = file.replace(/\.md$/, "");
    definitions.push(loadDefinitionFile(join(__dirname, file), id));
  }

  // Load skill definitions from skills/ subdirectory
  const skillsDir = join(__dirname, "skills");
  if (existsSync(skillsDir)) {
    const skillFiles = readdirSync(skillsDir).filter((f) => f.endsWith(".md"));
    for (const file of skillFiles) {
      const id = file.replace(/\.md$/, "");
      definitions.push(loadDefinitionFile(join(skillsDir, file), id));
    }
  }

  return definitions;
}
```

- [ ] **Step 2: Run existing tests**

Run: `npx vitest run src/engine/tool_definitions/__tests__/`
Expected: PASS

- [ ] **Step 3: Run full resolver tests to make sure nothing breaks**

Run: `npx vitest run src/engine/resolver/`
Expected: PASS (92 tests)

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: loader supports skills/ subdirectory for skill definitions"
```

---

### Task 11: Enhance GameInterpreter Prompt

**Files:**
- Modify: `src/engine/interpreter/gameInterpreter.ts`
- Modify: `src/engine/interpreter/__tests__/gameInterpreter.test.ts`

- [ ] **Step 1: Update buildInterpreterPrompt to group definitions by category**

Replace `buildInterpreterPrompt` in `src/engine/interpreter/gameInterpreter.ts`:

```typescript
export function buildInterpreterPrompt(
  definitions: ActionDefinition[]
): string {
  // Separate general definitions from skill definitions
  const generalDefs = definitions.filter((d) => !d.skillCheck);
  const skillDefs = definitions.filter((d) => d.skillCheck);

  // Group skill definitions by type for readability
  const skillGroups: Record<string, ActionDefinition[]> = {};
  for (const def of skillDefs) {
    const type = def.skillCheck!.type === "opposed" ? "opposed" : "single";
    const key = type === "opposed" ? "Opposed (social/combat)" : "Single (skill check)";
    if (!skillGroups[key]) skillGroups[key] = [];
    skillGroups[key].push(def);
  }

  const formatDef = (d: ActionDefinition): string => {
    let line = `- **${d.id}**: ${d.description}`;
    if (d.interpreter?.examples?.length) {
      line += ` (e.g. "${d.interpreter.examples[0]}")`;
    }
    if (d.impactHint) {
      line += ` [impact: default ${d.impactHint.default}`;
      if (d.impactHint.range) line += `, range ${d.impactHint.range}`;
      line += "]";
    }
    return line;
  };

  const sections: string[] = [];

  sections.push("### General Actions (no skill check)");
  sections.push(generalDefs.map(formatDef).join("\n"));

  for (const [groupName, defs] of Object.entries(skillGroups)) {
    sections.push("");
    sections.push(`### ${groupName}`);
    sections.push(defs.map(formatDef).join("\n"));
  }

  const defList = sections.join("\n");

  return `You are an action interpreter for a game simulation engine.

Given a natural language action, decompose it into an ordered sequence of steps. Each step references one of the available action definitions.

## Available Definitions
${defList}

## Rules
- A simple action maps to a single step (e.g., "搜查房间" → [perception])
- A composite action maps to multiple ordered steps (e.g., "撬开柜子然后搜查里面" → [locksmith, perception])
- If the action involves going somewhere first, the first step should be "movement"
- If the action is a simple conversation without persuasion/deception, use "conversation"
- If the action involves giving/receiving items, use "item_exchange"
- If no specific skill definition matches, use "action" (general action)
- Never use "generic" if a more specific definition exists

## Impact Levels (per step)
Each step gets its own impact value determining who perceives it:
- **0**: Private / unnoticed — thinking, reading alone, resting, observing, moving quietly
- **1**: Targeted / one-on-one — whispering, private conversation, discreet item handoff
- **2**: Room-wide — speaking loudly, firing a gun, breaking a door, searching openly
- **3**: Building-wide — fire alarm, shouting down a stairwell, smoke filling the building
- **4**: Neighborhood — explosion, gunshot echoing, building collapse
- **5**: Global — town alarm, summoning ritual, earthquake
Default to 0 unless the step clearly warrants higher.

## Output Format
Respond with ONLY a JSON object:
{
  "steps": [
    { "definitionId": "locksmith", "impact": 1 },
    { "definitionId": "perception", "impact": 0 }
  ]
}`;
}
```

- [ ] **Step 2: Update tests**

In `src/engine/interpreter/__tests__/gameInterpreter.test.ts`, update the `buildInterpreterPrompt` test:

```typescript
describe("buildInterpreterPrompt", () => {
  it("includes all definition IDs and descriptions", () => {
    const defs: ActionDefinition[] = [
      {
        id: "action",
        title: "Action",
        description: "General actions",
        content: "",
        guidanceBody: "",
        impactHint: { default: 0, range: "0-2" },
      },
      {
        id: "perception",
        title: "Perception",
        description: "Finding hidden objects",
        content: "",
        guidanceBody: "",
        skillCheck: {
          skill: "Perception",
          difficulty: "regular",
          type: "single",
          failBehavior: "partial",
        },
        interpreter: { examples: ["搜查房间"] },
      },
      {
        id: "brawling",
        title: "Brawling",
        description: "Hand-to-hand combat",
        content: "",
        guidanceBody: "",
        skillCheck: {
          skill: "Brawling",
          difficulty: "regular",
          type: "opposed",
          opposedDefense: ["Dodge"],
          failBehavior: "abort",
        },
        interpreter: { examples: ["挥拳攻击"] },
      },
    ];

    const prompt = buildInterpreterPrompt(defs);

    expect(prompt).toContain("action");
    expect(prompt).toContain("General actions");
    expect(prompt).toContain("perception");
    expect(prompt).toContain("Finding hidden objects");
    expect(prompt).toContain("brawling");
    expect(prompt).toContain("Hand-to-hand combat");
    expect(prompt).toContain("General Actions (no skill check)");
    expect(prompt).toContain("Opposed (social/combat)");
    expect(prompt).toContain("Single (skill check)");
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/engine/interpreter/__tests__/gameInterpreter.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: GameInterpreter prompt handles ~72 definitions grouped by category"
```

---

### Task 12: End-to-End Verification

- [ ] **Step 1: Verify all definitions load**

Run: `npx vitest run src/engine/`
Expected: All tests pass

- [ ] **Step 2: Run type check**

Run: `pnpm build:tsc`
Expected: No new type errors in our changed files

- [ ] **Step 3: Run lint**

Run: `pnpm check`
Expected: No new lint errors in our changed files

- [ ] **Step 4: Update the E2E test script to use a skill definition**

Add a 4th scenario to `scripts/test-resolver-schema.ts` that uses a skill definition (e.g. `perception`):

```typescript
// Scenario 4: perception skill definition
results.push(
  await runScenario(
    "Scenario 4: perception (搜查房间)",
    "perception",
    "仔细搜查书房的每个角落，寻找隐藏的线索",
    buildItemInspectContext(),
    definitions,
    runtime,
    dgsm,
    log,
  ),
);
```

Run: `npx tsx scripts/test-resolver-schema.ts`
Expected: 4/4 pass, perception definition used with its own outputSchema

- [ ] **Step 5: Commit**

```bash
git commit -m "test: verify skill definitions load and work with StateResolver"
```
