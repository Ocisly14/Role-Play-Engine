# Weather Engine and Passable Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 封锁（connection block）改成三个来源各写各的、最后写的人说了算；天气不再按代码规则盖全区封锁，而由一个独立的 LLM「天气 engine」在天气变化时判断哪些通道不通、每个户外地点是什么样；World Action Engine（WAE）可以按动作放行一条被封的通道。

**Architecture:** (1) Applier 删掉 `(featureId, reason)` 投票表，`connection.setBlock` 直接写 DGSM 的 `blockedConnections` 标志。(2) `weather.ts` 只保留状态机和数值贡献；转换时发一条内部 `weather.transition` 信号，orchestrator 在脚本事件之后读到它，调用天气 engine，把判断转成 StateChange 塞进同一次 flush；该内部信号不会进入公开事件流，晴天不调模型。(3) `movement.passBlockedConnectionId` 贯穿 schema → validator → finalize → orchestrator → movement runtime，值是具体通道 id，只在匹配的封锁边消费一次。

**Tech Stack:** TypeScript, vitest, 自研 `models/` LLM 层（`generateToolCalls`）, biome。

**Spec:** 2026-09-03 与用户的讨论结论，全部记录在下方「设计决定」；没有单独的 spec 文件。

## Global Constraints

- 包管理器 pnpm；`pnpm check` 是 biome；测试 `pnpm test -- <file>`。
- **不按任务提交。** 用户要求所有改动审阅后一次提交；每个任务末尾不 commit。
- **不自动跑测试。** 每个任务写好测试即可；统一在最后一个任务由用户说「跑」之后再跑。
- 世界文字是中文；代码、标识符、规则文档是英文。不引入任何具名设定的术语。
- 不引入调度器、不引入 LangChain。
- 快照兼容：本次改变持久化 movement 状态语义，提升 `ACTION_SCHEMA_VERSION`；按既有策略拒绝旧快照，不迁移旧投票或布尔放行状态。

## 设计决定（来自讨论）

1. **投票表删除。** 一条边一个标志 `{blocked, reason}`；来源有三个：天气 engine（`sourceFeatureId: "weather"`）、脚本事件、WAE（`action:<id>`）。谁写在后面谁算数，任何一个来源都可以清掉别人设的封锁。
2. **天气 engine 管什么。** 状态机（类型、强度、120 分钟一次的转换、`affectedSceneIds`）和温度贡献、照明上限留在 `weather.ts`。天气 engine 只在类型或强度变化时被叫起来（子系统转换、初始化、脚本 `weather.set`），输入是该区域的户外地点 prose、候选通道、新天气，输出「关哪些通道 + 每个地点一句条件」。
3. **撤销靠差分。** 模型每次输出完整集合；代码和 `WeatherRegionState.judgedBlockIds` 做差，多出的设、少掉的撤。条件按 `featureId: "weather"` 整体替换。技能减值由代码按类型和强度算好挂在条件上，模型只写文字。
4. **晴天不调模型。** `weatherType === "clear"` 走空判断：撤掉上次的封锁、清掉天气条件。
5. **失败兜底。** 一轮修补；仍不合法或模型报错就 `console.warn`，本次转换只落状态机和数值，封锁和条件保持上次的。
6. **WAE 保留 `connectionBlock`**（它是三个来源之一），新增 `movement.passBlockedConnectionId`：障碍被清除 → `connectionBlock {blocked:false}`；只是这个人过去了 → 填 `exitsFromHere` 给出的具体封锁通道 id。runtime 只在该边消费一次放行，后续边照常检查；不能和尚未掷骰的 `check` 同时出现。
7. **顺带修两个让天气从未跑起来的 bug**（本次核对中发现，用户尚未确认，见任务 2 的说明）：
   - `createTickEngine` 给 Applier 的 `featureScopes` 是空 Map，所有 `feature.setState` 都写到 `scene` 作用域，而 orchestrator 和读上下文按子系统自己的 `anchorKind` 读；region 作用域的天气状态写了没人读，天气停在预设上不动。
   - `anchorIdsFor("region")` 只扫场景的 `parentLocationId`，顶层场景没有父级、道路不被扫描，`OUTDOOR` 永远不是锚点；grayhaven 的天气预设写的正是 `regionId: "OUTDOOR"`。

## 文件结构

- Modify `src/engine/core/applier.ts` — 删投票表，`connection.setBlock` 直写。
- Modify `src/engine/core/tickEngine.ts` — 去掉 `connectionVotes` 持久化；按注册表建 `featureScopes`；新增 `weatherJudgeFn` 选项。
- Modify `client/server/simulation/service.ts` — 持久化类型去掉 `connectionVotes`。
- Modify `src/engine/core/tickOrchestrator.ts` — `anchorIdsFor("region")` 含 `OUTDOOR`；新增 Phase 8b 天气判断；`initMovementRuntime` 传 `passBlockedConnectionId`。
- Modify `src/engine/core/featureReadContext.ts` — `getAllRegionIds` 与 orchestrator 同一规则。
- Modify `src/engine/actions/movementRuntime.ts` — `passBlockedConnectionId` 状态与跳过检查。
- Modify `src/engine/resolution/worldDeltaSchema.ts` / `worldDeltaValidator.ts` / `types.ts` — `movement.passBlockedConnectionId`。
- Modify `src/engine/subsystem/weather.ts` — 不再写封锁和条件，改发内部 `weather.transition` 信号；`judgedBlockIds`。
- Create `src/engine/weather/weatherJudgement.ts` — 纯函数：请求构建、校验、判断 → StateChange。
- Create `src/engine/weather/weatherEngine.ts` — LLM 调用、一轮修补。
- Create `src/engine/rules/weather-judgement.md` — 天气 engine 的规则文档。
- Modify `src/engine/rules/world/movement-and-position.md`、`scene-changes.md` — 封锁语义与放行。
- Modify `docs/engine-operations.md`、`CLAUDE.md`、`README.md`。
- Tests: `src/engine/core/__tests__/applierConnectionBlock.test.ts`、`tickOrchestrator.test.ts`、`scriptedEventRunner.test.ts`；`src/engine/actions/__tests__/movementRuntime.test.ts`；`src/engine/resolution/__tests__/worldDeltaValidator.test.ts`、`schemaAgreement.test.ts`；新建 `src/engine/core/__tests__/outdoorFixture.ts`（夹具）、`src/engine/core/__tests__/tickEngineSubsystems.test.ts`、`src/engine/weather/__tests__/weatherJudgement.test.ts`、`src/engine/weather/__tests__/weatherEngine.test.ts`。

---

### Task 1: Applier — 一条边一个标志，最后写的人算数

**Files:**
- Modify: `src/engine/core/applier.ts:36-52`（类型与类注释）、`:74`、`:413-418`、`:445-452`、`:539-541`、`:543-637`（replay 循环）、`:719-776`（删除整段）
- Modify: `src/engine/core/tickEngine.ts:50-57`、`:81-92`、`:153-160`
- Modify: `client/server/simulation/service.ts:158-168`
- Test: `src/engine/core/__tests__/applierConnectionBlock.test.ts`、`src/engine/core/__tests__/tickOrchestrator.test.ts:405-411`

**Interfaces:**
- Produces: `Applier` 不再有 `serializeConnectionVotes` / `rehydrateConnectionVotes`；`TickEnginePersistedState` 不再有 `connectionVotes`。
- 语义：`connection.setBlock` 在 pass 2(b) 的顺序回放里直接 `dgsm.setConnectionBlocked(edge.a.id, edge.b.id, blocked, reason)`；同一次 flush 里 Engine delta 先落、buffer 后落。

- [ ] **Step 1: 改写测试**

在 `applierConnectionBlock.test.ts` 里删掉 `describe("refcounted votes from several sources")` 和 `describe("vote table serialization")`（第 259-324 行），换成：

```ts
describe("one flag per edge — the last writer wins, whoever they are", () => {
  it("a second source overwrites the reason, and a third clears the edge", () => {
    const { dgsm, applier } = fixture;
    applier.flush([], T, [
      blockDelta("a1", "connection.ja.rmain", true, "a felled tree"),
    ]);
    applier.flush([], T, [
      blockDelta("a2", "connection.ja.rmain", true, "a mudslide"),
    ]);
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBe("a mudslide");

    // A third action, a third reason: the edge still opens. Nothing is
    // counted — whoever writes last says what the passage is.
    applier.flush([], T, [
      blockDelta("a3", "connection.ja.rmain", false, "the tree dragged aside"),
    ]);
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBeUndefined();
  });

  it("an Engine delta clears a block a subsystem set", () => {
    const { dgsm, applier } = fixture;
    applier.flush(
      [
        {
          kind: "connection.setBlock",
          connectionId: makeFeatureEdgeId("weather", "J_A", "R_MAIN"),
          blocked: true,
          sourceFeatureId: "weather",
          reason: "snowdrifts",
        },
      ],
      T,
      []
    );
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBe("snowdrifts");

    applier.flush([], T, [
      blockDelta("a1", "connection.ja.rmain", false, "shovelled through"),
    ]);
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBeUndefined();
  });

  it("within one flush the buffered change lands after the Engine's", () => {
    const { dgsm, applier } = fixture;
    applier.flush(
      [
        {
          kind: "connection.setBlock",
          connectionId: makeFeatureEdgeId("weather", "J_A", "R_MAIN"),
          blocked: true,
          sourceFeatureId: "weather",
          reason: "snowdrifts",
        },
      ],
      T,
      [blockDelta("a1", "connection.ja.rmain", false, "shovelled through")]
    );
    // Engine deltas apply first, subsystem changes after: the road is shut.
    expect(dgsm.getConnectionBlockReason("J_A", "R_MAIN")).toBe("snowdrifts");
  });
});
```

`describe("collapses the two directions' exit ids onto one edge")` 里的用例保留（语义不变），但把它挪进上面这个 describe。文件头注释第 1-6 行改成：

```ts
// connectionBlock lands on state.blockedConnections as ONE flag per canonical
// edge (the same key scheme pathfinding, the movement runtime and the context
// builder already read): the exit id resolves through the connection
// registry, a subsystem's `<featureId>:<a>|<b>` pair through the fallback,
// and whoever writes last says whether the passage is open.
```

