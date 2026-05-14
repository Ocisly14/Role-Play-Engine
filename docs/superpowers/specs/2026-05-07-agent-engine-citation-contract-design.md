# Agent ↔ Engine Citation-Based Target Resolution — Design

**Date:** 2026-05-07
**Status:** Design complete — all 6 open questions resolved 2026-05-07. Ready for implementation plan.
**Builds on:**
- `docs/superpowers/specs/2026-04-20-engine-architecture-refactor-design.md` （TickEngine 三层架构）
- `docs/superpowers/plans/2026-04-21-engine-architecture-refactor-plan.md` §G （Phase G 渲染层）

---

## 1. Motivation

Phase G 渲染层落地后，agent 阅读 perception narrative 时已经在用 `[N]` 数字引用 + reference block 思考实体。但 agent 输出端仍保留旧的双字段契约：

```ts
RoleSimDecision.act = {
  actionText: string,
  targetCharacterIds?: string[],   // ← 由 LLM 自己填
}
```

这带来两个问题：

1. **冗余 / 漂移风险**：LLM 要同时维护"actionText 描述了什么"和"targetCharacterIds 指向谁"两个并行真相，容易写成 `actionText: "talk to Smith"` 但 `targetCharacterIds: ["jones"]`。
2. **物 / 场景没对等表达**：当前只有 character 的目标 ID 被结构化，物品和场景靠 actionText 自然语言识别，引擎 7 个内部消费者（impactPropagation / skillCheck / scriptedEventRunner / skillRoll / stateContextBuilder / tickOrchestrator / SimulationEventEmitter）只对 character 路径友好，对 item / scene 没有同一级 ID 路由能力。

本设计的目标：让 actionText 成为单一信息源，agent 用 `[<完整名称>]` 引用实体，引擎侧的 `GameInterpreter` 负责把这些引用解析成 skill 所需的 ID。

---

## 2. 数据流（设计后）

```
agent.decideNext
    │
    ▼
RoleSimDecision { tool: "act", actionText: "ask [Smith] about [the letter]" }
    │
    ▼
NpcActionController.decide()
    │   （Controller 不解析引用，纯 transport）
    ▼
engine.submitAction({ characterId, actionText, sceneId })
    │
    ▼
ActionIntake.submit
    │
    ├─ buildPerceivableDirectory(actorId, dgsm)
    │     → { characters: { Smith → smithId,
    │                       "the gaunt man" → ghostId, ... },
    │         items:      { "the letter" → letter42, ... } }
    │
    ▼
interpretAction(actionText, directory, skillCatalog)
    │
    │   1. 匹配 actionText → action definition（如 character_interaction）
    │   2. 解析 actionText 里的 [Name] 标记
    │   3. 根据 definition 的 slot 规约，把 [Name] 注入对应 slot
    │
    ▼
InterpretedStep {
  definitionId: "character_interaction",
  referencedEntities: [
    { id: "smith",    kind: "character" },
    { id: "letter42", kind: "item" }
  ],
  ...
}
    │
    ▼
ActionStep / CharacterAction（referencedEntities 由 interpreter 输出，单一字段）
```

关键变化：

- **agent 输出层**：`RoleSimDecision.act` 删掉 `targetCharacterIds` 字段。
- **引擎入口**：`ActionInput.targetCharacterIds` 删除，新参数（或 directory 内部构建）；interpreter 负责填 `ActionStep.targetCharacterIds`。
- **renderer**：保持 Phase G 现状，**不**新增结构化 citationMap 输出。引用括号 `[Name]` 是给 agent 写作 + memory 可读性用的视觉标记，不再是结构化契约。
- **directory 构建**：纯 DGSM 函数，与 renderer 共用 known/unknown 决策逻辑。

---

## 3. Decisions（按 brainstorm 顺序）

### D1. 短原子动作（每次 `act` = 单 tick）

agent 永远只输出"短动作"——即每次 `act` 表达单 tick 内可完成的一个原子意图。"出门去找李四"这种跨 tick 的长意图，由 agent 自己分解成多 tick 的连续 `act`（出门 → 走街 → 进港口 → 看见李四 → 互动）。

