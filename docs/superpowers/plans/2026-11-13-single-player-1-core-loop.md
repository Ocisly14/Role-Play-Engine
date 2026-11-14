# 单人游玩 · 计划 1：玩家核心循环（后端） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让一个注入的玩家角色在现有模拟里跑起来：手动模式下由玩家下指令（含队列），托管模式下由角色自己决定、需要时向玩家"朋友"请教；世界在需要玩家时暂停并持久化等待状态；记录走过的地方供地图使用；死亡与睡觉分别发出暂停与自动存档信号。

**Architecture:** 新建 `src/player/`，放纯逻辑（玩家状态、叫醒分类、到访记录、指令拆分）。`NpcActionController.decide()` 对玩家角色分流到新的 `decidePlayer()`，通过一个窄端口 `PlayerPort` 读写玩家状态、请求暂停。`SimulationRunner` 持有玩家状态（存进运行时快照的 `_player` 键），对外暴露玩家操作方法，并由新的 HTTP 路由和 WebSocket 事件接到前端。NPC 的提示词、工具和行为一律不变。

**Tech Stack:** TypeScript / Node ≥ 18 / vitest / Express。沿用 `src/models` 的 `generateToolCalls`。

**Spec:** `docs/superpowers/specs/2026-11-13-single-player-design.md`

**本计划是四个子计划中的第一个**（后三个待写，都依赖本计划）：
- 计划 2：角色创建（完整档案、快速生成、点数上限、入镇入口）
- 计划 3：游玩界面（布局 v3、手绘探索地图、角色标签页、存读档界面）
- 计划 4：桌面化（Electron、SQLite、BYO key 设置向导、去网站部件、去 embedding、存档快照与读档、托盘与通知、token 用量）

## Global Constraints

- **不自动提交。** 全部改动最后合成**一次**提交，且只在用户明确说提交时才提交。任务步骤里没有 commit 步。
- **不自动运行。** 所有 `pnpm test` / `pnpm build:tsc` / `pnpm check` 命令写明命令和期望输出，由用户运行（或用户明确说"跑"时再跑）。验证集中放在 Task 8。任何会调用模型的脚本（`pnpm chat`、`test:agent-decisions`、`prompt:budget` 等）只有用户明确要求才跑。
- 只为算法逻辑写单测（Task 1、2 的纯函数、Task 5/6 的分流与持久化行为）；纯类型、薄委托不写测试。
- **NPC 一字不变：** `SYSTEM_PROMPT`、`AGENT_TOOLS`、`actTool` 的字节内容不改；玩家专用的工具和文档放进新的常量。
- 时间一律用 `gameDateTime`（ISO 字符串），不引入拆分的日期/时间字段。
- 不引入中央调度器或每日计划；玩家队列是角色本人的计划，引擎每次只收到一个行动。
- 信任边界照常检查玩家指令；手动模式**不做**"角色知不知道"的检查（spec §5.1）。
- 新测试放在源码旁的 `__tests__/`，用 `@/` 别名。
- 代码与标识符、注释用英文；提示词正文用英文（与现有 `*Doc` 一致）。
- 若 `2026-11-13-decisions-api-fast-paths-design.md` 已落地：玩家角色不走其中任何跳过渲染/决策的快速路径。

## Review Focus

1. **等待玩家时退出程序**：重启后必须仍停在同一个待定决策/提问上，不能丢、不能自动继续 → Task 6 测试 `pending survives save/hydrate`。
2. **tick 正在执行时玩家提交输入**：不能和本 tick 的决策并发提交两个命令；要等本 tick 结束再处理 → Task 6 测试 `input during tick waits for tick end`。
3. **队列走到一半角色死亡**：不再推进队列，待定状态是 `dead`，之后任何输入都被拒绝 → Task 6 测试 `death clears queue and blocks input`。
4. **等待朋友回话时切到手动模式**：待定提问应转成待定决策，不能永远挂着一个没人回答的问题 → Task 6 测试 `mode switch converts consult to decision`。
5. **天气/脚本事件（`sourceActionIds` 为空）以 `full` 送达玩家**：必须暂停，不能因为"空集合 ⊆ 自己的行动"被当成自己的结果 → Task 2 测试 `feature event with no source actions pauses`。

