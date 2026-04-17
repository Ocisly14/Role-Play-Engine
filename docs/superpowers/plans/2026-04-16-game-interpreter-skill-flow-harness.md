# Game Interpreter Skill Flow Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完善 `scripts/test-game-interpreter-skill-flow.ts` 诊断脚本：扩大 fixture 覆盖面（技能/output key/skill check 分支/执行位置）+ 增加 JSONL 中断恢复。

**Architecture:** 纯脚本增强。fixture 接口加两个可选字段（`forcedSkillStatus`、`executionLocation`）；runner 在三个节点注入（`stageCaseState` 做位置、`runCase` 做 skill 覆盖、`main` 做 checkpoint I/O）。报告 summary 新增覆盖矩阵。核心新逻辑（checkpoint / forced result 合成）写 vitest 单测，fixture 数据靠 TypeScript 编译 + `--list-cases` 验证。

**Tech Stack:** TypeScript (NodeNext), tsx, vitest, node:fs。不动 `src/` 下的生产代码。

**User preferences（来自项目 memory）:**
- 不在每个任务后提交，全部改完再由用户一次审核提交
- 规范文档在实现完成前不单独提交（spec 已按此原则留在 working tree）

---

## 文件结构

**修改：**
- `scripts/fixtures/gameInterpreterSkillFlowCases.ts` — 接口加字段 + 27 个新 fixture
- `scripts/test-game-interpreter-skill-flow.ts` — runner 逻辑 + CLI + checkpoint I/O + summary 增强

**新增：**
- `scripts/lib/checkpoint.ts` — JSONL checkpoint 读写工具（从脚本里拆出，便于单测）
- `scripts/lib/forcedSkillResult.ts` — `buildForcedSkillResult` 合成函数（同上）
- `scripts/lib/__tests__/checkpoint.test.ts` — checkpoint 单测
- `scripts/lib/__tests__/forcedSkillResult.test.ts` — 合成函数单测

`scripts/lib/` 是新建目录。拆成独立文件的理由：`test-game-interpreter-skill-flow.ts` 已近千行，继续塞不利于阅读；新 helper 拆到 `lib/` 使 vitest 能直接 import 做单测。

---

## Task 1: 新增 `forcedSkillStatus` + `executionLocation` 字段到 fixture 接口

**Files:**
- Modify: `scripts/fixtures/gameInterpreterSkillFlowCases.ts:1-13`

**背景**：后续 runner 代码会读这两个字段，接口必须先更新。这一步只加类型，不加 fixture 数据。

- [ ] **Step 1: 修改接口**

替换文件顶部的接口定义：

```ts
export interface GameInterpreterSkillFlowCase {
  id: string;
  label: string;
  actorId: string;
  targetIds?: string[];
  executionSceneId: string;
  actionText: string;
  expectedSteps: string[];
  expectedPrimaryDefinitionId: string;
  expectedOutputKeysAnyOf: string[];
  notes?: string;
  /**
   * If set, the runner synthesizes a SkillCheckResult with this level
   * instead of rolling dice. Values match planning/types.ts SuccessLevel.
   */
  forcedSkillStatus?: "critical" | "hard" | "regular" | "fail" | "fumble";
  /**
   * Override where the actor (and any targets) are placed before the case runs.
   * Default: all placed in executionSceneId.
   */
  executionLocation?:
    | { type: "scene"; sceneId: string }
    | { type: "road"; roadId: string; position: number }
    | { type: "junction"; junctionId: string };
}
```

- [ ] **Step 2: 确认编译不报错**

Run: `pnpm build:tsc`
Expected: 无错误（20 个现有 fixture 无新字段也合法，因为两个新字段都是 optional）。

---

## Task 2: 新增 `buildForcedSkillResult` helper + 单测

**Files:**
- Create: `scripts/lib/forcedSkillResult.ts`
- Create: `scripts/lib/__tests__/forcedSkillResult.test.ts`

**背景**：`runCase` 里碰到 `forcedSkillStatus` 时用此函数合成一个合法的 `ToolResult`（类型定义在 `src/engine/types.ts:362`）。

- [ ] **Step 1: 写失败测试**

Create `scripts/lib/__tests__/forcedSkillResult.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { buildForcedSkillResult } from "../forcedSkillResult.js";

describe("buildForcedSkillResult", () => {
  it("maps critical to completed + critical", () => {
    const result = buildForcedSkillResult("critical", "perception");
    expect(result.done).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.successLevel).toBe("critical");
    expect(result.outcomeDescription).toContain("critical");
    expect(result.rollDetail).toContain("forced");
  });

  it("maps hard to completed + hard", () => {
    const result = buildForcedSkillResult("hard", "locksmith");
    expect(result.status).toBe("completed");
    expect(result.successLevel).toBe("hard");
  });

  it("maps regular to completed + regular", () => {
    const result = buildForcedSkillResult("regular", "research");
    expect(result.status).toBe("completed");
    expect(result.successLevel).toBe("regular");
  });

  it("maps fail to failed + fail", () => {
    const result = buildForcedSkillResult("fail", "psychology");
    expect(result.status).toBe("failed");
    expect(result.successLevel).toBe("fail");
  });

  it("maps fumble to failed + fumble", () => {
    const result = buildForcedSkillResult("fumble", "brawling");
    expect(result.status).toBe("failed");
    expect(result.successLevel).toBe("fumble");
  });

  it("embeds the skill name in outcomeDescription when provided", () => {
    const result = buildForcedSkillResult("critical", "perception");
    expect(result.outcomeDescription).toContain("perception");
  });

  it("accepts undefined skill", () => {
    const result = buildForcedSkillResult("regular", undefined);
    expect(result.outcomeDescription).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run scripts/lib/__tests__/forcedSkillResult.test.ts`
Expected: 失败，文件不存在。

- [ ] **Step 3: 实现函数**

Create `scripts/lib/forcedSkillResult.ts`:

```ts
import type { SuccessLevel } from "../../src/planning/types.js";
import type { ToolResult } from "../../src/engine/types.js";

export type ForcedSkillStatus = "critical" | "hard" | "regular" | "fail" | "fumble";

const MAPPING: Record<
  ForcedSkillStatus,
  { status: "completed" | "failed"; successLevel: SuccessLevel }
> = {
  critical: { status: "completed", successLevel: "critical" },
  hard: { status: "completed", successLevel: "hard" },
  regular: { status: "completed", successLevel: "regular" },
  fail: { status: "failed", successLevel: "fail" },
  fumble: { status: "failed", successLevel: "fumble" },
};

export function buildForcedSkillResult(
  status: ForcedSkillStatus,
  skill: string | undefined
): ToolResult {
  const { status: toolStatus, successLevel } = MAPPING[status];
  const skillLabel = skill ? ` for ${skill}` : "";
  return {
    done: true,
    status: toolStatus,
    outcomeDescription: `Forced ${status} outcome${skillLabel} (diagnostic)`,
    successLevel,
    rollDetail: `forced:${status}`,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run scripts/lib/__tests__/forcedSkillResult.test.ts`