**Why:** 与 game-like 即时回合制契合；引擎不需要为 agent 维持多 tick 意图链；与 spec §3 "ActionStep chain" 不冲突（chain 仍由 interpreter 在引擎内部产出，与 agent 意图层无关）。

**含义：**
- 不需要"长动作 fallback"；
- agent 在 perception 里看不见的人，agent 不应该尝试 act 他们 —— 因为不在场景里时只能选"移动到对方所在位置"这种短动作，而不是"对他做什么"。

### D2. `RoleSimDecision.act` 删掉 `targetCharacterIds`

```ts
// Before
type ActDecision = { tool: "act"; actionText: string; targetCharacterIds?: string[] };

// After
type ActDecision = { tool: "act"; actionText: string };
```

`ActionInput.targetCharacterIds` 同步删除（参见 §4.4）。`ActionStep.targetCharacterIds` 字段保留，但**完全由 interpreter 填充**，不由调用方传入。

**Why:** actionText 成为单一真相；漂移风险消失；LLM 认知负荷降低。

### D3. 引用语法 = `[<完整名称>]`（agent 输出契约）

agent 在 `actionText` 里引用任何具名实体（人 / 物 / 场景）时，**必须**用方括号包裹完整名称：

```
"ask [Smith] about [the letter]"
"approach [the gaunt man]"
"enter [the Lighthouse Library]"
"hand [the bound ledger] to [Helen Park]"
```

**约束：**
- 括号里必须是 reference block / directory 中**完整、未缩写**的名称字段。
- 对 KNOWN 角色：用 canonical name（如 `Smith`）。
- 对 UNKNOWN 角色：用 renderer 输出的描述串（如 `the gaunt man`）。
- Controller / interpreter 做精确字符串匹配，不允许模糊 / 缩写。

D3 是 **agent 输出端的契约**。Interpreter 在 agent 不守契约（漏写括号 / 写错名）时如何 fallback 是另一个问题，见 §6 OQ2 / OQ3。

**Why:**
- 符合学术引用直觉（"完整 author 名 + year"，而非"S. 19"）。
- 精确匹配实现简单，无歧义。
- 引用串持久化进 memory 后是自描述的（"approach [Smith]" 即使脱离 citation 上下文也能读）。

### D4. Interpreter 负责名字 → ID 映射（Controller 不解析）

NpcActionController 在引用流里只做 transport：把 `actionText` 透传给 `engine.submitAction`，不解析括号、不查 ID。

`GameInterpreter` 在做"actionText → ActionDefinition 选择"的同时，做"`[Name]` → entity ID"的查表。

**Why:**
- 单一职责：interpreter 已经在解析 actionText 的语义内容（选 skill），让它顺手解析引用是同一职责的延伸。
- Controller 不需要 DGSM 访问 / 关系图查询。
- skill 知道自己需要什么类型的 slot（character / item / scene），interpreter 也知道 skill 的 slot 规约，所以解析 + 注入是同一个组件的事。

### D5. Interpreter 输出 `referencedEntities: { id, kind }[]` 单一字段

interpreter 解析 `actionText` 里的 `[Name]` 标记时，用 directory 查表 → entity ID + 同时记录 kind（来自 directory 命中的桶 —— `directory.characters` 命中即 kind="character"，`directory.items` 命中即 kind="item"）。

```ts
type EntityKind = "character" | "item" | "scene";

interface ReferencedEntity {
  id: string;
  kind: EntityKind;
}

interface InterpretedStep {
  // ... existing (definitionId, impact, engine, codeSubsystem, overlayFields)
  referencedEntities?: ReferencedEntity[];   // 单一字段，自带 kind
}
```

工作流：

