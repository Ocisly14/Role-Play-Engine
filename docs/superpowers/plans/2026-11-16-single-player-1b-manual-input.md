# 单人游玩 · 计划 1b：手动模式的输入与关系板 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让手动模式真正可玩：玩家的四种输入（点出口 / 说话 / 行动 / 睡觉）由代码直接构造成 `act` 命令交给引擎；提供出口列表和 `@` 候选列表；加关系板（给遇到过的人起名、写备注、画人与人的连线）。同时拆掉计划 1 留下的队列和翻译接口。

**Architecture:** 新增纯函数模块 `src/player/playerCommands.ts`（输入 → `act` 原始参数）和 `src/player/playerBoard.ts`（关系板的纯数据操作）。控制器对外提供玩家此刻的引用范围（出口、可 `@` 的人和物品），并接收玩家命令，走与 NPC 相同的 `buildActionCommand` 信任边界。Runner 持有关系板状态、记录遇到过的人，对外暴露新方法；路由随之替换。命令里的时长、检定、对抗、路线全部由引擎原有的开始判定决定，代码只填引擎要求行动者给的字段。

**Tech Stack:** TypeScript / Node ≥ 18 / vitest / Express。

**Spec:** `docs/superpowers/specs/2026-11-13-single-player-design.md`（§5.1 手动模式、§5.3、§6、§8）

**承接：** 计划 1（`docs/superpowers/plans/2026-11-13-single-player-1-core-loop.md`）已实现并提交于 `18cf8b93`。本计划在其上修改。

## Global Constraints

- **不自动提交、不自动运行。** 任务步骤里没有 commit 步；`pnpm test` / `pnpm build:tsc` / `pnpm check` 由用户运行，集中在 Task 7。仓库根目录目前没有 `node_modules`，实现者只能靠阅读核对类型。
- **另一个会话正在同一工作区修改 `src/roleSim/npcActionController.ts`、`src/engine/**` 等文件**（wake gate、concealment、Decisions 快速路径）。改控制器时只动玩家相关的代码段，先重新读文件再改，不回退别人的改动。
- **NPC 行为、提示词、工具字节不变。**
- 玩家命令一律经过 `buildActionCommand`（带控制器为玩家记录的 `citationScope`），不给玩家开后门。
- 界面和接口**绝不暴露陌生人的真实 id 或真名**：陌生人一律用 `aliasFor(playerId, realId)` 生成的代号作为 handle，显示文字用 `knownAs` 或 `descriptionIdentifier(profile)`。已认识的人（`isKnownTo`）handle 就是真实 id。
- 时长字段固定填 `1`（引擎的 `resolvedDurationTicks` 才算数，规则见 `engine/rules/world/action-adjudication.md`）。
- 说话命令不带 `skillId`，除非用了非母语（此时 `skillId: "Languages"` + `language`）。行动命令的 `skillId` 只取玩家所选，不替玩家推断。
- 关系板上"人与人之间的连线"只是玩家笔记：存在 `PlayerState`，不写入记忆、不进入任何提示词或引擎。
- 时间字段用 `gameDateTime`；代码与注释英文；测试放在源码旁的 `__tests__/`，`@/` 别名。

## Review Focus

1. **陌生人真名/真实 id 泄露到接口**：`getPlayerView()`、出口与 `@` 列表、关系板节点里，陌生人的 handle 必须是代号、label 必须是描述 → Task 3 测试 `stranger handles are aliases, labels are descriptions`。
2. **`@` 了一个此刻已经不在场的人**：命令照常交给信任边界判定（代号稳定，边界能解析），不能在构造阶段崩溃或悄悄丢掉引用 → Task 2 测试 `unknown handle in text is kept as literal text and reported`；Task 4 测试 `rejected command returns reason and keeps pending`。
3. **给一个人起名后又改名**：`knownAs` 被覆盖为新名字，之前的关系记忆不重复写一份空备注 → Task 5 测试 `renaming overwrites knownAs without a duplicate memory`。
4. **玩家正在走一段长路时点了另一个出口**：新命令替换当前行动（`replacesActionId`），不同时存在两个玩家命令 → Task 4 测试 `a new command replaces the live action`。
5. **托管模式下调用手动命令接口**：拒绝并给出明确错误，不提交 → Task 4 测试 `manual commands are refused in delegated mode`。

---