---

### Task 1: 玩家状态与到访记录（纯逻辑）

**Files:**
- Create: `src/player/playerState.ts`
- Create: `src/player/visitedMap.ts`
- Test: `src/player/__tests__/playerState.test.ts`
- Test: `src/player/__tests__/visitedMap.test.ts`

**Interfaces:**
- Produces（`playerState.ts`）:
  ```ts
  export const PLAYER_STATE_KEY = "_player";
  export type PlayerMode = "manual" | "delegated";
  export interface QueueStep {
    id: string;            // short random hex, like commandId
    text: string;          // player's words for this one step
    status: "pending" | "running" | "done";
    actionId?: string;     // engine action id once submitted
  }
  export type PlayerPending =
    | { kind: "decision"; since: string; reason: "woken" | "failed" | "idle" | "rejected"; rejection?: string }
    | { kind: "consult"; since: string; question: string }
    | { kind: "dead"; since: string };
  export interface FriendNote { gameDateTime: string; question?: string; answer: string }
  export interface PlayerState {
    characterId: string;
    mode: PlayerMode;
    queue: QueueStep[];
    pending: PlayerPending | null;
    visited: VisitedMap;               // from visitedMap.ts
    friendLog: FriendNote[];           // oldest first
    forceWake: boolean;                // delegated: proactive advice waiting to be read
  }
  export function createPlayerState(characterId: string): PlayerState; // mode "manual"
  export function nextPendingStep(s: PlayerState): QueueStep | undefined;
  export function runningStep(s: PlayerState): QueueStep | undefined;
  export function setQueue(s: PlayerState, texts: string[]): PlayerState;      // replaces every non-done step
  export function markRunning(s: PlayerState, stepId: string, actionId: string): PlayerState;
  export function markDone(s: PlayerState, actionId: string): PlayerState;    // no-op if no step has it
  export function dropRunning(s: PlayerState): PlayerState;                    // failed/interrupted step is abandoned
  export function switchMode(s: PlayerState, mode: PlayerMode): PlayerState;
  export function isPlayerState(v: unknown): v is PlayerState;                 // shape guard for hydrate
  ```
  所有函数不改入参，返回新对象。
- Produces（`visitedMap.ts`）:
  ```ts
  export interface VisitedMap {
    scenes: Record<string, string>;   // sceneId -> first arrival gameDateTime
    roads: Record<string, string>;    // roadId  -> first full traversal gameDateTime
    lastSceneId?: string;
    roadEntry?: { roadId: string; fromSceneId: string };
  }
  export interface VisitTopology {
    road(id: string): { endpointA: string; endpointB: string } | null;
    roadsBetween(a: string, b: string): string[];
  }
  export function emptyVisited(): VisitedMap;
  export function recordPosition(
    v: VisitedMap, pos: CharacterPosition | null, topo: VisitTopology, gameDateTime: string
  ): VisitedMap;   // returns the same object reference when nothing changed
  ```
  `CharacterPosition` 来自 `src/state/topologyTypes.ts`。

- [ ] **Step 1: 写 `playerState.test.ts`**

  - `createPlayerState("p1")` → `mode === "manual"`、`queue` 为空、`pending === null`、`forceWake === false`、`visited` 等于 `emptyVisited()`。
  - `setQueue(s, ["去图书馆", "查旧报纸"])` → 两个 `pending` 步骤，文本保持原样；已 `done` 的步骤保留在前面，`pending`/`running` 的被替换。
  - `markRunning` 之后 `runningStep(s).actionId === "a1"`；`markDone(s, "a1")` 后该步 `status === "done"`，`nextPendingStep` 是下一步。
  - `dropRunning` 把 running 步骤从队列移除，其余不变。
  - `switchMode(s, "delegated")`：清空所有非 done 步骤；`pending.kind === "consult"` 时切到 `"manual"` 会变成 `{ kind: "decision", reason: "woken", since: <原 since> }`（Review Focus 4 的纯逻辑部分）。
  - `isPlayerState` 对 `createPlayerState` 的结果为 true，对 `{}`、`null`、缺 `visited` 的对象为 false。