在 `tickOrchestrator.test.ts:405-411` 的 `persistedState` 字面量里删掉 `connectionVotes: {},`。

- [ ] **Step 2: 删投票表**

`applier.ts`：
- 删第 36 行 `type ConnectionVote = ...`。
- 类注释（38-52 行）改为：

```ts
/**
 * Applier
 *
 * Single DGSM mutator: features never write to DGSM directly — they return
 * StateChange[] which the Applier consolidates and flushes in a two-pass
 * algorithm:
 *
 *   Pass 1: group order-independent kinds (hp/san/fatigue deltas, event
 *           emissions, environment contributions).
 *   Pass 2: (a) apply grouped aggregates (sum + clamp + DamageReport);
 *           (b) replay the original change stream for order-dependent
 *               kinds (conditions, descriptions, connection flags, feature
 *               state, items). A connection block is one flag per edge and
 *               the last write wins: the weather engine, a scripted event and
 *               the World Action Engine all write it, and any of them may
 *               clear what another set.
 */
```

- 删第 74 行 `private connectionVotes = ...`。
- 删 Pass 1 的 `setBlockVotes` 声明（413-418）和 `case "connection.setBlock"` 分支（445-452）。
- 删 Pass 2(a) 的 `for (const vote of setBlockVotes) { this.applySetBlockVote(vote); }`（539-541）。
- 在 Pass 2(b) 的 `switch` 里、`case "connection.setHidden"` 之前加：

```ts
        case "connection.setBlock": {
          // One flag per edge, last writer wins. The validator refuses an
          // unknown exit id upstream and a subsystem's pair id names two real
          // places, so a miss here is stale runtime state — a warn, never a
          // throw: one bad flag must not take the whole flush down.
          const edge = this.dgsm.resolveConnectionEdgeById(c.connectionId);
          if (!edge) {
            console.warn(
              `[Applier] connection.setBlock dropped: connection id "${c.connectionId}" resolves to no edge`
            );
            break;
          }
          this.dgsm.setConnectionBlocked(
            edge.a.id,
            edge.b.id,
            c.blocked,
            c.reason
          );
          break;
        }
```

- 删 `applySetBlockVote`、`serializeConnectionVotes`、`rehydrateConnectionVotes` 三个方法及其注释（719-776 行）。

`tickEngine.ts`：`TickEnginePersistedState` 删 `connectionVotes` 字段；删第 91 行 `applier.rehydrateConnectionVotes(...)`；`serialize()` 删 `connectionVotes` 行。

`service.ts:158-168`：类型断言里删掉 `connectionVotes: Record<string, { featureId: string; reason: string }[]>;` 那三行。

- [ ] **Step 3: 自检**

`grep -rn "connectionVotes\|applySetBlockVote\|ConnectionVote" src client scripts --include='*.ts'` 应无输出。

---

### Task 2: 让子系统状态写到它被读的地方，让 `OUTDOOR` 成为区域

这是两个既有 bug 的修复（设计决定 7）。修完之后天气会真的开始演化：grayhaven 的雾预设会在第一 tick 触发一次天气判断，之后每两小时按转移矩阵变一次。**执行前请用户确认这一点。**

**Files:**
- Modify: `src/engine/core/tickEngine.ts:74`
- Modify: `src/engine/core/tickOrchestrator.ts:629-636`
- Modify: `src/engine/core/featureReadContext.ts:129-136`
- Create: `src/engine/core/__tests__/outdoorFixture.ts`（测试夹具，不带 .test 后缀，vitest 不会把它当测试收集；Task 6 也用它）
- Test: `src/engine/core/__tests__/tickEngineSubsystems.test.ts`（新建）

**Interfaces:**
- Produces: `createTickEngine` 用 `subsystemRegistry.getAnchorSubsystems()` 构造 `featureScopes: Map<featureId, anchorKind>`；区域锚点 = 所有场景和道路的 `parentLocationId ?? "OUTDOOR"`。

- [ ] **Step 1: 写夹具和测试**

新建 `src/engine/core/__tests__/outdoorFixture.ts`：

```ts
// src/engine/core/__tests__/outdoorFixture.ts
//
// A small outdoor world for the tick-engine tests: two node scenes joined by
// a road, one indoor scene hanging off the hollow. Nothing outdoors has a
// parent, so the whole outdoors is the implicit OUTDOOR region. Not a test
// file itself — vitest collects only `*.test.ts` — so other test files may
// import it without re-running anything.

import { vi } from "vitest";
import {
  DynamicGameStateManager,
  initialDynamicGameState,
} from "../../../state/DynamicGameState.js";
import { type RoadNode, buildTopology } from "../../../state/topologyTypes.js";
import type { DynamicScene } from "../../../state/types.js";
import { SubsystemRegistry } from "../../subsystem/registry.js";
import type { AnchorSubsystem } from "../../subsystem/types.js";
import { CodeToolRegistry } from "../../tools/codeTool.js";
import { createTickEngine } from "../tickEngine.js";

export function makeOutdoorDgsm(): DynamicGameStateManager {
  const state = initialDynamicGameState("1923-04-02T09:00:00");
  const ridge: DynamicScene = {
    id: "SCN_ridge",
    name: "山脊",
    description: "一道裸露的山脊，风从北面直灌过来。",
    items: [],
    conditions: [],
    connections: [{ id: "connection.ridge.pass", targetId: "ROAD_pass" }],
  };
  const hollow: DynamicScene = {
    id: "SCN_hollow",
    name: "谷底",
    description: "两排石屋夹着的小巷，背风。",
    items: [],
    conditions: [],
    connections: [
      { id: "connection.hollow.pass", targetId: "ROAD_pass" },
      { id: "connection.hollow.inn", targetId: "SCN_inn" },
    ],
  };
  const inn: DynamicScene = {
    id: "SCN_inn",
    name: "客栈",
    description: "低矮的堂屋。",
    parentLocationId: "B_INN",
    indoor: true,
    items: [],
    conditions: [],
    connections: [{ id: "connection.inn.hollow", targetId: "SCN_hollow" }],
  };
  const pass: RoadNode = {
    id: "ROAD_pass",
    name: "山道",
    description: "翻过山脊的土路。",
    parentLocationId: "OUTDOOR",
    connections: [
      { id: "connection.pass.a", targetId: "SCN_ridge", role: "endpointA" },
      { id: "connection.pass.b", targetId: "SCN_hollow", role: "endpointB" },
    ],
    endpointA: "SCN_ridge",
    endpointB: "SCN_hollow",
    travelTimeMinutes: 20,
    alongConnections: [],
    items: [],
    conditions: [],
  };
  for (const s of [ridge, hollow, inn]) state.scenes.set(s.id, s);
  state.roads.set(pass.id, pass);
  state.topology = buildTopology(state.scenes, state.roads);
  return new DynamicGameStateManager(state);
}

/** A tick engine over the fixture with the given subsystems and a World
 *  Action Engine stub that is never reached (no commands are submitted). */
export function makeEngine(
  dgsm: DynamicGameStateManager,
  subsystems: AnchorSubsystem[],
  extra: Partial<Parameters<typeof createTickEngine>[0]> = {}
) {
  const reg = new SubsystemRegistry();
  for (const s of subsystems) reg.register(s);
  return createTickEngine({
    dgsm,
    scriptedEvents: [],
    subsystemRegistry: reg,
    tickDurationMinutes: 1,
    codeTools: new CodeToolRegistry(),
    resolveTickFn: vi.fn(),
    ...extra,
  });
}
```

新建 `src/engine/core/__tests__/tickEngineSubsystems.test.ts`：

```ts
// A subsystem's state has to be written where the next tick reads it: under
// its own anchor kind. And the outdoors is a region even though no scene
// names it as a parent — the module's weather presets do.

import { describe, expect, it, vi } from "vitest";
import type { AnchorSubsystem } from "../../subsystem/types.js";
import { makeEngine, makeOutdoorDgsm } from "./outdoorFixture.js";

describe("subsystem state scope", () => {
  it("writes a region subsystem's state where the next tick reads it", async () => {
    const dgsm = makeOutdoorDgsm();
    const seen: string[] = [];
    const counter: AnchorSubsystem = {
      id: "counter",
      kind: "anchor",
      anchorKind: "region",
      description: "counts ticks per region",
      effectSummary: "",
      affectedKinds: ["feature.setState"],
      shouldExist: () => true,
      initialState: (anchorId) => [
        { kind: "feature.setState", featureId: "counter", key: anchorId, state: { n: 0 } },
      ],
      onTick: (anchorId, ctx) => {
        const prev = ctx.getFeatureState<{ n: number }>(anchorId);
        seen.push(`${anchorId}:${prev?.n ?? "missing"}`);
        return [
          {
            kind: "feature.setState",
            featureId: "counter",
            key: anchorId,
            state: { n: (prev?.n ?? 0) + 1 },
          },
        ];
      },
    };
    const engine = makeEngine(dgsm, [counter]);
    await engine.tick();
    await engine.tick();

    // Tick 1 runs before its own initialState is flushed ("missing"); tick 2
    // reads what tick 1 wrote — under "region", where it was written. The
    // inn's building (B_INN) is a region too; only the implicit outdoors is
    // asserted on.
    expect(seen.filter((s) => s.startsWith("OUTDOOR"))).toEqual([
      "OUTDOOR:missing",
      "OUTDOOR:1",
    ]);
    expect(dgsm.getScopedFeatureState("counter", "region", "OUTDOOR")).toEqual({
      n: 2,
    });
  });
});
```

- [ ] **Step 2: 修 `featureScopes`**

`tickEngine.ts:74` 改为：

```ts
  // Each subsystem's state lives under ITS anchor kind. The Applier used to
  // be handed an empty map here and wrote every feature.setState under
  // "scene", while the orchestrator and the read contexts read under the
  // subsystem's own kind — region-scoped weather was written where nothing
  // ever read it, and stood at its preset for the whole run.
  const featureScopes = new Map<string, FeatureStateScope>(
    opts.subsystemRegistry
      .getAnchorSubsystems()
      .map((s) => [s.id, s.anchorKind] as const)
  );
  const applier = new Applier(opts.dgsm, featureScopes);
```

