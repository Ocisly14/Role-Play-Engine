# Tool-Driven Action Engine Refactor Plan

**Date:** 2026-08-26  
**Status:** Proposed — pending review  
**Scope:** RoleSim action selection, action intake, TickEngine action lifecycle, semantic resolution, persistence and observability  
**Out of scope:** Memory retrieval redesign, renderer redesign, world-feature/subsystem behavior changes, UI redesign

## 1. Goal

彻底拆分“角色决策”和“世界结算”：

- 角色 Agent 只根据感知、记忆和目标调用唯一的结构化 `act` Tool，表达“我想做什么”。
- Engine 是行动的唯一权威，负责受理、校验、排队、启动、逐 tick 推进、冲突处理、结算和状态写入。
- 技能和属性属于角色状态；角色提交行动时可以附带想使用的 `skillId`。只要角色确实拥有该技能，就立即按真实技能值掷骰；Engine 随后同时根据行动、技能选择和骰点结果判断该选择是否合理以及最终结果。
- 不再维护单项 `ActionDefinition`；所有开放行动由一份统一世界结算规则和一个通用 WorldDelta schema 处理。
- 移除所有正常行动都必须经过的自然语言 `GameInterpreter`。
- `act.description` 天然支持开放式和复合行动，不再需要 `attempt` fallback。
- 保持 `Applier` 为 DGSM 的唯一写入者。

目标主循环：

```text
World State S(t)
    ↓ perception
RoleSim Agent
    ↓ calls act(description, objectRefs, proposedDurationTicks, skillId?, utterance?)
Trusted Action Intake
    └─ if skillId exists: load owned skill value and roll immediately
    ↓ immutable ActionCommand (+ optional SkillRollRecord)
ActionCommand Inbox
    ↓
TickEngine
    ├─ validate new commands
    ├─ load active actions
    ├─ expose deterministic code tools to the unified Engine
    ├─ resolve all semantic actions with the full world and all active actions
    ├─ resolve conflicts and action transitions
    └─ emit StateChange[]
    ↓
Applier atomic flush
    ↓
World State S(t+1) + TickReport
```

## 2. Non-goals

- 不让 RoleSim Agent 直接决定行动成功、失败、实际耗时、伤害或目标反应；角色可以提交预期/愿意投入的 tick 数，但不具有权威性。
- 不让 Action Tool 直接修改 DGSM。
- 不把 pathfinding、骰点、数值聚合等确定性逻辑交给 LLM。
- 不创建独立的 `attemptSkill` Tool。唯一 `act` Tool 包含可选 `skillId`；它表达角色主动采用的能力路径，不代表 Engine 必须接受，也不允许角色提交技能值、难度或骰点结果。
- 不在第一阶段动态改变每次 Agent 调用的 Tool 列表；当前 Tool 定义位于缓存前缀，保持稳定更利于 prompt cache。
- 不要求“一个 tick 只有一次模型网络请求”。对外只有一个 Engine 入口，但 Engine 内部可以按需调用确定性执行器或语义 resolver。

## 3. Core decisions

### D1. Tool 表达意图，Engine 决定事实

角色可表达：

- 行动描述；
- 操作、使用、前往或影响的对象引用；
- 方法、措辞和主观目的；
- 是否替换当前行动。
- 对该行动预期或愿意投入的 `proposedDurationTicks`。

角色不可表达为权威结果：

- `success: true`；
- 实际伤害值；
- 实际耗时；
- 目标接受、屈服或死亡；
- 直接 `StateChange`。

Tool call 返回的是受理回执，不是世界结算：

```ts
interface ActionReceipt {
  accepted: boolean;
  actionId?: string;
  status: "queued" | "rejected";
  reason?: string;
}
```

### D2. 对角色只暴露一个统一行动 Tool

MVP 世界行动入口：

| Tool | 用途 | 语义 |
|---|---|---|
| `act` | 移动、对话、操作、交换、等待、复合行动及任意开放式行动 | 创建一个统一 `ActionCommand`；Engine 自己理解和结算 |
| `continue` | 保持当前进行中行动 | 控制信号，不创建新 command，不是动作类型 |

`writeMemory`、`recallMemory`、`getMapSnapshot` 继续作为非终止工具存在。

唯一 `act` schema：

```ts
interface ActToolArgs {
  description: string;
  objectRefs: Array<{
    kind: "character" | "item" | "scene";
    id: string;
    role?: "target" | "tool" | "destination" | "recipient";
  }>;
  proposedDurationTicks: number;
  skillId?: string;
  utterance?: string;
}
```

角色可以只描述行为、操作对象和方法：

```ts
act({
  description: "尝试用随身工具撬开柜锁",
  objectRefs: [{ kind: "item", id: "cabinet_lock", role: "target" }],
  proposedDurationTicks: 2
})
```

也可以明确声明想使用的技能：

```ts
act({
  description: "使用随身工具撬开柜锁",
  objectRefs: [{ kind: "item", id: "cabinet_lock", role: "target" }],
  skillId: "locksmith",
  proposedDurationTicks: 2
})
```

判定规则：

- 带 `skillId`：Trusted Action Intake 只确认角色拥有该技能，然后立即由代码读取真实技能值并掷骰，将不可篡改的 roll record 与行动一起提交给 Unified World Action Engine。这一阶段不判断技能是否合理。Engine 在看到结果后才判断技能是否适用、所需难度/成功等级以及最终结果。
- 未带 `skillId`：不自动掷骰；Engine 根据统一规则、角色能力、目标阻力和环境状态，直接判断成功、部分成功、失败、受阻或继续推进。
- 无论哪条路径，角色都不能提交自己的技能数值、难度、对方防御值或骰点结果。
- `proposedDurationTicks` 是意图：表示角色对行动时长的预期/投入意愿。Engine 根据行动、工具、阻力、环境和并发情况输出权威 `resolvedDurationTicks`，可与角色提交值不同。

### D3. Tool 参数与 Engine Command 分离

模型产生的是不受信任的 Tool 参数；Controller 添加受信任 envelope 后才成为 `ActionCommand`。

模型不得填写：

- `actorId`；
- `issuedAt`；
- `sceneId`；
- `actionId`；
- `replacesActionId`；
- session/module 标识。

这些字段全部由 Controller 从当前 Engine/DGSM 状态生成，防止模型伪造角色、地点或时间。

### D4. 不再提前取消旧行动

当前 Agent 在有进行中行动时调用 `act`，Controller 会先同步取消旧 handle，再提交新行动。新架构改为：

```ts
interface TrustedActionEnvelope {
  commandId: string;
  actorId: string;
  issuedAt: GameTime;
  issuedSceneId: string;
  replacesActionId?: string;
}
```

旧行动和替换命令同时进入下一次 tick resolution。Engine 在同一份世界快照中输出：

- 旧行动的 `interrupted` transition；
- 已经发生的部分效果；
- 新行动的 `started`、`rejected` 或即时完成结果。

这样不再需要单独的 cancel-time resolver 调用。

### D5. Action 是持久化的一等状态，不再是预先生成结果的计时器

新 `EngineAction` 至少保存：

```ts
interface EngineAction {
  id: string;
  command: ActionCommand;
  status: "queued" | "active" | "completed" | "failed" | "interrupted" | "cancelled";
  submittedAt: GameTime;
  startedAt?: GameTime;
  lastAdvancedAt?: GameTime;
  progressMinutes: number;
  /** Engine-owned authoritative duration decided from the action and world state. */
  resolvedDurationTicks?: number;
  nextWakeAt?: GameTime;
  runtime?: Record<string, unknown>;
}
```

