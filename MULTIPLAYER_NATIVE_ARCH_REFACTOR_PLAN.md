# Multiplayer 原生架构改造文档（无 singlePlayerProxy）

> 日期：2026-02-25  
> 目标：彻底移除 `singlePlayerProxy`，将多人链路改为原生 `sceneRoom` 架构；每轮把当前 `sceneRoom` 的全部角色注入模板；LLM 输出不使用 `sceneShared`。

---

## 1. 硬性要求（本次以此为准）

1. 完全删除 `src/dynamicworldagent/multiplayerGraph/singlePlayerProxy.ts` 及所有调用。
2. `multiplayerGraph` 全节点使用原生多人接口（`manager + sceneRoomId`）。
3. 模板注入按 `sceneRoom` 隔离：
   - 只注入当前 `sceneRoom` 的玩家角色 + 当前场景 NPC。
   - 不能混入其他 `sceneRoom` 的玩家输入/状态。
4. LLM 输出契约不使用 `sceneShared`；所有结果直接在顶层字段或按角色数组返回。
5. 场景切分后，新旧 `sceneRoom` 并行推进且互不污染。

---

## 2. 当前问题（针对现有 changes）

1. 图中仍有 `createSinglePlayerProxy(...)` 调用，导致多人语义被压扁为“代表玩家”。
2. `Action/Combat/BattleKeeper` 主路径仍依赖单人 manager 形状。
3. 多个节点仍有“取 `memberPlayerIds[0]` 当代表”的逻辑，不满足“scene 内全角色输入”。
4. `sceneRoomSplitter` 还在走 proxy 方式触发 Director 切场。
5. 当前 `tsc` 存在签名错位，说明“多人原生接口”尚未打通。

---

## 3. 新的 LLM 输入输出契约（无 sceneShared）

## 3.1 输入（每个 sceneRoom 每轮）

```ts
interface SceneRoomRoleInput {
  roleType: "player" | "npc";
  id: string;
  name: string;
  profile: Record<string, unknown>; // 属性/状态/技能/背包/近期行动
  thisRoundInput?: {
    inputType: "input" | "skip";
    content: string;
    selectedSkill: string | null;
    skillSelectionMode: "manual" | "auto";
  };
}

interface SceneRoomRoundPromptInput {
  sceneRoomId: string;
  gameTime: string;
  currentScenario: Record<string, unknown> | null;
  rolesInScene: SceneRoomRoleInput[]; // 当前 scene 全角色
  conversationHistory: Record<string, unknown>[];
  relevantHistory: Record<string, unknown>[];
  playerActionAnalyses: Record<string, unknown>; // orchestrator 结果
}
```

要点：
1. `rolesInScene` 必须覆盖“本 scene 的所有玩家 + scene NPC”。
2. 每个玩家只携带自己的输入；如果玩家选择 `skip`，则不注入该玩家的输入（`thisRoundInput` 省略/为空即可）。

## 3.1.1 Template 注入（按 sceneRoom 隔离，强制约束）

Action/Character/Director/Keeper 的 prompt template 必须只注入当前 `sceneRoomId` 的上下文，并且明确区分“玩家角色集合”和“NPC 集合”，避免“代表玩家/合并玩家”为单个角色的做法。

最低注入字段（建议都以 JSON 字符串注入，便于 template 直接粘贴）：

1. `sceneRoomId`
2. `gameTime`（建议用 `Day N, HH:MM`）
3. `currentScenario`（仅当前 sceneRoom 的 snapshot）
4. `scenePlayersJson`：本 sceneRoom 的所有玩家角色数组（每个玩家一条）
5. `sceneNpcsJson`：本 sceneRoom 当前场景内 NPC 数组
6. `roundInputsJson`：本轮玩家输入数组（仅注入 `inputType: "input"` 的记录；`skip` 不注入）
7. `playerActionAnalysesJson`：Orchestrator 的 per-player 解析结果（按 playerId 索引）
8. `conversationHistoryJson` / `relevantHistoryJson`：同样按 sceneRoom 注入（不要全局混入其他 sceneRoom 的历史）