并在文件顶部 `import type { ..., FeatureStateScope, ... } from "./types.js";`。

- [ ] **Step 3: 修区域锚定**

`tickOrchestrator.ts:629-636` 的 `case "region"` 改为：

```ts
      case "region": {
        // A region is a `parentLocationId`, and the outdoors is the implicit
        // one: a top-level scene or a road with no parent belongs to
        // "OUTDOOR" — the convention getOutdoorLocationIdsInRegion reads and
        // the weather presets name. Scanning scenes alone never produced it,
        // so no weather region was ever anchored.
        const out = new Set<string>();
        const state = dgsm.getState();
        for (const scene of state.scenes.values()) {
          out.add(scene.parentLocationId ?? "OUTDOOR");
        }
        for (const road of (state.roads ?? new Map()).values()) {
          out.add(road.parentLocationId ?? "OUTDOOR");
        }
        return Array.from(out).sort();
      }
```

`featureReadContext.ts:129-136` 的 `getAllRegionIds` 改成同样的规则：

```ts
    getAllRegionIds: () => {
      // Same rule as TickOrchestrator.anchorIdsFor("region"): a place with
      // no parent belongs to the implicit "OUTDOOR" region.
      const state = dgsm.getState();
      const out = new Set<string>();
      for (const scene of state.scenes.values()) {
        out.add(scene.parentLocationId ?? "OUTDOOR");
      }
      for (const road of (state.roads ?? new Map()).values()) {
        out.add(road.parentLocationId ?? "OUTDOOR");
      }
      return Array.from(out).sort();
    },
```

---

### Task 3: movement runtime — `passBlockedConnectionId`

**Files:**
- Modify: `src/engine/actions/movementRuntime.ts:48-64`（状态）、`:194-200`（签名）、`:278-297`（返回的 state）、`:373`、`:426`
- Test: `src/engine/actions/__tests__/movementRuntime.test.ts`

**Interfaces:**
- Produces: `initMovementRuntime(dgsm, actorId, route, vehicleId?, passBlockedConnectionId?)`；`MovementRuntimeState.passBlockedConnectionId?: string`，匹配具体边后删除。

- [ ] **Step 1: 写测试**

在 `movementRuntime.test.ts` 末尾追加：

```ts
describe("passBlockedConnectionId", () => {
  // A blocked passage is a world fact the runtime enforces at the step that
  // reaches it. The Engine may let ONE walk through — the character climbs
  // the fallen tree, wades the ford — without opening the passage for anyone
  // else: that is `passBlockedConnectionId` on this movement, and only this movement.
  it("stops at a blocked passage unless the Engine let this walk through", () => {
    const dgsm = makeDgsm();
    dgsm.__positions.set("npc_1", { type: "scene", sceneId: "S_HOME" });
    dgsm.__blocked.set(["S_HOME", "J_A"].sort().join("::"), "snowdrifts");

    const stopped = initMovementRuntime(dgsm, "npc_1", ["J_A"]);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(advanceMovement(dgsm, "npc_1", stopped.state)).toMatchObject({
      status: "blocked",
      blockedReason: "blocked: snowdrifts",
    });

    const through = initMovementRuntime(dgsm, "npc_1", ["J_A"], undefined, "connection.home.ja");
    expect(through.ok).toBe(true);
    if (!through.ok) return;
    expect(through.state.passBlockedConnectionId).toBe("connection.home.ja");
    const advanced = advanceMovement(dgsm, "npc_1", through.state);
    expect(advanced.status).toBe("arrived");
    expect(advanced.stateChanges.at(-1)).toMatchObject({
      kind: "character.position",
      position: { type: "scene", sceneId: "J_A" },
    });
  });
});
```

- [ ] **Step 2: 实现**

`MovementRuntimeState` 加字段（放在 `vehicleId` 之后）：

```ts
  /** The exact authored passage this walk may cross while its obstacle stays.
   *  Consumed only at the matching edge; all other checks still run. */
  passBlockedConnectionId?: string;
```

`initMovementRuntime` 签名加第五个可选字符串参数 `passBlockedConnectionId`，原样存入 state。封锁检查解析该 id 的对称边；只在当前 `blockCheck` 匹配时放行并删除字段，其他边照常阻断。

`advanceMovement` 与 `drainImmediate` 都先读取当前边的封锁原因；存在封锁时仅由一次性的精确边匹配放行。

---

### Task 4: WAE — `movement.passBlockedConnectionId` 从 schema 到 orchestrator，加规则文档

**Files:**
- Modify: `src/engine/resolution/worldDeltaSchema.ts:42`、`:650-668`
- Modify: `src/engine/resolution/worldDeltaValidator.ts:379-404`（validateStart）、`:1656-1667`（FinalizedResolution）、`:1768-1775`（finalize）
- Modify: `src/engine/resolution/types.ts:293-294`
- Modify: `src/engine/core/tickOrchestrator.ts:289-299`
- Modify: `src/engine/rules/world/movement-and-position.md`、`src/engine/rules/world/scene-changes.md:36-51`
- Test: `src/engine/resolution/__tests__/worldDeltaValidator.test.ts`、`src/engine/resolution/__tests__/schemaAgreement.test.ts:562-570`

**Interfaces:**
- Consumes: Task 3 的 `initMovementRuntime(..., passBlockedConnectionId)`。
- Produces: `RawActionStart.movement: { route: string[]; vehicleId?: string; passBlockedConnectionId?: string }`；`movementInits[id]` 同形。

- [ ] **Step 1: 写测试**

`worldDeltaValidator.test.ts` 的 `describe("finalizeResolution")` 里追加：

```ts
  it("carries one exact movement.passBlockedConnectionId into the movement init", () => {
    const finalized = finalizeResolution(
      {
        starting: [
          start({
            resolvedDurationTicks: undefined,
            movement: { route: ["SCN_1"], passBlockedConnectionId: "connection.scn1.door" },
          }),
        ],
      },
      makeContext({})
    );
    expect(finalized.movementInits[ACTION_ID]).toEqual({
      route: ["SCN_1"],
      passBlockedConnectionId: "connection.scn1.door",
    });

    const errors = validateRawResolution(
      {
        starting: [
          start({
            movement: { route: ["SCN_1"], passBlockedConnectionId: "yes" as never },
          }),
        ],
      },
      makeContext({})
    );
    expect(text(errors)).toContain("passBlockedConnectionId");
  });
```

`schemaAgreement.test.ts:569-570` 的期望改为 `29` 和 `49`，第 562-564 行注释里的数字同步改（`movement.passBlockedConnectionId` 各加一个可选项）。

- [ ] **Step 2: schema**

`worldDeltaSchema.ts` 的 movement 增加 `passBlockedConnectionId?: string`：它必须引用 `exitsFromHere` 中的精确连接 id。

`submitResolutionTool` 的 `movement.properties` 在 `vehicleId` 之后加：

```ts
                passBlockedConnectionId: {
                  type: "string",
                  description:
                    "true when the actor GETS PAST a passage that is blocked right now — climbs the fallen tree, wades the flooded ford, pushes on through the blizzard — without removing what blocks it: the passage stays blocked for everyone else and the runtime lets only this walk through. Judge it from the act, the obstacle's reason (see exitsFromHere) and the character. Omit it when the obstacle stops them: the runtime then interrupts the walk and tells them why. When the act REMOVES the obstacle (a barricade broken, a tree dragged aside) write a sceneChanges connectionBlock blocked:false instead, and no passBlockedConnectionId.",
                },
```

- [ ] **Step 3: validator 与 finalize**

`validateStart` 里 `movement.vehicleId` 检查之后加：

```ts
    if (
      entry.movement.passBlockedConnectionId !== undefined &&
      typeof entry.movement.passBlockedConnectionId !== "string"
    ) {
      errs.push("movement.passBlockedConnectionId must be an exact connection id from exitsFromHere");
    }
```

`FinalizedResolution.movementInits` 与 `resolution/types.ts` 的字段类型均为 `passBlockedConnectionId?: string`；validator 还拒绝它与 `check` 同时出现。

`finalizeResolution` 把精确的 `passBlockedConnectionId` 原样带入 movement init。

- [ ] **Step 4: orchestrator**

`tickOrchestrator.ts:295-298` 改为：

```ts
        movementStates.set(
          actionId,
          initMovementRuntime(
            dgsm,
            actorId,
            init.route,
            init.vehicleId,
            init.passBlockedConnectionId
          )
        );
```

- [ ] **Step 5: 规则文档**

`movement-and-position.md` 在「Actor-owned routes」之后插入：

```markdown
## Blocked passages

A blocked passage is a world fact with a reason. Three writers set and clear
it: the weather engine closes passages the weather makes impassable, a
scripted event floods a ford, and you close a door someone barricades. One
flag per passage; the last write wins, and any writer may clear what another
set.

Code stops a walker at a blocked passage the moment their route reaches it
and hands you the interruption. Never pre-judge a stated route against the
blocked list. The actor learns the passage is shut, and their next command is
where the judgement happens:

- The act REMOVES the obstacle (the barricade broken down, the tree dragged
  aside): emit `sceneChanges connectionBlock {blocked:false}` and no
  `passBlockedConnectionId`. The passage is open for everyone.
- The act GETS THIS PERSON THROUGH while the obstacle stays (climbing the
  tree, wading the ford, pushing on through the blizzard): set
  `movement.passBlockedConnectionId` to the exact blocked id from
  `exitsFromHere`. The passage stays blocked for everyone else; the runtime
  consumes the grant at that edge only. Never combine it with a `check`.
- The obstacle stops them: neither. The runtime interrupts the walk again and
  the actor is told why.

Never both for one passage in one resolution. `passBlockedConnectionId`
grants no route; it only applies to a matching edge in the stated route.
```

`scene-changes.md` 的 Passages 段第一条改为：

```markdown
- `connectionBlock` sets or clears whether that passage can be traversed and
  records the objective reason. One flag per passage, three writers — the
  weather engine, scripted events and you — and the last write wins: clearing
  it opens the passage whoever shut it. Use `blocked:false` only when an act
  actually removes the obstacle; a person getting past an obstacle that stays
  is `movement.passBlockedConnectionId` on their movement (see
  `movement-and-position.md`).
```