1. interpreter 用 LLM 选 ActionDefinition（现状）。
2. 解析 actionText 里所有 `[Name]` 标记。
3. 每个 `[Name]`：查 directory（按 character → item → scene 顺序），命中 → push `{ id, kind }` 到 `referencedEntities`；全部 miss → 失败行为见 OQ3。
4. 输出 `InterpretedStep`。
5. 下游 7 个消费者按需 `filter(r => r.kind === "character")` 取子集；ScriptedEvent / StateContextBuilder 等可以按 kind 路由不同的注入逻辑（参见 §4.10）。

**Why（OQ1 → resolved）：**
- 复用现有 `stateDomains` 已经在做"该注入哪些字段"的声明 —— interpreter 只输出 `(id, kind)` 元组，注入规约由 stateDomains 管，不需要新加 `slotSchema` 字段。
- 单一字段比 `referencedIds + targetCharacterIds` 双字段干净：无信息冗余，"动作影响哪些 entity" 单一真相。
- 自带 kind 比"扁平 ID + 下游查 DGSM 判 kind"省查询：interpreter 在解析时本来就知道 kind（来自 directory 命中的桶），下游 `r.kind === "character"` filter 是 O(1) 字段比较，无需 DGSM 调用。
- 可追溯性：日志 / 持久化 / TickReport 直接看到 `[{id:"smith", kind:"character"}, {id:"library", kind:"scene"}]`，调试一目了然。
- 未来扩展：加新 kind（"junction" / "road" / "region"）只动 enum + 受益的 consumer，不需要 schema 重构。

### D6. Renderer 不产 citationMap，且删除 god-eye fallback

Phase G 渲染层产出 `RenderedPerception { narrative }`，**不**附加结构化 citationMap。`[Name]` 括号在 narrative 里是给 agent 的视觉标记，仅此而已。

第一性原理：renderer 的本质是把客观状态转成 NPC **主观感知**。原 Phase G 的 god-eye fallback（LLM 失败时拼上帝视角客观文本）和这个本质冲突 —— 它输出的不是主观感知，而是另一种视角。删除：

- `src/roleSim/renderer/godEyeFallback.ts` 整个文件删除。
- `render()` 签名改成 `Promise<RenderedPerception | null>`：null = LLM 调用失败。
- `RenderedPerception.llmSucceeded` 字段删除（null 即失败信号）。
- `NpcActionController.decide()` 拿到 null 时直接 return，跳过 `agent.decideNext()` —— 该 NPC 这一 tick 没"感知到"任何东西，in-flight 行动继续不变（与 Decision 14 自洽：`act` 是开新动作的唯一入口）。
- 该 tick 的事件对该 NPC 永久丢失（物理直觉：人偶尔也会漏事），LLM render fail rate 应远低于 0.1%，长期累积影响可忽略。

**Why（合并 D6 + 原 D7）：**
- 单一真相：directory 永远从 DGSM 现取，不会和 renderer 产出的 stale 映射不一致。
- 单一渲染路径：删 godEye 后 renderer 只有"成功 / 失败"二态，无"成功但是低保真"的中间态。
- 减少跨层数据契约：renderer 既不向引擎传 citationMap，也不假装产出永远成功的 narrative。

### D7. ~~（已合并入 D6）~~

### D8. Character directory = `actor.relationships ∪ in-scene characters`

`buildPerceivableDirectory(actorId, dgsm)` 的 character 范围：

- **KNOWN**：actor 关系图中出现过的所有 character（即 `actor.relationships[].targetId`）。directory key = canonical name。
- **UNKNOWN in scene**：当前场景里在场但不在关系图的角色。directory key = renderer 用过的 description identifier（appearance 串 / 默认 fallback）。

**对齐：**
- 与 Phase G renderer 的 `isKnownTo` + `descriptionIdentifier` 完全同源 —— 抽出 shared helper，renderer 和 interpreter 都调。
- 不在关系图、又不在场景的 NPC：directory 不收，interpreter 解析 fail。

**Why:**
- 物理直觉：agent 只能 act 自己 know 的人；幻觉一个完全没接触过的名字 → 解析失败 → 行为降级（有意暴露 bug）。
- 不重复扩散 known/unknown 决策逻辑：renderer 怎么显示，interpreter 就怎么解析。