DB 侧隔离要求（硬性）：
1. `game_turns` 必须新增列 `scene_room_id`（多人写入；单人可为 `NULL`）。
2. `conversationHistory` 必须从 DB 读取最近 N 条 **completed turns**，并且按 `(session_id, scene_room_id)` 过滤，确保不同 sceneRoom 的对话不会互相串台。
3. `relevantHistory`（RAG）检索 query：
   - 单人：用本轮 `characterInput`。
   - 多人：用当前 `sceneRoom` 内所有 `inputType:"input"` 且非空的输入合并（建议按 `CharacterName: content` 逐行拼接）。
4. RAG 返回 turn 条数：原先为 3，统一提升为 **5 条 turn**（actionLog 另外算）。

隔离规则（硬性）：
1. 禁止读取/注入其他 `sceneRoomId` 的 `roundInputs`、`temporaryInfo`、玩家状态、NPC 状态。
2. 同一 `roomId` 下存在多个 sceneRoom 并行推进时，template 注入必须做到“场景内可见、场景外不可见”。
3. 允许共享的仅有“全局时间线/全局触发器/全局知识库”这类明确标注为全局的数据；玩家输入与 scene snapshot 一律不共享。

多人注入说明：
1. `scenePlayersJson` 可能包含多个玩家角色；模板必须按数组循环展示，不可只取 `[0]`。
2. 任何“玩家视角/玩家行动结果/玩家状态更新”的字段，必须能标识到具体玩家（至少包含 `playerId` 或 `characterId`）。

## 3.2 输出（Action 节点）

```ts
interface SceneRoomRoundActionOutput {
  sceneRoomId: string;
  timeElapsedMinutes: number;
  combatUpdate: {
    entersCombat: boolean;
    combatInitiatedBy: "player" | "npc" | null;
    combatParticipantIds: string[];
  };
  sceneChangeRequests: Array<{
    playerId: string;
    shouldChange: boolean;
    targetSceneName: string | null;
    reason: string;
  }>;
  roleResults: Array<{
    roleType: "player" | "npc";
    roleId: string;
    roleName: string;
    actionResult: Record<string, unknown>;
    actionResultDetailed: Record<string, unknown>;
    stateUpdate?: Record<string, unknown>;
    actionLog?: Record<string, unknown>[];
  }>;
  npcResponseAnalyses: Record<string, unknown>[];
}
```

说明：
1. 不使用 `sceneShared`。
2. 公共字段（时间推进、战斗开关）放顶层。
3. 角色结果统一放 `roleResults[]`，每条结果显式带 `roleType + roleId`。
4. **必须包含多个玩家的行动结果**：当 `sceneRoom` 内有多个玩家提交 input 时，`roleResults` 至少要包含每个提交 input 的玩家一条结果。若需要在叙事中体现 `skip` 玩家“无行动/等待”，建议由代码在解析后补齐对应结果（而不是把 `skip` 输入注入 LLM）。

## 3.2.1 Output 对多人模板的约束（Action → Keeper）

Keeper 的 narrative 生成必须可基于 `roleResults[]` 显式反映“本 sceneRoom 多个玩家各自做了什么，结果如何”。因此：

1. `roleResults[].actionResult` 建议包含可读摘要字段（如 `resultText` / `summary`）。
2. `roleResults[].actionLog`（如提供）必须能区分角色来源（按 `roleId`/`characterId`）。
3. 禁止把多个玩家的结果合并成一个“代表玩家”的 actionResult。

---

## 4. 架构改造方案

## 4.1 Graph 层

文件：`src/dynamicworldagent/multiplayerGraph/multiplayerGraph.ts`

改造：
1. 删除 `singlePlayerProxy` import。
2. `entry`：`heartbeatAgent.evaluateTurnStart(manager, sceneRoomId, { db })`。
3. `action`：改为 `actionAgent.processSceneRoomRound(...)`（单次处理当前 sceneRoom）。
4. `character`：`characterAgent.analyzeNPCResponses(manager, sceneRoomId, language)`。
5. `director`：`directorAgent.checkStoryProgression(manager, sceneRoomId)`。
6. `keeper`：`keeperAgent.generateNarrative(combinedInput, manager, sceneRoomId, language, options)`。
7. `combatA/B/battleKeeper`：新增多人原生接口，不再传 proxy。

## 4.2 Scene split 层

文件：`src/dynamicworldagent/multiplayerGraph/sceneRoomSplitter.ts`

改造：
1. 删除 proxy 构造。
2. 直接调用 `directorAgent.handleActionDrivenSceneChange(manager, newSceneRoomId, targetSceneName, reason)`。
3. 保持 split 后 DB 持久化与 WS 广播不变。