---

### Task 5: weather 子系统 — 不再写封锁和条件，改发转换事件

**Files:**
- Modify: `src/engine/subsystem/weather.ts`（头注释、`:8-15` import、`:28-33` 状态、`:43-52` 常量、`:223-340` emit helpers、`:373-425` buildWeatherSetChanges、`:437-450`、`:465-491` initialState、`:499-557` onTick）
- Test: `src/engine/core/__tests__/scriptedEventRunner.test.ts:329-460`

**Interfaces:**
- Produces:
  - `export const WEATHER_FEATURE_ID = "weather"`
  - `export const WEATHER_TRANSITION_EVENT = "weather.transition"`
  - `export interface WeatherTransitionEventData { regionId: string; state: WeatherRegionState }`
  - `WeatherRegionState.judgedBlockIds?: string[]`
  - `getWeatherLabel`、`computeSkillPenalties` 保持导出（Task 6 用）。

- [ ] **Step 1: 改测试**

`scriptedEventRunner.test.ts:371-403` 的用例 "reopens the roads the blizzard closed, and rewrites the condition" 改为：

```ts
  it("re-clocks the region and asks the weather engine to judge it", () => {
    const dgsm = makeWeatherDgsm(5);
    const out = run(
      new ScriptedEventRunner([eases]),
      dgsm,
      1,
      "2038-12-06T19:00:00"
    );

    const set = out.find((c) => c.kind === "feature.setState");
    expect(set).toMatchObject({
      featureId: "weather",
      key: "OUTDOOR",
      state: { weatherType: "snow", intensity: 2, minutesInState: 0 },
    });
    // Blocks and conditions are the weather engine's to write once the
    // orchestrator hears this event; the subsystem casts neither.
    expect(out.filter((c) => c.kind === "connection.setBlock")).toHaveLength(0);
    expect(out.filter((c) => c.kind === "scene.addCondition")).toHaveLength(0);
    const events = out.filter((c) => c.kind === "event.emit");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: {
        type: "weather.transition",
        data: {
          regionId: "OUTDOOR",
          state: { weatherType: "snow", intensity: 2 },
        },
      },
    });
  });
```

第 405-425 行的用例 "closes them again when a script sets the snow back over the threshold" 改为：

```ts
  it("carries the heavier snow into the event when a script raises it", () => {
    const dgsm = makeWeatherDgsm(1);
    const heavier: ScriptedEvent = {
      ...eases,
      onComplete: [
        {
          kind: "weather.set",
          regionId: "OUTDOOR",
          weatherType: "snow",
          intensity: 5,
        },
      ],
    };
    const out = run(
      new ScriptedEventRunner([heavier]),
      dgsm,
      1,
      "2038-12-06T19:00:00"
    );
    const events = out.filter((c) => c.kind === "event.emit");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: { data: { state: { weatherType: "snow", intensity: 5 } } },
    });
  });
```

"does nothing for a region no preset created" 里追加一行 `expect(out.filter((c) => c.kind === "event.emit")).toHaveLength(0);`。

- [ ] **Step 2: 实现**

文件头注释 1-6 行改为：

```ts
// src/engine/subsystem/weather.ts
//
// Regional weather: the state machine (type, intensity, the 120-minute
// transition check) and the numbers it contributes to the environment
// (temperature, an illumination cap). What the weather DOES to a region —
// which passages it closes, what each outdoor place is like under it — is
// not a rule here: on every change this subsystem emits a
// `weather.transition` event, and the orchestrator asks the weather engine
// (src/engine/weather/) to judge it from the places' own prose.
```

删 `makeFeatureEdgeId` 和 `SceneCondition` 的 import（若不再使用）。

常量段改为：

```ts
export const WEATHER_FEATURE_ID = "weather";
const FEATURE_ID = WEATHER_FEATURE_ID;
/** Region-scoped state, so a read context for this subsystem must say so. */
const ANCHOR_KIND = "region" as const;
const TRANSITION_CHECK_INTERVAL_MINUTES = 120;
const MAX_INTENSITY = 5;
/** The tick's word to the orchestrator that a region's weather changed. */
export const WEATHER_TRANSITION_EVENT = "weather.transition";
```

删 `BLOCKING_INTENSITY_THRESHOLD`、`WEATHER_BLOCK_REASON`。

`WeatherRegionState` 加：

```ts
  /** The weather-edge ids the weather engine closed at its last judgement
   *  for this region — the diff base for the next one: a passage it does not
   *  close again reopens. Absent before any judgement. */
  judgedBlockIds?: string[];
```

加：

```ts
export interface WeatherTransitionEventData {
  regionId: string;
  state: WeatherRegionState;
}
```

删 `connectionIdFor`、`buildWeatherSceneCondition`、`emitConnectionBlocks`，加：

```ts
/**
 * The orchestrator's cue that this region's weather changed and the weather
 * engine must judge what it does. A subsystem returns StateChanges and
 * nothing else, so the cue rides as a FeatureEvent: impact 0 and no scene or
 * character, which is what keeps the perception shim from routing it to
 * anyone.
 */
function transitionEvent(
  regionId: string,
  state: WeatherRegionState
): StateChange {
  const data: WeatherTransitionEventData = { regionId, state };
  return {
    kind: "event.emit",
    event: {
      type: WEATHER_TRANSITION_EVENT,
      impact: 0,
      description: `weather in ${regionId}: ${getWeatherLabel(state.weatherType, state.intensity)}`,
      data: data as unknown as Record<string, unknown>,
    },
  };
}
```

`buildWeatherSetChanges` 的返回改为：

```ts
  return [
    {
      kind: "feature.setState",
      featureId: FEATURE_ID,
      key: regionId,
      state: next,
    },
    transitionEvent(regionId, next),
    ...emitEnvContributions(next),
  ];
```

其注释里关于「re-casts the connection votes」的句子改为「emits the internal transition signal that has the weather engine re-judge the region」。

`initialState` 的尾部改为：

```ts
    const regionState = makeRegionState(preset, affectedSceneIds);
    return [
      {
        kind: "feature.setState",
        featureId: FEATURE_ID,
        key: anchorId,
        state: regionState,
      },
      ...emitEnvContributions(regionState),
      transitionEvent(anchorId, regionState),
    ];
```

`onTick` 里 `if (transitioned) { ... }` 整块改为：

```ts
    // What the change does to the region is the weather engine's judgement,
    // asked for once per change through this event.
    if (transitioned) out.push(transitionEvent(anchorId, next));
```

`affectedKinds` 改为 `["feature.setState", "feature.removeState", "environment.contribute", "environment.cap", "event.emit"]`；`effectSummary` 改为 "Per-region weather contributing temperature/illumination cap to env; passages and conditions are judged by the weather engine on each change."；`planningPrompt` 最后一句改为 "Weather affects outdoor scenes only (skill penalties; in severe weather the weather engine closes exposed passages)."。

---

### Task 6: 天气判断的纯函数：请求、校验、落地

**Files:**
- Create: `src/engine/weather/weatherJudgement.ts`
- Test: `src/engine/weather/__tests__/weatherJudgement.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `WEATHER_FEATURE_ID`、`WeatherRegionState`、`WeatherType`、`getWeatherLabel`、`computeSkillPenalties`。
- Produces:
  - `buildWeatherJudgementRequest(dgsm, regionId, state): WeatherJudgementRequest`
  - `validateWeatherJudgement(raw, request): { ok: true; judgement } | { ok: false; errors: string[] }`
  - `weatherJudgementChanges(regionId, state, judgement): StateChange[]`
  - `EMPTY_WEATHER_JUDGEMENT`
  - 类型 `WeatherJudgementRequest`、`WeatherJudgement`、`WeatherPlace`、`WeatherPassage`。

- [ ] **Step 1: 写测试**

```ts
// src/engine/weather/__tests__/weatherJudgement.test.ts
//
// The deterministic half of the weather engine: which passages a region
// offers, what a valid judgement is, and how one becomes StateChanges.

import { describe, expect, it } from "vitest";
import { makeOutdoorDgsm } from "../../core/__tests__/outdoorFixture.js";
import type { WeatherRegionState } from "../../subsystem/weather.js";
import {
  EMPTY_WEATHER_JUDGEMENT,
  buildWeatherJudgementRequest,
  validateWeatherJudgement,
  weatherJudgementChanges,
} from "../weatherJudgement.js";

const RIDGE_PASS = "weather:ROAD_pass|SCN_ridge";
const HOLLOW_PASS = "weather:ROAD_pass|SCN_hollow";

function snow(intensity: number, judgedBlockIds?: string[]): WeatherRegionState {
  return {
    weatherType: "snow",
    intensity,
    minutesInState: 0,
    affectedSceneIds: ["SCN_ridge", "SCN_hollow", "ROAD_pass"],
    ...(judgedBlockIds ? { judgedBlockIds } : {}),
  };
}

describe("buildWeatherJudgementRequest", () => {
  it("lists the outdoor places and the outdoor-to-outdoor passages once each", () => {
    const dgsm = makeOutdoorDgsm();
    dgsm.setConnectionBlocked("SCN_ridge", "ROAD_pass", true, "a landslide");
    const request = buildWeatherJudgementRequest(dgsm, "OUTDOOR", snow(4, [RIDGE_PASS]));

    expect(request.weather).toEqual({ type: "snow", intensity: 4, label: "Blizzard" });
    expect(request.places.map((p) => [p.id, p.kind])).toEqual([
      ["SCN_ridge", "scene"],
      ["SCN_hollow", "scene"],
      ["ROAD_pass", "road"],
    ]);
    expect(request.places[0].description).toContain("山脊");
    // Both directions of one passage are one entry; the inn's doorway is
    // indoors and not the weather's to close.
    expect(request.passages.map((p) => p.connectionId).sort()).toEqual(
      [HOLLOW_PASS, RIDGE_PASS].sort()
    );
    const ridge = request.passages.find((p) => p.connectionId === RIDGE_PASS);
    expect(ridge).toMatchObject({ travelTimeMinutes: 20, blockedNow: "a landslide" });
    expect(request.previouslyClosed).toEqual([RIDGE_PASS]);
  });
});

