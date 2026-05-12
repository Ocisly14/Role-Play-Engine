# 当前架构快照 vs `2026-04-20-engine-architecture-refactor-design.md`

**日期：** 2026-05-07
**对应分支：** `engine-phase-g-renderer`（Phase G 渲染层已落地）
**对照文档：** `docs/superpowers/specs/2026-04-20-engine-architecture-refactor-design.md`

> 目的：把 Phase A–G 全部落地之后的真实代码形态描述清楚，并标记每一处与原 spec 的差异。给后续阅读者一个不需要追 commit 的入口。

---

## 1. 三层全貌

```
┌──────────────────────────────────────────────────────────────────────┐
│ ① Role Simulation Layer  src/roleSim/                                │
│                                                                       │
│   RoleSimAgent (decideNext)                                           │
│     └─ LLMRoleSimAgent (llmAgent.ts) — agent loop + tool dispatch     │
│                                                                       │
│   RoleSimContext {                                                    │
│     npcProfile, currentScene, currentAction?,                         │
│     recentMemory, longTermIntent?,                                    │
│     perception?: { narrative }    ← Phase G 渲染层产物                │
│   }                                                                   │
│                                                                       │
│   Tools: act / continue / writeMemory / recallMemory / getMapSnapshot │
│                                                                       │
│   NpcActionController — 唯一驱动者                                     │
│     ├─ engine.on("tickCompleted", processTickReport)                  │
│     ├─ processTickReport(report):                                     │
│     │     1. findAffectedCharacters(intrinsic event.impact) 算传播     │
│     │     2. 收 ended-action ∪ 受影响 ∪ idle-alive 的并集               │
│     │     3. 顺序 decide() 每个 NPC（无并发）                          │
│     └─ decide(): buildContext → render() → agent.decideNext()         │
│                                       ├─ act: cancel live + submit    │
│                                       └─ continue: no-op              │
│                                                                       │
│   Renderer (roleSim/renderer/) — Phase G                              │
│     ├─ types.ts:        PerceivedBundle / OwnActionState              │
│     ├─ buildBundle.ts:  scene + ownConditions + ownAction + events    │
│     ├─ llmRenderer.ts:  ModelClass.SMALL, maxRetries:2,               │
│     │                   输出 [narrative] + [references]               │
│     ├─ godEyeFallback.ts: 确定性兜底（无 LLM）                         │
│     └─ index.ts:        render() (LLM→fallback) / renderFallback()    │
│                                                                       │
│   submitAction / cancelAction          on(tickCompleted)              │
│         ▼                                  ▲                          │
├──────────────────────────────────────────────────────────────────────┤
│ ② TickEngine  src/engine/core/                                       │
│                                                                       │
│   createTickEngine(opts) → TickEngine                                 │
│     submitAction (async) / cancelAction / interruptAction             │
│     tick() / on(...) / getActionStatus / getActorQueue                │
│     serialize() / persistedState  ← Phase E 持久化路径                │
│                                                                       │
│   内部组件：                                                            │
│     ActionIntake → Queue → TickOrchestrator                           │
│       Phase 0   WorldFeature.init()  (fresh session only)             │
│       Phase 1   clock.advance                                         │
│       Phase 2   applyPendingInterrupts (C-妥协)                        │
│       Phase 3   activate (lazy resolver)                              │
│       Phase 4   commitDue (DEX 顺序)                                   │
│       Phase 5   featureRunner.runTick                                 │
│       Phase 6   featureRunner.runPropagation                          │
│       Phase 7   scriptedEventRunner.run                               │
│       Phase 8   emergentEventEmitter.scan                             │
│       Phase 9   applier.flush (sum+clamp+DamageReports)               │
│       Phase 9.5 condition-expiry sweep                                │
│       Phase 10  streaming events + tickCompleted(TickReport)          │
│                                                                       │
│     CodeEngineRegistry — Phase E：engine:"code" 动作（目前 movement）  │
├──────────────────────────────────────────────────────────────────────┤
│ ③ DGSM  src/state/DynamicGameState.ts                                 │
│   单一 mutator = Applier；StateChange 16 种 kind                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. 层间连接（实际）

| 方向 | 接口 / 文件 |
|---|---|
| Role sim → Engine | `engine.submitAction(input)` / `engine.cancelAction(handle)`（Decision 14：`act` 吞并 cancel：先 query `getActorQueue` 找 live step → cancel → 再 submit 新 action） |
| Engine → Role sim | `engine.on("tickCompleted", report => controller.processTickReport(report))` —— 单一通道，没有第二条事件总线 |
| Controller → Renderer | `decide()` 内调 `buildPerceivedBundle` + `render()`，结果灌入 `ctx.perception.narrative` |
| Renderer → Agent | 通过 `ctx.perception.narrative`（一段第一人称叙事 + `[N]` 引用 + reference block）；不再用旧的 `reviseTriggers` 触发列表 |
| Engine → Persistence | `engine.serialize() → { queue, dexByActor, connectionVotes }` 由 SimulationRuntime 落到 DB；恢复用 `persistedState` 构造选项 |
| Engine → 外部 UI | EventBus 流式事件：`actionCompleted` / `actionInterrupted` / `actionCancelled` / `featureEvent` |

注意：

- 没有中央调度器；NPC 决定权完全在 `RoleSimAgent`，Controller 只在两个时刻触发 `decide()`：tick 结束后受影响 / 行动结束 / idle 的 NPC，以及 bootstrap。
- Controller busy-NPC wake-up 门槛：NPC 当前有 active step 且本 tick 没收到任何传播事件 → 直接跳过 decide()。

---

## 3. StateChange 列表（与 spec 对照）

实际类型联合 16 种（`src/engine/core/types.ts:180-272`）：

```
scene.addCondition / scene.removeCondition / scene.damageItem
character.hp / character.san / character.fatigue
character.addCondition / character.removeCondition
character.position                          ← Phase E 新增（CodeEngine 移动）
connection.setBlock
feature.setState / feature.removeState
event.emit
environment.contribute / environment.cap / environment.hazard   ← §3a env 层
```

与 spec §6 的差异：spec 里只描述了前 13 种（含 §3a 的 env 三种 + scene.damageItem），`character.position` 是 Phase E 为 movement 子系统新增的。

---

## 4. 与 spec 的对齐 / 偏离

### 4.1 完全对齐

- 三层分离（Role sim / TickEngine / DGSM）
- TickEngine 是纯执行器 —— 不调用 LLM impact gate、不感知 NPC AI
- `submitAction` / `cancelAction` / `interruptAction` 三 API 类型层面分立
- ActionStep + stepGroupId + chain 不可中段修改（mid-chain modification = not supported）
- Lazy per-step resolver + DEX 排序
- 流式事件 + 末尾 `tickCompleted(TickReport)` batch
- Applier sum+clamp+DamageReport，单写入点；death 通过合成 `FeatureEvent { type: "character.died" }` 上报
- ScriptedEventRunner 独立 phase（spec §3 / §5）
- §3a 全部落地：EnvironmentReading 中间层、`sanity → role sim`、`WorldFeature.init()` + Phase 0、`globalSkillPenalty` 字段

### 4.2 实施中演化的差异

| # | 偏离点 | spec 怎么说 | 现状 | 评价 |
|---|---|---|---|---|
| 1 | **FeatureEvent shape** | §7b 标 TBD：`{ type; characterId?; sceneId?; data? }` | 加了 `impact: 0\|1\|...\|5` 和 `description: string` 两个字段；事件自描述，propagation + 渲染层直接用 | Phase F 决定。建议把 spec §7b 那行回填，避免下次按 spec 看到 stale shape |
| 2 | **EmergentEventEmitter** | §5 包 `encounterScanner` + 世界事件检测 | Phase E 删除了 encounter detection；emergent scanner 数组当前为空、可插槽。"两 NPC 同场景"的探测彻底挪到渲染层 | Phase E 决定，spec 已与之偏离 |
| 3 | **Impact gate** | §3 "role sim 跑 LLM impact gate 决定要不要 `interruptAction`" | 不存在 LLM gate。流程是：`findAffectedCharacters(event.impact)` 决定影响范围 → 渲染器渲染 → agent 自决：`act` 吞并取消，或 `continue` no-op。**Controller 从不调 `interruptAction`** | Phase F+G 决定（plan §F-decision 14、§G-decision G3）。impact 是事件内聚属性，不再额外过 LLM 判断 |
| 4 | **`reviseTriggers` → `perception.narrative`** | spec 没有渲染层概念 | 引入 §G 渲染层；把 god-eye 触发列表替换成第一人称引用式叙事（`[N]` 标号 + reference block） | Phase G 新增。引用语法允许将来给玩家 UI 也复用 |
| 5 | **submitAction 异步** | §4 同步返回 `ActionHandle` | 返回 `Promise<ActionHandle>`（interpreter 是 LLM 调用） | "interpreter at submit" 的必然结果，spec 注释失准 |
| 6 | **`TickEngine.serialize()`** | §10 "未决：ActionStep 持久化策略" | 已落地：`engine.serialize() / persistedState` + SimulationRuntime 整合 | 关掉了一个 open question |
| 7 | **CodeEngineRegistry** | spec 没有 | Phase E 新增；为跨 tick 动作（movement）走代码路径而非 resolver；通过 `engine: "code"` 动作分发 | Phase E 新增 |
| 8 | **`getCharacterSkillModifiers` hook** | §6 原本有 | §3a 删除，改 CharacterCondition.mechanicalEffect.globalSkillPenalty | §3a 已自洽 |

### 4.3 spec §10 中其他未决项现状

| spec §10 项 | 现状 |
|---|---|
| tickProcessor 模块布局 | 旧文件已删，被 TickOrchestrator + 10 个组件替代 |
| 迁移策略 | Phase A-G 一路 ship，无回退路径 |
| ActionStep 持久化策略 | 已选：JSON blob + serialize/persistedState |
| Session resume 行为 | 从持久化状态恢复（不重建 NpcDailyPlan） |
| `src/engine/handlers/` 去留 | 仍存在；未完全融入 commit flow |

---

## 5. 一些观察

- 当前架构里只剩**两个 LLM 调用点**对每个受影响 NPC 每 tick：渲染器（Haiku-tier，1 次）+ agent.decideNext（Sonnet-tier，1 次）。中间没有 impact gate 那一道额外调用。
- `continue` tool 同时承担"对这次事件不感兴趣"和"维持当前行动"两个语义，自然替代了 spec 里 LLM impact gate 的判断功能。
- 渲染层是**可面向玩家**的，目前只给 NPC agent 用，但其引用语法（`[N]` + reference block）已经满足 UI 提取人物 / 物品 / 场景的需要。
- 因为 `act` 在 controller 里被定义成"先 cancel live + 再 submit"，agent 不需要直接持有 ActionHandle，Engine 的内部 handle 不暴露给 agent —— 与 spec §3 "engine 不感知 NPC AI" 完全相容。

---

## 6. 后续可考虑

1. **Spec §7b FeatureEvent 行回填** —— 把当前的 `impact` + `description` 写进去，避免下次有人对着 stale shape。
2. **Phase G 渲染层 smoke test** —— 单测全部 mock 了 LLM；真实管线尚未跑过一遍 LLM 调用，建议起 sim session 看一眼输出。
3. **Phase G plan checkbox 收尾** —— `2026-04-21-engine-architecture-refactor-plan.md` 中 Phase G 的 G1–G11 还没勾。
4. **观望项：deferred tools** —— `observe` / `reviseLongTermIntent`（plan §F-out-of-scope）目前没有触发器，等真实运行后看是否必要。
5. **`src/engine/handlers/` 收尾** —— spec §10 未决项之一，要不要彻底融入 commit flow 取决于 Phase H 之后的需求。