**Item directory（暂定）：当前场景里的 items。** 是否包含 actor inventory 见 §6 OQ4。

---

## 4. Component Changes

### 4.1 `src/roleSim/agent.ts`

```diff
 export type RoleSimDecision =
   | {
       tool: "act";
       actionText: string;
-      targetCharacterIds?: string[];
     }
   | { tool: "continue"; reason?: string }
   ...
```

### 4.2 `src/roleSim/toolSkills/actSkill.ts`

`actSkill` 系统提示语更新：

- 删除 `targetCharacterIds` 字段说明和示例。
- 新增 `[Name]` 引用语法说明（D3 约束）：「引用任何具名实体时用方括号 + 完整名称，必须照搬 references block 里那一行的名称字段」。
- 更新所有示例：`{ "tool": "act", "actionText": "ask [Smith] about the letter" }`。
- 加一段 "短动作" 准则（D1）：单 tick 单意图，跨多 tick 的目标分解成连续 `act`。

### 4.3 `src/roleSim/llmAgent.ts`

`buildTerminalDecision` 删除 `targetCharacterIds` 解析分支（D2）。

### 4.4 `src/roleSim/npcActionController.ts`

两处改动：

**(a) `submitAction` 不再传 `targetCharacterIds`：**
```diff
 await this.engine.submitAction({
   characterId: npcId,
   actionText: decision.actionText,
-  targetCharacterIds: decision.targetCharacterIds,
   sceneId: this.resolveCurrentSceneId(npcId),
 });
```

**(b) renderer 返回 null 时跳过 decide（D6）：**
```diff
 const rendered = await render({ npcId, bundle, dgsm: this.dgsm, language: this.language });
+if (rendered === null) {
+  // LLM render 失败 = 该 NPC 这一 tick 没感知到任何东西，in-flight 行动继续
+  return;
+}
 // ... build ctx with rendered.narrative，调 agent.decideNext
```

### 4.5 `src/engine/core/types.ts`

```diff
 export interface ActionInput {
   characterId: string;
   actionText: string;
-  targetCharacterIds?: string[];
   sceneId: string;
   overlayFields?: Record<string, unknown>;
 }

+export type EntityKind = "character" | "item" | "scene";
+
+export interface ReferencedEntity {
+  id: string;
+  kind: EntityKind;
+}
+
 export interface ActionStep {
   // ... existing
-  targetCharacterIds: string[];
+  referencedEntities: ReferencedEntity[];   // interpreter 输出，含 kind 标签
 }

 export interface CharacterAction {
   // ... existing
-  targetCharacterIds: string[];
+  referencedEntities: ReferencedEntity[];   // tickOrchestrator 从 ActionStep 透传
 }
```

`targetCharacterIds` 字段在 `ActionInput` / `ActionStep` / `CharacterAction` 全部删除。7 个内部消费者改成 `referencedEntities.filter(r => r.kind === "character")` 取子集（详见 §4.10）。

### 4.6 `src/engine/types.ts` — `ActionDefinition` 不需新结构

OQ1 已 resolved（D5）：复用现有 `stateDomains.<domain>.inject + fields` 规约，不加 `slotSchema` 字段。

`stateDomains.<domain>.inject` 取值集合可能要小幅扩展，把 "referenced" 加进 `item` / `scene` 域：

```yaml
stateDomains:
  character:
    inject: [actor, targets]    # targets 来自 step.targetCharacterIds
  item:
    inject: [referenced]        # referenced 来自 step.referencedIds 中 kind=item 的子集
  scene:
    inject: [current, referenced]   # current 来自 actor 当前位置；referenced 同上 item
```

这是延伸现有约定，不是新约定。具体哪些 inject 取值要支持，看 §4.7 InterpretedStep 输出后 `StateContextBuilder` 怎么消费。

### 4.7 `src/engine/interpreter/gameInterpreter.ts`

`interpretAction(input)` → `interpretAction(input, directory, skillCatalog)`。