describe("validateWeatherJudgement", () => {
  const dgsm = makeOutdoorDgsm();
  const request = buildWeatherJudgementRequest(dgsm, "OUTDOOR", snow(4));

  it("accepts a judgement naming only known passages and places", () => {
    const result = validateWeatherJudgement(
      {
        blocks: [{ connectionId: RIDGE_PASS, reason: "雪堆没过膝盖" }],
        conditions: [{ placeId: "SCN_ridge", description: "风雪横扫山脊 " }],
      },
      request
    );
    expect(result).toEqual({
      ok: true,
      judgement: {
        blocks: [{ connectionId: RIDGE_PASS, reason: "雪堆没过膝盖" }],
        conditions: [{ placeId: "SCN_ridge", description: "风雪横扫山脊" }],
      },
    });
  });

  it("treats missing lists as empty", () => {
    expect(validateWeatherJudgement({}, request)).toEqual({
      ok: true,
      judgement: { blocks: [], conditions: [] },
    });
  });

  it("refuses unknown ids, duplicates and empty text, naming each", () => {
    const result = validateWeatherJudgement(
      {
        blocks: [
          { connectionId: "connection.ridge.pass", reason: "x" },
          { connectionId: RIDGE_PASS, reason: "" },
          { connectionId: RIDGE_PASS, reason: "again" },
        ],
        conditions: [
          { placeId: "SCN_inn", description: "x" },
          { placeId: "SCN_hollow", description: "a" },
          { placeId: "SCN_hollow", description: "b" },
        ],
      },
      request
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("blocks[0]");
    expect(result.errors.join("\n")).toContain("blocks[1]");
    expect(result.errors.join("\n")).toContain("blocks[2]");
    expect(result.errors.join("\n")).toContain("conditions[0]");
    expect(result.errors.join("\n")).toContain("conditions[2]");
    expect(result.errors).toHaveLength(5);
  });

  it("refuses unreadable input", () => {
    expect(validateWeatherJudgement(undefined, request).ok).toBe(false);
  });
});

describe("weatherJudgementChanges", () => {
  it("sets the new blocks, lifts the ones no longer judged, replaces the conditions and remembers the set", () => {
    const state = snow(4, [RIDGE_PASS]);
    const changes = weatherJudgementChanges("OUTDOOR", state, {
      blocks: [{ connectionId: HOLLOW_PASS, reason: "谷口的雪堆" }],
      conditions: [{ placeId: "SCN_hollow", description: "巷子里积雪没踝" }],
    });

    expect(changes.filter((c) => c.kind === "connection.setBlock")).toEqual([
      {
        kind: "connection.setBlock",
        connectionId: HOLLOW_PASS,
        blocked: true,
        sourceFeatureId: "weather",
        reason: "谷口的雪堆",
      },
      {
        kind: "connection.setBlock",
        connectionId: RIDGE_PASS,
        blocked: false,
        sourceFeatureId: "weather",
        reason: "weather cleared",
      },
    ]);
    // Every affected place sheds its old weather condition; only the judged
    // ones get a new one, carrying the code-computed skill penalties.
    expect(changes.filter((c) => c.kind === "scene.removeCondition")).toEqual([
      { kind: "scene.removeCondition", sceneId: "SCN_ridge", predicate: { featureId: "weather" } },
      { kind: "scene.removeCondition", sceneId: "SCN_hollow", predicate: { featureId: "weather" } },
      { kind: "scene.removeCondition", sceneId: "ROAD_pass", predicate: { featureId: "weather" } },
    ]);
    expect(changes.filter((c) => c.kind === "scene.addCondition")).toEqual([
      {
        kind: "scene.addCondition",
        sceneId: "SCN_hollow",
        condition: {
          featureId: "weather",
          description: "[Weather] 巷子里积雪没踝",
          mechanicalEffect: {
            skillPenalty: {
              Investigation: -20,
              "Land Vehicle Operation": -20,
              Athletics: -20,
              "Survival & Navigation": -20,
            },
          },
        },
      },
    ]);
    expect(changes.at(-1)).toEqual({
      kind: "feature.setState",
      featureId: "weather",
      key: "OUTDOOR",
      state: { ...state, judgedBlockIds: [HOLLOW_PASS] },
    });
  });

  it("the empty judgement lifts everything and hangs nothing", () => {
    const changes = weatherJudgementChanges("OUTDOOR", snow(0, [RIDGE_PASS]), EMPTY_WEATHER_JUDGEMENT);
    expect(changes.filter((c) => c.kind === "connection.setBlock")).toEqual([
      {
        kind: "connection.setBlock",
        connectionId: RIDGE_PASS,
        blocked: false,
        sourceFeatureId: "weather",
        reason: "weather cleared",
      },
    ]);
    expect(changes.filter((c) => c.kind === "scene.addCondition")).toHaveLength(0);
    expect(changes.at(-1)).toMatchObject({
      kind: "feature.setState",
      state: { judgedBlockIds: [] },
    });
  });
});
```

（`computeSkillPenalties("snow", 4)`：Investigation −5×4、Land Vehicle Operation −5×4、Athletics −5×4、Survival & Navigation −5×4。）

- [ ] **Step 2: 实现**

```ts
// src/engine/weather/weatherJudgement.ts
//
// The deterministic half of the weather engine: what the model is asked (the
// region's outdoor places, the passages between them, the weather), what a
// valid answer is, and how an answer becomes StateChanges. No model call
// lives here — see weatherEngine.ts — so every rule about candidates, diffs
// and penalties is testable without one.

import type { DynamicGameStateManager } from "../../state/DynamicGameState.js";
import { makeFeatureEdgeId } from "../../state/blockedConnections.js";
import type { SceneCondition, StateChange } from "../core/types.js";
import {
  WEATHER_FEATURE_ID,
  type WeatherRegionState,
  type WeatherType,
  computeSkillPenalties,
  getWeatherLabel,
} from "../subsystem/weather.js";

export interface WeatherPlace {
  id: string;
  kind: "scene" | "road";
  name: string;
  description: string;
}

/** A passage the weather may close: both ends outdoors, addressed by the
 *  weather's own edge id (`weather:<a>|<b>`, endpoints sorted) — the id the
 *  applier resolves through the connection registry's pair fallback. */
export interface WeatherPassage {
  connectionId: string;
  from: string;
  to: string;
  /** Full-length walk when one end is a road. */
  travelTimeMinutes?: number;
  /** Set when the passage is blocked at this moment, by anyone, with why. */
  blockedNow?: string;
}

export interface WeatherJudgementRequest {
  regionId: string;
  weather: { type: WeatherType; intensity: number; label: string };
  places: WeatherPlace[];
  passages: WeatherPassage[];
  /** What the last judgement closed. Anything not closed again reopens. */
  previouslyClosed: string[];
}

export interface WeatherJudgement {
  blocks: Array<{ connectionId: string; reason: string }>;
  conditions: Array<{ placeId: string; description: string }>;
}

/** Clear weather: nothing closed, nothing hung. No model is asked for it. */
export const EMPTY_WEATHER_JUDGEMENT: WeatherJudgement = Object.freeze({
  blocks: [],
  conditions: [],
}) as WeatherJudgement;

export function buildWeatherJudgementRequest(
  dgsm: DynamicGameStateManager,
  regionId: string,
  state: WeatherRegionState
): WeatherJudgementRequest {
  const roads = dgsm.getState().roads ?? new Map();
  const places: WeatherPlace[] = [];
  const passages: WeatherPassage[] = [];
  const seen = new Set<string>();
  for (const id of state.affectedSceneIds) {
    const place = dgsm.getScene(id);
    if (!place) continue;
    const isRoad = roads.has(id);
    places.push({
      id,
      kind: isRoad ? "road" : "scene",
      name: place.name,
      description: place.description ?? "",
    });
    for (const connection of place.connections ?? []) {
      const other = dgsm.getScene(connection.targetId);
      // Only an outdoor-to-outdoor edge is the weather's to close; a doorway
      // into a house is not.
      if (!other || other.indoor) continue;
      const connectionId = makeFeatureEdgeId(
        WEATHER_FEATURE_ID,
        id,
        connection.targetId
      );
      if (seen.has(connectionId)) continue;
      seen.add(connectionId);
      const road = roads.get(isRoad ? id : connection.targetId);
      const blockedNow = dgsm.getConnectionBlockReason(id, connection.targetId);
      passages.push({
        connectionId,
        from: id,
        to: connection.targetId,
        ...(road ? { travelTimeMinutes: road.travelTimeMinutes } : {}),
        ...(blockedNow !== undefined ? { blockedNow } : {}),
      });
    }
  }
  return {
    regionId,
    weather: {
      type: state.weatherType,
      intensity: state.intensity,
      label: getWeatherLabel(state.weatherType, state.intensity),
    },
    places,
    passages,
    previouslyClosed: [...(state.judgedBlockIds ?? [])],
  };
}

export type WeatherJudgementValidation =
  | { ok: true; judgement: WeatherJudgement }
  | { ok: false; errors: string[] };

/** Shape and reference checks only — whether a passage DESERVES closing is
 *  the rule document's judgement, in full context. */
export function validateWeatherJudgement(
  raw: unknown,
  request: WeatherJudgementRequest
): WeatherJudgementValidation {
  if (!raw || typeof raw !== "object") {
    return {
      ok: false,
      errors: [
        "the judgement must be an object with `blocks` and `conditions` arrays",
      ],
    };
  }
  const { blocks, conditions } = raw as {
    blocks?: unknown;
    conditions?: unknown;
  };
  const errors: string[] = [];
  const passageIds = new Set(request.passages.map((p) => p.connectionId));
  const placeIds = new Set(request.places.map((p) => p.id));
  const outBlocks: WeatherJudgement["blocks"] = [];
  const outConditions: WeatherJudgement["conditions"] = [];

  if (blocks !== undefined && !Array.isArray(blocks)) {
    errors.push("`blocks` must be an array");
  }
  const seenBlocks = new Set<string>();
  for (const [i, b] of (Array.isArray(blocks) ? blocks : []).entries()) {
    const at = `blocks[${i}]`;
    const entry = b as { connectionId?: unknown; reason?: unknown } | null;
    if (!entry || typeof entry !== "object") {
      errors.push(`${at}: must be {connectionId, reason}`);
      continue;
    }
    if (
      typeof entry.connectionId !== "string" ||
      !passageIds.has(entry.connectionId)
    ) {
      errors.push(
        `${at}: connectionId ${JSON.stringify(entry.connectionId)} is not one of this region's passages — use an id from the Passages list verbatim`
      );
      continue;
    }
    if (seenBlocks.has(entry.connectionId)) {
      errors.push(`${at}: "${entry.connectionId}" is listed twice`);
      continue;
    }
    seenBlocks.add(entry.connectionId);
    if (typeof entry.reason !== "string" || !entry.reason.trim()) {
      errors.push(
        `${at}: reason is required — one objective sentence naming what blocks the way`
      );
      continue;
    }
    outBlocks.push({
      connectionId: entry.connectionId,
      reason: entry.reason.trim(),
    });
  }

  if (conditions !== undefined && !Array.isArray(conditions)) {
    errors.push("`conditions` must be an array");
  }
  const seenPlaces = new Set<string>();
  for (const [i, c] of (Array.isArray(conditions) ? conditions : []).entries()) {
    const at = `conditions[${i}]`;
    const entry = c as { placeId?: unknown; description?: unknown } | null;
    if (!entry || typeof entry !== "object") {
      errors.push(`${at}: must be {placeId, description}`);
      continue;
    }
    if (typeof entry.placeId !== "string" || !placeIds.has(entry.placeId)) {
      errors.push(
        `${at}: placeId ${JSON.stringify(entry.placeId)} is not one of this region's places`
      );
      continue;
    }
    if (seenPlaces.has(entry.placeId)) {
      errors.push(
        `${at}: "${entry.placeId}" already has a condition — one per place`
      );
      continue;
    }
    seenPlaces.add(entry.placeId);
    if (typeof entry.description !== "string" || !entry.description.trim()) {
      errors.push(`${at}: description is required`);
      continue;
    }
    outConditions.push({
      placeId: entry.placeId,
      description: entry.description.trim(),
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, judgement: { blocks: outBlocks, conditions: outConditions } };
}

/** The condition the weather engine's sentence becomes: the subsystem's
 *  featureId so the next judgement can replace it wholesale, and the
 *  code-computed skill penalties for this weather — the model writes what
 *  the place is like, never a number. */
function weatherCondition(
  state: WeatherRegionState,
  description: string
): SceneCondition {
  const penalties = computeSkillPenalties(state.weatherType, state.intensity);
  const skillPenalty: Record<string, number> = {};
  for (const { skill, delta } of penalties) {
    skillPenalty[skill] = (skillPenalty[skill] ?? 0) + delta;
  }
  return {
    featureId: WEATHER_FEATURE_ID,
    description: `[Weather] ${description}`,
    mechanicalEffect: penalties.length > 0 ? { skillPenalty } : undefined,
  };
}

/**
 * A judgement as StateChanges. The model states the full set; code does the
 * bookkeeping: every judged passage is set (idempotently — last writer wins
 * on the flag), every passage the last judgement closed and this one does
 * not is lifted, every affected place sheds its old weather condition and
 * the judged ones get a new one, and the set is remembered on the region
 * state for the next diff.
 */
export function weatherJudgementChanges(
  regionId: string,
  state: WeatherRegionState,
  judgement: WeatherJudgement
): StateChange[] {
  const out: StateChange[] = [];
  const next = new Set(judgement.blocks.map((b) => b.connectionId));
  for (const block of judgement.blocks) {
    out.push({
      kind: "connection.setBlock",
      connectionId: block.connectionId,
      blocked: true,
      sourceFeatureId: WEATHER_FEATURE_ID,
      reason: block.reason,
    });
  }
  for (const id of state.judgedBlockIds ?? []) {
    if (next.has(id)) continue;
    out.push({
      kind: "connection.setBlock",
      connectionId: id,
      blocked: false,
      sourceFeatureId: WEATHER_FEATURE_ID,
      reason: "weather cleared",
    });
  }
  for (const sceneId of state.affectedSceneIds) {
    out.push({
      kind: "scene.removeCondition",
      sceneId,
      predicate: { featureId: WEATHER_FEATURE_ID },
    });
  }
  for (const condition of judgement.conditions) {
    out.push({
      kind: "scene.addCondition",
      sceneId: condition.placeId,
      condition: weatherCondition(state, condition.description),
    });
  }
  out.push({
    kind: "feature.setState",
    featureId: WEATHER_FEATURE_ID,
    key: regionId,
    state: { ...state, judgedBlockIds: [...next] },
  });
  return out;
}
```

---

### Task 7: 天气 engine（LLM 调用）与规则文档

**Files:**
- Create: `src/engine/weather/weatherEngine.ts`
- Create: `src/engine/rules/weather-judgement.md`
- Test: `src/engine/weather/__tests__/weatherEngine.test.ts`

**Interfaces:**
- Consumes: Task 6 的 `WeatherJudgementRequest`、`validateWeatherJudgement`。
- Produces:
  - `export type WeatherJudgeResult = { ok: true; judgement: WeatherJudgement } | { ok: false; failure: string }`
  - `export type WeatherJudgeFn = (request: WeatherJudgementRequest) => Promise<WeatherJudgeResult>`
  - `export async function judgeWeather(request): Promise<WeatherJudgeResult>`
  - `export function renderWeatherRequest(request): string`
  - `export const submitWeatherJudgementTool: ToolSpec`

- [ ] **Step 1: 写测试**

```ts
// src/engine/weather/__tests__/weatherEngine.test.ts
//
// The weather engine's turn loop against a stubbed model: one clean
// submission, one repair, one refusal, one model error.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "../../../models/providers/types.js";

const generateToolCalls = vi.fn();

vi.mock("../../../models/index.js", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "../../../models/types.js"
  );
  return { ...actual, generateToolCalls };
});

const { judgeWeather, renderWeatherRequest } = await import("../weatherEngine.js");

const RIDGE_PASS = "weather:ROAD_pass|SCN_ridge";

const request = {
  regionId: "OUTDOOR",
  weather: { type: "snow" as const, intensity: 4, label: "Blizzard" },
  places: [
    { id: "SCN_ridge", kind: "scene" as const, name: "山脊", description: "裸露的山脊。" },
    { id: "ROAD_pass", kind: "road" as const, name: "山道", description: "翻山的土路。" },
  ],
  passages: [{ connectionId: RIDGE_PASS, from: "SCN_ridge", to: "ROAD_pass", travelTimeMinutes: 20 }],
  previouslyClosed: [],
};

function submission(args: object, id = "call_1") {
  const toolCalls = [{ id, name: "submit_weather_judgement", args }];
  return { toolCalls, assistantMessage: { role: "assistant" as const, toolCalls } };
}

beforeEach(() => {
  generateToolCalls.mockReset();
});

describe("judgeWeather", () => {
  it("renders the passages the model may name and accepts a clean judgement", async () => {
    generateToolCalls.mockResolvedValueOnce(
      submission({
        blocks: [{ connectionId: RIDGE_PASS, reason: "雪堆没过膝盖" }],
        conditions: [{ placeId: "SCN_ridge", description: "风雪横扫" }],
      })
    );
    const result = await judgeWeather(request);
    expect(result).toEqual({
      ok: true,
      judgement: {
        blocks: [{ connectionId: RIDGE_PASS, reason: "雪堆没过膝盖" }],
        conditions: [{ placeId: "SCN_ridge", description: "风雪横扫" }],
      },
    });
    const options = generateToolCalls.mock.calls[0][0];
    expect(options.toolChoice).toEqual({ name: "submit_weather_judgement" });
    expect(options.operation).toBe("weather-engine");
    const prompt = (options.messages as ModelMessage[])[0];
    expect(JSON.stringify(prompt)).toContain(RIDGE_PASS);
    expect(renderWeatherRequest(request)).toContain("裸露的山脊");
  });

  it("sends the errors back once and takes the corrected judgement", async () => {
    generateToolCalls
      .mockResolvedValueOnce(
        submission({ blocks: [{ connectionId: "connection.ridge.pass", reason: "x" }], conditions: [] })
      )
      .mockResolvedValueOnce(submission({ blocks: [], conditions: [] }, "call_2"));
    const result = await judgeWeather(request);
    expect(result).toEqual({ ok: true, judgement: { blocks: [], conditions: [] } });
    const second = generateToolCalls.mock.calls[1][0].messages as ModelMessage[];
    const feedback = second.at(-1);
    expect(feedback?.role).toBe("tool");
    expect(JSON.stringify(feedback)).toContain("REJECTED");
    expect(JSON.stringify(feedback)).toContain("blocks[0]");
  });

  it("gives up after one repair", async () => {
    const bad = submission({ blocks: [{ connectionId: "nope", reason: "x" }], conditions: [] });
    generateToolCalls.mockResolvedValueOnce(bad).mockResolvedValueOnce(bad);
    const result = await judgeWeather(request);
    expect(result.ok).toBe(false);
    expect(generateToolCalls).toHaveBeenCalledTimes(2);
  });

  it("reports a model error instead of throwing", async () => {
    generateToolCalls.mockRejectedValueOnce(new Error("boom"));
    const result = await judgeWeather(request);
    expect(result).toEqual({ ok: false, failure: "model error: boom" });
  });
});
```

- [ ] **Step 2: 规则文档**

`src/engine/rules/weather-judgement.md`：

```markdown
# Weather Judgement

You are asked once each time a region's weather changes. Code owns the
weather itself — its type, its intensity on a 1 (slight) to 5 (extreme)
scale, when it changes, and the temperature and light it contributes. You
own what that weather DOES to this region: which passages it closes, and
what each outdoor place is like under it. Nothing else.

## Read the request

- **Places**: every outdoor place in the region, with its own prose. The
  prose is the evidence: a bare ridge, a sunken lane between walls, a ford, a
  plank bridge, a road along a cliff are different answers to the same storm.
- **Passages**: the only ids `blocks` may name, verbatim. Each joins two
  outdoor places; `blockedNow` says it is shut at this moment, by whatever
  shut it — a landslide a script caused, a barricade a character built, or
  your own last judgement.
- **Previously closed by weather**: what your last judgement shut. A passage
  you do not list again reopens. There is no separate "lift" — the list you
  send IS the set of weather closures.

## Closing a passage

Close a passage only when a person on foot could not reasonably get through
it under this weather: a ridge road in a severe blizzard, a ford under storm
flood, an exposed causeway in hurricane winds, a mountain track in zero
visibility fog. Sheltered lanes between houses, short walks across a yard,
covered ways stay open. Rain, heat, cold and light fog close nothing by
themselves. At intensity 3 a closure is the exception; below 3, do not close.

`reason` is one objective sentence in the language of the place
descriptions, naming what blocks the way — drifts, floodwater, fallen trees,
wind that knocks a walker down. It is what a character who reaches the
passage is told, and what the World Action Engine reads when that character
then tries to get through anyway.

## Conditions

One entry per place the weather visibly touches: a `placeId` from Places and
one present-tense sentence, in the language of the place descriptions, of
what the weather does THERE — visibility, footing, sound, exposure, what
can and cannot be seen or heard. Omit a place the weather does not visibly
touch. No mood, no character reactions, no numbers; code attaches the
mechanical penalties itself.

## Consistency

The same weather over the same geography gets the same answer. Stronger
weather closes at least what weaker weather closed. When unsure whether a
passage is impassable, leave it open and say in the condition how hard it is.

## Output

Exactly one `submit_weather_judgement` call carrying `blocks` and
`conditions`, both arrays, either possibly empty.
```

- [ ] **Step 3: 实现**

```ts
// src/engine/weather/weatherEngine.ts
//
// The weather engine: the third LLM seam. The World Action Engine judges
// what characters do and the renderer judges what they perceive; this one
// judges what the weather does to a region — which passages it closes and
// what each outdoor place is like under it — from the places' own prose,
// which no code rule could read. Called only when a region's weather changes
// (a few times an in-world day), on a request a few thousand tokens long,
// with one repair turn.

import { readFileSync } from "node:fs";
import { ModelClass, generateToolCalls } from "../../models/index.js";
import type { ModelMessage, ToolSpec } from "../../models/providers/types.js";
import {
  type WeatherJudgement,
  type WeatherJudgementRequest,
  validateWeatherJudgement,
} from "./weatherJudgement.js";

export type WeatherJudgeResult =
  | { ok: true; judgement: WeatherJudgement }
  | { ok: false; failure: string };

export type WeatherJudgeFn = (
  request: WeatherJudgementRequest
) => Promise<WeatherJudgeResult>;

/** One submission and one repair. The payload is a handful of ids and
 *  sentences, so a repair re-sends the whole judgement. */
const MAX_TURNS = 2;

function loadRuleFile(name: string, fallback: string): string {
  const candidates = [
    new URL(`../rules/${name}`, import.meta.url),
    `${process.cwd()}/src/engine/rules/${name}`,
  ];
  for (const candidate of candidates) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      // try next
    }
  }
  console.warn(`[WeatherEngine] ${name} not found; using embedded summary`);
  return fallback;
}

