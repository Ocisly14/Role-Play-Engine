# 引擎纯代码省钱项（第 1 步）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 不调用任何新模型，用代码规则省掉两类结算调用：纯步行正常到达的行动由代码直接收尾；结算里没有任何「有新结果」的结束时，跳过三个变更阶段。

**Architecture:** 一个共享的开关模块（`off | shadow | on` + 影子日志），两处接入：`TickOrchestrator` 在收集结算触发时把纯到达的行动摘出来由代码写 `completed`；`resolveTick` 在结算会话里，endings 被接受后若没有 `outcome`，直接以 `[]` 接受三个变更阶段。默认 `off`，行为与现在完全一致。

**Tech Stack:** TypeScript、vitest、pnpm。

**Spec:** `docs/superpowers/specs/2026-11-13-decisions-api-fast-paths-design.md`（6.3 第 0 步、第 3 步「没有 outcome 行动时三个变更阶段全部跳过」、6.6 开关与影子模式）。

**不在本计划内：** 讨论时定过的「去掉同一栋楼内的捷径」已撤销——每段路线在规划前都经 `placesAdjacent` 检查，捷径只在两个直接相邻的房间之间触发，`blockCheck` 查的正是那道门；去掉它反而会让相邻房间经街上绕行。暗门防护归第 2 步（隐藏机制设计 5.6，已更正）。

## Global Constraints

- 开关名与取值：`ENGINE_ARRIVAL_SKIP`、`DECISIONS_PHASE_SKIP`，取值 `off | shadow | on`，**默认 `off`**；无法识别的值按 `off` 处理并警告一次。
- 影子日志：环境变量 `DECISIONS_SHADOW_LOG` 指向的文件，每条一行 JSON；未设置时不写。
- shadow：照常走 LLM，只记录代码规则的预测与 LLM 实际结果是否一致；不改变任何行为。
- 不提交（commit）：所有改动留在工作区，由用户审阅后一次性提交，讨论稿随本步一起提交。
- 不自动运行测试：每个任务只写测试；最后一个任务统一运行，运行前先征得用户同意。
- 单测放在源码旁的 `__tests__/`；路径别名 `@/*` → `src/*`。
- 遵守 `pnpm check`（biome）格式。

## Review Focus

1. **到达的同时被中断**（行动者死亡、被阻断）：不能被代码收尾成 `completed`，必须照常进结算 → Task 2 测试 `an interrupted arrival still goes to the Engine`。
2. **带台词的步行**（到了再说话）：台词要在结算里送达，不能被代码吞掉 → Task 2 测试 `a walk that carries an utterance is still settled by the Engine`。
3. **代码收尾不得产生兜底事件**：否则行动者会收到「行动结束了，没有留下可见的变化」 → Task 2 测试断言 `report.occurrences` 不含该行动。
4. **全局校验回退到被跳过的阶段**：那个阶段必须真的跑一次，不能再次被跳过 → Task 3 测试 `a rewind into a skipped phase runs it`。
5. **endings 里只要有一个 `outcome`**：三个变更阶段都不能跳 → Task 3 测试 `one outcome among the endings runs all five phases`。

---

### Task 1: 开关与影子日志模块

**Files:**
- Create: `src/engine/shared/fastPath.ts`
- Test: `src/engine/shared/__tests__/fastPath.test.ts`
- Modify: `.env.example`（末尾追加三行注释过的变量：`# ENGINE_ARRIVAL_SKIP=off`、`# DECISIONS_PHASE_SKIP=off`、`# DECISIONS_SHADOW_LOG=./output/shadow.jsonl`，各附一行中文说明）

**Interfaces:**
- Produces:
  - `export type FastPathMode = "off" | "shadow" | "on";`
  - `export type FastPathName = "ENGINE_ARRIVAL_SKIP" | "DECISIONS_PHASE_SKIP";`（第 3 步会往里加名字）
  - `export function fastPathMode(name: FastPathName, env: NodeJS.ProcessEnv = process.env): FastPathMode`
  - `export function recordShadow(name: FastPathName, entry: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): void` —— 写入 `{ fastPath: name, at: <ISO 时间>, ...entry }` 一行；写文件出错只 `console.warn`，绝不抛出。

- [ ] **Step 1: 写测试 `fastPath.test.ts`**