### Task 1: 拆掉队列与翻译接口

**Files:**
- Modify: `src/player/playerState.ts`、`src/player/__tests__/playerState.test.ts`
- Modify: `src/player/wakeClassifier.ts`、`src/player/__tests__/wakeClassifier.test.ts`
- Modify: `src/player/playerPort.ts`
- Modify: `src/roleSim/npcActionController.ts`（只动玩家分支）、`src/roleSim/__tests__/playerDecide.test.ts`
- Modify: `src/simulation/SimulationRunner.ts`、`src/simulation/__tests__/playerRunner.test.ts`
- Modify: `client/server/simulation/playerController.ts`、`client/server/simulation/routes.ts`

**Interfaces:**
- Removes: `QueueStep`、`PlayerState.queue`、`nextPendingStep`、`runningStep`、`setQueue`、`markRunning`、`markDone`、`dropRunning`；`PlayerStepTranslator`、控制器的 `playerTranslator` 依赖；runner 的 `playerTranslator` / `playerSplitter` 参数、`replacePlayerQueue`、`submitPlayerInput`；`resolvePlayer` 的 `"steps"` 分支；`ManualWakeVerdict` 的 `advanceQueue`；`ManualWakeInput.hasPendingStep`；路由 `PUT /player/queue`、`POST /player/input`。
- Produces:
  ```ts
  // wakeClassifier.ts
  export type ManualWakeVerdict =
    | { kind: "none" }
    | { kind: "pause"; reason: "woken" | "failed" | "idle" };
  // 规则顺序不变，只是"空闲"一律 pause/idle
  ```
  ```ts
  // SimulationRunner
  sendAdvice(text: string): Promise<void>;   // 原 submitPlayerInput 的托管分支，原样搬过来；手动模式下抛 Error("advice is for delegated mode")
  ```
- `isPlayerState` 对仍带 `queue` 字段的旧存档照样返回 true（字段被忽略）；hydrate 时丢掉 `queue`。

- [x] **Step 1: 改测试**
  - `wakeClassifier.test.ts`：删掉 `advanceQueue` 相关用例；"自己这步 completed、无他人事件、空闲" → `pause/idle`；`trace` + completed + 空闲 → `pause/idle`。
  - `playerState.test.ts`：删掉队列用例；新增 `isPlayerState accepts a legacy state with queue`。
  - `playerDecide.test.ts`：删掉翻译器 stub 和所有队列用例；保留"他人 full 事件暂停""trace 不暂停""托管 askFriend""forceWake"等。
  - `playerRunner.test.ts`：删掉 `submitPlayerInput` 手动分支、`replacePlayerQueue`、splitter 用例；托管建议的用例改调 `sendAdvice`；新增 `sendAdvice in manual mode throws`。
- [x] **Step 2: 实现删除**，让上述测试与类型一致。控制器的 `resolvePlayer({kind:"continue"})` 在手动模式下只是什么都不提交（当前行动继续）。
- [x] **Step 3: 路由**：删 `/player/queue`、`/player/input`；新增 `POST /simulation/:id/player/advice { text }` → `sendAdvice`（400 空文本，409 模式不对）。

---

### Task 2: 输入 → `act` 原始参数（纯函数）

**Files:**
- Create: `src/player/playerCommands.ts`
- Test: `src/player/__tests__/playerCommands.test.ts`

**Interfaces:**
- Produces:
  ```ts
  /** Player-facing handle → what the player sees, for the four inputs. */
  export interface MentionLabel { handle: string; label: string; kind: "character" | "item" | "scene" }

  export type PlayerInput =
    | { kind: "move"; to: string }                                   // a place handle from the exits list
    | { kind: "say"; to: string[]; words: string; language?: string } // character handles; language omitted = native
    | { kind: "act"; text: string; skillId?: string }                // text may contain @[handle] tokens
    | { kind: "sleep" };

  export interface BuildInputDeps {
    labels: ReadonlyMap<string, MentionLabel>;  // every handle the player may use right now
    nativeLanguages: readonly string[];
    language: "zh" | "en";                      // module language, for the code-written description
  }

  export type BuildInputResult =
    | { ok: true; rawArgs: Record<string, unknown>; unknownHandles: string[] }
    | { ok: false; reason: string };

  export function buildPlayerActArgs(input: PlayerInput, deps: BuildInputDeps): BuildInputResult;
  export const MENTION_TOKEN: RegExp; // /@\[([^\[\]\s]+)\]/g
  ```
  `rawArgs` 的形状就是 `act` 工具参数（交给 `buildActionCommand`）：`{ description, objectRefs: [{ id }], proposedDurationTicks: 1, skillId?, language?, utterance?, sleep? }`。