const RULES_DOC = loadRuleFile(
  "weather-judgement.md",
  "Close a passage only when this weather makes it impassable on foot; write one objective sentence per place the weather visibly touches; a passage you do not list reopens."
);

const SYSTEM_PROMPT = `You are the weather engine of a tick-based world simulation. A region's weather has just changed. You decide what that weather does to the region's outdoor places and the passages between them, and nothing else: code owns the weather itself, its numbers and its clock.

${RULES_DOC}`;

export const submitWeatherJudgementTool: ToolSpec = {
  name: "submit_weather_judgement",
  strict: false,
  description:
    "Terminal: the complete judgement for this region under its new weather — every passage it closes, and one condition per place the weather visibly touches. A passage you do not list is open.",
  inputSchema: {
    type: "object",
    properties: {
      blocks: {
        type: "array",
        description:
          "Passages impassable on foot under this weather. Each names a connectionId from the Passages list VERBATIM and one objective sentence, in the language of the place descriptions, saying what blocks the way — it is what a character who reaches the passage is told.",
        items: {
          type: "object",
          properties: {
            connectionId: { type: "string" },
            reason: { type: "string" },
          },
          required: ["connectionId", "reason"],
          additionalProperties: false,
        },
      },
      conditions: {
        type: "array",
        description:
          "One entry per place the weather visibly touches: a placeId from the Places list and one objective present-tense sentence of what the weather does THERE (visibility, footing, sound, exposure), in the language of the place descriptions. Omit places it does not touch. No mood, no character reactions, no numbers.",
        items: {
          type: "object",
          properties: {
            placeId: { type: "string" },
            description: { type: "string" },
          },
          required: ["placeId", "description"],
          additionalProperties: false,
        },
      },
    },
    required: ["blocks", "conditions"],
    additionalProperties: false,
  },
};