Engine 不再要求 LLM 行动在激活时就生成一个未来才提交的完整 `plannedOutcome`。进行中行动在到期、受影响或被替换时，基于最新快照结算。

### D6. Tick 输出同时包含生命周期变化与世界变化

仅有世界变化不足以维护行动。统一结果必须同时包含生命周期变化和通用世界增量：

```ts
interface ActionTransition {
  actionId: string;
  actorId: string;
  from: EngineAction["status"];
  to: EngineAction["status"];
  progressDeltaMinutes: number;
  /** Set or revised only by Engine; never copied as an authoritative Tool result. */
  resolvedDurationTicks?: number;
  timingReason?: string;
  nextWakeAt?: GameTime;
  reason?: string;
}

type CharacterChange = {
  domain: "character";
  characterId: string;
  operation: CharacterStateOperation;
};

type SceneChange = {
  domain: "scene";
  sceneId: string;
  operation: SceneStateOperation;
};

type ItemChange = {
  domain: "item";
  itemId?: string;
  operation: ItemStateOperation;
};

type WorldDelta = CharacterChange | SceneChange | ItemChange;

interface SourcedWorldDelta<T extends WorldDelta = WorldDelta> {
  source:
    | { kind: "action"; actionId: string }
    | { kind: "subsystem"; subsystemId: string }
    | { kind: "scriptedEvent"; eventId: string };
  causalBasis: string;
  delta: T;
}

interface Occurrence {
  id: string;
  tickId: string;
  sourceActionIds: string[];
  locationId?: string;
  facts: Array<{
    id: string;
    type: string;
    content: string;
    entityRefs: ActionEntityRef[];
  }>;
  participants: Array<{
    characterId: string;
    role: "actor" | "target" | "directly_affected";
  }>;
  perceiverCharacterIds: string[];
  signals: Array<{
    factIds: string[];
    channel: "visual" | "sound" | "smell" | "touch" | "direct";
    originLocationId?: string;
    intensity?: number;
  }>;
}

interface TickResolution {
  transitions: ActionTransition[];
  characterChanges: SourcedWorldDelta<CharacterChange>[];
  sceneChanges: SourcedWorldDelta<SceneChange>[];
  itemChanges: SourcedWorldDelta<ItemChange>[];
  occurrences: Occurrence[];
}
```

`WorldDelta` 是一个统一 union，`TickResolution` 只是按被改变的世界实体显式分成三组，不因 Tool 或行动类别切换规则或 schema。Character changes 可覆盖生命、理智、疲劳、位置、姿态、条件和关系；Scene changes 可覆盖条件、连接、环境与可观察状态；Item changes 可覆盖创建、移动、修改、损坏和销毁。主观感知和记忆不属于 Engine WorldDelta，由渲染后的角色层处理。

`source` metadata用于审计、冲突诊断和幂等校验；`causalBasis` 必须简短说明为什么该行动会产生这个变化。兼容迁移期由 adapter 将 `WorldDelta[]` 转换为现有 `StateChange[]` 后交给 `Applier`；长期可以让 `Applier` 直接消费 WorldDelta。

`Occurrence` 记录本 tick 确实发生但不一定持久化为状态的客观事实，例如说话、枪声、撞击、某人从 A 移动到 B，以及“某角色撬锁失败，工具从锁孔滑出”这类描述性行动结果。这类结果应使用带 actor/target entity refs 的 `action_result` fact，不应为了保存描述而伪造 `CharacterChange`。只有行动令角色真正进入了可持续的新状态，例如受伤、失衡、位置改变或获得状态效果，才同时输出 `CharacterChange`。

Engine 同时根据客观位置、拓扑、距离、遮挡、信号强度、直接作用关系和角色感官状态，输出能够感知到该 occurrence 的角色 ID。Engine 不输出每个角色具体感知到哪些 fact、如何理解、是否认出参与者或任何角色视角文本。

Engine 之后直接进入按角色渲染：

```text
Occurrence[]（客观事实 + perceiverCharacterIds）
    ↓ for each perceiverCharacterId
Perception Renderer
    + occurrence facts/signals
    + character profile/location/senses/knowledge/memory/current action
    ↓
RenderedPerception（第一人称、主观、身份脱敏）
    ↓
RoleSim Agent decision
```

```ts
interface OccurrenceRenderInput {
  characterId: string;
  occurrences: Occurrence[];
  character: CharacterRenderContext;
}
```

Controller 按 `perceiverCharacterIds` 聚合该角色本 tick 的 occurrences，每个角色最多调用一次 Renderer。Renderer 根据 occurrence signals 和角色自身情况决定具体呈现哪些事实、用什么称谓、感知清晰度以及第一人称表达，但不能创造 occurrence 中不存在的客观事实。Controller 将拥有 occurrence 的角色作为本 tick 决策候选，并与行动结束 transition、空闲状态合并去重。

### D7. 行动触发结算时注入完整世界，由 Engine 判断相关性和因果

统一 Engine 的输入必须是一个可验证、可重放的 `EngineResolutionContext`，而不是由各个 Tool 临时拼接自己的 prompt：

```ts
interface EngineResolutionContext {
  trigger: {
    actionIds: string[];
    reason: "new_action" | "duration_reached" | "replacement" | "interrupted";
  };

  tick: {
    tickId: string;
    tickStartTime: GameTime;
    durationMinutes: number;
    worldVersion: string;
    randomSeed: string;
  };

  rules: {
    resolutionGuide: "src/engine/rules/world-action-resolution.md";
    outputSchemaVersion: number;
    worldInvariants: WorldInvariant[];
  };

  state: {
    scenes: SceneSnapshot[];
    items: ItemSnapshot[];
    characters: CharacterSnapshot[];
  };

  actions: {
    newCommands: ActionCommand[];
    activeActions: EngineAction[];
  };

  events: {
    objectiveWorldEvents: ObjectiveWorldEvent[];
    deterministicResults: DeterministicResult[];
  };
}
```

World Action Engine 不因时钟每跳动一次就自动调用。只有存在 action resolution trigger 时，才构建一个全局 resolution context 并调用一次 Engine。每次调用注入：

- **结算触发器：** 触发结算的 action IDs 与原因，例如新 command、行动到达 Engine 指定的时长、replacement 或 interruption。
- **Tick 上下文：** tick ID、起始时间、全局固定 tick 时间单位、不可变 world version 和确定性随机种子。
- **统一指导：** 同一份世界行动结算规则、输出 schema 版本和代码侧世界不变量；不注入单项 ActionDefinition。
- **场景状态：** 所有场景的客观状态、实体列表、连接、距离、可达性、遮挡、光照、噪声和其他环境条件。
- **物品状态：** 所有物品的位置、持有者、容器/装备关系、完整度、开启/锁定/激活状态、容量、耗材和客观属性。
- **角色状态：** 所有角色的基础属性、真实 skill 值、HP/SAN/疲劳、位置、姿态、状态效果、感官、装备、关系和结构化知识。
- **新增行动：** 本 tick 全部 `ActionCommand`，包括 trusted envelope、意图、目标、替换关系和已立即生成的 `SkillRollRecord`。
- **进行中行动：** 世界中全部未结束 `EngineAction`，包括原始 command、status、progress、runtime、nextWakeAt 和已结算且不可重复的效果。
- **本 tick 客观输入：** 在当前 resolution phase 之前已发生或按时序已生效的 scripted/world events，以及 skill roll、pathfinding、damage dice 等受信任确定性结果。

“全量”在 MVP 中就是每次 Engine 被行动触发时都提供完整世界权威快照，不代表无行动时也每 tick 调用 Engine。不预先计算冲突组，不预先裁剪所谓“相关”场景、物品或角色。Engine 根据场景拓扑、时间、距离、物理接触、信号和行动依赖，自己判断哪些行动互相影响、效果传播到哪里、哪些角色能感知到 Occurrence。