```ts
it("defaults to off", () => expect(fastPathMode("ENGINE_ARRIVAL_SKIP", {})).toBe("off"));
it("reads on and shadow", () => {
  expect(fastPathMode("ENGINE_ARRIVAL_SKIP", { ENGINE_ARRIVAL_SKIP: "on" })).toBe("on");
  expect(fastPathMode("DECISIONS_PHASE_SKIP", { DECISIONS_PHASE_SKIP: "shadow" })).toBe("shadow");
});
it("treats an unknown value as off", () =>
  expect(fastPathMode("ENGINE_ARRIVAL_SKIP", { ENGINE_ARRIVAL_SKIP: "yes" })).toBe("off"));
it("appends one JSON line per record when DECISIONS_SHADOW_LOG is set", () => {
  // tmp 文件放在 os.tmpdir() 下的新目录；写两条，读回两行，
  // 每行 JSON.parse 后含 fastPath / at / 传入的字段
});
it("writes nothing when DECISIONS_SHADOW_LOG is unset", () => {
  // 调用后目标目录仍为空
});
```

- [ ] **Step 2: 实现 `fastPath.ts`**

用 `fs.appendFileSync`；未知值的警告按名字只发一次（模块级 `Set`）。

---

### Task 2: 纯步行到达由代码收尾（`ENGINE_ARRIVAL_SKIP`）

**Files:**
- Modify: `src/engine/core/tickOrchestrator.ts`（Phase 5 触发收集、`transitions` 组装、兜底事件的 `settled` 集合、Phase 12 提交）
- Test: `src/engine/core/__tests__/tickOrchestrator.test.ts`（新 `describe("a plain arrival closes in code")`）

**Interfaces:**
- Consumes: Task 1 的 `fastPathMode`、`recordShadow`。
- Produces: 无对外接口。

**规则（判定「纯到达」）**：一个到期行动同时满足——
- `arrivedActionIds.has(id)`（本 tick 移动 runtime 报告到达）；
- `!action.check`（开始时没有设检定）；
- `!action.command.utterance?.trim()`；
- 不在本 tick 的中断集合里（把 `interruptions` 的计算挪到 `dueIds` 之前，用它的 actionId 集合排除）。

**`on`：**
- 这些 id 从 `duration_reached` 触发里去掉。
- 为每个生成 `ActionTransition { actionId, actorId, from: "active", to: "completed", progressDeltaMinutes: 0 }`，放进 `transitions`（位于 start 与 settlement 之间），从而进入 `commits` 与 TickReport。
- 这些 id 加入兜底事件判断用的 `settled` 集合。
- Phase 12 在 flush 之后对它们调用 `applyTransition`，与结算的提交同一位置。
- 若去掉后再无触发，不开结算会话（现有逻辑自然满足）。

**`shadow`：** 不摘出，照常结算。结算成功后，对每个预测 id 记 `recordShadow("ENGINE_ARRIVAL_SKIP", { tick: nextTickTime, actionId, predicted: "no_change", llm, agree })`：结算没给它 transition → `llm: "unsettled"`；transition 带 `reason` 或任一 occurrence 的 `sourceActionIds` 含它 → `llm: "result"`；否则 `"no_change"`。`agree = llm === "no_change"`。结算失败不记。

- [ ] **Step 1: 写测试**

复用文件里 `describe("a walk that starts partway along a road")` 的 `makeRoadDgsm` / `stubResolveWithWalk`：把这两个工厂提到文件顶层（不改它们的行为），供新 describe 使用。用 `vi.stubEnv` 设开关，`afterEach(() => vi.unstubAllEnvs())`。站位用 `position: 0.05`（一分钟就到）。

```ts
it("on: a plain walk is closed by code — one Engine call (the start), completed, committed", async () => {
  // stubEnv ENGINE_ARRIVAL_SKIP=on；tick 一次
  expect(resolve.fn).toHaveBeenCalledTimes(1);
  expect(engine.getAction(id)).toMatchObject({ status: "completed" });
  expect(report.transitions).toContainEqual(expect.objectContaining({ actionId: id, to: "completed" }));
  expect(report.commits.map((c) => c.handleId)).toContain(id);
  expect(report.occurrences.some((o) => o.sourceActionIds.includes(id))).toBe(false);
});
it("off: the same walk is settled by the Engine (two calls)", ...);         // 不设开关
it("a walk that carries an utterance is still settled by the Engine", ...); // command({ utterance: "到了。" })，on，2 次调用
it("a walk with a check is still settled by the Engine", ...);              // stub 的 starting 行加 check: { requiredLevel: "regular" }，command({ declaredSkillId: "Athletics" })，on，2 次调用
it("an interrupted arrival still goes to the Engine", ...);                 // on；submitCommand 后、tick 前 engine.requestInterruption(id, "actor died")（排队中的中断会在开始判定把它变成 active 后生效）；断言结算上下文的 interrupted 触发含该 id，且代码没有把它写成 completed
it("shadow: settled by the Engine, and one shadow line records the disagreement", ...);
// stubEnv DECISIONS_SHADOW_LOG 指向 tmp 文件；stub 的 ending 写了 outcome，故 llm === "result"、agree === false
```