调用方变化：`ActionIntake.submit`（`src/engine/core/actionIntake.ts:31`）当前是 `interpretAction(input)`；改成先调 `buildPerceivableDirectory(input.characterId, dgsm)`，再 `interpretAction(input, directory)`。这意味着 `ActionIntake` 的构造依赖加上 `dgsm` 引用（或者从 `tickEngine.ts` 注入 `getDirectory: (characterId) => PerceivableDirectory` 闭包）。

新增 directory 参数：

```ts
interface PerceivableDirectory {
  characters: Map<string, string>;  // displayName → charId
  items: Map<string, string>;       // displayName → itemId
}
```

interpreter 内部新增的处理流程（`[Name]` 解析）见 D5。

输出 `InterpretedStep` 扩展（D5 形态）：

```ts
interface InterpretedStep {
  definitionId: string;
  impact: 0 | 1 | 2 | 3 | 4 | 5;
  engine: "code" | "llm";
  codeSubsystem?: string;
  overlayFields?: Record<string, unknown>;
  referencedEntities?: ReferencedEntity[];   // 新增：每个 [Name] 解析出 { id, kind }
}
```

`ActionIntake` 把 `referencedEntities` 透传到 `ActionStep`，不做 filter / 二次分类 / DGSM 查询。

### 4.8 共享 helper —— `src/state/perceivableDirectory.ts`（新文件）

```ts
export function buildPerceivableDirectory(
  actorId: string,
  dgsm: DynamicGameStateManager
): PerceivableDirectory;
```

实现：复用 Phase G renderer 已有的 `isKnownTo` / `descriptionIdentifier` 决策（D8）。Renderer 和 interpreter 都改成调这个 helper。

### 4.9 `src/roleSim/renderer/`

D6 的渲染层简化（删 god-eye + render 返回 null）：

- **删除文件**：`src/roleSim/renderer/godEyeFallback.ts`。
- **`src/roleSim/renderer/types.ts`**：`RenderedPerception` 删 `llmSucceeded` 字段。
- **`src/roleSim/renderer/index.ts`**：`render()` 签名 `Promise<RenderedPerception>` → `Promise<RenderedPerception | null>`；删 `renderFallback` 导出和 `buildGodEyeFallback` re-export；try/catch 的 catch 分支直接 return null。
- **`src/roleSim/renderer/llmRenderer.ts`**：本身无结构变化。

renderer 的 system prompt 里关于 `[N]` 数字引用的规则，与 agent 的 actSkill 里 `[Name]` 文本引用规则**是两套独立约定**：

- **Renderer 输入端**：narrative 里 `[N]` + reference block 里 `[N] Name: desc`，给 agent 阅读。
- **Agent 输出端**：actionText 里 `[Name]`（直接用 reference block 里的 `Name` 字段），给 interpreter 解析。

两端用的标记不同（数字 vs 名字），物理上不冲突 —— 数字是给 narrative paragraph 紧凑标注用的，名字是给 actionText 持久可读用的。

### 4.10 7 个引擎内部消费者改动

`targetCharacterIds` 全部删除；改成 `referencedEntities.filter(r => r.kind === "character")`：

| # | 文件 | 改动 |
|---|---|---|
| 1 | `src/engine/shared/impactPropagation.ts:60-95` | `ImpactPropagationAction.targetCharacterIds` → `referencedEntities`；level 1 propagation loop 加 kind filter |
| 2 | `src/engine/tools/skillCheckTool.ts:48-55` | 构造 `SkillRollNode` 时，`targetCharacterIds: targetIds` → 透传 `referencedEntities` |
| 3 | `src/engine/shared/skillRoll.ts:100-135` | `SkillRollNode.targetCharacterIds` → `referencedEntities`；combat opposed-roll 路径 `const targetIds = (node.referencedEntities ?? []).filter(r => r.kind === "character").map(r => r.id)` |
| 4 | `src/engine/core/scriptedEventRunner.ts:147-164` | `matchesAction` 里 `withTargetId` 匹配前先 filter 到 character（保留 char-only 语义；语义扩展见 §6 OQ6） |
| 5 | `src/engine/resolver/stateContextBuilder.ts:285-305` | `targets` 域 inject：`const targetIds = (node.referencedEntities ?? []).filter(r => r.kind === "character").map(r => r.id)` |
| 6 | `src/engine/core/tickOrchestrator.ts:245, 435` | `CharacterAction.targetCharacterIds: step.targetCharacterIds` → `referencedEntities: step.referencedEntities` |
| 7 | `src/simulation/SimulationEventEmitter.ts:95-103` | `action.targetCharacterIds[0]` → `action.referencedEntities.find(r => r.kind === "character")?.id` |