所有 `state` 必须来自同一 `worldVersion`；不得把本 tick 尚未 flush 的预期变化伪装成已发生事实。未来只有在完整世界输入经验证确实成为成本瓶颈后，才另行设计上下文裁剪；该优化不属于本计划。

以下内容不注入 World Action Engine：

- Renderer 产生的角色视角文本；
- RoleSim 的思维过程、希望发生的结果或未结构化内心独白；
- 角色的未结构化全量记忆；但世界实体和会影响行动的结构化知识在 MVP 中保持全量注入；
- 旧 Interpreter 的解释结果、`InterpretedStep[]` 或单项 ActionDefinition；
- 尚未通过 validator/Applier 提交的预期状态变化。

### D8. 使用一份统一世界结算规则，不再存在单项 ActionDefinition

Engine 不再先判断“这是什么 action type”，也不根据 action type 切换不同 prompt、state domain 或 output schema。所有行动都由同一份稳定规则文档处理：

```text
src/engine/rules/world-action-resolution.md
```

该文档只描述跨行动通用的第一性原则：

1. **因果性：** 每个变化必须能由当前行动、进行中行动或本 tick 事件直接解释。
2. **状态约束：** 结果必须服从角色能力、身体状态、工具、物品状态、场景条件和目标抵抗。
3. **时空局部性：** 角色只能影响当前可接触或通过真实传播链可影响的实体；移动必须服从拓扑和耗时。
4. **时间与进度：** 全局 tick 时间单位固定；角色只提交 `proposedDurationTicks`，Engine 根据行动与世界状态决定 `resolvedDurationTicks` 和 `nextWakeAt`。长行动在到达结算点前只保存 progress，不提前提交尚未发生的完整结果。
5. **守恒与所有权：** 物品不能同时属于多个位置；消耗、转移、创建和销毁必须有合理来源与去向。
6. **先骰后审：** 角色附带其拥有的 `skillId` 时立即生成并持久化骰点；Engine 随后判断技能是否适用、需要什么成功等级以及结果。没有 `skillId` 时由 Engine 直接判断，不进行隐藏骰点。
7. **能力内化：** 角色只声明技能 ID；真实技能值、阈值和随机结果全部由受信任代码从角色状态产生，角色不能伪造。
8. **并发一致性：** 同一快照上的冲突行动联合判断，独占资源不能产生互相矛盾的结果。
9. **最小充分变化：** 只输出实际改变的字段，不为丰富叙事制造无关状态。
10. **事实与感知分离：** Engine 输出客观 Occurrence 和能够感知它的角色 ID；Renderer 再根据 occurrence signals 与角色自身决定具体感知内容、主观表达和可写入记忆的内容。
11. **行动触发：** 无新行动、无到期进行中行动、无 replacement/interruption 时不调用 World Action Engine；普通时钟推进不是语义结算触发器。

所有 Tool 都只是结构化意图入口，不决定 Engine 可修改的 state domain：

```text
                         act
                         ↓
              Unified World Action Engine
                         ↓
   ActionTransition[]
   + CharacterChange[] / SceneChange[] / ItemChange[]
   + Occurrence[]
```

只要满足统一因果规则和世界不变量，Engine 可以在同一次结算中修改角色、场景或物品状态。例如一次撞门行动可以同时造成角色疲劳、门损坏和场景噪声；不需要预先选择一个只允许部分字段的 action definition。

### D9. 确定性规则必须在代码侧执行

- movement：复用现有 `movementSubsystem`；
- skill applicability、required success level、check type、targets、opposed defense：Engine 在收到 actor roll 后决定；
- skill roll：复用现有 skill-check pipeline；
- inventory ownership/presence：代码校验；
- damage dice/clamp：代码执行；
- elapsed/progress arithmetic：Engine 执行；
- entity/reference validity：代码校验；
- 通用 WorldDelta schema、ID 引用和世界不变量：代码校验；
- 并发行动的实际结果：Engine 在全局上下文中联合判断；代码 validator + Applier 只负责拒绝仍然违反唯一所有权或状态不变量的输出。

Engine 可以在内部使用语义模型理解行为并提出 `ActionJudgement`，但该结果必须经过代码校验。带 skill 的行动在进入 Engine 前已经拥有不可变的 actor roll record；Engine 负责根据行动事实判断技能相关性、所需成功等级、是否需要对抗以及最终结果。未带 skill 的行动走 direct judgement，由语义 Engine 根据完整状态直接给出客观结果；它不生成角色视角叙事或记忆。

### D10. 迁移采用双路径和 shadow mode

在完全删除旧 Interpreter 前保留 feature flag：

```ts
type ActionPipelineMode =
  | "legacy_interpreter"
  | "tool_commands_shadow"
  | "tool_commands";
```

- `legacy_interpreter`：现有行为；
- `tool_commands_shadow`：新路径生成 resolution 但不写入 DGSM，与旧路径结果对比；
- `tool_commands`：新路径成为权威。

不允许双路径同时写入世界。

## 4. Data contracts

### 4.1 Agent-facing reference

```ts
interface ActionEntityRef {
  kind: "character" | "item" | "scene";
  id: string;
}

interface ActionObjectRef extends ActionEntityRef {
  role?: "target" | "tool" | "destination" | "recipient";
}
```

`act` 使用结构化 `objectRefs`，不再要求模型在 `actionText` 中拼接 `[narrative]` / `[references]` 两段文本。`role` 只表达角色如何使用该对象，不限制 Engine 最终可修改哪些实体。

Controller 使用本 tick 的 `PerceivableDirectory` 验证所有 refs。持久化的 command 保存结构化 refs，因此不再需要后续重新解析 citation 文本。`utterance` 用于保留确切说话原文；未说话的行动不填写。

### 4.2 Unified ActionCommand

```ts
interface ActionCommand extends TrustedActionEnvelope {
  description: string;
  utterance?: string;
  objectRefs: ActionObjectRef[];
  /** Role-proposed commitment/estimate; Engine may accept, shorten or extend it. */
  proposedDurationTicks: number;
  /** Copied from the Action Tool's optional skillId after profile validation. */
  declaredSkillId?: string;
  /** Trusted, immutable and generated immediately when declaredSkillId exists. */
  skillRoll?: SkillRollRecord;
}
```

实际实现使用一个严格 JSON Schema，不再存在按动作类型的 discriminated union。Agent-facing `act` args 不暴露 trusted envelope、`declaredSkillId` 或 `skillRoll`；Trusted Action Intake 把 `skillId` 转换成后两者。

唯一会创建新 command 的 `act` Tool 必须填写正整数 `proposedDurationTicks`；`continue` 不创建 command，因此不重新提交时长。Trusted Action Intake 只校验取值范围并持久化该意图值。Engine 在首次结算时产生 `resolvedDurationTicks`，并据此设置 `nextWakeAt`；若世界状态真正发生改变而需调整时长，Engine 必须输出新的 timing reason，不得静默改写。

### 4.3 Engine-owned action judgement

角色 Tool 参数中的 `skillId` 经 Trusted Action Intake 做“该角色确实拥有此技能”的基础校验后，立即由受信任代码生成 `SkillRollRecord`。这不是技能适用性审核；只是为了取得可信的真实技能值。Command 必须满足 `declaredSkillId` 与 `skillRoll` 同时存在或同时不存在：