- [ ] **Step 2: 写 `visitedMap.test.ts`**

  用一个手写的 `VisitTopology`：路 `R1`（A–B）、`R2`（B–C）、`R3`（A–C）。
  - 站在场景 A → `scenes.A === t0`、`lastSceneId === "A"`；再次站在 A，时间不覆盖。
  - A → 在 `R1` 上 → B：`roads.R1` 被记上，`roadEntry` 清空，`scenes.B` 被记上。
  - A → `R1` → 回到 A：`roads` 不记 `R1`。
  - A → `R1` → 直接到 `R2`（同一 tick 跨过节点 B）：记 `R1`、记 `scenes.B`，`roadEntry = { roadId: "R2", fromSceneId: "B" }`。
  - A 直接跳到 B（没观察到路上位置），`roadsBetween("A","B")` 只有 `R1` → 记 `R1`；有两条路连接时不记任何路。
  - 从路边室内场景 `I`（不是 `R1` 的端点）走上 `R1` 再到 B → 记 `scenes.B`，**不记** `R1`（不是完整走完）。
  - `pos === null` → 返回同一个对象引用。

- [ ] **Step 3: 运行，确认失败**

  Run: `pnpm test -- src/player/__tests__`
  Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现两个文件**

  `recordPosition` 规则即上面的测试；"同一 tick 跨节点"只处理两条路共享一个端点的情况。

- [ ] **Step 5: 运行，确认通过**

  Run: `pnpm test -- src/player/__tests__`
  Expected: PASS

---

### Task 2: 手动模式叫醒分类（纯逻辑）

**Files:**
- Create: `src/player/wakeClassifier.ts`
- Test: `src/player/__tests__/wakeClassifier.test.ts`

**Interfaces:**
- Consumes: `Occurrence`、`ActionTransition`（`src/engine/actions/types.ts`）
- Produces:
  ```ts
  export interface ManualWakeInput {
    playerId: string;
    occurrences: ReadonlyArray<Occurrence>;      // only rows listing the player as perceiver
    transitions: ReadonlyArray<ActionTransition>; // only the player's own, this tick
    ownActionIds: ReadonlySet<string>;           // player's transitioned + live action ids
    hasLiveAction: boolean;                      // after this tick's transitions
    hasPendingStep: boolean;
  }
  export type ManualWakeVerdict =
    | { kind: "none" }
    | { kind: "advanceQueue" }
    | { kind: "pause"; reason: "woken" | "failed" | "idle" };
  export function classifyManualWake(input: ManualWakeInput): ManualWakeVerdict;
  ```

- [ ] **Step 1: 写测试**（按优先级排列；每条一个 `it`）

  1. 自己的 transition `to: "failed"` / `"interrupted"` / `"cancelled"` → `pause/failed`，即使队列还有下一步。
  2. 别人造成的 occurrence（`sourceActionIds` 含非自己的 id），玩家的 clarity 为 `full` → `pause/woken`；`limited` 同样。
  3. **只有** `trace` 级的别人 occurrence，玩家仍有进行中的行动 → `none`。
  4. `trace` 级别人 occurrence + 自己这步 `completed` + 队列有下一步 → `advanceQueue`。
  5. 只有自己行动的结果 occurrence（`sourceActionIds ⊆ ownActionIds`，clarity `full`）+ `completed` + 有下一步 → `advanceQueue`。
  6. `feature event with no source actions pauses`：`sourceActionIds: []`，clarity `full` → `pause/woken`。
  7. 没有进行中的行动、队列为空 → `pause/idle`。
  8. 进行中、什么都没发生 → `none`。

- [ ] **Step 2: 运行，确认失败**

  Run: `pnpm test -- src/player/__tests__/wakeClassifier.test.ts`
  Expected: FAIL

- [ ] **Step 3: 实现 `classifyManualWake`**

  判定顺序：失败类 transition → 非 trace 的他人 occurrence（`sourceActionIds` 为空或含非自己 id 都算他人）→ 空闲时有下一步则 `advanceQueue`、否则 `pause/idle` → `none`。

- [ ] **Step 4: 运行，确认通过**

  Run: 同上
  Expected: PASS

---

### Task 3: 玩家专用的工具、提示词和命令字段