每处 1-3 行实质改动。`tickOrchestrator` + `SimulationEventEmitter` 是 UI / event 暴露面：CharacterAction 形状变化会传播到前端事件流，前端如果在用 `targetCharacterIds[0]` 类的字段需要同步更新（参见 §7 Out of Scope 列表里的"前端事件 schema 适配"）。

### 4.11 测试影响

- `src/roleSim/__tests__/renderer.test.ts`：删除 godEye fallback 相关测试（"render() retry+fallback 路径"等）；新增 "render() returns null on LLM fail" 测试。
- `src/roleSim/__tests__/npcActionController.tickReport.test.ts`：删除 `targetCharacterIds` 相关断言；新增 `referencedEntities` 断言；新增"render 返回 null 时 controller 跳过 decide"测试。
- `src/engine/interpreter/__tests__/gameInterpreter.test.ts`：新增引用解析测试（known / unknown / 物品 / 缺失等）+ kind 标签验证。
- `src/state/__tests__/perceivableDirectory.test.ts`（新）：directory 构建逻辑测试，覆盖 D8 的所有分支。
- 删除 `src/roleSim/__tests__/userPromptBuilder.test.ts` 里关于 `targetCharacterIds` 的断言（如果存在）。
- `src/engine/__tests__/integration/` 任何用了 `targetCharacterIds` 的 fixture 都要换成 `referencedEntities`。

---

## 5. 与 Phase G 渲染层的关系（澄清）

| 项 | Phase G 渲染层 | 本设计 |
|---|---|---|
| 引用标记 | `[N]`（narrative 内）+ `[references]` block | `[Name]`（actionText 内） |
| 引用解析方 | 不解析（agent 阅读） | GameInterpreter |
| 实体范围决策 | `isKnownTo` + `descriptionIdentifier` | 同（共享 helper） |
| 结构化输出 | `RenderedPerception { narrative }` | 不增加字段 |
| 渲染失败行为 | `render() → null`（D6 简化），controller 跳过 decide | 不影响 |

两层引用语法**有意不对称**：
- 数字 `[N]` 给 narrative 段落用 —— 紧凑、引用块清晰，不重复名字。
- 文本 `[Name]` 给 actionText 用 —— 短句、无 reference block 伴随、需要自描述（持久化进 memory 后还要可读）。

---

## 6. Resolved Questions（实施前已决，无 open）

### ~~OQ1. `ActionDefinition` 的 slot 规约形态~~ — Resolved 2026-05-07
**Resolution:** 不加新结构。复用现有 `stateDomains.<domain>.inject + fields` 规约。如果需要在 stateDomains 里支持"被 actionText 引用的物 / 场景"，给 `inject` 取值集合加 `referenced`（例：`stateDomains.scene.inject = [current, referenced]`）。这是延伸现有约定，不是新约定。

### ~~OQ2. `[Name]` 必需还是可选？~~ — Resolved 2026-05-07
**Resolution:** **必需 + 失败容错**。agent 输出契约要求所有命名实体都用 `[Name]` 括号包裹（D3）；但 interpreter 在 actionText 完全不带括号时，回退到自然语言名字识别（与 OQ3 失败行为分开看：括号缺失 ≠ 解析失败）。理由：LLM 偶尔漏写括号是可观察的；硬拒绝代价高于宽松容错。