```ts
interface SkillRollRecord {
  rollId: string;
  skillId: string;
  skillValue: number;
  roll: number;
  successLevel:
    | "critical"
    | "extreme"
    | "hard"
    | "regular"
    | "failure"
    | "fumble";
}

type ActionJudgement =
  | {
      kind: "direct";
      outcome: "success" | "partial" | "failure" | "blocked" | "continue";
      reason: string;
    }
  | {
      kind: "skill_assessed";
      skillId: string;
      rollId: string;
      applicability: "accepted" | "rejected";
      requiredLevel?: "regular" | "hard" | "extreme";
      checkType?: "single" | "opposed";
      targetIds: string[];
      opposedDefenseIds?: string[];
      outcome: "success" | "partial" | "failure" | "blocked" | "continue";
      reason: string;
    };
```

`declaredSkillId` 为空时只能产生 `direct` judgement，不掷骰。存在时骰点已经发生，Engine 必须产生 `skill_assessed`：技能合理时结合 successLevel、requiredLevel、目标抵抗和世界状态判断结果；技能不合理时标记 `applicability: "rejected"`，该骰点不提供成功收益，但仍保留在 trace 中用于重放和审计。`applicability` 被拒绝时不必伪造 `requiredLevel` 或 `checkType`。

### 4.4 Engine-internal deterministic code tools

```ts
interface EngineCodeTool<I, O> {
  readonly name: string;
  execute(input: I, snapshot: Readonly<WorldSnapshot>): Promise<O>;
}
```

pathfinding、movement cost、inventory ownership/presence、skill/opposed roll、damage dice 和数值 clamp 等确定性能力作为 Engine 内部 code tools 暴露。Engine 根据统一 `ActionCommand.description + objectRefs` 决定何时调用；不存在 `ActionCommand.kind -> executor` 路由。Code tool 只返回可信计算/校验结果，不直接修改 DGSM；最终变化仍由统一 Engine 输出并经 Applier 提交。

## 5. Target tick phases

```text
Phase 1  Freeze tick-start snapshot and advance logical clock
Phase 2  Drain ActionCommand inbox
Phase 3  Validate commands against tick-start state/perceivable scope
Phase 4  Build one full-world EngineResolutionContext
Phase 5  Attach replacements/interruption triggers
Phase 6  Run one global World Action Engine session with deterministic code tools
Phase 7  Collect structured transitions, changes and occurrences
Phase 8  Run anchor subsystems and scripted events
Phase 9  Validate transitions and sourced WorldDeltas
Phase 10 Validate and reject incompatible writes
Phase 11 Applier flushes once
Phase 12 Persist actions and emit TickReport
```

所有行动读取同一个 tick-start snapshot。除明确的 phase contract 外，一个行动不能读取另一个行动刚刚写出的未提交变化。

Phase 4–7 是条件阶段：如果本 tick 没有 action resolution trigger，就不构建模型上下文，也不调用 World Action Engine；时钟、确定性 subsystem 和已排程 scripted event 仍可按各自规则推进。

### Action-driven resolution trigger policy

Active actions 不会仅因时钟走了一个普通 tick 就重新调用模型。满足任一条件才触发一次全局 World Action Engine 结算：

- inbox 中有新 action command；
- `nextWakeAt <= tickTime`；
- 新 command 声明 replacement；
- 进行中行动收到明确 interruption/cancellation 信号。

新 action 首次进入 Engine 时，Engine 将角色提交的 `proposedDurationTicks` 与完整世界状态一起判断，产生权威 `resolvedDurationTicks`。若行动不立即完成，将其保存为 active 并设置 `nextWakeAt`。到期时该 active action 再次触发 Engine 结算实际完成、继续、失败或中断。

一旦被任一 action 触发，Engine 仍接收完整世界、本 tick 全部新 actions 和全部 active actions，由 Engine 判断其他行动是否被影响；这样既保留全局判断能力，又避免在没有行动结算需求时空调用模型。

## 6. Implementation phases

### Phase 0: Baseline and fixtures

**Goal:** 固定旧系统行为，建立迁移对照数据。

**Files:**

- Create: `src/engine/actions/__tests__/fixtures/`
- Create: `src/engine/actions/__tests__/legacyParity.test.ts`
- Modify: simulation debug logging as needed

- [ ] 记录至少以下旧路径 fixture：普通行动、移动、物品交换、单人技能、对抗技能、行动中途切换、两个角色争用同一物品、目标离场。
- [ ] fixture 保存 tick-start snapshot、agent decision、旧 interpreted steps、resolver output、TickReport。
- [ ] 确认当前 `pnpm build:tsc` 和相关 Vitest 测试基线。
- [ ] 定义 shadow comparison 允许的非确定性差异；比较 action status、引用实体、关键 state-change kind 和 objective facts，不要求下游 Renderer 文本逐字相等。

**Exit criteria:** 迁移前的关键行为可重复观察，失败时能区分新旧路径差异。

### Phase 1: Introduce command and lifecycle types

**Goal:** 添加新类型，不改变运行时行为。

**Files:**

- Create: `src/engine/actions/types.ts`
- Create: `src/engine/actions/__tests__/types.test.ts`
- Modify: `src/engine/core/types.ts` only for shared/re-exported types

- [ ] 定义 agent tool args、trusted envelope、`ActionCommand`、`SkillRollRecord`、`ActionJudgement`、`EngineAction`、`ActionTransition`、`CharacterChange | SceneChange | ItemChange`、`Occurrence`、`TickResolution`。
- [ ] 定义 command schema version，初始值 `1`。
- [ ] 为 `ActionCommand` 单一 schema 添加 required/optional 字段、object ref role 和边界值测试；不建立 action-kind discriminator。
- [ ] 明确 `EngineAction.runtime` 的序列化限制：仅 JSON-safe 数据，不保存闭包、Map 或类实例。

**Exit criteria:** 新类型通过类型检查，旧 pipeline 无行为变化。

### Phase 2: Build the unified agent-facing act tool

**Goal:** 角色直接选择结构化行动 Tool。

**Files:**

- Create: `src/roleSim/tools/act.ts`
- Modify/reuse: the existing `continue` control tool
- Modify: `src/roleSim/tools/schemas.ts`
- Modify: `src/roleSim/systemPrompt.ts`
- Modify: `src/roleSim/agent.ts`
- Modify: `src/roleSim/llmAgent.ts`
- Modify: `src/roleSim/toolDispatcher.ts`
- Modify tests under `src/roleSim/__tests__/`

- [ ] 只将一个 `act` 注册为创建世界行动的 terminal tool。
- [ ] 保留 `continue`；没有 active action 时调用继续保持现有 no-op 语义。
- [ ] Tool args 只包含角色可声明的意图字段，不包含 trusted envelope。
- [ ] `objectRefs` 采用 `{id, kind, role?}` 结构，不再依赖 actionText citation block；role 只可为 target/tool/destination/recipient。
- [ ] `act` 必填 `description`、`objectRefs`、`proposedDurationTicks`，可选 `skillId` 和 `utterance`；`utterance` 保留角色实际说出的原文。
- [ ] prompt 明确 `proposedDurationTicks` 只是角色的预估/投入意愿，不是实际耗时。
- [ ] Tool schema 不接受 skill value、difficulty、check type、roll 或 success 字段。
- [ ] Agent prompt 说明：只在角色有意识地运用某项已拥有技能时附带 `skillId`；不得为了数值优势填写与行动无关的高技能。
- [ ] 更新 agent prompt：禁止把预期结果写成已经发生的事实。
- [ ] 更新 agent loop，使 `act` 返回单一 action decision；`continue` 仍返回不创建 command 的控制 decision。
- [ ] 保持 informational tools 与 terminal tool 不得在同一 turn 混用的现有约束。