/** The request as titled JSON sections, the same shape the World Action
 *  Engine reads. */
export function renderWeatherRequest(request: WeatherJudgementRequest): string {
  const section = (title: string, data: unknown): string =>
    `## ${title}\n${JSON.stringify(data, null, 1)}`;
  return [
    "# Weather Judgement Request",
    section("Weather", {
      regionId: request.regionId,
      ...request.weather,
      scale: "intensity 1 (slight) to 5 (extreme)",
    }),
    section("Places (every outdoor place in the region)", request.places),
    section(
      "Passages (the only ids `blocks` may name; `blockedNow` = shut at this moment, by anyone)",
      request.passages
    ),
    section(
      "Previously closed by weather (reopens unless listed again)",
      request.previouslyClosed
    ),
    "Judge now: one submit_weather_judgement call.",
  ].join("\n\n");
}

export async function judgeWeather(
  request: WeatherJudgementRequest
): Promise<WeatherJudgeResult> {
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [{ kind: "text", text: renderWeatherRequest(request) }],
    },
  ];
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let res: Awaited<ReturnType<typeof generateToolCalls>>;
    try {
      res = await generateToolCalls({
        customSystemPrompt: SYSTEM_PROMPT,
        cacheSystemPrompt: true,
        messages,
        tools: [submitWeatherJudgementTool],
        toolChoice: { name: submitWeatherJudgementTool.name },
        allowParallelCalls: false,
        modelClass: ModelClass.MEDIUM,
        operation: "weather-engine",
      });
    } catch (err) {
      return {
        ok: false,
        failure: `model error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const call = res.toolCalls.find(
      (c) => c.name === submitWeatherJudgementTool.name
    );
    if (!call) return { ok: false, failure: "the model made no submission" };
    const validated = validateWeatherJudgement(
      call.unreadableArgs ? undefined : call.args,
      request
    );
    if (validated.ok) return { ok: true, judgement: validated.judgement };
    if (turn === MAX_TURNS - 1) {
      return {
        ok: false,
        failure: `still invalid after a repair: ${validated.errors.join("; ")}`,
      };
    }
    messages.push(res.assistantMessage);
    messages.push({
      role: "tool",
      results: [
        {
          toolCallId: call.id,
          content: [
            "REJECTED. Fix these and send the WHOLE judgement again:",
            ...validated.errors.map((e) => `- ${e}`),
          ].join("\n"),
        },
      ],
    });
  }
  return { ok: false, failure: "turn budget spent" };
}
```

---

### Task 8: orchestrator — Phase 8b 天气判断，接线到 tickEngine

**Files:**
- Modify: `src/engine/core/tickOrchestrator.ts:20-63`（import）、`:70-81`（deps）、`:410-418` 之后（新阶段）
- Modify: `src/engine/core/tickEngine.ts:59-71`、`:94-104`
- Test: `src/engine/core/__tests__/tickEngineSubsystems.test.ts`

**Interfaces:**
- Consumes: Task 5 的 `WEATHER_TRANSITION_EVENT`、`WeatherTransitionEventData`；Task 6 的三个函数；Task 7 的 `judgeWeather`、`WeatherJudgeFn`。
- Produces: `OrchestratorDeps.weatherJudgeFn?: WeatherJudgeFn`；`CreateTickEngineOptions.weatherJudgeFn?: WeatherJudgeFn`。

- [ ] **Step 1: 写测试**

在 `tickEngineSubsystems.test.ts` 追加：

```ts
import type { WeatherRegionState } from "../../subsystem/weather.js";
import type { WeatherJudgeFn } from "../../weather/weatherEngine.js";
// (vitest 2: `vi.fn<WeatherJudgeFn>()` takes the function type as its one
// type argument.)

/** A weather stub that seeds one region in the given weather and raises the
 *  transition event once, on its first tick. */
function weatherStub(state: WeatherRegionState): AnchorSubsystem {
  return {
    id: "weather",
    kind: "anchor",
    anchorKind: "region",
    description: "stub weather",
    effectSummary: "",
    affectedKinds: ["feature.setState", "event.emit"],
    shouldExist: () => true,
    // Like the real subsystem: a region without a preset (here the inn's
    // building, B_INN) gets no state and no event.
    initialState: (anchorId) =>
      anchorId === "OUTDOOR"
        ? [
            { kind: "feature.setState", featureId: "weather", key: anchorId, state },
            {
              kind: "event.emit",
              event: {
                type: "weather.transition",
                impact: 0,
                description: "stub",
                data: { regionId: anchorId, state },
              },
            },
          ]
        : [],
    onTick: () => [],
  };
}

const AFFECTED = ["SCN_ridge", "SCN_hollow", "ROAD_pass"];

describe("weather judgement (Phase 8b)", () => {
  it("asks the weather engine on a transition and applies its judgement in the same tick", async () => {
    const dgsm = makeOutdoorDgsm();
    const judge = vi.fn<WeatherJudgeFn>(async (request) => ({
      ok: true,
      judgement: {
        blocks: [{ connectionId: "weather:ROAD_pass|SCN_ridge", reason: "雪堆没过膝盖" }],
        conditions: [{ placeId: "SCN_ridge", description: "风雪横扫山脊" }],
      },
    }));
    const engine = makeEngine(
      dgsm,
      [weatherStub({ weatherType: "snow", intensity: 5, minutesInState: 0, affectedSceneIds: AFFECTED })],
      { weatherJudgeFn: judge }
    );
    await engine.tick();

    expect(judge).toHaveBeenCalledTimes(1);
    const request = judge.mock.calls[0][0];
    expect(request.regionId).toBe("OUTDOOR");
    expect(request.passages.map((p) => p.connectionId).sort()).toEqual([
      "weather:ROAD_pass|SCN_hollow",
      "weather:ROAD_pass|SCN_ridge",
    ]);
    expect(dgsm.getConnectionBlockReason("SCN_ridge", "ROAD_pass")).toBe("雪堆没过膝盖");
    expect(dgsm.getConnectionBlockReason("SCN_hollow", "ROAD_pass")).toBeUndefined();
    expect(dgsm.getSceneConditions("SCN_ridge")).toEqual([
      expect.objectContaining({ featureId: "weather", description: "[Weather] 风雪横扫山脊" }),
    ]);
    expect(dgsm.getScopedFeatureState("weather", "region", "OUTDOOR")).toMatchObject({
      judgedBlockIds: ["weather:ROAD_pass|SCN_ridge"],
    });

    // The only region in the world got exactly one judgement; a second tick
    // with no transition asks for none.
    await engine.tick();
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("clears without asking: everything the last judgement closed reopens", async () => {
    const dgsm = makeOutdoorDgsm();
    dgsm.setConnectionBlocked("SCN_ridge", "ROAD_pass", true, "雪堆没过膝盖");
    dgsm.appendSceneCondition("SCN_ridge", { featureId: "weather", description: "[Weather] 旧的" });
    const judge = vi.fn<WeatherJudgeFn>();
    const engine = makeEngine(
      dgsm,
      [
        weatherStub({
          weatherType: "clear",
          intensity: 0,
          minutesInState: 0,
          affectedSceneIds: AFFECTED,
          judgedBlockIds: ["weather:ROAD_pass|SCN_ridge"],
        }),
      ],
      { weatherJudgeFn: judge }
    );
    await engine.tick();
    expect(judge).not.toHaveBeenCalled();
    expect(dgsm.getConnectionBlockReason("SCN_ridge", "ROAD_pass")).toBeUndefined();
    expect(dgsm.getSceneConditions("SCN_ridge")).toEqual([]);
  });

  it("leaves passages and conditions as they were when the judgement fails", async () => {
    const dgsm = makeOutdoorDgsm();
    dgsm.setConnectionBlocked("SCN_ridge", "ROAD_pass", true, "雪堆没过膝盖");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const judge = vi.fn<WeatherJudgeFn>(async () => ({ ok: false, failure: "model error: boom" }));
    const engine = makeEngine(
      dgsm,
      [weatherStub({ weatherType: "snow", intensity: 3, minutesInState: 0, affectedSceneIds: AFFECTED, judgedBlockIds: ["weather:ROAD_pass|SCN_ridge"] })],
      { weatherJudgeFn: judge }
    );
    await engine.tick();
    expect(dgsm.getConnectionBlockReason("SCN_ridge", "ROAD_pass")).toBe("雪堆没过膝盖");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("weather judgement for OUTDOOR failed"));
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: orchestrator**

import 段加：

```ts
import {
  WEATHER_TRANSITION_EVENT,
  type WeatherRegionState,
  type WeatherTransitionEventData,
} from "../subsystem/weather.js";
import { type WeatherJudgeFn, judgeWeather } from "../weather/weatherEngine.js";
import {
  EMPTY_WEATHER_JUDGEMENT,
  buildWeatherJudgementRequest,
  weatherJudgementChanges,
} from "../weather/weatherJudgement.js";
```

`OrchestratorDeps` 在 `resolveTickFn` 之后加：

```ts
  /** Injectable for tests; defaults to the real weather engine. */
  weatherJudgeFn?: WeatherJudgeFn;
```

在 `buffer.push(...scriptedEventRunner.run({...}))` 之后、`// Phase 11` 之前插入：

```ts
    // Phase 8b — weather judgement. A region whose weather changed this tick
    // (the subsystem's transition, its seeding, or a script's weather.set)
    // raised a transition event into the buffer; the weather engine says
    // which passages that weather closes and what each outdoor place is
    // like, and its answer joins this same flush. After the scripted events,
    // so a script's weather.set is judged in the tick it lands. Clear weather
    // needs no judgement: everything the last one closed or hung goes.
    const weatherTransitions = new Map<string, WeatherRegionState>();
    for (const c of buffer) {
      if (c.kind !== "event.emit" || c.event.type !== WEATHER_TRANSITION_EVENT) {
        continue;
      }
      const data = c.event.data as unknown as WeatherTransitionEventData | undefined;
      if (data?.regionId && data.state) {
        weatherTransitions.set(data.regionId, data.state);
      }
    }
    for (const [regionId, state] of weatherTransitions) {
      const clear = state.weatherType === "clear" || state.intensity <= 0;
      const request = buildWeatherJudgementRequest(dgsm, regionId, state);
      const judged = clear
        ? { ok: true as const, judgement: EMPTY_WEATHER_JUDGEMENT }
        : await (this.deps.weatherJudgeFn ?? judgeWeather)(request);
      if (!judged.ok) {
        console.warn(
          `[TickOrchestrator] weather judgement for ${regionId} failed: ${judged.failure} — passages and conditions left as they were`
        );
        continue;
      }
      buffer.push(...weatherJudgementChanges(regionId, state, judged.judgement));
    }
```

- [ ] **Step 3: tickEngine**

`CreateTickEngineOptions` 在 `resolveTickFn` 之后加：

```ts
  /** Test seam: replaces the weather engine LLM call. */
  weatherJudgeFn?: WeatherJudgeFn;
```

import `import type { WeatherJudgeFn } from "../weather/weatherEngine.js";`，`new TickOrchestrator({...})` 里加 `weatherJudgeFn: opts.weatherJudgeFn,`。

---

### Task 9: 文档，然后统一验证

**Files:**
- Modify: `docs/engine-operations.md:34-60`（§2）、`:82-90`（§4.1 表）、`:155-160`（§6）、`:173-178`（§7）
- Modify: `CLAUDE.md:7`、`:77-83`
- Modify: `README.md:38-44`

- [ ] **Step 1: `docs/engine-operations.md`**

§2 表格之后加一节：

```markdown
### 2.1 天气 engine：第二个会话，另一个触发源

天气子系统只跑状态机和数值。区域的天气类型或强度一变（子系统每 120 分钟一次的转换、初始化、脚本 `weather.set`），它在 buffer 里放一条内部 `weather.transition` 信号；orchestrator 在脚本事件之后消费它，再调用 `engine/weather/weatherEngine.ts`。输入是该区域所有户外地点的 prose、候选通道（两端都在户外，id 形如 `weather:<a>|<b>`）和新天气，输出「关哪些通道、哪些地点挂什么条件」。该信号在 flush 前移除，不进入公开事件流。代码把模型给出的完整集合与 `WeatherRegionState.judgedBlockIds` 做差，多出的设、少掉的撤；条件按 `featureId: "weather"` 整体替换，技能减值由代码按类型和强度挂上。晴天不调模型。失败时只打警告，封锁和条件保持上次的。
```

§4.1 表格 `movement` 一行改为：

```markdown
| `movement` | `{route: string[], vehicleId?, passBlockedConnectionId?}` —— **演员自己说出的**路线，逐段拓扑相邻。Engine 从不替他补一段没说过的腿。`passBlockedConnectionId` 是具体封锁通道 id，只在匹配边消费一次，不能和未决 `check` 同时出现；障碍被清除则用 `connectionBlock {blocked:false}`。 |
```

§6 的映射段落之后加一句：

```markdown
`connection.setBlock` 是一条边一个标志：天气 engine、脚本事件、WAE 三个来源各写各的，最后写的人说了算，任何一个都可以清掉别人设的。没有投票表、没有引用计数。
```

§7 子系统清单里 `weather` 后加注：`（只管状态机与数值贡献；封锁和条件由天气 engine 写）`。

- [ ] **Step 2: `CLAUDE.md`**

第 7 行的 `*The two LLM seams*` 改为 `*The LLM seams*`；第 77 行标题改为 `### The LLM seams`；在 RoleSimAgent 段之后加：

```markdown
**Weather engine** (`engine/weather/weatherEngine.ts`) — one small session per region per weather change. The weather subsystem keeps the state machine and the numbers; on a change it raises a `weather.transition` event, and the orchestrator (Phase 8b, after scripted events) asks this engine which passages the weather closes and what each outdoor place is like, from the places' own prose. Code diffs the answer against the last one (`judgedBlockIds`), attaches the skill penalties, and folds it into the same flush. Clear weather is deterministic; a failed judgement leaves passages and conditions as they were.

Connection blocks are one flag per edge with a reason. Three writers — the weather engine, scripted events and the World Action Engine — and the last write wins; any of them may clear what another set. There is no refcount. A character getting past an obstacle that stays uses the exact blocked edge's one-shot `movement.passBlockedConnectionId`, not a cleared block; it cannot accompany an unresolved check.
```

- [ ] **Step 3: `README.md`**

第 38-44 行的两个要点改为：

```markdown
- **Code engine** — deterministic transitions: movement along the place
  graph, the clock, the weather state machine, sunlight, stamina, item
  damage, condition expiry, dice.
- **LLM engines** — open-ended outcomes. The World Action Engine reads the
  full world context, resolves every action that triggered this tick, and
  emits typed `WorldDelta`s that the code validates and applies. A smaller
  weather engine judges, on each weather change, which passages the weather
  closes and what each outdoor place is like.
```

- [ ] **Step 4: 统一验证（需要用户说「跑」）**

```bash
pnpm check
pnpm build:tsc
pnpm test
```

预期：biome 无报错；tsc 无报错；全部测试通过，包括新建的三个测试文件和改过的五个。

- [ ] **Step 5: 交给用户审阅，一次提交**

`git status` 里应看到本计划涉及的文件加上已删除的 `src/engine/subsystem/fire.ts`。提交由用户决定。