- [x] **Step 1: 写测试**（每条一个 `it`）
  1. `move`：`{kind:"move", to:"SCN_main_north"}`，label "主街北口"，`language:"zh"` → `description === "我走向主街北口。"`、`objectRefs === [{id:"SCN_main_north"}]`、`proposedDurationTicks === 1`；`language:"en"` → `"I walk to 主街北口."`。
  2. `move` 到不在 `labels` 里的 handle → `{ ok:false }`，reason 含该 handle。
  3. `say` 给一个人：`utterance` 逐字等于 `words`（首尾空白去掉），`description === "我对柜台后的女人说话。"`，`objectRefs` 是该 handle，无 `skillId`。
  4. `say` 不带对象：`description === "我开口说话。"`，`objectRefs === []`。
  5. `say` 用非母语 `"English"`（`nativeLanguages: ["中文"]`）→ `skillId:"Languages"`、`language:"English"`；用母语或省略 → 两者都不出现。
  6. `say` 空 `words` → `{ ok:false, reason:"empty words" }`。
  7. `act`：`"我用@[ITEM_crowbar]撬开@[item.drawer]"` → `description === "我用撬棍撬开抽屉"`（token 换成 label），`objectRefs` 按出现顺序去重；`skillId` 原样透传，不传则不出现。
  8. `unknown handle in text is kept as literal text and reported`：文本里的 `@[nobody]` 不在 labels → 原样保留 `@[nobody]` 文本、不进 `objectRefs`、出现在 `unknownHandles`，仍 `ok:true`。
  9. `act` 空文本 → `{ ok:false, reason:"empty action" }`。
  10. `sleep` → `sleep:true`、`description` 为 `"我躺下睡觉。"` / `"I lie down to sleep."`、`objectRefs:[]`。
- [x] **Step 2: 实现 `buildPlayerActArgs`**，不读世界状态，只用 `deps`。

---

### Task 3: 出口、`@` 列表与"遇到过的人"

**Files:**
- Modify: `src/roleSim/npcActionController.ts`（新增两个公开方法，不改 NPC 路径）
- Modify: `src/player/playerState.ts`（`met` 字段）
- Modify: `src/simulation/SimulationRunner.ts`、`src/simulation/types.ts`（`PlayerView` 扩展）
- Test: `src/simulation/__tests__/playerOptions.test.ts`

**Interfaces:**
- Consumes: `buildPerceivableDirectory`、`aliasFor`、`isKnownTo`、`knownAs`、`descriptionIdentifier`（`src/state/perceivableDirectory.ts`），`resolvePerceivedLocation(...).adjacentIds`（`src/state/perceivedLocation.ts`），控制器私有的 `citationScopes`。
- Produces:
  ```ts
  // NpcActionController
  /** The scope the player's last decision was built with (what they may point at). */
  playerCitationScope(): CitationScope | undefined;
  // PlayerState
  met: Record<string, string>;   // real character id -> first gameDateTime they appeared in the player's perception
  // SimulationRunner
  getPlayerOptions(): { exits: MentionLabel[]; mentions: MentionLabel[] } | null;
  ```
  `PlayerView` 增加 `options: { exits: MentionLabel[]; mentions: MentionLabel[] }`。
  - `exits`：`resolvePerceivedLocation(玩家位置).adjacentIds`，label 为场景/路的 `name`。
  - `mentions`：`buildPerceivableDirectory(playerId, dgsm, playerCitationScope())` 里的人（handle = `characterHandles` 的键）、物品（含自身背包，label = 物品 `name`）。人的 label：`knownAs(...)`，没有时用陌生人描述。注意 `descriptionIdentifier` 会加英文冠词 `"the "`（给英文渲染器用的），在中文模组里直接拼进 `description` 会变成"我对the 制服熨得……说话"。所以新增 `strangerLabel(profile, language)`（放在 `playerCommands.ts` 旁边，**不改** `descriptionIdentifier`）：`zh` 取 `appearance ?? occupation ?? "陌生人"`，`en` 用 `descriptionIdentifier`。测试 `stranger handles are aliases, labels are descriptions` 用它断言。
  - `met`：每当玩家的一段感知被记录（runner 的 `onPerception` 分支），用 `tagsIn([narrative])` 取出 tag，经同一时刻的 directory `characterHandles` 换成真实 id，首次出现时记下 `gameDateTime`。
  - `isPlayerState` 对缺 `met` 的旧存档返回 true，hydrate 时补 `{}`。