**Exit criteria:** Agent 能稳定产生结构化 action decisions；尚不提交到新 Engine 路径。

### Phase 3: Command normalization and trust boundary

**Goal:** 把模型参数安全地转换成受信任 `ActionCommand`。

**Files:**

- Create: `src/engine/actions/commandBuilder.ts`
- Create: `src/engine/actions/commandValidator.ts`
- Create: `src/engine/actions/__tests__/commandValidator.test.ts`
- Modify: `src/state/perceivableDirectory.ts` if a reusable ref validator is needed
- Modify: `src/roleSim/npcActionController.ts`

- [ ] Controller 根据 NPC id、当前时间、当前场景构建 trusted envelope。
- [ ] 从 Engine 查询 active action；若新 command 应替换它，写入 `replacesActionId`，但不立即取消。
- [ ] 校验所有 refs 属于调用角色的 `PerceivableDirectory`。
- [ ] 若 Tool 带 `skillId`，Trusted Action Intake 只校验该 ID 确实存在于角色 profile/abilities 并立即掷骰；不在此做任何语义适用性、难度或成败判断。
- [ ] 校验 `proposedDurationTicks` 是配置范围内的正整数，原样写入 command；CommandBuilder 不得将它转换成权威耗时。
- [ ] 校验 `objectRefs.role` 枚举与引用可见性；不根据 role 把 command 分类为移动、交流或交换。
- [ ] item ownership/presence、目标存活、destination 可达性和复合行动可行性都交由 Engine 在完整上下文中判断；CommandBuilder 不语义分类。
- [ ] 对拒绝结果返回结构化 reason，使 Agent 下一次决策能看到事实反馈。
- [ ] 复用 `parseActionText` 的底层 entity-scope 校验思路，但新路径不再解析 citation prose。

**Exit criteria:** 模型无法伪造 actor、scene、time 或不可感知 entity；command 可安全持久化。

### Phase 4: Add Engine command inbox and persistence

**Goal:** Engine 接收 command，而不是解释自然语言并立即生成 steps。

**Files:**

- Create: `src/engine/actions/commandInbox.ts`
- Create: `src/engine/actions/actionStore.ts`
- Create: `src/engine/actions/__tests__/commandInbox.test.ts`
- Modify: `src/engine/core/tickEngine.ts`
- Modify: `src/engine/core/queue.ts` or replace it behind an adapter
- Modify: engine serialization types and `src/simulation/SimulationRunner.ts`

- [ ] 添加 `submitCommand(command): Promise<ActionReceipt>`。
- [ ] 添加 `getActorActions(actorId)`、`getAction(actionId)`。
- [ ] command inbox 保证 commandId 幂等；相同 command 重试不能生成第二个 action。
- [ ] inbox 保存 command 创建时的 `SkillRollRecord`；排队、tick retry 和 rehydration 只能复用该 rollId，不得重掷。
- [ ] `EngineAction` 与 inbox 一起进入 `TickEngine.serialize()`。
- [ ] snapshot 中记录 `actionSchemaVersion`。
- [ ] 为旧 `ActionStep[]` snapshot 提供兼容读取策略：继续 legacy mode，或显式执行一次迁移；不得静默丢失 active action。
- [ ] 暂时保留 `submitAction(ActionInput)` 作为 legacy adapter。

**Exit criteria:** 新 command 能排队、序列化、恢复，但尚未成为默认结算路径。

### Phase 5: Engine-internal deterministic code tools

**Goal:** 将必须精确计算或校验的能力暴露给统一 Engine，而不按角色动作类型路由到不同 executor。

**Files:**

- Create: `src/engine/tools/pathfindingTool.ts`
- Create: `src/engine/tools/movementCostTool.ts`
- Create: `src/engine/tools/inventoryValidationTool.ts`
- Create tests under `src/engine/tools/__tests__/`
- Modify: `src/engine/subsystem/movement.ts` only to expose/reuse existing mechanics
- Modify: `src/engine/registerDefaults.ts`

- [ ] pathfinding/movement cost tool 复用现有 movement subsystem，不复制算法。
- [ ] inventory validation tool 原子检查物品位置、持有者、容器关系和唯一所有权，但不直接转移物品。
- [ ] 整理可复用的 skill/opposed roll、damage dice、clamp 和时间换算为受信任 Engine code tools。
- [ ] 所有 code tool 输入/输出可持久化和重放，并记录调用来源 actionId。
- [ ] code tool 不直接调用 DGSM mutator，不输出角色视角文本，不根据 action kind 注册或路由。

**Exit criteria:** 统一 Engine 可从 `act.description + objectRefs` 按需调用确定性能力；角色和 Command 都不需要先声明动作类型。

### Phase 6: Immediate skill roll and Engine assessment

**Goal:** 角色可在统一 `act` Tool 中声明要使用的技能；受信任代码立即掷骰，Engine 再判断技能选择和最终结果。未声明技能的行动由 Engine 直接判断，不进行隐藏检定。

**Files:**

- Create: `src/engine/actions/adjudication/skillAdjudicator.ts`
- Create: `src/engine/actions/adjudication/types.ts`
- Create: `src/engine/actions/adjudication/__tests__/skillAdjudicator.test.ts`
- Create: `src/engine/rules/world-action-resolution.md`
- Refactor/reuse: existing skill roll utilities under `src/engine/shared/` and `src/engine/tools/`

- [ ] 编写统一 `world-action-resolution.md`，只包含第一性原则、检定原则、时间/因果/并发约束和 WorldDelta 输出规则，不包含单项行动定义。
- [ ] 定义不可变 `SkillRollRecord`，包含 rollId、skillId、提交时的真实 skillValue、raw roll 和 successLevel。
- [ ] CommandBuilder 在确认角色拥有 skillId 后立即调用 deterministic roll service；不等待 Engine 做语义适用性判断。
- [ ] `declaredSkillId` 与 `skillRoll` 必须同时存在或同时不存在；command retry 使用已有 rollId，绝不重骰。
- [ ] 定义 `ActionJudgement`：无骰点的 `direct` 或骰后判定的 `skill_assessed`。
- [ ] 没有 `declaredSkillId` 时产生 `direct` judgement，由 Engine 基于完整上下文判断 success/partial/failure/blocked/continue。
- [ ] 存在 `declaredSkillId + skillRoll` 时，Engine 读取行动目标、方法、现场条件、工具、目标抵抗和进行中行动，判断技能是否语义适用。
- [ ] 技能不适用时输出 `applicability: "rejected"`；已经发生的骰点保留，但不得为行动提供成功收益。
- [ ] 技能适用时，Engine 根据客观难度给出 requiredLevel，并把 roll successLevel 与 requiredLevel、对抗结果和场景约束共同用于最终结算。
- [ ] Engine 必须给出技能适用性和 requiredLevel 的事实依据，便于审计“看到骰点后迁就结果”的偏差；本架构接受 Engine 在看到 roll 后完成这项判断。
- [ ] opposed check 如需目标方随机结果，由 Engine 明确选择 defense 后调用 deterministic opponent-roll tool；actor roll 不得重掷。
- [ ] Skill adjudication 是统一 Engine 阶段；不能因 Engine 为该行动调用了确定性 code tool 就忽略已产生的 skill roll。
- [ ] Unified World Action Engine 接收 action + roll result 与最新 actor/target/scene/item state，产生 judgement，并输出通用 WorldDelta、Occurrence 和行动结算事实。
- [ ] validator 检查 WorldDelta 的结构、实体引用、数值边界和世界不变量；不再按 action type/definition 限制可修改的 domain。
- [ ] `SkillRollRecord` 随 command 持久化，`ActionJudgement` 随 action runtime 持久化；retry、取消或恢复不得生成新的 actor roll。
- [ ] 一个角色提交的 skill 默认只对应一个 actor roll；长行动需要再次检定时，必须由角色产生新的带 skill 行动，或另行定义明确的持续检定协议。