**Files:**
- Create: `src/roleSim/tools/askFriend.ts`（`askFriendTool: ToolSpec`、`askFriendDoc: string`）
- Create: `src/roleSim/tools/playerDirective.ts`（`playerDirectiveDoc: string`、`sleepFieldDoc: string`）
- Modify: `src/roleSim/tools/schemas.ts`（新增 `playerActTool`、`PLAYER_MANUAL_TOOLS`、`PLAYER_DELEGATED_TOOLS`；`actTool`、`AGENT_TOOLS` 不动）
- Modify: `src/roleSim/systemPrompt.ts`（新增 `PLAYER_SYSTEM_PROMPT`；`SYSTEM_PROMPT` 不动）
- Modify: `src/roleSim/agent.ts`（`RoleSimContext.player?`、`RoleSimDecision` 新增 `askFriend`、act 的 `sleep?`）
- Modify: `src/roleSim/llmAgent.ts`（按 `ctx.player` 选系统提示和工具；解析 `askFriend` 和 `sleep`）
- Modify: `src/roleSim/toolDispatcher.ts`（`TERMINAL_TOOLS`、`VALID_TOOLS` 加 `askFriend`）
- Modify: `src/roleSim/userPromptBuilder.ts`（`ctx.player` 存在时追加一段，放在最后一个可缓存断点之后）
- Modify: `src/engine/actions/types.ts`（`ActionCommand.sleep?: boolean`）
- Modify: `src/engine/actions/commandValidator.ts`、`commandBuilder.ts`（接受并透传可选布尔 `sleep`）
- Test: `src/roleSim/__tests__/playerTools.test.ts`
- Test: 在现有 `src/engine/actions/__tests__/` 的 validator/builder 测试文件里各加一条（找对应文件；没有就新建 `commandSleepFlag.test.ts`）

**Interfaces:**
- Produces:
  ```ts
  // agent.ts
  RoleSimContext.player?: {
    mode: PlayerMode;
    directive?: string;          // manual: the one step the character must carry out
    friendLog?: ReadonlyArray<FriendNote>;  // delegated: what the friend has said, oldest first
  };
  RoleSimDecision |= { tool: "askFriend"; question: string };
  // act variant gains: sleep?: boolean
  ```
  `llmAgent.decideNext(ctx)` 的签名不变。规则：`ctx.player?.mode === "manual"` → `PLAYER_SYSTEM_PROMPT` + `PLAYER_MANUAL_TOOLS`（playerAct、continue、writeMemory）；`"delegated"` → `PLAYER_SYSTEM_PROMPT` + `PLAYER_DELEGATED_TOOLS`（playerAct、continue、writeMemory、askFriend）；没有 `player` → 原样。
- `playerActTool` = `actTool` 的深拷贝，`inputSchema.properties` 多一个 `sleep: { type: "boolean", description: … }`，`name` 仍是 `"act"`。

- [ ] **Step 1: 写测试**

  - `SYSTEM_PROMPT` 不含 `"askFriend"`，`AGENT_TOOLS` 的工具名仍是 `["act","continue","writeMemory"]`，`actTool.inputSchema.properties` 没有 `sleep`。
  - `PLAYER_DELEGATED_TOOLS` 含 `askFriend`，`PLAYER_MANUAL_TOOLS` 不含；两者的 act 都有 `sleep`。
  - `PLAYER_SYSTEM_PROMPT.startsWith(SYSTEM_PROMPT)`（复用 NPC 的前缀，附加玩家段落）。
  - `buildUserPromptSegments` 在 `ctx.player.directive = "去图书馆"` 时，最后一段包含该文本；没有 `player` 时输出与改动前逐字相同（用现有 `userPromptBuilder.test.ts` 的 fixture 做快照对比）。
  - validator：`sleep: true` 通过并出现在结果里；`sleep: "yes"` 被拒（reason 用现有 reject 码中最接近的一个，或新增 `invalid_sleep`）；builder 把 `sleep` 拷到 `ActionCommand`，不传则字段不存在。
  - `llmAgentToolLoop.test.ts` 的 stub 模式：模型返回 `askFriend({question:"要告诉他吗？"})` → decision `{ tool: "askFriend", question: "要告诉他吗？" }`。

