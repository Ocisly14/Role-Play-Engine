# State Resolver Output Schema Design

## Problem

StateResolver 当前返回一个固定的 `StateResolution` 类型（characterChanges, itemChanges, sceneChanges, memories, relationships, featureOverlays, narrative），所有 action 类型共用。存在三个问题：

1. **LLM 输出不稳定** — 没有严格 schema 约束，LLM 经常返回意外格式或多余字段
2. **不同 action 类型需要不同的输出结构** — movement 不需要 itemChanges，item_modify 不需要 sceneChanges，但目前无法按 definition 裁剪
3. **可扩展性差** — 新增 definition 时可能需要改 TypeScript 代码

此外，StateResolver 的定位是**纯状态变更引擎**，不应承担叙事职责。现有的 `narrative` 字段应移除。

## Design

### 核心思路

1. 定义一组标准的 **State Change Type**，每种有完整的 JSON Schema
2. Definition 的 `outputSchema` 声明选用哪些 type + 可选的 custom 字段
3. 运行时根据声明动态组装 JSON Schema，用于约束 LLM 输出和校验结果
4. 每种 type 注册自己的 apply 函数，`applyStateResolution` 按 typeId 分发

### 1. State Change Type 注册表

每种状态变更是一个独立的、完整的 schema 单元，定义在 `engine/resolver/stateChangeTypes.ts`：

```typescript
const STATE_CHANGE_TYPES = {
  // ---- Character ----
  "character.hp": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        delta: { type: "number" },
      },
      required: ["characterId", "delta"],
    },
    description: "HP change (negative = damage)",
  },

  "character.san": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        delta: { type: "number" },
      },
      required: ["characterId", "delta"],
    },
    description: "SAN change (negative = loss)",
  },

  "character.fatigue": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        delta: { type: "number" },
      },
      required: ["characterId", "delta"],
    },
    description: "Fatigue delta",
  },

  "character.condition": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        add: { type: "array", items: { type: "string" } },
        remove: { type: "array", items: { type: "string" } },
      },
      required: ["characterId"],
    },
    description: "Add/remove conditions on a character",
  },

  "character.position": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        sceneId: { type: "string" },
        junction: { type: "string" },
      },
      required: ["characterId", "sceneId"],
    },
    description: "Relocate character",
  },

  // ---- Item ----
  "item.move": {
    schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["itemId", "from", "to"],
    },
    description: "Transfer item between locations",
  },

  "item.destroy": {
    schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
      },
      required: ["itemId"],
    },
    description: "Remove item from world",
  },

  "item.create": {
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        location: { type: "string" },
        properties: { type: "object" },
      },
      required: ["name", "location"],
    },
    description: "Spawn new item",
  },

  "item.modify": {
    schema: {
      type: "object",
      properties: {
        itemId: { type: "string" },
        properties: { type: "object" },
      },
      required: ["itemId", "properties"],
    },
    description: "Update item properties",
  },

  // ---- Scene ----
  "scene.condition": {
    schema: {
      type: "object",
      properties: {
        sceneId: { type: "string" },
        add: { type: "array", items: { type: "string" } },
        remove: { type: "array", items: { type: "string" } },
      },
      required: ["sceneId"],
    },
    description: "Add/remove scene environmental conditions",
  },

  // ---- Memory ----
  "memory.event": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        content: { type: "string" },
      },
      required: ["characterId", "content"],
    },
    description: "Event memory for participant",
  },

  "memory.witness": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        content: { type: "string" },
      },
      required: ["characterId", "content"],
    },
    description: "Witness memory for observer",
  },

  "memory.information": {
    schema: {
      type: "object",
      properties: {
        characterId: { type: "string" },
        content: { type: "string" },
      },
      required: ["characterId", "content"],
    },
    description: "Learned information",
  },

  // ---- Relationship ----
  "relationship.change": {
    schema: {
      type: "object",
      properties: {
        fromId: { type: "string" },
        toId: { type: "string" },
        delta: { type: "number" },
        note: { type: "string" },
      },
      required: ["fromId", "toId"],
    },
    description: "Relationship score change",
  },
};
```

### 2. Definition 的 outputSchema 声明

definition `.md` 的 frontmatter 新增 `outputSchema` 块，替代 `stateDomains` 中的 `output` 字段。`stateDomains` 只保留输入注入职责。

```yaml
# action.md
outputSchema:
  use:
    - character.fatigue
    - character.condition
    - scene.condition
    - item.move
    - item.modify
    - memory.event
  custom:
    discoveredClue:
      type: string
      description: "Clue ID if found"
```

```yaml
# movement.md
outputSchema:
  use:
    - character.fatigue
    - character.position
    - memory.event
    - memory.witness
```

```yaml
# character_interaction.md
outputSchema:
  use:
    - character.hp
    - character.san
    - character.fatigue
    - character.condition
    - character.position
    - item.move
    - item.destroy
    - memory.event
    - memory.witness
    - memory.information
    - relationship.change
  custom:
    knowledgeRevealed:
      type: string[]
      description: "IDs of knowledge entries revealed during interaction"
```

### 3. Schema 组装

运行时根据 definition 的 `outputSchema` 动态组装完整 JSON Schema：

```typescript
// engine/resolver/schemaBuilder.ts

function buildOutputSchema(definition: ActionDefinition): JsonSchema {
  const properties: Record<string, JsonSchema> = {};

  // 标准 type：从注册表取 schema，包装成数组
  for (const typeId of definition.outputSchema.use) {
    const changeType = STATE_CHANGE_TYPES[typeId];
    properties[typeId] = {
      type: "array",
      items: changeType.schema,
    };
  }

  // custom 字段：直接加入顶层
  if (definition.outputSchema.custom) {
    for (const [name, fieldDef] of Object.entries(definition.outputSchema.custom)) {
      properties[name] = customFieldToJsonSchema(fieldDef);
    }
  }

  return { type: "object", properties, additionalProperties: false };
}
```