**Exit criteria:** RoleSim 只能输出可选 skill ID；技能存在时立即产生一次可信 roll，Engine 随后独占适用性、required level、对抗配置和最终结果；未声明 skill 的行动不产生隐藏 roll。

### Phase 7: Unified World Action Engine global resolution

**Goal:** 统一处理所有 `act` commands 和进行中行动，不先分类为移动、对话、交换或 fallback。

**Files:**

- Create: `src/engine/resolution/worldActionEngine.ts`
- Create: `src/engine/resolution/contextBuilder.ts`
- Create: `src/engine/resolution/worldDeltaSchema.ts`
- Create: `src/engine/resolution/worldDeltaValidator.ts`
- Create tests under `src/engine/resolution/__tests__/`
- Refactor/migrate useful generic logic from: `src/engine/resolver/stateResolver.ts`
- Refactor/migrate useful context logic from: `src/engine/resolver/stateContextBuilder.ts`

- [ ] 只有 action resolution trigger 存在时，`contextBuilder` 才按 D7 产生唯一完整 `EngineResolutionContext`：trigger、tick/version/seed、统一指导与不变量、全部 scene/item/character snapshots、本 tick 全部 new commands、全部 active actions、已生效客观事件和确定性结果。
- [ ] Engine 在新 action 首次结算时读取 `proposedDurationTicks`，并输出权威 `resolvedDurationTicks + nextWakeAt + timing reason`；不得直接信任角色提交的耗时。
- [ ] 不建立 action footprint、conflict group 或上下文因果裁剪器；Engine 从完整输入中自己判断行动冲突、因果影响和感知者。
- [ ] 验证全局 context 内所有 state 来自同一 tick-start `worldVersion`；禁止注入 Renderer 文本、RoleSim 思维过程、Interpreter 输出或未 flush delta。
- [ ] 添加全量上下文测试：任意场景、物品、角色、新行动和 active action 都必须完整出现，且不得为“看起来无关”而被代码层过滤。
- [ ] 全局 output 必须按 actionId 返回 transition，并将世界变化显式分组为 `characterChanges` / `sceneChanges` / `itemChanges`；所有 change 带 source actionId。
- [ ] 每个 WorldDelta 必须携带 `causalBasis`；validator 拒绝无法关联到输入行动、进行中行动或本 tick 事件的变化。
- [ ] 每个 Occurrence 输出原子化客观 facts、直接 participants、客观 signals 和 `perceiverCharacterIds`；接收者只用 character ID 表示。
- [ ] 角色行动的一次性描述结果使用 `Occurrence.fact(type: "action_result")` 表达；只有 HP、位置、姿态、条件等真正状态变化进入 `characterChanges`。
- [ ] Engine 根据位置、拓扑、距离、遮挡、signals、直接作用关系和角色感官状态计算 perceiver IDs，但不为各角色输出 fact 子集或感知解释。
- [ ] Engine 的 fact content 禁止使用特定角色视角措辞，例如“我看见”“我认出”“令我害怕”；身份、位置和结果使用世界真实引用。
- [ ] 所有 `act` commands 使用同一 World Action Engine 输入形状和统一规则；`description` 可表达单一或复合行动，`objectRefs.role` 不决定允许修改的 state domain。
- [ ] Engine 输入同时包含 declared skill 和已生成的 SkillRollRecord；Engine 完成适用性、required level、对抗与最终 WorldDelta 判断。无 skill 则 direct judgement，不生成 `InterpretedStep[]` 或 `definitionId`。
- [ ] 对不存在 ID、违反世界不变量、重复 action transition、非法状态迁移执行一次 corrective retry；重试后仍非法则丢弃对应 action 的非法 delta，并将 action 标记为 failed/rejected。
- [ ] Engine 必须在一次全局结算中处理：同一物品被多人获取、目标离场、角色死亡后继续行动、互相替换/打断、同一 connection 的冲突修改；validator 作为最后不变量防线，不另行分组或重新语义结算。
- [ ] 保留 Applier 对 hp/san/fatigue 的聚合语义。

**Exit criteria:** 行动触发时，所有新增和进行中行动与完整世界快照由同一 Engine 基于统一规则联合结算，且 Engine 产生权威行动时长；无触发时不调用模型。不存在预先冲突分组、因果上下文裁剪、action definition 选择或 Interpreter。

### Phase 8: Rewrite TickOrchestrator action phases

**Goal:** Engine 正式成为唯一动作推进器。

**Files:**

- Modify: `src/engine/core/tickOrchestrator.ts`
- Modify: `src/engine/core/tickEngine.ts`
- Modify: `src/engine/core/eventBus.ts`
- Modify: `src/engine/core/types.ts`
- Modify: `src/engine/core/applier.ts` only for sourced-change adapter/validation
- Modify tests under `src/engine/core/__tests__/` and `src/engine/__tests__/integration/`

- [ ] 按第 5 节的新 phases 替换 queued-step activation 和 plannedOutcome commit 流程。
- [ ] 同一个 tick-start snapshot 驱动本次全局 action resolution。
- [ ] 实现 action-driven gate：无 new/due/replacement/interruption action 时跳过 World Action Engine，不影响时钟和确定性 subsystem 推进。
- [ ] replacement 在 action resolution 阶段生成 interruption，不再使用 pending cancellation re-resolve。
- [ ] active action 的 progress、runtime 和 nextWakeAt 在 flush 成功后更新；若 flush 失败，不提交生命周期变化。
- [ ] `TickReport` 增加 transitions，同时在迁移期继续派生 legacy activations/commits/cancellations。
- [ ] `TickReport` 增加 occurrences；迁移期把 subsystem/scripted `FeatureEvent` 适配成 Occurrence，最终统一下游事件入口。
- [ ] 保持 anchor subsystems 和 scripted events 的既有相对时序，除非另行批准语义变化。
- [ ] 增加 tickId/worldVersion，保证 retry 不重复应用同一 TickResolution。

**Exit criteria:** 新 action path 可以端到端推进并生成 UI/Memory 所需报告。

### Phase 9: Per-character rendering and RoleSim switch

**Goal:** Engine 通过 perceiver IDs 路由客观 occurrences，Renderer 再结合每个角色自身生成感知；RoleSim 只接收渲染结果并提交 command。

**Files:**

- Modify: `src/roleSim/npcActionController.ts`
- Modify: `src/roleSim/agent.ts`
- Modify: `src/roleSim/userPromptBuilder.ts`
- Modify: `src/roleSim/renderer/buildBundle.ts`
- Modify: `src/roleSim/renderer/llmRenderer.ts`
- Create or modify tests under `src/roleSim/renderer/__tests__/`
- Modify: memory routing tests