- [ ] **Step 2: 运行，确认失败**

  Run: `pnpm test -- src/roleSim src/engine/actions`
  Expected: 新增用例 FAIL，其余 PASS

- [ ] **Step 3: 实现**

  提示词要求（英文写，放进 `*Doc` 常量）：
  - `playerDirectiveDoc`：当上下文给出 *Your decision* 时，这是你本人已经决定的一步。只把它变成**一个** `act`：挑引用、估时长、选技能；若是出行，在 `description` 里用地名写清整条路线。不评判、不替换、不拒绝；即使你不认得路，也按这句话去走。可以照常用 `writeMemory` 记下刚得知的名字或路。
  - `askFriendDoc`：你有一个不在这里的朋友，只有你能和他说话，别人看不见他。遇到**你自己**觉得重要、拿不准的事，可以 `askFriend` 用自己的口吻问他；他的话只是建议，最后由你决定。小事不要问。已经问过、他回答了的事，不要再问同一件。
  - `sleepFieldDoc`：只有当这个行动就是去睡觉（入睡、躺下过夜）时才设 `sleep: true`。
  - userPromptBuilder 的玩家段落：manual 时写 `Your decision: <directive>`；delegated 时把 `friendLog` 列为 `Your friend said (at <gameDateTime>): <answer>`，有 question 时先列问题。spec §5.2 说"这次对话进入角色的感知流"：在角色的提示词里，就由这一段 `friendLog` 承担（它同样是追加式、整份注入）；界面上把它和感知段落按时间穿插显示，那是计划 3 的事。

- [ ] **Step 4: 运行，确认通过**

  Run: 同上
  Expected: PASS

---

### Task 4: 把一串话拆成步骤

**Files:**
- Create: `src/player/splitInstruction.ts`
- Test: `src/player/__tests__/splitInstruction.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function splitInstruction(text: string, opts: { language: string }): Promise<string[]>;
  ```
  一次 `generateToolCalls`，`ModelClass.SMALL`，`toolChoice: "any"`，唯一工具 `submit_steps`（strict，`{ steps: string[] }`，`minItems: 1`），`operation: "player-split-instruction"`。

- [ ] **Step 1: 写测试**（用 `vi.mock("@/models/index.js")` 打桩 `generateToolCalls`）

  - 模型返回 `{ steps: ["去图书馆", "查旧报纸", "回旅馆"] }` → 原样返回。
  - 模型抛错 / 返回空数组 / 返回非字符串元素 → 返回 `[text.trim()]`。
  - `text` 为空白 → 抛 `Error("empty instruction")`，不调用模型。

- [ ] **Step 2: 运行，确认失败** — Run: `pnpm test -- src/player/__tests__/splitInstruction.test.ts` · Expected: FAIL

- [ ] **Step 3: 实现**

  系统提示要求：按发生顺序拆成玩家原话里的各个独立步骤；只拆不增删、不改写意图；单一步骤就返回一个元素；保持原语言。

- [ ] **Step 4: 运行，确认通过** — Expected: PASS

---

### Task 5: 控制器分流 `decidePlayer`

**Files:**
- Create: `src/player/playerPort.ts`
- Modify: `src/roleSim/npcActionController.ts`
- Test: `src/roleSim/__tests__/playerDecide.test.ts`（参照 `occurrenceRouting.test.ts` 的搭法：stub agent、stub renderer、`makeIntegrationEngine`）

**Interfaces:**
- Produces（`playerPort.ts`）:
  ```ts
  export interface PlayerPort {
    playerId(): string | null;
    get(): PlayerState;
    set(next: PlayerState): void;
    /** Record what the player must answer and ask the runner to pause after this tick. */
    requestPause(pending: PlayerPending): void;
  }
  ```