组装出的 JSON Schema 有两个用途：
- **LLM 约束**：传给 structured output / tool calling，强制模型按 schema 返回
- **结果校验**：validate 返回的 JSON，不合格拒绝并重试一次

### 4. State Change Appliers

每种 state change type 注册对应的 apply 函数：

```typescript
// engine/resolver/stateChangeAppliers.ts

const STATE_CHANGE_APPLIERS: Record<string, (dgsm, changes: any[]) => void> = {
  "character.hp":        (dgsm, changes) => { for (const c of changes) dgsm.updateNpcHp(c.characterId, c.delta); },
  "character.san":       (dgsm, changes) => { for (const c of changes) dgsm.updateNpcSan(c.characterId, c.delta); },
  "character.fatigue":   (dgsm, changes) => { for (const c of changes) dgsm.updateNpcFatigue(c.characterId, c.delta); },
  "character.condition": (dgsm, changes) => {
    for (const c of changes) {
      const npc = dgsm.getNpc(c.characterId);
      if (c.add) npc.status.conditions.push(...c.add);
      if (c.remove) npc.status.conditions = npc.status.conditions.filter(cond => !c.remove.includes(cond));
    }
  },
  "character.position":  (dgsm, changes) => { for (const c of changes) dgsm.setCharacterPosition(c.characterId, c.sceneId, c.junction); },
  "item.move":           (dgsm, changes) => { for (const c of changes) dgsm.moveItem(c.itemId, c.from, c.to); },
  "item.destroy":        (dgsm, changes) => { for (const c of changes) dgsm.removeItem(c.itemId); },
  "item.create":         (dgsm, changes) => { for (const c of changes) dgsm.createItem(c.name, c.location, c.properties); },
  "item.modify":         (dgsm, changes) => { for (const c of changes) dgsm.modifyItem(c.itemId, c.properties); },
  "scene.condition":     (dgsm, changes) => {
    for (const c of changes) {
      if (c.add) dgsm.appendSceneConditions(c.sceneId, c.add);
      if (c.remove) dgsm.removeSceneConditions(c.sceneId, c.remove);
    }
  },
  "memory.event":        (dgsm, changes) => { for (const c of changes) dgsm.addMemory(c.characterId, "event", c.content); },
  "memory.witness":      (dgsm, changes) => { for (const c of changes) dgsm.addMemory(c.characterId, "witness", c.content); },
  "memory.information":  (dgsm, changes) => { for (const c of changes) dgsm.addMemory(c.characterId, "information", c.content); },
  "relationship.change": (dgsm, changes) => { for (const c of changes) dgsm.updateRelationship(c.fromId, c.toId, c.delta, c.note); },
};
```

`applyStateResolution` 变为简单的分发：

```typescript
function applyStateResolution(dgsm, resolution, definition) {
  for (const typeId of definition.outputSchema.use) {
    const changes = resolution[typeId];
    if (!changes?.length) continue;
    STATE_CHANGE_APPLIERS[typeId](dgsm, changes);
  }
  // custom 字段返回给调用方自行处理（feature overlay 等）
}
```

### 5. 完整数据流

```
PlanNode 到达执行时间
       │
       ▼
GameInterpreter 分类 → definitionId = "action"
       │
       ▼
Registry.getDefinition("action")
       │
       ├─ stateDomains  → 控制输入（注入哪些状态给 LLM）
       └─ outputSchema  → 控制输出（LLM 能返回什么）
       │
       ▼
SkillCheck（如果 definition 要求）
       │
       ▼
StateResolver.resolve(context)
       │
       ├─ 1. buildStateContext(stateDomains)    ← 输入侧不变
       ├─ 2. buildOutputSchema(outputSchema)    ← 动态组装 JSON Schema
       ├─ 3. buildPrompt(guidance + stateContext + outputSchema)
       ├─ 4. LLM 调用（structured output 模式，schema 约束返回格式）
       └─ 5. validate(response, schema)         ← 校验，失败重试一次
       │
       ▼
applyStateResolution(dgsm, resolution, definition)
       │
       ├─ 遍历 definition.outputSchema.use
       │   对每个 typeId，调用 STATE_CHANGE_APPLIERS[typeId]
       │
       └─ custom 字段 → 返回给调用方
       │
       ▼
CharacterAction 记录（纯结构化数据，无 narrative）
```

### 与现状对比

| 现在 | 改后 |
|------|------|
| 固定 `StateResolution` 类型，所有 action 共用 | 每个 definition 声明自己的输出子集 |
| LLM 自由返回 JSON，prompt 口头约束 | JSON Schema structured output，强制约束 |
| `parseStateResolution` 有 legacy 兼容逻辑 | schema validate，不合格直接拒绝 |
| narrative 混在状态变更里 | 纯状态变更，无叙事 |
| `applyStateResolution` 处理固定结构 | 按 typeId 分发，只 apply 声明的类型 |
| 新增 action 类型可能需要改 TS | 新增 definition 零 TS 改动（除非新增 state change type） |

### 迁移策略

- `stateDomains.[domain].output` 标记 deprecated，过渡期两者共存
- 旧的 `StateResolution` 类型保留为内部兼容层，逐步替换
- `parseStateResolution` 的 legacy 逻辑在全部 definition 迁移后移除