- [ ] 将 terminal action decisions 交给 `commandBuilder + submitCommand`。
- [ ] 删除 Controller 的“先 cancel 当前 action”逻辑。
- [ ] `continue` 只保留为角色决策，不提交新 command。
- [ ] Controller 按 `occurrence.perceiverCharacterIds` 建立 characterId → occurrences 映射；同一角色同一 tick 只进入一次渲染/决策流程。
- [ ] Renderer 输入该角色对应的完整 occurrences，以及角色 profile、位置、感官、知识、记忆、当前状态和当前行动。
- [ ] Renderer 根据 occurrence signals 与角色自身判断该角色具体感知到哪些方面；Engine 不提供 per-character fact 子集。
- [ ] Renderer 必须隐藏角色尚未知晓的 canonical identity，并允许不同角色对同一 fact 产生不同但不违背事实的表述。
- [ ] Renderer 不得创造 occurrence facts 中不存在的实体、动作、结果或因果关系；不确定或只能听见时必须采用相应模糊表达。
- [ ] Controller 将 perceiver IDs、行动结束 transition 和空闲角色合并去重，选择需要调用 `decide()` 的 NPC。
- [ ] 当前行动提示读取 `EngineAction`，展示 intent、progress 和 startedAt，不暴露 engine runtime。
- [ ] 客观状态记忆若仍由 WorldDelta 产生，只作为事实记录；主观 witness/perception memory 必须根据该角色的 rendered perception 写入。
- [ ] 被拒绝的 command 作为下一次 perception/decision feedback，而不是伪造成已发生事件记忆。

**Exit criteria:** RoleSim 与 Engine 的唯一动作边界是 `ActionCommand`。

### Phase 10: Shadow rollout and parity verification

**Goal:** 在不污染世界状态的前提下比较新旧结果。

**Files:**

- Create: `src/engine/actions/shadowComparator.ts`
- Create: `src/engine/actions/__tests__/shadowComparator.test.ts`
- Modify: simulation configuration and logging
- Add integration fixtures/scripts under `scripts/`

- [ ] 开启 `tool_commands_shadow`，旧 pipeline 仍是唯一 writer。
- [ ] 对比 action description/objectRefs、status、duration band、state-change kinds、关键 entity ids。
- [ ] 输出结构化 mismatch 日志，不比较自由叙事的逐字一致性。
- [ ] 使用固定随机种子运行多 NPC、多地点、行动中断和并发物品场景。
- [ ] 统计 Interpreter 调用量、World Action Engine 调用量、输入/输出 token、tick latency 和非法 ref rate。
- [ ] 达到验收门槛后切换 `tool_commands`。

**Exit criteria:** 关键状态语义无回退，且 Interpreter 调用已不在正常路径出现。

### Phase 11: Remove legacy interpreter pipeline

**Goal:** 删除已无调用者的旧路径和兼容字段。

**Files:**

- Delete: `src/engine/interpreter/gameInterpreter.ts`
- Delete or replace: `src/engine/core/actionIntake.ts`
- Delete: `src/engine/definitions/registry.ts`
- Delete: `src/engine/tool_definitions/` after unified-rule parity is verified
- Delete: obsolete per-definition resolver prompt/schema builders after generic logic is migrated
- Modify: `src/engine/core/tickEngine.ts`
- Modify: `src/simulation/SimulationRunner.ts`
- Modify: `src/engine/types.ts`
- Modify: `src/engine/core/types.ts`
- Modify: `src/engine/registerDefaults.ts`
- Modify: `README.md`
- Delete obsolete interpreter tests after equivalent command tests exist

- [ ] 删除 `interpretAction` dependency injection。
- [ ] 删除 `InterpretedStep`、`InterpretedResult` 和 `ActionStep.plannedOutcome`。
- [ ] 删除 `ActionDefinition`、`ActionDefinitionRegistry`、`createDefaultDefinitions()` 及所有 `definitionId` 字段。
- [ ] 将旧 definition 中仍然有效的跨行动原则整理进唯一的 `world-action-resolution.md`；不得把 per-action 规则表原样拼接成伪统一文档。
- [ ] 删除 per-definition guidance、stateDomains、skillCheck 和 outputSchema 加载路径。
- [ ] 删除/停用所有按 move/communicate/interact/exchange/wait/attempt 注册的角色世界行动 Tool，以及 `ActionCommand.kind` 分发或 executor registry；生产只保留 `act` 与 `continue` 控制信号。
- [ ] 将 citation parsing 中仍有价值的纯校验逻辑迁移到 command validator；确认无调用者后再删除旧 parser。
- [ ] 将 `findAffectedCharacters` 中可复用的空间传播逻辑迁移到 Engine 的 occurrence perceiver 计算器；输出仅为 character IDs。
- [ ] 删除 legacy pipeline feature flag 和 snapshot adapter，前提是已过支持窗口。
- [ ] 更新 README 架构图和 action contract。

**Exit criteria:** 生产代码中不存在 ActionDefinition、definition 选择或自然语言分类阶段；所有 action 起源可追溯到具体 Tool/Command，所有开放结算使用同一规则文档和 WorldDelta schema。

### Phase 12: Final verification

- [ ] Run focused RoleSim tool-loop tests.
- [ ] Run focused Engine action/code-tool/world-resolution tests.
- [ ] Run persistence rehydration tests for queued, active, interrupted and completed actions.
- [ ] Run concurrent conflict scenarios with fixed seeds.
- [ ] Run `pnpm build:tsc`.
- [ ] Run `pnpm test`.
- [ ] Run `pnpm lint` and document any pre-existing unrelated failures.
- [ ] Verify no normal runtime call uses operation `game-interpreter`.
- [ ] Verify exactly one command-producing agent Tool exists: `act`; `continue` is control-only and every other world action is expressed through `act.description`.
- [ ] Verify `act` requires `description + objectRefs + proposedDurationTicks`, exposes only optional `skillId + utterance`, and never exposes skill value, difficulty, check type, roll, success or `resolvedDurationTicks`.
- [ ] Verify `ActionCommand` has no action-kind discriminator and no runtime path dispatches by move/communicate/interact/exchange/wait/attempt.
- [ ] Verify Engine persists an authoritative timing decision with reason.
- [ ] Verify Engine occurrences contain objective facts/participants/signals plus perceiver character IDs, without per-character fact subsets or subjective perception fields.
- [ ] Verify occurrence perceiver IDs obey physical/sensory reach, and Renderer never introduces facts absent from the occurrence.
- [ ] Verify every applied action-originated StateChange has an action source in debug traces.
- [ ] Verify retrying a tick or command is idempotent.
- [ ] Verify a valid declared skill is rolled exactly once before semantic applicability is assessed, including command retry, tick retry and snapshot rehydration.
- [ ] Verify idle clock ticks with no new/due/replaced/interrupted action make zero World Action Engine calls.

## 7. Test matrix

| Scenario | Expected result |
|---|---|
| Move to known reachable scene | command accepted; deterministic progress; final position change |
| Move to unknown/unreachable scene | rejected/failed with factual reason; no teleport |
| Ask present NPC a routine question | Engine emits objective speech facts with perceiver IDs; Renderer gives each listed actor grounded perception |
| Private speech with a bystander nearby | Engine includes only characters able to perceive the occurrence; Renderer decides what each one heard |
| Gunshot across adjacent scenes | Engine may list local and adjacent perceivers; Renderer uses signals/location to render sight versus sound-only perception |
| Silent state change with no witness | WorldDelta applies; occurrence contains no unrelated perceiver IDs |
| Speech with no persistent state change | Occurrence lists its perceivers and can trigger their next decisions |
| Difficult request with a relevant social skill | Actor roll is created immediately; Engine accepts the skill and judges outcome against required level/opposition |
| Difficult request without skillId | Engine directly judges success/partial/failure from full context; no hidden roll |
| Open a simple visible container without skillId | Engine directly resolves it; no unnecessary skill roll |
| Pick a secured lock with Locksmith | Locksmith roll is created immediately; Engine judges relevance, required level and result |
| Use an irrelevant high skill on a lock | Roll still occurs and is persisted; Engine rejects its applicability and grants no skill success benefit |
| Retry a command carrying a skill roll | Existing rollId is reused; no second actor roll is generated |
| Role proposes 1 tick for a difficult long action | Engine may assign a longer resolvedDurationTicks with an objective timing reason |
| Role proposes many ticks for an immediate action | Engine may complete immediately or shorten the authoritative duration |
| Clock advances with no action resolution trigger | No World Action Engine call; deterministic clock/subsystems continue |
| Active action reaches nextWakeAt | The action triggers one global resolution with the latest complete world snapshot |
| Character attempts an action but no persistent state changes | Emit an objective `action_result` occurrence; do not fabricate a CharacterChange |
| Failed action also injures the actor | Emit an `action_result` occurrence and a separate sourced CharacterChange for the injury |
| Two NPCs take same item | one atomic winner or explicit conflict result; never duplicate ownership |
| Target leaves before interaction completes | action interrupted/failed using latest snapshot |
| Replace active long action | old partial progress + interruption and new start resolved together |
| Retry same commandId | no duplicate action |
| Resume persisted active movement | same runtime/progress/path; no restart |
| Open-ended composite act | grounded semantic result; invalid refs/changes rejected without action-type classification |
| NPC dies while action active | action terminates; no later completion write |
| World Action Engine retry | original judgement and skill roll reused; no double state application |