- Modify `NpcActionControllerDeps`：`player?: PlayerPort`。
- Modify `DecideOpts`：`transitions?: ActionTransition[]`（该角色本 tick 的 transitions）。
- New controller methods:
  ```ts
  /** Called by the runner while paused, after the player answered. Never renders. */
  async resolvePlayer(input:
    | { kind: "continue" }
    | { kind: "steps" }                  // queue already replaced via PlayerPort.set
    | { kind: "advice" }                 // delegated: friendLog already appended
  ): Promise<void>;
  ```
  private：`decidePlayer(npcId, opts)`、`submitPlayerStep(npcId, ctx, step)`、`buildContextFromHistory(npcId)`（与 `buildContext` 相同，但 `perception` 取 `perceptionHistory` 最后一条，不调用 renderer；历史为空时退回 `buildContext`）。

- [ ] **Step 1: 写测试**

  公共搭法：玩家 `p1`，`PlayerPort` 用内存对象实现，记录 `requestPause` 调用。
  1. manual，`p1` 的步骤 `completed`、队列有下一步、无他人 occurrence → agent 收到的 ctx 里 `player.directive === 下一步文本`，引擎收到命令，`requestPause` 未调用，队列下一步变 `running` 且带 `actionId`。
  2. manual，他人 occurrence `full` → `requestPause({kind:"decision", reason:"woken"})`，agent **未**被调用。
  3. manual，只有 `trace` 他人 occurrence 且在忙 → 不暂停、agent 未调用，但 perception 被记录（`onPerception` 收到一条）。
  4. manual，翻译出的命令被边界拒绝两次 → `requestPause({kind:"decision", reason:"rejected", rejection: <reason>})`，running 步骤被丢弃。
  5. manual，agent 对 directive 返回 `continue` 而不是 `act` → `requestPause` 的 `reason: "rejected"`。
  6. delegated，agent 返回 `askFriend` → `requestPause({kind:"consult", question})`，没有命令提交。
  7. delegated，agent 返回 `act` → 走与 NPC 相同的提交路径；`requestPause` 未调用。
  8. `forceWake: true` 的 delegated 玩家即使在忙且无 occurrence，本 tick 也会被 decide，之后 `forceWake` 置回 false。
  9. NPC（非玩家）的 decide 行为与改动前一致：现有 `occurrenceRouting.test.ts`、`decideConcurrency.test.ts` 不改即通过。

- [ ] **Step 2: 运行，确认失败** — Run: `pnpm test -- src/roleSim/__tests__/playerDecide.test.ts` · Expected: FAIL

- [ ] **Step 3: 实现**

  - `processTickReport`：把每个角色本 tick 的 transitions 放进 `DecideOpts.transitions`；`player.get().forceWake` 为真时把玩家加入 targets。
  - `decide()`：开头若 `npcId === player?.playerId()` → `return this.decidePlayer(npcId, opts)`；玩家已死直接返回（死亡由 runner 处理）。
  - 把现有"build → submit → 拒绝重试一次"抽成私有 `submitDecision(npcId, ctx, decision): Promise<{ ok: true; actionId: string } | { ok: false; reason: string }>`，NPC 与玩家共用；NPC 路径的日志与行为保持不变。
  - `decidePlayer`：先 `buildContext`（会渲染并记录 perception）；本 tick 有 `completed` 的玩家 transition → `markDone`；有失败类 transition → `dropRunning`。manual → `classifyManualWake`；delegated → 带 `player: { mode, friendLog }` 调 agent。
  - 不对玩家调用 `memoryConsolidator` 以外的任何新代写逻辑（consolidation 与 compaction 沿用，二者都是角色本人的判断）。

- [ ] **Step 4: 运行，确认通过** — Run: `pnpm test -- src/roleSim` · Expected: PASS

---

### Task 6: Runner 接入：状态持久化、暂停原因、死亡、睡觉、到访

**Files:**
- Modify: `src/simulation/SimulationRunner.ts`
- Modify: `src/simulation/types.ts`（新事件类型）
- Test: `src/simulation/__tests__/playerRunner.test.ts`