- [ ] **Step 2: 按上面的规则修改 `tickOrchestrator.ts`**

---

### Task 3: 没有 outcome 时跳过三个变更阶段（`DECISIONS_PHASE_SKIP`）

**Files:**
- Modify: `src/engine/resolution/worldActionEngine.ts`（`Session` 增字段、`resolveTick` 阶段循环、回退处理）
- Test: `src/engine/resolution/__tests__/worldActionEngine.test.ts`（新 `describe("skipping change phases when nothing has an outcome")`）
- Modify: `CLAUDE.md`（The LLM seams 一节：说明结算在 `DECISIONS_PHASE_SKIP=on` 时会跳过变更阶段、`ENGINE_ARRIVAL_SKIP=on` 时纯到达不进结算，两者默认 `off`；Environment 一节补三个变量）

**Interfaces:**
- Consumes: Task 1 的 `fastPathMode`、`recordShadow`；现有 `validatePhase`、`acceptedPhaseValue`、`PHASE_FIELDS`、`draftKey`。
- Produces（第 3 步会扩展它们）：
  - `const CHANGE_PHASES: ReadonlySet<ResolutionPhase>` = `characterChanges`、`itemChanges`、`sceneChanges`
  - `function noOutcomeEnding(draft: AcceptedResolutionDraft): boolean` —— `draft.endings` 已接受且其中没有 `mode === "outcome"`
  - `Session.unskippable: Set<ResolutionPhase>` —— 初始为空；全局回退时，把 `from` 及其后、本会话内的阶段全部加入

**`on`：** 在 settlement 会话里、对 `CHANGE_PHASES` 中且不在 `unskippable` 的阶段，若 `noOutcomeEnding(session.draft)`：用 `{ [PHASE_FIELDS[phase]]: [] }` 调 `validatePhase`；无错误则以 `acceptedPhaseValue` 写入草稿、不发请求，`console.log` 一行 `[WorldActionEngine] tick <id> phase <phase> skipped — no ending carries an outcome`；有错误（理论上不会）则照常 `runPhase`。

**`shadow`：** 照常 `runPhase`；接受后若满足跳过条件，记 `recordShadow("DECISIONS_PHASE_SKIP", { tick, phase, rows: <接受的行数>, agree: rows === 0 })`。

- [ ] **Step 1: 写测试**（`vi.stubEnv` + `afterEach(() => vi.unstubAllEnvs())`；剧本用文件里现有的 `accept` / `script` / `SETTLEMENT_ANSWERS`，跳过的阶段不放进剧本）

```ts
it("on: every ending no_change → only endings and occurrences are requested", async () => {
  // script(accept("endings", { endings: [{ actionId: LIVE, mode: "no_change" }] }),
  //        accept("occurrences", { occurrences: [] }))
  expect(phasesRequested()).toEqual(["endings", "occurrences"]);
  expect(result.resolution.characterChanges).toEqual([]);  // item / scene 同
  expect(gate).toHaveBeenCalledTimes(1);
});
it("on: a pure_speech ending skips them too", ...);        // 剧本照抄现有 pure speech 用例的 endings 与 occurrences
it("on: one outcome among the endings runs all five phases", ...); // SETTLES_LIVE；phasesRequested 等于 SESSION_PHASES.settlement
it("on: a rewind into a skipped phase runs it", async () => {
  // gate 第一次返回 target { kind: "itemChange", index: 0 } 的错误（同现有回退用例）
  // 剧本：endings(no_change)、occurrences、itemChanges([])、sceneChanges([])、occurrences
  expect(phasesRequested()).toEqual(["endings", "occurrences", "itemChanges", "sceneChanges", "occurrences"]);
});
it("shadow: all five run, and three shadow lines say agree: true", ...);
it("off: all five run (unchanged)", ...);
```

- [ ] **Step 2: 按上面的规则修改 `worldActionEngine.ts`**

- [ ] **Step 3: 更新 `CLAUDE.md`**

---

### Task 4: 统一验证（需用户同意后运行）

- [ ] **Step 1: 征得用户同意后运行**

```bash
pnpm test -- src/engine/shared/__tests__/fastPath.test.ts src/engine/core/__tests__/tickOrchestrator.test.ts src/engine/resolution/__tests__/worldActionEngine.test.ts
```

Expected: 全部通过；原有用例（开关默认 `off`）不受影响。

- [ ] **Step 2: 类型与格式**

```bash
pnpm build:tsc
```

```bash
pnpm check
```

Expected: 无类型错误；biome 无剩余问题。

- [ ] **Step 3: 交给用户审阅 diff，不提交**