## 8. Acceptance criteria

1. RoleSim 的所有新世界行动都通过唯一 `act(description, objectRefs, proposedDurationTicks, skillId?, utterance?)` Tool 产生；`ActionCommand` 没有动作类型字段，`continue` 只是不创建 command 的控制信号。
2. Agent 无法提交 actor/time/scene/actionId 等受信任字段。
3. `GameInterpreter` 不在正常路径调用；最终从代码中移除。
4. 不存在单项 ActionDefinition、per-definition prompt 或 per-definition output schema。
5. Engine 是 action status、progress、runtime 和 outcome 的唯一 source of truth。
6. Action Tool 不直接修改 DGSM，所有变化仍经 Applier 一次性提交。
7. 只有 new/due/replacement/interruption action 触发时才调用 World Action Engine；无行动结算触发的普通时钟 tick 不产生模型调用。
8. 触发结算时，本 tick 全部新增和进行中行动基于同一 tick-start snapshot 联合判断；Engine 接收 D7 定义的完整 `EngineResolutionContext`，代码层不预先过滤世界实体或行动。
9. RoleSim 必须提交意图性 `proposedDurationTicks`，且可以提交可选 `skillId`；它不能提交权威 `resolvedDurationTicks`、技能值、难度、check type、骰点或成功结果。Engine 根据行动和世界状态决定实际 tick 耗时及 `nextWakeAt`。
10. 带 skill 的行动在确认角色拥有该技能后立即掷骰；Engine 收到 roll 后判断适用性、required level、对抗和最终结果。无 skill 的行动由 Engine direct judgement，绝不隐藏掷骰。
11. Engine 可在满足统一因果规则时同时修改 character、scene 和 item state，不受 Tool 类别字段白名单限制。
12. Engine 将持久化世界变化显式分为 `characterChanges`、`sceneChanges` 和 `itemChanges`；描述性行动结果属于 Occurrence，不当作角色持久状态。
13. Engine 的 Occurrence 包含客观 facts、participants、signals 和 `perceiverCharacterIds`，但不包含 per-character fact 子集、角色主观视角或决策调度建议。
14. Renderer 对每个 perceiver 结合完整 occurrence 与角色自身决定具体感知内容；不同角色可以得到不同表达，但不能增加客观事实。
15. movement、roll、inventory ownership 和数值计算保持确定性。
16. action replacement 不需要独立 cancellation resolver。
17. snapshot/rehydration 可恢复进行中的 action，且不会重新判定同一 judgement point、重新掷骰或重复效果。
18. 记录完整世界输入的 token/latency 基线；MVP 不为了预测性能问题提前引入冲突分组或因果上下文裁剪。

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| 单一 `act.description` 过于开放，增加 Engine 理解负担 | 保留结构化 `objectRefs/role`、`proposedDurationTicks`、`skillId` 和 `utterance`；用 fixtures 覆盖移动、对话、物品、等待和复合行动 |
| Engine 误解行动描述后调用错误的确定性能力 | 不产生或持久化 action type；记录 code-tool 调用与输入，validator 拒绝与快照或引用不一致的结果 |
| 通用 WorldDelta schema 允许修改范围较宽 | 不按 Tool 限域，但逐 delta 校验因果说明、实体引用、数值边界、所有权、拓扑和世界不变量 |
| 每次行动结算注入完整世界和所有 active actions 导致成本上升 | 无行动触发时不调用 Engine；先测量触发调用的 token/latency 和结算质量，确认成为瓶颈后再设计裁剪方案 |
| 角色填写的时长与实际难度不符 | 将 `proposedDurationTicks` 始终视为意图；Engine 输出带客观理由的 `resolvedDurationTicks`，Tool 无权填写后者 |
| replacement 导致旧行动效果重复 | actionId + tickId + progress cursor + sourced changes 幂等校验 |
| snapshot 升级丢失进行中行动 | schema version + 显式 migration/legacy mode，禁止静默 drop |
| 新旧 pipeline 同时写入 | feature flag 保证单 writer；shadow output 永不进入 Applier |
| 角色滥用最高技能 | 无关技能虽然已掷骰，但 Engine 标记 applicability rejected，不给予技能成功收益，并记录原因 |
| Engine 看到骰点后迁就 required level | Engine 必须输出基于场景事实的 requiredLevel 理由并记录 trace；通过固定案例监控结果相关偏差 |
| Perceiver 计算或 Renderer 泄漏上帝视角事实 | Engine 只列出物理可感知的角色 ID；Renderer 按角色隔离调用，并测试未知身份、隔墙声音和不可见结果 |

## 10. Recommended delivery order

建议按以下里程碑交付，而不是一次性重写：

1. **M1 — Typed commands:** Phase 0–4，建立 Tool/Command 边界和持久化。
2. **M2 — Deterministic capabilities:** Phase 5，将 pathfinding、movement cost、inventory validation 等受信任能力暴露为 Engine 内部 code tools。
3. **M3 — Immediate skill roll:** Phase 6，支持角色声明 skill 后立即掷骰、Engine 骰后审核，以及无 skill 的 direct judgement。
4. **M4 — Unified world resolution:** Phase 7–8，使用同一规则联合结算新增和进行中行动。
5. **M5 — RoleSim cutover:** Phase 9–10，shadow 验证并切换 writer。
6. **M6 — Cleanup:** Phase 11–12，删除 Interpreter 和旧类型，完成全量验证。

M2 是第一个必须可运行的 vertical slice。若 M2 尚未稳定，不开始删除旧 pipeline；若 M4 尚未完成，不宣称“统一 tick 结算”已经实现。

## 11. Review questions before implementation

以下问题不阻塞本文作为默认计划，但正式编码前应确认：

actor skill roll 的边界已确定：由 Trusted Action Intake 内的 deterministic roll service 在 command 创建时立即生成；语义 World Action Engine 收到的 command 已携带 immutable `SkillRollRecord`。MVP 上下文边界也已确定：只有 action resolution trigger 才调用 Engine；调用时注入完整世界快照和全部 new/active actions，不预先分冲突组或裁剪因果上下文。角色提交 `proposedDurationTicks`，Engine 产生 `resolvedDurationTicks`。以下仍需在正式编码前确认：

1. 旧 snapshot 支持窗口多长？默认：至少跨一个发布版本，不静默删除 active actions。
2. WorldDelta 初版是直接替换当前 `StateChange`，还是先做 adapter？默认：先做 adapter 复用 Applier，稳定后再统一底层类型。