Expected: 7 个测试全过。

---

## Task 3: 新增 checkpoint 读写模块 + 单测

**Files:**
- Create: `scripts/lib/checkpoint.ts`
- Create: `scripts/lib/__tests__/checkpoint.test.ts`

**背景**：JSONL 格式，每行一条 record：header / case / summary。读取时收集已完成 case IDs，并检测是否已 completed。

- [ ] **Step 1: 写失败测试**

Create `scripts/lib/__tests__/checkpoint.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  appendCheckpointLine,
  loadCheckpoint,
  openCheckpoint,
  finalizeCheckpoint,
} from "../checkpoint.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "cp-test-"));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("checkpoint", () => {
  it("returns null when file does not exist", () => {
    const loaded = loadCheckpoint(path.join(tmpDir, "missing.jsonl"));
    expect(loaded).toBeNull();
  });

  it("writes header on openCheckpoint", () => {
    const filePath = path.join(tmpDir, "a.jsonl");
    openCheckpoint(filePath, {
      sessionId: "S1",
      moduleName: "Cassandra_zh",
      language: "zh",
      provider: "openai",
      totalCases: 3,
      caseIds: ["a", "b", "c"],
    });
    const contents = readFileSync(filePath, "utf-8");
    const [headerLine] = contents.trim().split("\n");
    const header = JSON.parse(headerLine);
    expect(header.type).toBe("header");
    expect(header.sessionId).toBe("S1");
    expect(header.totalCases).toBe(3);
    expect(header.caseIds).toEqual(["a", "b", "c"]);
    expect(header.startedAt).toBeDefined();
  });

  it("appends case lines and loads them back", () => {
    const filePath = path.join(tmpDir, "b.jsonl");
    openCheckpoint(filePath, {
      sessionId: "S2",
      moduleName: "M",
      language: "zh",
      provider: "openai",
      totalCases: 2,
      caseIds: ["x", "y"],
    });
    appendCheckpointLine(filePath, { type: "case", id: "x", label: "X" });

    const loaded = loadCheckpoint(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.header.sessionId).toBe("S2");
    expect(loaded!.completedCaseIds.has("x")).toBe(true);
    expect(loaded!.completedCaseIds.has("y")).toBe(false);
    expect(loaded!.isComplete).toBe(false);
    expect(loaded!.results).toHaveLength(1);
  });

  it("marks isComplete=true when summary line present", () => {
    const filePath = path.join(tmpDir, "c.jsonl");
    openCheckpoint(filePath, {
      sessionId: "S3",
      moduleName: "M",
      language: "zh",
      provider: "openai",
      totalCases: 1,
      caseIds: ["x"],
    });
    appendCheckpointLine(filePath, { type: "case", id: "x" });
    finalizeCheckpoint(filePath, { totalCases: 1, applyPass: 1 });

    const loaded = loadCheckpoint(filePath);
    expect(loaded!.isComplete).toBe(true);
    expect(loaded!.summary).toBeDefined();
    expect((loaded!.summary as any).totalCases).toBe(1);
  });

  it("ignores a corrupted final line when loading", () => {
    const filePath = path.join(tmpDir, "d.jsonl");
    openCheckpoint(filePath, {
      sessionId: "S4",
      moduleName: "M",
      language: "zh",
      provider: "openai",
      totalCases: 2,
      caseIds: ["x", "y"],
    });
    appendCheckpointLine(filePath, { type: "case", id: "x" });
    // Simulate a crash mid-write by appending invalid JSON
    const fs = require("node:fs") as typeof import("node:fs");
    fs.appendFileSync(filePath, '{"type":"case","id":"y",');

    const loaded = loadCheckpoint(filePath);
    expect(loaded).not.toBeNull();
    expect(loaded!.completedCaseIds.has("x")).toBe(true);
    expect(loaded!.completedCaseIds.has("y")).toBe(false);
    expect(loaded!.isComplete).toBe(false);
  });

  it("openCheckpoint overwrites when fresh=true", () => {
    const filePath = path.join(tmpDir, "e.jsonl");
    openCheckpoint(filePath, {
      sessionId: "OLD",
      moduleName: "M",
      language: "zh",
      provider: "openai",
      totalCases: 1,
      caseIds: ["x"],
    });
    openCheckpoint(filePath, {
      sessionId: "NEW",
      moduleName: "M",
      language: "zh",
      provider: "openai",
      totalCases: 1,
      caseIds: ["x"],
    });
    const loaded = loadCheckpoint(filePath);
    expect(loaded!.header.sessionId).toBe("NEW");
  });

  it("creates parent directory if missing", () => {
    const filePath = path.join(tmpDir, "nested", "deeper", "f.jsonl");
    openCheckpoint(filePath, {
      sessionId: "S",
      moduleName: "M",
      language: "zh",
      provider: "openai",
      totalCases: 0,
      caseIds: [],
    });
    expect(existsSync(filePath)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run scripts/lib/__tests__/checkpoint.test.ts`
Expected: 失败，文件不存在。

- [ ] **Step 3: 实现 checkpoint 模块**

Create `scripts/lib/checkpoint.ts`:

```ts
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export interface CheckpointHeader {
  type: "header";
  sessionId: string;
  moduleName: string;
  language: string;
  provider: string;
  totalCases: number;
  caseIds: string[];
  startedAt: string;
}

export interface OpenCheckpointParams {
  sessionId: string;
  moduleName: string;
  language: string;
  provider: string;
  totalCases: number;
  caseIds: string[];
}

export interface CheckpointLoadResult {
  header: CheckpointHeader;
  completedCaseIds: Set<string>;
  results: unknown[];
  isComplete: boolean;
  summary?: unknown;
  finishedAt?: string;
}

function ensureDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

export function openCheckpoint(
  filePath: string,
  params: OpenCheckpointParams
): void {
  ensureDir(filePath);
  const header: CheckpointHeader = {
    type: "header",
    sessionId: params.sessionId,
    moduleName: params.moduleName,
    language: params.language,
    provider: params.provider,
    totalCases: params.totalCases,
    caseIds: [...params.caseIds],
    startedAt: new Date().toISOString(),
  };
  writeFileSync(filePath, `${JSON.stringify(header)}\n`);
}

export function appendCheckpointLine(
  filePath: string,
  record: unknown
): void {
  appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

export function finalizeCheckpoint(
  filePath: string,
  summary: unknown
): void {
  appendCheckpointLine(filePath, {
    type: "summary",
    finishedAt: new Date().toISOString(),
    ...(typeof summary === "object" && summary !== null ? summary : { summary }),
  });
}

export function loadCheckpoint(filePath: string): CheckpointLoadResult | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return null;

  let header: CheckpointHeader | null = null;
  const completedCaseIds = new Set<string>();
  const results: unknown[] = [];
  let summary: unknown = undefined;
  let finishedAt: string | undefined;

  for (const line of lines) {
    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      // Corrupted line — ignore (likely a mid-write crash). Stop here.
      break;
    }
    if (record?.type === "header") {
      header = record as CheckpointHeader;
    } else if (record?.type === "case") {
      if (typeof record.id === "string") {
        completedCaseIds.add(record.id);
      }
      results.push(record);
    } else if (record?.type === "summary") {
      summary = record;
      finishedAt = record.finishedAt;
    }
  }

  if (!header) return null;

  return {
    header,
    completedCaseIds,
    results,
    isComplete: summary !== undefined,
    ...(summary !== undefined ? { summary } : {}),
    ...(finishedAt !== undefined ? { finishedAt } : {}),
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run scripts/lib/__tests__/checkpoint.test.ts`
Expected: 7 个测试全过。

