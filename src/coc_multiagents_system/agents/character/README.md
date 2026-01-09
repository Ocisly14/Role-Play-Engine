# Character Agent - 注入到模板的信息说明

## 模板变量

Character Agent 会将以下信息注入到模板中，通过 Handlebars 变量访问：

### 1. `{{characterInput}}`
- **类型**: string
- **说明**: 玩家角色的输入/动作描述
- **来源**: `analyzeNPCResponses` 方法的 `characterInput` 参数

### 2. `{{latestActionResultJson}}`
- **类型**: JSON 字符串
- **说明**: 最新的动作执行结果
- **内容**:
  ```json
  {
    "timestamp": Date,
    "gameTime": string,           // 游戏时间 (HH:MM)
    "timeElapsedMinutes": number, // 消耗的游戏时间（分钟）
    "location": string,           // 执行动作的位置
    "character": string,          // 执行动作的角色名称
    "result": string,              // 动作结果描述
    "diceRolls": string[],        // 骰子投掷记录
    "timeConsumption": string,     // 时间消耗类型 ("instant" | "short" | "scene")
    "scenarioChanges": string[]    // 场景变化描述
  }
  ```
- **来源**: `gameState.temporaryInfo.actionResults` 数组的最后一个元素

### 3. `{{scenarioInfoJson}}`
- **类型**: JSON 字符串
- **说明**: 当前场景的完整信息
- **内容**:
  ```json
  {
    "id": string,                  // 场景 ID
    "name": string,                // 场景名称
    "location": string,             // 场景位置
    "description": string,          // 场景描述
    "characters": Array,            // 场景中的角色列表
    "clues": Array,                 // 线索列表
    "conditions": Array,            // 环境条件
    "events": Array,                // 事件列表
    "exits": Array,                 // 出口列表
    "permanentChanges": Array       // 永久性变化
  }
  ```
- **来源**: `gameState.currentScenario`

### 4. `{{playerCharacterJson}}`
- **类型**: JSON 字符串
- **说明**: 玩家角色的基础信息
- **内容**:
  ```json
  {
    "id": string,                   // 角色 ID
    "name": string,                 // 角色名称
    "attributes": {                 // 属性
      "STR": number,
      "CON": number,
      "DEX": number,
      "APP": number,
      "POW": number,
      "SIZ": number,
      "INT": number,
      "EDU": number
    },
    "status": {                     // 状态
      "hp": number,
      "maxHp": number,
      "sanity": number,
      "maxSanity": number,
      "luck": number,
      "mp": number,
      "conditions": string[],
      "damageBonus": string,
      "build": number,
      "mov": number
    },
    "skills": Record<string, number>, // 技能
    "inventory": string[]            // 物品清单
  }
  ```
- **来源**: `gameState.playerCharacter`

### 5. `{{sceneNpcsJson}}`
- **类型**: JSON 字符串（数组）
- **说明**: 当前场景中所有 NPC 的完整信息
- **内容**: 每个 NPC 包含：
  ```json
  {
    "id": string,                   // NPC ID
    "name": string,                 // NPC 名称
    "occupation": string,           // 职业
    "age": number | "Unknown",      // 年龄
    "appearance": string,           // 外貌描述
    "personality": string,          // 性格描述
    "background": string,          // 背景信息
    "goals": string[],              // 目标列表
    "secrets": string[],            // 秘密列表
    "attributes": {                 // 属性（同玩家角色）
      "STR": number,
      "CON": number,
      ...
    },
    "status": {                     // 状态（同玩家角色）
      "hp": number,
      "sanity": number,
      ...
    },
    "skills": Record<string, number>, // 技能
    "inventory": string[],            // 物品清单
    "clues": Array,                  // NPC 知道的线索
    "relationships": Array,          // 关系列表
    "currentLocation": string | null  // 当前位置
  }
  ```
- **来源**: 
  - 首先从 `gameState.currentScenario.characters` 中匹配的 NPC
  - 然后从 `gameState.npcCharacters` 中查找 `currentLocation` 与场景位置匹配的 NPC
  - 去重处理，避免重复

## 模板中的条件判断

模板还支持 Handlebars 条件语句：

- `{{#if latestActionResult}}...{{/if}}`: 判断是否有最新的动作结果

## 使用示例

在模板中，这些变量可以直接使用：

```handlebars
## Character Input
"{{characterInput}}"

## Latest Action Result
{{#if latestActionResult}}
{{latestActionResultJson}}
{{else}}
No action result available yet.
{{/if}}

## Current Scenario Information
{{scenarioInfoJson}}

## Player Character
{{playerCharacterJson}}

## NPCs in Current Scene Location
{{sceneNpcsJson}}
```