## 4.3 Agent 层（重点）

### A. ActionAgent

文件：`src/dynamicworldagent/multiplayerAgent/action/actionAgent.ts`

新增：
1. `processSceneRoomRound(manager, sceneRoomId, roundInputs, language, roundTurnId)`。
2. 组装 `rolesInScene`（scene 玩家 + scene NPC）并统一注入 LLM。
3. 解析 `SceneRoomRoundActionOutput` 后：
   - 批量写 `temporaryInfo.actionResults`
   - 批量写 `temporaryInfo.actionResultsDetailed`
   - 按 `roleId` 应用 `stateUpdate`
   - 应用 `timeElapsedMinutes`
   - 写入 `sceneChangeRequests` / `combatUpdate` / `npcResponseAnalyses`

### B. CharacterAgent

文件：`src/dynamicworldagent/multiplayerAgent/character/characterAgent.ts`

调整：
1. 输入必须包含 scene 全玩家和 scene NPC，而非仅玩家动作结果。
2. 输出继续是 NPC 响应分析，但要可追溯对应角色（建议加 `targetRoleId`/`relatedRoleIds`）。

### C. KeeperAgent

文件：`src/dynamicworldagent/multiplayerAgent/keeper/keeperAgent.ts`

调整：
1. 模板输入新增 `scenePlayersJson` / `sceneNpcsJson` / `roundRoleResultsJson`。
2. narrative 由 sceneRoom 维度统一生成，不走代表玩家模式。

### D. CombatActionAgentA/B + BattleKeeper

文件：
- `src/dynamicworldagent/multiplayerAgent/combat/combatActionAgentA.ts`
- `src/dynamicworldagent/multiplayerAgent/combat/combatActionAgentB.ts`
- `src/dynamicworldagent/multiplayerAgent/combat/battleKeeperAgent.ts`

调整：
1. 新增 `...ForSceneRoom(manager, sceneRoomId, ...)` 原生接口。
2. 战斗上下文注入 scene 全玩家 + 参战 NPC。
3. 输出按 `roleResults[]` 结构返回，不走 proxy。

---

## 5. 状态层要求（sceneRoom 隔离）

文件：`src/dynamicworldagent/multiplayerState/MultiplayerDynamicGameState.ts`

建议新增/明确方法：

```ts
setCurrentActionAnalysis(sceneRoomId: string, action: ActionAnalysis | null): void;
setSceneChangeRequest(sceneRoomId: string, req: SceneChangeRequest | null): void;
setNPCResponseAnalyses(sceneRoomId: string, analyses: NPCResponseAnalysis[]): void;
addActionResultDetail(sceneRoomId: string, detail: Record<string, unknown>): void;
advanceGameTime(elapsedMinutes: number): void;
addFatigueMinutes(playerId: string, elapsedMinutes: number): void;
applyRestForPlayer(playerId: string, restMinutes: number): RestResult;
applyRoleStateUpdate(sceneRoomId: string, roleType: "player"|"npc", roleId: string, update: Record<string, unknown>): void;
```

隔离原则：
1. `temporaryInfo` 仅写当前 `sceneRoom`。
2. `roundInputs` 只消费当前 `sceneRoom` 成员输入。
3. 不允许通过全局字段覆盖其他 `sceneRoom` 的中间态。

---

## 6. 落地顺序（建议）

1. 先删 `singlePlayerProxy` 文件与导出，修 graph 编译。
2. 打通 `action` 节点的多人原生 round 接口（这是核心）。
3. 同步 `character/keeper` 的全角色注入。
4. 再改 `combatA/B/battleKeeper`。
5. 最后改 `sceneRoomSplitter` 走原生 director 调用。

---

## 7. 验收标准

1. 仓库内无 `singlePlayerProxy` 文件和引用。
2. `pnpm build:tsc` 通过。
3. 同一房间两个 `sceneRoom` 并行回合时：
   - 各自只看到本 sceneRoom 角色输入。
   - 各自产生独立 `actionResults/keeperNarrative`。
4. Action LLM 输出中无 `sceneShared` 字段。
5. Keeper narrative 明确可反映“本 sceneRoom 全角色”的行动结果。

---

## 8. 备注

本方案是“原生多人主路径”改造；单人 `dynamicBasic` 路径不改。若后续要提高稳健性，建议在输出 parse 层补 `zod` 校验，按角色粒度容错。