---

## Task 4: runner 集成 `forcedSkillStatus` + `executionLocation`

**Files:**
- Modify: `scripts/test-game-interpreter-skill-flow.ts`（`stageCaseState` + `runCase` + imports）

**背景**：把前两个 helper 接进 runner 主流程。

- [ ] **Step 1: 加 imports**

在 `scripts/test-game-interpreter-skill-flow.ts` 顶部 imports 区追加：

```ts
import { buildForcedSkillResult } from "./lib/forcedSkillResult.js";
```

- [ ] **Step 2: 扩展 `stageCaseState` 支持 road/junction**

找到现有 `stageCaseState` 函数（约 `:478`），替换主体：

```ts
function stageCaseState(
  dgsm: DynamicGameStateManager,
  testCase: GameInterpreterSkillFlowCase
): void {
  ensureNpcExists(dgsm, testCase.actorId);
  for (const targetId of testCase.targetIds ?? []) {
    ensureNpcExists(dgsm, targetId);
  }
  if (!dgsm.getScene(testCase.executionSceneId)) {
    throw new Error(`Scene "${testCase.executionSceneId}" is not available`);
  }

  const actorPosition =
    testCase.executionLocation ??
    ({ type: "scene", sceneId: testCase.executionSceneId } as const);

  if (actorPosition.type === "road") {
    const topology = dgsm.getState().townTopology;
    if (!topology?.roads.has(actorPosition.roadId)) {
      throw new Error(`Road "${actorPosition.roadId}" not in topology`);
    }
  } else if (actorPosition.type === "junction") {
    const topology = dgsm.getState().townTopology;
    if (!topology?.junctions.has(actorPosition.junctionId)) {
      throw new Error(`Junction "${actorPosition.junctionId}" not in topology`);
    }
  }

  dgsm.setCharacterPosition(testCase.actorId, actorPosition);

  // Targets always co-located in the execution scene by default.
  for (const targetId of testCase.targetIds ?? []) {
    dgsm.setCharacterPosition(targetId, {
      type: "scene",
      sceneId: testCase.executionSceneId,
    });
  }
}
```

- [ ] **Step 3: 在 `runCase` 里注入 `forcedSkillStatus`**

找到 `runCase` 中 `executeSkillCheck(...)` 调用（约 `:662`）。紧接着的赋值 `result.skillCheck = {...}` 之前插入：

```ts
  const rawSkillResult = executeSkillCheck(
    definition.skillCheck,
    node.characterId,
    node.skill,
    dgsm,
    testCase.executionSceneId,
    registry,
    node.targetCharacterIds
  );

  const skillResult = testCase.forcedSkillStatus
    ? buildForcedSkillResult(testCase.forcedSkillStatus, node.skill)
    : rawSkillResult;
```

并把后续代码里所有 `skillResult` 的旧名（原代码用的是同名变量）保持一致。也就是：把原 `executeSkillCheck` 的返回先命名为 `rawSkillResult`，再根据 fixture 决定用哪个。把原代码中 `const skillResult = executeSkillCheck(...)` 这一处替换为上面两行即可——下面 `result.skillCheck = {...}` 起所有用 `skillResult` 的地方无需改动。

**注意**：原代码里这个变量命名直接就是 `const skillResult = executeSkillCheck(...)`（在 `runCase` 约 `:662`）。整体替换成上述两段赋值。

- [ ] **Step 4: TypeScript 校验**

Run: `pnpm build:tsc`
Expected: 无错误。

- [ ] **Step 5: 加一个探路 fixture 验证 forcedSkillStatus 链路**

编辑 `scripts/fixtures/gameInterpreterSkillFlowCases.ts`，在现有数组末尾（`}`，`]` 之间）加一个临时 case：

```ts
    {
      id: "tmp_forced_fumble_brawling",
      label: "探路：forced fumble",
      actorId: "Bruno Galilei",
      executionSceneId: "SCN_1_SUB_1",
      actionText: "冲上去抱摔接待员",
      expectedSteps: ["brawling"],
      expectedPrimaryDefinitionId: "brawling",
      expectedOutputKeysAnyOf: [],
      forcedSkillStatus: "fumble",
    },
```

- [ ] **Step 6: 用 `--list-cases` 确认新 case 可见**

Run: `pnpm test:game-interpreter-flow -- --list-cases`
Expected: 输出包含 `- tmp_forced_fumble_brawling: 探路：forced fumble`，总数 = 21。

- [ ] **Step 7: 移除探路 fixture**

删除上一步加的 `tmp_forced_fumble_brawling`。Task 7 会在 Group C 里正式加固定 fixture。

---

## Task 5: CLI 加 `--fresh` / `--resume` + checkpoint 集成到 `main`

**Files:**
- Modify: `scripts/test-game-interpreter-skill-flow.ts`（`CliOptions` / `parseArgs` / `main` / helper 函数）

- [ ] **Step 1: 扩展 CliOptions + parseArgs**

在 `scripts/test-game-interpreter-skill-flow.ts` 的 `CliOptions` 接口定义（约 `:37`）加：

```ts
interface CliOptions {
  listCases: boolean;
  help: boolean;
  caseIds: string[];
  reportPath?: string;
  fresh: boolean;
  resumeSessionId?: string;
}
```

在 `parseArgs` 里初始化 `fresh: false`，并在 for 循环里新增两个分支：

```ts
    if (arg === "--fresh") {
      options.fresh = true;
      continue;
    }
    if (arg === "--resume") {
      const raw = argv[i + 1];
      if (!raw) throw new Error("--resume requires a session id");
      options.resumeSessionId = raw;
      i += 1;
      continue;
    }
```