**Interfaces:**
- Consumes: Task 1–5 的全部导出。
- Produces（`SimulationRunner` 新公开方法）:
  ```ts
  getPlayerView(): PlayerView | null;
  submitPlayerInput(text: string): Promise<void>;
  continuePlayer(): Promise<void>;
  answerFriend(text: string): Promise<void>;
  setPlayerMode(mode: PlayerMode): Promise<void>;
  replacePlayerQueue(steps: string[]): Promise<void>;
  editPlayerMemory(op:
    | { op: "add"; type: NpcMemoryType; content: string }
    | { op: "replace"; memoryId: string; content: string }
    | { op: "delete"; memoryId: string }): Promise<void>;
  ```
  ```ts
  export interface PlayerView {
    state: PlayerState;
    alive: boolean;
    currentAction: { description: string; progressMinutes: number; resolvedDurationTicks?: number } | null;
    perceptions: Array<{ gameDateTime: string; location: string; narrative: string }>; // whole stream
    paused: boolean;
  }
  ```
  构造参数新增 `onAutosaveRequested?: (info: { characterId: string; gameDateTime: string; sceneId: string }) => Promise<void>`（计划 4 实现存档；这里默认 no-op）。
  新事件类型（`SimulationEventType`）：`"player_perceived" | "player_pending" | "player_state" | "player_map_updated" | "player_autosave_requested" | "player_died"`。`player_perceived` **要广播**（只有玩家一个人，不会刷屏），`npc_perceived` 仍不广播。

- [ ] **Step 1: 写测试**（用 `makeIntegrationEngine` 或 runner 的现有测试搭法；模型调用全部打桩）

  1. `pending survives save/hydrate`：设 `pending = consult` → `saveRuntime()` → 用持久化结果新建 runner 并 `hydrateFromRuntime` → `getPlayerView().state.pending` 相同，runner 处于 `paused`。
  2. 玩家决策触发 `requestPause` → 本 tick 结束后 `state === "paused"`，发出 `player_pending` 事件。
  3. `continuePlayer()` 在等待决策时 → `pending` 清空、runner 回到 running；若暂停是玩家手动按的（`pause()`），回应后保持 paused。
  4. `input during tick waits for tick end`：`tickInProgress` 时调用 `submitPlayerInput` → 直到当前 tick 完成才调用 `controller.resolvePlayer`；期间不会出现两条玩家命令。
  5. `death clears queue and blocks input`：玩家 `isNpcAlive` 变 false → `pending.kind === "dead"`、队列清空、发 `player_died`、runner paused；之后 `submitPlayerInput` 抛 `Error("player is dead")`。
  6. `mode switch converts consult to decision`：等待 consult 时 `setPlayerMode("manual")` → `pending.kind === "decision"`。
  7. 睡觉：玩家某行动 transition 到 `active` 且 `command.sleep === true` → 本 tick `saveRuntime` 之后调用一次 `onAutosaveRequested`，并发 `player_autosave_requested`；`sleep` 未设不触发。
  8. 到访：tick 前后玩家从 A 走到 B → `state.visited` 按 Task 1 规则更新，发 `player_map_updated`；没变化不发。
  9. 暂停再恢复不跳钟：`pause()` → 等待 → `resume()` → 下一 tick 后 `gameDateTime` 只比暂停时多 1 分钟（`syncRealTime: true`）。
  10. `injectCharacter` 在已有玩家时抛 `Error("a player character already exists")`；首次注入后 `getPlayerView()` 非 null、`mode === "manual"`。

- [ ] **Step 2: 运行，确认失败** — Run: `pnpm test -- src/simulation/__tests__/playerRunner.test.ts` · Expected: FAIL