### ~~OQ3. Interpreter 解析失败时的行为~~ — Resolved 2026-05-07
**Resolution:** **action fail + 完整 actionText 入日志**。agent 写 `[Smith]` 但 directory 里没 Smith → `interpretAction` 抛 `CitationResolutionError`；`ActionIntake.submit` catch 后用 `actionInterrupted` 类型事件回报，actionStep 不入队，console.warn 打印完整 actionText + actor + tick 时间用于诊断。NPC 该 tick 等价于 idle，下一 tick 重新 decide。理由：暴露 bug 比掩盖 bug 重要；C 选项过于复杂。

### ~~OQ4. Item directory 范围~~ — Resolved 2026-05-07
**Resolution:** **scene + inventory**。`buildPerceivableDirectory` 的 items 包含两部分：
- 当前场景里的 items（`scene.items`）
- actor 持有的 inventory items（如 DGSM 提供 `actor.inventory`）
两组 key（item.name）合并；冲突按"场景优先"（actor 看到房间里的物品名比自己包里的更显眼）。理由：item_exchange 这类 definition 必然引用自身持有的物品。

### ~~OQ5. Memory 持久化保留 `[Name]` 还是展开？~~ — Resolved 2026-05-07
**Resolution:** **保留括号**。memory layer 不二次格式化，actionText 完整原样存盘。recall 出来即使脱离原 citation 上下文，`[Smith]` / `[the letter]` 仍是自描述的。

### ~~OQ6. ScriptedEvent.withTargetId 扩展到任意 entity？~~ — Resolved 2026-05-07
**Resolution:** **保留 char-only 语义**。`matchesAction` 内 filter 到 character 后再 `includes`。现有 scripted event YAML 配置零迁移。Phase H scope 不顺手改 ScriptedEvent DSL；将来 module 作者真需要任意 entity 匹配时再单独开 Phase。

---

## 7. Out of Scope

- ScriptedEvent.withTargetId 语义扩展（OQ6 的 B 选项）。
- Renderer 输出对玩家 UI 的暴露：D6 只承诺 renderer 不变形，将来 UI 复用时是消费 narrative 的事。
- 多步 chain（spec §3 ActionStep chain）下的引用解析：本设计假设单步 act；多步 chain 时 interpreter 产出 N 个 InterpretedStep，每步独立解析自己 actionText 的引用 —— 应该自然 work，但实现时确认。
- **前端事件 schema 适配**：`CharacterAction` 形状变化（`targetCharacterIds: string[]` → `referencedEntities: { id, kind }[]`）会传播到 WebSocket 事件流。前端如果在用旧字段需要同步更新 —— 不在本 spec 范围，但实现时要列在 PR 描述里提醒前端 owner。

---

## 8. Migration 提示

无 backwards compatibility（与 spec §3 一致）。`RoleSimDecision.act` 删字段是 breaking change；`CharacterAction` / `ActionStep` 的 `targetCharacterIds` 全部换成 `referencedEntities` 也是 breaking change。但因为 actionText 同时变 `[Name]` 引用语法，旧 `targetCharacterIds: ["smith"]` 即使保留也会和新 actionText 不一致 —— 干净删干净。

涉及修改的文件总数估算：
- 类型 / 接口：3（`agent.ts` / `core/types.ts` / `engine/types.ts`）
- agent 路径：3（`actSkill.ts` / `llmAgent.ts` / `npcActionController.ts`）
- 引擎入口路径：3（`actionIntake.ts` / `gameInterpreter.ts` / `tickEngine.ts` 调用面）
- 引擎内部 7 个 character 消费者（§4.10）：7 个文件，每处 1-3 行 filter
- 渲染层共享 helper：renderer 的 `isKnownTo` / `descriptionIdentifier` 抽出共享
- 新文件：1（`perceivableDirectory.ts`）
- 测试：约 6 个测试文件 + 1 新测试 + integration fixture 适配
- 前端：CharacterAction event schema 变更，前端 owner 需同步（Out of Scope）

预估 Phase H scope，约 3-4 天工作量（含 OQ2-5 解决 + 7 处消费者迁移）。