`printHelp` 里也补这两个参数的说明。

- [ ] **Step 2: 加 imports**

顶部追加：

```ts
import {
  appendCheckpointLine,
  finalizeCheckpoint,
  loadCheckpoint,
  openCheckpoint,
} from "./lib/checkpoint.js";
```

并移除原来的 `writeFileSync` / `mkdirSync` / `existsSync` 里和 report 写相关的代码（open/finalize 已替代）。但 `existsSync` 和 `mkdirSync` 可能被别处复用，审慎删除——只删除 main 末尾"generate report JSON"那一段。

- [ ] **Step 3: 重写 main 的执行流程**

把 `main` 中从 `requireRunEnvironment()` 之后、到 `disconnectPrisma` 之前这段替换：

```ts
  requireRunEnvironment();
  const selectedCases = selectCases(options.caseIds);

  // --- checkpoint resume handling ---
  let sessionId = `skill-flow-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let alreadyDone = new Set<string>();
  let priorResults: CaseExecutionResult[] = [];

  if (options.reportPath) {
    const existing = options.fresh
      ? null
      : loadCheckpoint(options.reportPath);

    if (existing && existing.isComplete && !options.fresh) {
      console.log(
        `Session ${existing.header.sessionId} already completed at ${(existing as any).finishedAt ?? "?"}. Re-run with --fresh to overwrite.`
      );
      return;
    }

    if (existing && !existing.isComplete) {
      sessionId = existing.header.sessionId;
      alreadyDone = existing.completedCaseIds;
      priorResults = existing.results as CaseExecutionResult[];
      console.log(
        `Resuming session ${sessionId}: ${alreadyDone.size}/${existing.header.totalCases} already done.`
      );
    } else {
      openCheckpoint(options.reportPath, {
        sessionId,
        moduleName: MODULE_NAME,
        language: LANGUAGE,
        provider: getProviderLabel(),
        totalCases: selectedCases.length,
        caseIds: selectedCases.map((c) => c.id),
      });
    }
  }

  const pendingCases = selectedCases.filter((c) => !alreadyDone.has(c.id));

  console.log(
    `Running ${pendingCases.length} case(s) (of ${selectedCases.length}) against ${MODULE_NAME} with provider=${getProviderLabel()}`
  );

  const { baseSerializedState, registry, runtime } = await initializeBaseState();
  const results: CaseExecutionResult[] = [...priorResults];

  try {
    for (let index = 0; index < pendingCases.length; index += 1) {
      const testCase = pendingCases[index];
      const result = await runCase({
        testCase,
        baseSerializedState,
        registry,
        runtime,
      });
      results.push(result);
      printCaseResult(
        result,
        priorResults.length + index + 1,
        selectedCases.length
      );

      if (options.reportPath) {
        appendCheckpointLine(options.reportPath, { type: "case", ...result });
      }
    }
  } finally {
    await disconnectPrisma();
  }

  const summary = buildSummary(results);
  printSummary(summary);

  if (options.reportPath) {
    finalizeCheckpoint(options.reportPath, summary);
    console.log(`\nCheckpoint/report written to ${options.reportPath}`);
  }
```

（原末尾 `if (options.reportPath) { ... writeFileSync ... }` 一段整个删除。）

- [ ] **Step 4: TypeScript 校验**

Run: `pnpm build:tsc`
Expected: 无错误。

- [ ] **Step 5: 手动 smoke：list-cases 仍然工作**

Run: `pnpm test:game-interpreter-flow -- --list-cases`
Expected: 列出 20 个（还没加新 fixture），不报错。

- [ ] **Step 6: 手动 smoke：--help 显示新参数**

Run: `pnpm test:game-interpreter-flow -- --help`
Expected: 输出包含 `--fresh` 和 `--resume`。

---

## Task 6: 报告 summary 增强（覆盖矩阵）

**Files:**
- Modify: `scripts/test-game-interpreter-skill-flow.ts`（`buildSummary` + `printSummary`）

- [ ] **Step 1: 改 `buildSummary`**

找到现有 `buildSummary`（约 `:812`）。整个函数替换：

```ts
function buildSummary(results: CaseExecutionResult[]): Record<string, unknown> {
  const definitionCounts: Record<string, number> = {};
  const outputKeyCounts: Record<string, number> = {};
  const skillStatusCoverage: Record<string, number> = {
    critical: 0,
    hard: 0,
    regular: 0,
    fail: 0,
    fumble: 0,
  };
  const executionLocationCoverage = { scene: 0, road: 0, junction: 0 };
  const missingCases: string[] = [];
  const expectedOutputKeysByCase = new Map<string, string[]>();

  for (const result of results) {
    const definitionId = result.definition?.id;
    if (definitionId) {
      definitionCounts[definitionId] = (definitionCounts[definitionId] ?? 0) + 1;
    }
    for (const key of result.resolver.outputKeys) {
      outputKeyCounts[key] = (outputKeyCounts[key] ?? 0) + 1;
    }

    const level = result.skillCheck?.successLevel;
    if (level && level in skillStatusCoverage) {
      skillStatusCoverage[level] += 1;
    }

    expectedOutputKeysByCase.set(result.id, result.expectedOutputKeysAnyOf);

    if (
      !result.interpreter.primaryMatch ||
      (result.resolver.ran && !result.resolver.outputKeyMatch)
    ) {
      missingCases.push(result.id);
    }
  }

  // executionLocation counts derived from results via presence of fixture-specific field.
  // We infer by looking at each result's implied environment through testCase metadata.
  // Since buildSummary doesn't currently see the fixture, we accept a simpler approach:
  // downstream callers wanting location coverage should include it in CaseExecutionResult
  // (see next step).
  for (const result of results) {
    const env = (result as CaseExecutionResult & { environment?: "scene" | "road" | "junction" }).environment;
    if (env && env in executionLocationCoverage) {
      (executionLocationCoverage as Record<string, number>)[env] += 1;
    } else {
      executionLocationCoverage.scene += 1;
    }
  }

  const allExpectedKeys = new Set<string>();
  for (const keys of expectedOutputKeysByCase.values()) {
    for (const k of keys) allExpectedKeys.add(k);
  }
  const uncoveredOutputKeys = [...allExpectedKeys].filter(
    (k) => !(k in outputKeyCounts)
  );

  const uncoveredSkillStatuses = Object.entries(skillStatusCoverage)
    .filter(([, n]) => n === 0)
    .map(([k]) => k);

  const primarySelectionPass = results.filter(
    (r) => r.interpreter.primaryMatch
  ).length;
  const fullStepSelectionPass = results.filter(
    (r) => r.interpreter.fullStepMatch
  ).length;
  const resolverRan = results.filter((r) => r.resolver.ran).length;
  const resolverValidationPass = results.filter(
    (r) => !r.resolver.ran || r.resolver.validationPassed
  ).length;
  const applyPass = results.filter((r) => r.applyPassed).length;
  const withErrors = results.filter((r) => r.error).length;

  return {
    totalCases: results.length,
    primarySelectionPass,
    fullStepSelectionPass,
    resolverRan,
    resolverValidationPass,
    applyPass,
    withErrors,
    definitionCounts,
    outputKeyCounts,
    skillStatusCoverage,
    executionLocationCoverage,
    uncoveredSkillStatuses,
    uncoveredOutputKeys,
    expectedVsActual: {
      primaryMatchRate:
        results.length === 0 ? 0 : primarySelectionPass / results.length,
      outputKeyMatchRate:
        results.length === 0
          ? 0
          : results.filter(
              (r) => !r.resolver.ran || r.resolver.outputKeyMatch
            ).length / results.length,
      missingCases,
    },
  };
}
```

- [ ] **Step 2: 在 `CaseExecutionResult` 接口 + `runCase` 里记录 `environment`**

在 `CaseExecutionResult` 接口（约 `:73`）加可选字段：

```ts
interface CaseExecutionResult {
  // ... existing ...
  environment?: "scene" | "road" | "junction";
}
```

在 `runCase` 里构造 `result` 的地方（约 `:595`）加：

```ts
    environment: testCase.executionLocation?.type ?? "scene",