- [x] **Step 1: 写测试**
  - `stranger handles are aliases, labels are descriptions`：玩家和一个陌生人同处一地 → `mentions` 里该人 handle 为 `aliasFor(player, npc)`、label 为 `descriptionIdentifier`，整个 `getPlayerView()` 的 JSON 字符串里不含该 NPC 的真实 id 和 `name`。
  - 设置 `knownAs` 后 → handle 为真实 id、label 为 `knownAs`。
  - `exits` 等于当前地点的相邻地点，label 为地名。
  - 记录一段含 `[stranger_x]` 的感知 → `met` 出现该真实 id；再次出现不改时间。
- [x] **Step 2: 实现。**

---

### Task 4: 提交玩家命令

**Files:**
- Modify: `src/roleSim/npcActionController.ts`（新增 `submitPlayerCommand`，复用现有 `submitDecision`）
- Modify: `src/simulation/SimulationRunner.ts`
- Modify: `client/server/simulation/playerController.ts`、`client/server/simulation/routes.ts`
- Test: `src/simulation/__tests__/playerCommandRunner.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `buildPlayerActArgs`，Task 3 的 `getPlayerOptions` 产出的 labels。
- Produces:
  ```ts
  // NpcActionController
  /** Submit raw act args for the player through the shared trust boundary
   *  (citation scope + replacesActionId). Never retries. */
  submitPlayerCommand(rawArgs: Record<string, unknown>): Promise<{ ok: true; actionId: string } | { ok: false; reason: string }>;
  // SimulationRunner
  submitPlayerCommand(input: PlayerInput): Promise<{ ok: true; unknownHandles: string[] } | { ok: false; reason: string }>;
  ```
  Runner 流程（在 `playerOp` 里）：模式必须是 manual（否则抛 `Error("commands are for manual mode")`）→ 用当下的 options 做 labels → `buildPlayerActArgs` → `controller.submitPlayerCommand` → 成功则清掉 `pending` 并按现有规则恢复世界；失败则 `pending` 不变、返回原因。
  路由：`POST /simulation/:id/player/command { input: PlayerInput }`；`{ok:false}` → 422 `{ error: reason }`；模式不对 → 409。

- [x] **Step 1: 写测试**
  - 暂停等待决策时提交 `move` → 引擎收到一条命令，`pending` 清空，世界恢复。
  - `rejected command returns reason and keeps pending`：`act` 里 `@` 一个边界不认的 handle（不在 scope 里）→ 返回 `{ok:false}`，`pending` 原样，没有命令进收件箱。
  - `a new command replaces the live action`：玩家有进行中的行动时提交新命令 → 命令带 `replacesActionId`。
  - `manual commands are refused in delegated mode`。
  - `sleep` 命令到达引擎时 `command.sleep === true`（与计划 1 的自动存档钩子衔接）。
- [x] **Step 2: 实现。**

---

### Task 5: 关系板

**Files:**
- Create: `src/player/playerBoard.ts`、`src/player/__tests__/playerBoard.test.ts`
- Create: `src/memory/relationshipWrite.ts`（从 `src/roleSim/toolDispatcher.ts` 抽出 relationship 写入，二者共用）
- Modify: `src/roleSim/toolDispatcher.ts`（改为调用共享函数，行为不变）
- Modify: `src/player/playerState.ts`（`boardLinks`）、`src/simulation/SimulationRunner.ts`、`src/simulation/types.ts`
- Modify: `client/server/simulation/playerController.ts`、`client/server/simulation/routes.ts`
- Test: `src/simulation/__tests__/playerBoardRunner.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/memory/relationshipWrite.ts
  export async function writeRelationship(deps: {
    dgsm: DynamicGameStateManager; memory: NpcMemoryManager;
    npcId: string; sessionId: string; moduleId: string; gameDateTime: string; location?: string;
  }, input: { targetRealId: string; content: string; knownAs?: string }): Promise<void>;
  // = 今天 writeMemory 对 relationship 做的两件事：dgsm.updateRelationship(...) + memory.add({type:"relationship", metadata:{targetId,targetName}})

  // src/player/playerBoard.ts
  export interface BoardLink { id: string; a: string; b: string; label: string } // a/b are real ids, never sent raw to the UI
  export function addLink(links: BoardLink[], a: string, b: string, label: string): BoardLink[];
  export function removeLink(links: BoardLink[], id: string): BoardLink[];
  export function linksTouching(links: BoardLink[], realId: string): BoardLink[];

  // PlayerState
  boardLinks: BoardLink[];

  // SimulationRunner
  getPlayerBoard(): { people: Array<{ handle: string; label: string; knownAs?: string; notes: string[]; firstMet: string }>; links: Array<{ id: string; a: string; b: string; label: string }> } | null; // a/b as handles
  namePerson(handle: string, name: string): Promise<void>;
  notePerson(handle: string, note: string): Promise<void>;
  linkPeople(aHandle: string, bHandle: string, label: string): Promise<{ id: string }>;
  unlinkPeople(linkId: string): Promise<void>;
  ```
  - 节点 = `met` 的键 ∪ 玩家关系图里的人。handle 规则同 Task 3。`notes` = 玩家角色对此人的 `relationship` 记忆内容（按时间）。
  - `namePerson`：handle → 真实 id（陌生人用 `aliasFor` 反查，同 `toolDispatcher` 的做法）→ `writeRelationship({ knownAs: name, content: <该人当前的 note 或空串> })`。名字非空。
  - `notePerson`：`writeRelationship({ content: note })`（不改 `knownAs`）。
  - 连线只改 `PlayerState.boardLinks`，不写记忆。
  - 路由：`PUT /player/board/people/:handle/name {name}`、`POST /player/board/people/:handle/notes {note}`、`POST /player/board/links {a,b,label}`、`DELETE /player/board/links/:linkId`；`GET /player` 的视图里带 `board`。
  - 所有操作在 `playerOp` 里执行（与 tick 串行），手动和托管模式都可用。

- [x] **Step 1: 写测试**
  - `playerBoard.test.ts`：`addLink` 生成 id、拒绝 a===b、同一对同一 label 不重复；`removeLink`；`linksTouching`。
  - `namePerson` 给陌生人起名 → `isKnownTo(player, npc)` 为真，`knownAs === name`，`getPlayerOptions().mentions` 里该人 handle 变为真实 id、label 为名字。
  - `renaming overwrites knownAs without a duplicate memory`：先起名再改名 → `knownAs` 为新名；`relationship` 记忆不多出一条空内容的行（空 `content` 时不 `memory.add`，只更新图）。
  - `notePerson` 写一条 relationship 记忆，`knownAs` 不变。
  - 连线不产生任何记忆写入；`getPlayerBoard()` 里连线两端是 handle（陌生人为代号）。
  - `toolDispatcher` 现有的 writeMemory relationship 测试不改即通过。
- [x] **Step 2: 实现。**

---

### Task 6: 规格回写

**Files:**
- Modify: `docs/superpowers/specs/2026-11-13-single-player-design.md` §10 表格（若实现中接口名有变，按实际更新）

- [x] **Step 1:** 对照实现更新 §10 的"玩家输入 → 命令"一行和事件列表；不改需求。

---

### Task 7: 集中验证（由用户运行）

实现补记：选项、提交和关系板的 runner 回归用例集中在 `playerRunner.test.ts`。关系板读取为异步，已有关系但没有初遇记录时 `firstMet` 为 `null`。命名保留已有的关系备注。行动进行中可提交替换命令，上一条命令仍在等待引擎开始时会收到 422。

- [ ] `pnpm install`
- [ ] `pnpm test -- src/player src/roleSim src/simulation src/memory src/engine/actions` → 全部 PASS
- [ ] `pnpm build:tsc` → 无错误
- [ ] `pnpm check` → 无剩余告警
- [ ] （会调用模型，仅用户要求时）`pnpm chat:dev`，注入一个角色：点出口走一段 → 世界暂停在到达处；说话框对柜台的人说一句 → 对方被叫醒回应；关系板给她起名 → 下一段感知里用这个名字称呼她。