- [ ] **Step 3: 实现**

  - 玩家状态：`saveRuntime` 写入 `gameState[PLAYER_STATE_KEY]`；`hydrateFromRuntime` 新增参数 `persistedPlayerState?: unknown`，`isPlayerState` 通过才采用；`injectCharacter` 创建它。
  - `PlayerPort` 由 runner 实现，`requestPause` 设 `pending` 并 `shouldPause = true`、记 `pauseReason = "player"`；`pause()` 记 `pauseReason = "manual"`。
  - 所有玩家操作先 `await this.tickIdle()`（新私有方法：`tickInProgress` 时等当前 tick 的 promise），再改状态、调 `controller.resolvePlayer`，最后仅当 `pauseReason === "player"` 时 `start()`。
  - `submitPlayerInput`：manual → `splitInstruction` → `setQueue` → `resolvePlayer({kind:"steps"})`；delegated → 若在等 consult，作为回答（同 `answerFriend`），否则 `friendLog` 追加 `{answer}`、`forceWake = true`，不暂停也不恢复。
  - `answerFriend`：`friendLog` 追加 `{question, answer}`，清 `pending`，`resolvePlayer({kind:"advice"})`。
  - `editPlayerMemory`：`memoryManager.add` / `reviseOwn` / `retractOwn`，`npcId = 玩家`，`sessionId` 照旧。
  - 死亡：`checkDerivedEvents` 发现新死者是玩家时设 `pending dead`、清队列、`shouldPause`。
  - 睡觉与到访：在 `wireEngineEvents` 的 `tickCompleted` 里暂存 report；`executeTick` 在 `saveRuntime()` 之后检查玩家 transitions（需 `tickEngine.getAction(id)` 或等价方法拿到 `command.sleep`；若无此查询方法，在 TickEngine 上加一个只读 `getAction(id): EngineAction | undefined`），并在 `engine.tick()` 之后调用 `recordPosition`（`VisitTopology` 由 `dgsm.getRoad` 和 `dgsm.getTopology().sceneToRoads` 实现）。
  - `onPerception` 中 `npcId === 玩家` 时额外立即广播 `player_perceived`。

- [ ] **Step 4: 运行，确认通过** — Run: `pnpm test -- src/simulation` · Expected: PASS

---

### Task 7: HTTP 路由与 WebSocket

**Files:**
- Create: `client/server/simulation/playerController.ts`
- Modify: `client/server/simulation/routes.ts`
- Modify: WebSocket 广播处（`wireEventListener` 所在文件，确认新事件类型被转发）

**Interfaces:**
- Consumes: Task 6 的 runner 方法；runner 查找沿用 `simulationService.getRunner(prisma, req.params.id)`（见 `characterController.ts`）。
- Produces（全部挂在 `simulation` 路由模块里，与现有路由同一鉴权层级）:
  | Method | Path | Body | 调用 |
  |---|---|---|---|
  | GET | `/simulation/:id/player` | — | `getPlayerView()`；无玩家返回 404 |
  | POST | `/simulation/:id/player/input` | `{ text: string }` | `submitPlayerInput` |
  | POST | `/simulation/:id/player/continue` | — | `continuePlayer` |
  | POST | `/simulation/:id/player/answer` | `{ text: string }` | `answerFriend` |
  | PUT | `/simulation/:id/player/mode` | `{ mode: "manual" \| "delegated" }` | `setPlayerMode` |
  | PUT | `/simulation/:id/player/queue` | `{ steps: string[] }` | `replacePlayerQueue` |
  | POST | `/simulation/:id/player/memories` | `editPlayerMemory` 的 op 对象 | `editPlayerMemory` |

  请求体校验失败返回 400 `{ error }`；runner 抛出的 `"player is dead"` 返回 409。成功返回 `{ success: true, player: getPlayerView() }`。

- [ ] **Step 1: 实现路由与控制器**（薄委托，不写单测）
- [ ] **Step 2: 确认 WebSocket 转发** — 在 `wireEventListener` 的广播路径里，`player_*` 事件全部转发；`npc_perceived`、`npc_perception_compacted` 仍不转发。

---

### Task 8: 集中验证（由用户运行）

- [ ] **Step 1: 单测** — Run: `pnpm test` · Expected: 全部 PASS，新增文件 `src/player/__tests__/*`、`playerTools`、`playerDecide`、`playerRunner` 均在列。
- [ ] **Step 2: 类型检查** — Run: `pnpm build:tsc` · Expected: 无错误。
- [ ] **Step 3: lint/format** — Run: `pnpm check` · Expected: 无剩余告警。
- [ ] **Step 4: 提示词开销（会调用模型，仅用户要求时跑）** — Run: `pnpm prompt:budget` · Expected: NPC 各块数值与改动前相同；记录玩家段落新增的 token 数。
- [ ] **Step 5: 手动冒烟（会调用模型，仅用户要求时跑）** — `pnpm chat:dev`，用现有 `POST /simulation/:id/characters` 注入一个角色，依次验证：手动输入一串话 → 队列逐步执行；他人对玩家说话 → 暂停并出现 `player_pending`；切托管 → 角色自行行动；退出进程再启动 → 停在同一待定状态。