```

加到 `result` 对象字面量里（和 `applyPassed: false` 一起）。

- [ ] **Step 3: 改 `printSummary` 添加覆盖矩阵输出**

在 `printSummary` 末尾（所有现有 console.log 之后）追加：

```ts
  const skillStatusCoverage = summary.skillStatusCoverage as Record<string, number>;
  const executionLocationCoverage = summary.executionLocationCoverage as Record<string, number>;
  const uncoveredSkillStatuses = summary.uncoveredSkillStatuses as string[];
  const uncoveredOutputKeys = summary.uncoveredOutputKeys as string[];
  const expectedVsActual = summary.expectedVsActual as {
    primaryMatchRate: number;
    outputKeyMatchRate: number;
    missingCases: string[];
  };

  console.log("\nCoverage Matrix");
  console.log(
    `- Skill status: ${Object.entries(skillStatusCoverage)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`
  );
  console.log(
    `- Execution location: ${Object.entries(executionLocationCoverage)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")}`
  );
  console.log(
    `- Uncovered skill statuses: ${uncoveredSkillStatuses.length === 0 ? "(none)" : uncoveredSkillStatuses.join(", ")}`
  );
  console.log(
    `- Uncovered output keys: ${uncoveredOutputKeys.length === 0 ? "(none)" : uncoveredOutputKeys.join(", ")}`
  );
  console.log(
    `- Primary match rate: ${(expectedVsActual.primaryMatchRate * 100).toFixed(0)}% | Output key match rate: ${(expectedVsActual.outputKeyMatchRate * 100).toFixed(0)}%`
  );
  if (expectedVsActual.missingCases.length > 0) {
    console.log(`- Mismatch cases: ${expectedVsActual.missingCases.join(", ")}`);
  }
```

- [ ] **Step 4: TypeScript 校验**

Run: `pnpm build:tsc`
Expected: 无错误。

---

## Task 7: 新增 Group C fixtures（skill check 分支锁定，6 case）

**Files:**
- Modify: `scripts/fixtures/gameInterpreterSkillFlowCases.ts`

**说明**：Group C 是纯 `forcedSkillStatus` 合成，不受 LLM 抖动影响，最稳定。先加它验证端到端。

- [ ] **Step 1: 加 6 个 fixture**

在数组末尾 `]` 之前追加一段注释 + 6 个 fixture：

```ts
    // ========== Group C — Skill check branch coverage (forcedSkillStatus) ==========
    {
      id: "branch_critical_perception",
      label: "分支锁定：critical — 大厅线索搜查",
      actorId: "Bruno Galilei",
      executionSceneId: "SCN_1_SUB_1",
      actionText: "仔细观察接待窗口和来访登记表，找有没有被人翻动过的痕迹",
      expectedSteps: ["perception"],
      expectedPrimaryDefinitionId: "perception",
      expectedOutputKeysAnyOf: ["memory.information"],
      forcedSkillStatus: "critical",
      notes: "强制 critical，验证 resolver 的大成功叙事分支",
    },
    {
      id: "branch_hard_locksmith",
      label: "分支锁定：hard — 撬实验室门禁",
      actorId: "Bruno Galilei",
      executionSceneId: "SCN_1_SUB_1",
      actionText: "试着打开通往实验室的电子门禁",
      expectedSteps: ["locksmith"],
      expectedPrimaryDefinitionId: "locksmith",
      expectedOutputKeysAnyOf: ["scene.condition", "item.modify"],
      forcedSkillStatus: "hard",
    },
    {
      id: "branch_regular_research",
      label: "分支锁定：regular — 查维修登记簿",
      actorId: "Marks White",
      executionSceneId: "SCN_12_SUB_1",
      actionText: "翻查维修登记簿，找最近几天谁来送修过钟表",
      expectedSteps: ["research"],
      expectedPrimaryDefinitionId: "research",
      expectedOutputKeysAnyOf: ["memory.information"],
      forcedSkillStatus: "regular",
    },
    {
      id: "branch_fail_psychology",
      label: "分支锁定：fail (partial) — 读人心",
      actorId: "Bruno Galilei",
      targetIds: ["Helen"],
      executionSceneId: "SCN_10_SUB_1",
      actionText: "观察海伦的神色，看她有没有在说谎",
      expectedSteps: ["psychology"],
      expectedPrimaryDefinitionId: "psychology",
      expectedOutputKeysAnyOf: ["memory.information", "relationship.change"],
      forcedSkillStatus: "fail",
      notes: "psychology 的 failBehavior=partial；resolver 应该继续跑，只是渲染失败叙事",
    },
    {
      id: "branch_fail_abort_intimidate",
      label: "分支锁定：fail+abort — 威胁接待员",
      actorId: "Bruno Galilei",
      targetIds: ["Helen"],
      executionSceneId: "SCN_10_SUB_1",
      actionText: "逼问海伦谁最近来过这里",
      expectedSteps: ["intimidate"],
      expectedPrimaryDefinitionId: "intimidate",
      expectedOutputKeysAnyOf: [],
      forcedSkillStatus: "fail",
      notes: "intimidate 的 failBehavior=abort；resolver 应被 runner 跳过，apply 零变化",
    },
    {
      id: "branch_fumble_brawling",
      label: "分支锁定：fumble — 肉搏大失败",
      actorId: "Bruno Galilei",
      targetIds: ["Helen"],
      executionSceneId: "SCN_10_SUB_1",
      actionText: "冲上去抱摔海伦",
      expectedSteps: ["brawling"],
      expectedPrimaryDefinitionId: "brawling",
      expectedOutputKeysAnyOf: [],
      forcedSkillStatus: "fumble",
      notes: "brawling 的 failBehavior=abort；fumble 也走 abort 路径",
    },
```

- [ ] **Step 2: 确认 list-cases 数量**

Run: `pnpm test:game-interpreter-flow -- --list-cases`
Expected: 总数 = 26（20 现有 + 6 新）。

- [ ] **Step 3: smoke 跑一个最便宜的 forced abort case（不需要 resolver，省一次 LLM）**

Run: `pnpm test:game-interpreter-flow -- --case branch_fail_abort_intimidate`
Expected: 输出里 `SkillCheck: failed | level=fail | Forced fail outcome for intimidate (diagnostic)`；`Resolver: skipped (skill_failed_abort)`；summary `Coverage Matrix` 里 `fail=1`，其余 status 为 0。

---

## Task 8: 新增 Group D fixtures（非 scene 执行位置，2 case）

**Files:**
- Modify: `scripts/fixtures/gameInterpreterSkillFlowCases.ts`

- [ ] **Step 1: 探查 Cassandra_zh 里可用的 junction id**

Run: `pnpm tsx -e "import('./src/state/moduleImporter.js').then(async () => { const { getPrismaClient } = await import('./src/shared/agents/memory/database/prismaClient.js'); const { resolveModuleIdByName } = await import('./src/shared/agents/memory/database/moduleScope.js'); const { loadModule } = await import('./src/state/moduleLoader.js'); const { initRuntime } = await import('./src/state/moduleLoader.js'); const prisma = getPrismaClient(); const id = await resolveModuleIdByName('Cassandra_zh'); const m = await loadModule(prisma, id!); const s = initRuntime({ sessionId: 'inspect', moduleData: m, gameDay: 1, timeOfDay: '08:00' }); console.log('junctions:', [...s.townTopology.junctions.keys()].slice(0, 5)); console.log('roads:', [...s.townTopology.roads.keys()].slice(0, 5)); process.exit(0); });"`

Expected: 打印一些 junction / road id。如果 junction 为空，Group D 的 junction case 降级为第二个 road case。

**如果有 junction**: 记下一个 id（下文记作 `JCT_X`）。
**如果没 junction**: 跳过步骤 3 的 junction case，Step 2 里 fixture 数量 = 1 个 road + 1 个 另一条 road。

- [ ] **Step 2: 加 fixture（有 junction 版本）**

在数组末尾追加：

```ts
    // ========== Group D — Non-scene execution location ==========
    {
      id: "env_road_perception",
      label: "环境：road 上观察街景",
      actorId: "Bruno Galilei",
      executionSceneId: "SCN_1_SUB_1",
      actionText: "走在通往焚化厂的路上留心街上有没有异常",
      expectedSteps: ["perception"],
      expectedPrimaryDefinitionId: "perception",
      expectedOutputKeysAnyOf: ["memory.information"],
      executionLocation: { type: "road", roadId: "ROAD_1", position: 0.5 },
    },
    {
      id: "env_junction_listen",
      label: "环境：junction 上偷听",
      actorId: "Helen",
      executionSceneId: "SCN_1_SUB_1",
      actionText: "站在十字路口，听附近有没有人低声交谈",
      expectedSteps: ["listen"],
      expectedPrimaryDefinitionId: "listen",
      expectedOutputKeysAnyOf: ["memory.information"],
      executionLocation: { type: "junction", junctionId: "JCT_X" },
      notes: "junctionId 需替换为 Cassandra_zh 实际存在的 junction",
    },
```

**把 `"JCT_X"` 替换为步骤 1 找到的真实 id**。如果没有 junction，删除这个 case，改成第二个 road case（使用另一个 roadId，比如 ROAD_2）。

- [ ] **Step 3: 确认 list-cases 数量**

Run: `pnpm test:game-interpreter-flow -- --list-cases`
Expected: 28（26 + 2）。

- [ ] **Step 4: smoke 跑一个 road case**

Run: `pnpm test:game-interpreter-flow -- --case env_road_perception`
Expected: 不报错，summary `executionLocationCoverage` 里 `road=1`, `scene=0`, `junction=0`。

---

## Task 9: 新增 Group B fixtures（output key 专项，7 case）

**Files:**
- Modify: `scripts/fixtures/gameInterpreterSkillFlowCases.ts`

**说明**：Group B 依赖 LLM 输出包含特定 output key，具有抖动，但 `expectedOutputKeysAnyOf` 放宽了匹配。

- [ ] **Step 1: 加 7 个 fixture**

在数组末尾追加：

```ts
    // ========== Group B — Output key targeted coverage ==========
    {
      id: "key_character_hp_first_aid",
      label: "output key: character.hp — 急救治伤",
      actorId: "Marks White",
      targetIds: ["Bruno Galilei"],
      executionSceneId: "SCN_12_SUB_1",
      actionText: "给布鲁诺流血的手臂包扎止血",
      expectedSteps: ["first_aid"],
      expectedPrimaryDefinitionId: "first_aid",
      expectedOutputKeysAnyOf: ["character.hp", "character.condition"],
    },
    {
      id: "key_character_san_occult",
      label: "output key: character.san — 研究扭曲蛛网",
      actorId: "Constantine Frollo",
      executionSceneId: "SCN_17_SUB_3",
      actionText: "凑近研究那张诡异的巨网，想看清上面的纹路",
      expectedSteps: ["occult"],
      expectedPrimaryDefinitionId: "occult",
      expectedOutputKeysAnyOf: ["character.san", "memory.information"],
    },
    {
      id: "key_character_condition_medicine",
      label: "output key: character.condition — 用药退烧",
      actorId: "Marks White",
      targetIds: ["Helen"],
      executionSceneId: "SCN_10_SUB_1",
      actionText: "给发烧的海伦喂退烧药",
      expectedSteps: ["medicine"],
      expectedPrimaryDefinitionId: "medicine",
      expectedOutputKeysAnyOf: ["character.condition", "character.hp"],
    },
    {
      id: "key_character_position_stealth",
      label: "output key: character.position — 潜行换位",
      actorId: "Helen",
      executionSceneId: "SCN_1_SUB_1",
      actionText: "悄悄从候诊区挪到走廊尽头不让任何人看见",
      expectedSteps: ["stealth"],
      expectedPrimaryDefinitionId: "stealth",
      expectedOutputKeysAnyOf: ["character.position", "memory.event"],
    },
    {
      id: "key_item_move_pickup",
      label: "output key: item.move — 捡起登记簿",
      actorId: "Bruno Galilei",
      executionSceneId: "SCN_1_SUB_1",
      actionText: "从柜台上把来访登记簿揣进口袋",
      expectedSteps: ["action"],
      expectedPrimaryDefinitionId: "action",
      expectedOutputKeysAnyOf: ["item.move", "memory.event"],
    },
    {
      id: "key_item_destroy_brawling",
      label: "output key: item.destroy — 打碎桌椅",
      actorId: "Bruno Galilei",
      targetIds: ["Helen"],
      executionSceneId: "SCN_10_SUB_1",
      actionText: "挥拳把海伦身边的椅子打碎挡住她逃路",
      expectedSteps: ["brawling"],
      expectedPrimaryDefinitionId: "brawling",
      expectedOutputKeysAnyOf: ["item.destroy", "scene.condition"],
    },
    {
      id: "key_memory_witness_spotting",
      label: "output key: memory.witness — 远距离目睹",
      actorId: "Helen",
      targetIds: ["Bruno Galilei"],
      executionSceneId: "SCN_1_SUB_1",
      actionText: "站在大厅角落，远远看着布鲁诺在窗口做什么",
      expectedSteps: ["spot_hidden"],
      expectedPrimaryDefinitionId: "spot_hidden",
      expectedOutputKeysAnyOf: ["memory.witness", "memory.information"],
      notes: "确认代码里 spot_hidden 是否存在；如无，改用 perception",
    },
```

- [ ] **Step 2: 验证 spot_hidden 是否存在**

Run: `ls src/engine/tool_definitions/skills/ | grep spot_hidden`
Expected: 若文件存在 → 不动。若不存在 → 把 `key_memory_witness_spotting` 的 `expectedSteps` 和 `expectedPrimaryDefinitionId` 从 `spot_hidden` 改成 `perception`。

- [ ] **Step 3: 确认 list-cases 数量**

Run: `pnpm test:game-interpreter-flow -- --list-cases`
Expected: 35（28 + 7）。

---

## Task 10: 新增 Group A fixtures（技能类别代表，12 case）

**Files:**
- Modify: `scripts/fixtures/gameInterpreterSkillFlowCases.ts`

**背景**：spec 原表把 firearms / fast_talk / library_use / spot_hidden 列了进去，但这些 id 在 `src/engine/tool_definitions/skills/` 里不存在。替换映射：

| spec 原意 | 实际用 | 原因 |
|---|---|---|
| firearms | pistol | firearms 在 CoC 7e 被拆成 pistol/rifle/submachine_gun，仓库里是拆开的 |
| fast_talk | bluff | 仓库用 bluff 代替 |
| library_use | law | 学术类代表换成 law（law.md 存在） |
| spot_hidden | archaeology | 学术/观察类换成 archaeology |

最终 12 个 fixture 对应 skill：brawling, pistol, persuade, intimidate, bluff, first_aid, medicine, psychology, psychoanalysis, law, archaeology, track。（部分 skill 与 Group B/C 重复也无所谓——每个 case 的 actionText 不同。）

- [ ] **Step 1: 加 12 个 fixture**

在数组末尾追加：

```ts
    // ========== Group A — Category-representative skills ==========
    {
      id: "combat_brawling_fight",
      label: "战斗：brawling 肉搏",
      actorId: "Bruno Galilei",
      targetIds: ["Helen"],
      executionSceneId: "SCN_10_SUB_1",
      actionText: "揪住海伦按在桌上不让她走",
      expectedSteps: ["brawling"],
      expectedPrimaryDefinitionId: "brawling",
      expectedOutputKeysAnyOf: ["character.hp", "character.condition"],
    },
    {
      id: "combat_pistol_shoot",
      label: "战斗：pistol 开枪",
      actorId: "Bruno Galilei",
      targetIds: ["Helen"],
      executionSceneId: "SCN_10_SUB_1",
      actionText: "拔出左轮对着海伦腿开一枪",
      expectedSteps: ["pistol"],
      expectedPrimaryDefinitionId: "pistol",
      expectedOutputKeysAnyOf: ["character.hp", "character.condition"],
    },
    {
      id: "social_persuade_let_through",
      label: "社交：persuade 让路",
      actorId: "Bruno Galilei",
      targetIds: ["Helen"],
      executionSceneId: "SCN_10_SUB_1",
      actionText: "耐心解释自己身份请海伦让路进后厨",
      expectedSteps: ["persuade"],
      expectedPrimaryDefinitionId: "persuade",
      expectedOutputKeysAnyOf: ["relationship.change", "memory.event"],
    },
    {
      id: "social_intimidate_confess",
      label: "社交：intimidate 逼供",
      actorId: "Bruno Galilei",
      targetIds: ["Helen"],
      executionSceneId: "SCN_10_SUB_1",
      actionText: "拍桌子瞪眼逼问海伦知道多少",
      expectedSteps: ["intimidate"],
      expectedPrimaryDefinitionId: "intimidate",
      expectedOutputKeysAnyOf: ["memory.information", "relationship.change"],
    },
    {
      id: "social_bluff_false_identity",
      label: "社交：bluff 报假身份",
      actorId: "Bruno Galilei",
      targetIds: ["Helen"],
      executionSceneId: "SCN_10_SUB_1",
      actionText: "对海伦谎称自己是卫生局巡查员",
      expectedSteps: ["bluff"],
      expectedPrimaryDefinitionId: "bluff",
      expectedOutputKeysAnyOf: ["memory.event", "relationship.change"],
    },
    {
      id: "medical_first_aid_bleeding",
      label: "医疗：first_aid 止血",
      actorId: "Marks White",
      targetIds: ["Bruno Galilei"],
      executionSceneId: "SCN_12_SUB_1",
      actionText: "撕下衣角给布鲁诺绑紧伤口止血",
      expectedSteps: ["first_aid"],
      expectedPrimaryDefinitionId: "first_aid",
      expectedOutputKeysAnyOf: ["character.hp", "character.condition"],
    },
    {
      id: "medical_medicine_diagnose",
      label: "医疗：medicine 诊断",
      actorId: "Marks White",
      targetIds: ["Helen"],
      executionSceneId: "SCN_10_SUB_1",
      actionText: "给海伦把脉量体温判断她是不是得了什么病",
      expectedSteps: ["medicine"],
      expectedPrimaryDefinitionId: "medicine",
      expectedOutputKeysAnyOf: ["memory.information", "character.condition"],
    },
    {
      id: "medical_psychology_read",
      label: "医疗：psychology 读人心",
      actorId: "Marks White",
      targetIds: ["Helen"],
      executionSceneId: "SCN_10_SUB_1",
      actionText: "观察海伦的表情判断她有没有说谎",
      expectedSteps: ["psychology"],
      expectedPrimaryDefinitionId: "psychology",
      expectedOutputKeysAnyOf: ["memory.information", "relationship.change"],
    },
    {
      id: "academic_psychoanalysis_calm",
      label: "学术：psychoanalysis 安抚",
      actorId: "Marks White",
      targetIds: ["Helen"],
      executionSceneId: "SCN_10_SUB_1",
      actionText: "陪海伦坐下慢慢疏导她的情绪",
      expectedSteps: ["psychoanalysis"],
      expectedPrimaryDefinitionId: "psychoanalysis",
      expectedOutputKeysAnyOf: ["character.san", "relationship.change"],
    },
    {
      id: "academic_law_interpret",
      label: "学术：law 查条款",
      actorId: "Marks White",
      executionSceneId: "SCN_12_SUB_1",
      actionText: "翻查工坊执照看能不能找出对方违规的地方",
      expectedSteps: ["law"],
      expectedPrimaryDefinitionId: "law",
      expectedOutputKeysAnyOf: ["memory.information"],
    },
    {
      id: "academic_archaeology_inspect",
      label: "学术：archaeology 古物辨识",
      actorId: "Constantine Frollo",
      executionSceneId: "SCN_17_SUB_3",
      actionText: "仔细查看祭坛底座的刻痕判断年代",
      expectedSteps: ["archaeology"],
      expectedPrimaryDefinitionId: "archaeology",
      expectedOutputKeysAnyOf: ["memory.information"],
    },
    {
      id: "special_track_footprint",
      label: "特殊：track 追踪足迹",
      actorId: "Constantine Frollo",
      executionSceneId: "SCN_17_SUB_3",
      actionText: "蹲下观察地上的脚印推断对方往哪走了",
      expectedSteps: ["track"],
      expectedPrimaryDefinitionId: "track",
      expectedOutputKeysAnyOf: ["memory.information"],
    },
```

- [ ] **Step 2: 确认 list-cases 数量**

Run: `pnpm test:game-interpreter-flow -- --list-cases`
Expected: **47**（35 + 12）。

- [ ] **Step 3: TypeScript 最终校验**

Run: `pnpm build:tsc`
Expected: 无错误。

---

## Task 11: lint / format

**Files:**
- 全部改动文件

- [ ] **Step 1: biome check**

Run: `pnpm check`
Expected: 无错误，或自动修复后无错误。若有 warning 按项目规范处理。

- [ ] **Step 2: vitest 全量跑一次 scripts 单测**

Run: `npx vitest run scripts`
Expected: `checkpoint.test.ts` + `forcedSkillResult.test.ts` 全过。

---

## Task 12: 端到端 smoke（限量，验证全链路）

**Files:** （无改动，仅运行）

- [ ] **Step 1: 确保环境变量已设置**

检查 `DATABASE_URL` 和 `OPENAI_API_KEY`（或对应 provider key）。

- [ ] **Step 2: 跑一个最便宜的 Group C + 一个 Group D case，触发 checkpoint 写入**

Run: `pnpm test:game-interpreter-flow -- --case branch_fail_abort_intimidate,env_road_perception --report /tmp/skillflow-smoke.jsonl`

Expected:
- 两个 case 都完成；第一个 Resolver skipped，第二个 Resolver ran
- `/tmp/skillflow-smoke.jsonl` 被创建；`head -1` 是 header，最后一行是 summary
- summary 里 `executionLocationCoverage.road >= 1`，`skillStatusCoverage.fail >= 1`

- [ ] **Step 3: 验证"已完成不重跑"**

Run 同一命令第二次：`pnpm test:game-interpreter-flow -- --case branch_fail_abort_intimidate,env_road_perception --report /tmp/skillflow-smoke.jsonl`

Expected: 输出 `Session ... already completed at ...`，不重跑 LLM。

- [ ] **Step 4: 验证 `--fresh` 覆盖**

Run: `pnpm test:game-interpreter-flow -- --case branch_fail_abort_intimidate --report /tmp/skillflow-smoke.jsonl --fresh`

Expected: 覆盖原文件，只跑 1 个 case。

- [ ] **Step 5: 清理**

Run: `rm /tmp/skillflow-smoke.jsonl`

---

## Task 13: （可选）整批跑一次完整 47 case 报告

**Files:** （无改动）

**注意**：此步骤会烧 ~94 次 LLM 调用（每 case interpreter + resolver）。预计耗时 10–20 分钟，成本 $1–3。**仅在用户明确要求时执行**；默认跳过。

- [ ] **Step 1: 跑全量**

Run: `pnpm test:game-interpreter-flow -- --report ./reports/skillflow-$(date +%Y%m%d).jsonl`

Expected: 中途每个 case 写入 checkpoint；全部完成后 summary 打印 Coverage Matrix，所有 5 个 skill status 至少各 1（Group C 保证）。

---

## 变更汇总（提交前用户可审核）

改动清单：

1. `scripts/fixtures/gameInterpreterSkillFlowCases.ts` — 接口 + 47 fixture
2. `scripts/test-game-interpreter-skill-flow.ts` — runner + CLI + checkpoint 集成 + summary 增强
3. `scripts/lib/forcedSkillResult.ts` — 新
4. `scripts/lib/checkpoint.ts` — 新
5. `scripts/lib/__tests__/forcedSkillResult.test.ts` — 新
6. `scripts/lib/__tests__/checkpoint.test.ts` — 新
7. `docs/superpowers/specs/2026-04-16-game-interpreter-skill-flow-harness-design.md` — 已有（spec）
8. `docs/superpowers/plans/2026-04-16-game-interpreter-skill-flow-harness.md` — 已有（本计划）

**不提交**（按用户偏好）：每个任务都不做 `git commit`。所有任务完成后等待用户审核，再一次性 commit。

---

## Self-Review 结果

**Spec coverage**：
- (1) 技能广度 → Task 10（Group A 12 case）
- (2) output key 广度 → Task 9（Group B 7 case）
- (3) skill check 分支 → Task 2 / 4 / 7（helper + 集成 + 6 case）
- (4) 执行环境 → Task 4 / 8（stageCaseState 支持 + 2 case）
- 中断恢复 → Task 3 / 5（checkpoint 模块 + main 集成）
- 报告增强 → Task 6
- 全部覆盖到。

**Placeholder 扫描**：
- `"JCT_X"` — 明确在 Task 8 Step 1/2 标注为需要替换，不是留白
- 无其他 TBD / TODO

**类型一致性**：
- `forcedSkillStatus` 类型在接口（Task 1）、helper 签名（Task 2）、runner 调用（Task 4）、summary 覆盖矩阵（Task 6）、各 fixture（Task 7）统一为 `"critical" | "hard" | "regular" | "fail" | "fumble"`
- `ToolResult.status` 统一为 `"completed" | "failed" | "interrupted"`
- `CharacterPosition.road` 统一为 `{ type: "road"; roadId: string; position: number }`
