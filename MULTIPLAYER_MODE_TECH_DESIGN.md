# 多人联机模式技术文档（确认版）

> 日期：2026-02-24  
> 范围：基于现有 DynamicWorld 单人系统，新增可落地的多人联机模式（按你确认的完整规则）

---

## 1. 目标与关键规则

本次多人模式以以下规则为准：

1. 新增一个简单的多人联机窗口（Lobby）。
2. 玩家可创建房间（Room），创建者为房主（Host）。
3. 创建房间时自动生成一个 5 位数字房间码；其他玩家通过填写房间码加入。
4. 房主选择模组。
5. 所有玩家分别选择角色并确认，全部确认后由房主开始游戏。
6. 改写 DGS：不再只注入一个玩家角色，而是注入所有玩家角色。
7. 非战斗轮：每位玩家每轮都必须“输入”或“跳过”；有输入的玩家按当前流程处理。
8. 战斗轮：每位玩家每轮都必须输入（不允许跳过）。
9. 复制并改写现有所有 agent，使其能处理多玩家角色和对应信息。
10. Agent 在生成与玩家相关的信息时必须携带 `playerId`。
11. 场景切换时按角色分组拆分聊天室并独立推进。
12. `actionlog timeline` 基本不改；`target scene snapshot` 需要一次性生成对应角色组的完整 snapshots。
13. 其他玩家可在其房间继续推进；达到休息时间后再将结果注入共享 state。
14. 多人存档采用”全量保存”：仅房主可保存，一次保存包含所有玩家游玩数据，并同步写入所有房间成员的存档库。从存档恢复需房主先建房、成员加入验证后再加载。
15. 休息系统按 `sceneRoom` 强一致：同一场景内所有玩家必须先全员选择”是否休息”，且若休息则必须使用一致的休息时长。
16. Action Agent 在每一轮只生成一个统一 `roundGameTime`（以及统一时间推进量），该轮所有玩家行动结果共享该时间，保证时间线一致。
17. Orchestrator 必须做回合耗时一致性校验：若同轮某玩家行动明确比其他玩家耗时高出 1 小时及以上，则拒绝该轮执行（场景转换需求除外），并返回明确理由。
18. 实施方式必须是”复制后改造”：先复制当前单人实现到 `multiplayer` 命名空间，再在复制品上修改；原单人代码与类型定义禁止改动。
19. 战斗轮与正常战斗轮结构一致（玩家轮次 + NPC 轮次），所有玩家输入收齐后统一注入，攻击目标和行动顺序由 LLM 根据玩家描述自行判断。
20. 任一玩家离线时全员自动退出，不做 AI 接管。如需继续须从存档恢复。
21. 删除单人系统中的 `isSimulatedQuery` / `simulatedQueryCount` 模拟查询机制，多人模式不再使用。
22. 场景图片按 `sceneRoom` 分别生成，不同 sceneRoom 可展示不同场景的图片。

---

## 2. 联机大厅与房间流程

### 2.1 房间创建

1. 玩家点击“创建房间”。
2. 服务端创建 `room`，自动生成 `roomCode`（5 位数字）。
3. 创建者自动成为 `host`，加入房间成员列表。

`roomCode` 规则：

1. 范围：`10000-99999`。
2. 同一时刻对 `status=waiting|ready|playing` 的房间唯一。
3. 冲突重试最多 N 次（建议 10 次）。

### 2.2 房间加入

1. 玩家输入 `roomCode`。
2. 服务端校验房间存在且未锁定。
3. 玩家加入成功后进入房间成员列表。

### 2.3 开局前准备

1. 仅 Host 可选择模组。
2. 每个玩家只能选择并确认一个角色。
3. 所有玩家 `confirmed=true` 后，Host 可点击“开始游戏”。
4. 点击开始后，房间状态切换为 `playing`，初始化多人 DGS。

---

## 3. 数据模型（Prisma）

建议新增以下核心表：

```prisma
enum RoomStatus {
  waiting
  ready
  playing
  finished
  closed
}

enum RoomMemberRole {
  host
  player
}

enum MemberConfirmStatus {
  pending
  confirmed
}

enum RoundInputType {
  input
  skip
}

model MultiplayerRoom {
  roomId         String     @id @map("room_id")
  roomCode       String     @unique @map("room_code") // 5位数字
  hostUserId     String     @map("host_user_id")
  moduleId       String?    @map("module_id") @db.Uuid
  status         RoomStatus @default(waiting)
  createdAt      DateTime   @default(now()) @map("created_at")
  updatedAt      DateTime   @default(now()) @map("updated_at")
  metadata       Json?      @db.JsonB

  members        MultiplayerRoomMember[]
  sceneRooms     MultiplayerSceneRoom[]

  @@index([status])
  @@map("multiplayer_rooms")
}

model MultiplayerRoomMember {
  id                  String              @id
  roomId              String              @map("room_id")
  userId              String              @map("user_id")
  role                RoomMemberRole      @default(player)
  characterId         String?             @map("character_id")
  currentSceneRoomId  String?             @map("current_scene_room_id")
  seatOrder           Int                 @map("seat_order")
  confirmStatus       MemberConfirmStatus @default(pending)
  joinedAt            DateTime            @default(now()) @map("joined_at")

  room           MultiplayerRoom      @relation(fields: [roomId], references: [roomId], onDelete: Cascade)
  user           User                 @relation(fields: [userId], references: [id])
  sceneRoom      MultiplayerSceneRoom? @relation(fields: [currentSceneRoomId], references: [sceneRoomId])

  @@unique([roomId, userId])
  @@unique([roomId, characterId])
  @@index([roomId, seatOrder])
  @@map("multiplayer_room_members")
}

model MultiplayerSceneRoom {
  sceneRoomId        String   @id @map("scene_room_id")
  roomId             String   @map("room_id")
  scenarioId         String?  @map("scenario_id")
  scenarioName       String?  @map("scenario_name")
  snapshotId         String?  @map("snapshot_id")
  snapshotName       String?  @map("snapshot_name")
  status             String   @default("active")
  roundNumber        Int      @default(1) @map("round_number")
  turnCursorSeat     Int      @default(1) @map("turn_cursor_seat")
  createdAt          DateTime @default(now()) @map("created_at")
  updatedAt          DateTime @default(now()) @map("updated_at")

  room               MultiplayerRoom @relation(fields: [roomId], references: [roomId], onDelete: Cascade)
  members            MultiplayerRoomMember[]

  @@index([roomId, status])
  @@index([roomId, scenarioId])
  @@index([roomId, snapshotId])
  @@map("multiplayer_scene_rooms")
}

model MultiplayerRoundInput {
  inputId            String         @id @map("input_id")
  roomId             String         @map("room_id")
  sceneRoomId        String         @map("scene_room_id")
  roundNumber        Int            @map("round_number")
  playerId           String         @map("player_id") // 对应 userId
  characterId        String         @map("character_id")
  inputType          RoundInputType @map("input_type")
  content            String?        @map("content")
  selectedSkill      String?        @map("selected_skill")
  skillSelectionMode String?        @map("skill_selection_mode") // manual | auto
  submittedAt        DateTime       @default(now()) @map("submitted_at")

  @@unique([sceneRoomId, roundNumber, playerId])
  @@index([roomId, sceneRoomId, roundNumber])
  @@map("multiplayer_round_inputs")
}

model MultiplayerCheckpoint {
  checkpointId   String   @id @map("checkpoint_id")
  roomId         String   @map("room_id")
  name           String?
  payload        Json     @db.JsonB // 全量快照（所有玩家 + 所有 sceneRoom + 全局 world state）
  createdBy      String   @map("created_by") // host userId
  createdAt      DateTime @default(now()) @map("created_at")

  members        MultiplayerCheckpointMember[]

  @@index([roomId])
  @@index([createdBy])
  @@map("multiplayer_checkpoints")
}

model MultiplayerCheckpointMember {
  id             String   @id
  checkpointId   String   @map("checkpoint_id")
  userId         String   @map("user_id")
  createdAt      DateTime @default(now()) @map("created_at")

  checkpoint     MultiplayerCheckpoint @relation(fields: [checkpointId], references: [checkpointId], onDelete: Cascade)
  user           User                  @relation(fields: [userId], references: [id])

  @@unique([checkpointId, userId])
  @@index([userId])
  @@map("multiplayer_checkpoint_members")
}
```

说明：

1. 单人 `sessions/game_turns` 保留，不破坏现有逻辑。
2. 多人回合聚合由 `MultiplayerRoundInput` 管理。
3. Agent 产出仍可继续写 `game_turns`，但新增 `playerId` 字段（或 metadata）确保归属。
4. 与现有实现兼容：`game_turns.sceneId` 继续承载 `snapshotId`；`scenarioId` 放入 metadata（或新增字段）单独存储。

---

## 4. DGS 改造（核心）

当前 `DynamicGameState` 的单玩家字段：

1. `playerCharacter`
2. 单输入 `messages + HumanMessage`

多人版需要改为：

```ts
interface MultiplayerPlayerState {
  playerId: string;         // userId
  characterId: string;
  characterName: string;
  profile: DynamicCharacterProfile;
  currentSceneRoomId: string;
  // 玩家维度的疲劳状态（不同玩家行动消耗不同）
  staminaState: {
    minutesSinceLastRest: number;
    fatigueActive: boolean;
    fatigueStartedAtGameTime?: string;
  };
}

interface MultiplayerTurnInput {
  playerId: string;
  characterId: string;
  inputType: "input" | "skip";
  content?: string;
  selectedSkill?: string | null;
  skillSelectionMode?: "manual" | "auto";
}

interface MultiplayerDynamicGameState {
  roomId: string;
  moduleName: string;
  players: Record<string, MultiplayerPlayerState>; // key=playerId
  // ===== 与单人 DynamicGameState 对齐的核心字段（必须保留）=====
  sessionId: string;
  gameDay: number;
  timeOfDay: string;
  scenarioTimeState: {
    sceneStartTime: string;
    // key 为 actionType 字符串（如 "exploration"），与单人语义一致
    playerTimeConsumption: Record<string, { totalShortActions: number; lastActionTime: string }>;
  };
  // 注意：staminaState 已移至 MultiplayerPlayerState（按玩家维度跟踪）
  tension: number;
  isBattle: boolean;
  combatState: CombatState | null;
  defeatedNpcHistory: DefeatedNpcHistoryEntry[];
  heartbeatActions: HeartbeatAction[];
  gameEnding: GameEndingInfo | null;
  keeperGuidance: string | null;
  moduleLimitations: string | null;
  npcCharacters: DynamicNPCProfile[];
  discoveredClues: DiscoveredClue[];
  consecutiveProgressionTriggers: number; // 连续场景推进计数器（max 3），Director 依赖
  moduleDigest: ModuleDigest | null;
  macroScene: MacroSceneStructure | null;
  truthTimeline: TruthEvent[];
  knowledgeMatrix: KnowledgeHolder[];
  redHerrings: RedHerring[];
  mythosEvents: MythosEvent[];
  endState: EndStateDefinition | null;
  scenarioOutlines: ScenarioOutline[];
  revealedTruthEvents: Set<string>;
  activatedKnowledgeHolders: Set<string>;
  deployedRedHerrings: Set<string>;
  mythosRevelations: Set<string>;
  pointOfNoReturnReached: boolean;
  pointOfNoReturnTrigger: string | null;
  updatedDynamicScenarioSnapshots: Map<string, DynamicScenarioSnapshot[]>; // key=scenarioId
  globalTrigger: {
    timeRestriction?: string;
    timeReason?: string;
    events?: string[];
    eventReasons?: string[];
    keeperNotes?: string;
  } | null;
  loadedAt: Date;
  lastUpdated: Date;

  // ===== 多人新增字段 =====
  // room 维度场景指针（每个 sceneRoom 都有自己的 current snapshot 和场景状态）
  sceneRooms: Record<string, {
    sceneRoomId: string;
    scenarioId: string | null;
    scenarioName: string | null;
    snapshotId: string | null;
    snapshotName: string | null;
    currentScenario: DynamicScenarioSnapshot | null; // 当前场景快照对象（对应单人 currentScenario）
    memberPlayerIds: string[];
    roundNumber: number;
    turnsInCurrentScene: number;
    lastPlayerInputTimeByPlayer: Record<string, string | null>;
    temporaryInfo: DynamicTemporaryInfo;
  }>;
  roundInputs: MultiplayerTurnInput[];
  restConsensusBySceneRoom?: Record<string, {
    phase: "idle" | "voting";
    votes: Record<string, { decision: "rest" | "continue"; restHours?: number }>;
    resolvedDecision?: "rest" | "continue";
    resolvedRestHours?: number;
  }>;
}
```

改造原则：

1. 任何玩家相关输出必须携带 `playerId`。
2. DGS 中不再依赖单 `playerCharacter`。
3. 所有玩家角色都在 state 中常驻。
4. 与现有状态保持一致：`currentScenario.id` 视为 `snapshotId`，`scenarioId` 通过场景映射（`scenarioOutlines` / `updatedDynamicScenarioSnapshots` key）定位。
5. 除“单玩家字段改为多玩家字段”外，单人 DGS 的核心字段不删减，避免丢失当前 Agent 依赖上下文（如 stamina/combat/heartbeat/globalTrigger 等）。

### 4.1 单人对照缺失项（本版补齐要求）

与当前单人实现相比，多人设计里必须补齐以下内容（否则会行为退化）：

1. `DynamicTemporaryInfo` 全结构（`rules/contextualData/actionResults/actionResultsDetailed/currentActionAnalysis/npcResponseAnalyses/sceneChangeRequest/previousScenario`）要按 `sceneRoom` 维度保留。
2. `turnsInCurrentScene`、`lastPlayerInputTime` 不能丢；需改为 room/player 维度（已在 `sceneRooms` 中定义）。
3. `scenarioTimeState`、`staminaState`、`combatState`、`heartbeatActions`、`gameEnding` 必须保留，不能只留 players/rooms 骨架。
4. 世界层字段（`moduleDigest/macroScene/truthTimeline/knowledgeMatrix/redHerrings/mythosEvents/endState/globalTrigger`）必须保持与单人一致。
5. 场景历史字段 `updatedDynamicScenarioSnapshots`（key=`scenarioId`）必须完整保留，以兼容 Director 的历史快照读写逻辑。

### 4.2 仍需严格对齐的运行时状态机

以下行为在单人里已存在，多人实现时也必须保持：

1. `requires_skill_selection` 中断语义：当某玩家需要技能选择时，需进入可恢复状态，而不是直接丢弃该玩家输入。
2. `resumeFromInterrupt` 续跑语义：恢复时不可清空该玩家对应的临时分析结果。
3. `temporaryInfo` 清理时机：单人是在 Entry 节点”真实玩家回合开始”时清理；多人需在 `sceneRoom` 回合开始时按同样语义清理。
4. turn 生命周期：`processing -> completed | error | requires_skill_selection` 的状态流转需保留（多人可按 round 或 player 子回合建模）。
5. `thread_id/turnId` 语义：Graph 调用配置里的线程标识需要稳定映射到多人回合（或子回合）ID，便于恢复与审计。

### 4.3 删除 Simulated Query 机制

单人系统中的 `isSimulatedQuery` / `simulatedQueryCount` 机制（Director 触发自动 NPC 行动）在多人模式中**不再使用**，必须完全移除：

1. 多人 Graph 中不保留 `isSimulatedQuery` 路由分支。
2. 多人 DGS 中不包含 `simulatedQueryCount` 字段。
3. NPC 自主行动统一通过 `heartbeat` 机制处理，不再走模拟玩家输入路径。

---

## 5. 回合规则

### 5.1 非战斗轮

每个 `sceneRoom` 的每轮中，所有玩家必须提交其轮输入：

1. `input`：有文本内容。
2. `skip`：跳过本轮。

当房间内所有玩家都提交后，才触发本轮 Agent 执行。

该轮时间规则（强制）：

1. Action Agent 仅产出一个统一 `roundGameTime`。
2. 该轮所有玩家动作结果都写入同一个 `roundGameTime`，不允许同轮内玩家各自生成不同时间。
3. 若需要记录耗时，仅允许一份统一 `roundTimeElapsedMinutes`（轮级别），再应用到共享时间线。

Orchestrator 前置校验（强制）：

1. 在进入 Action Agent 前，先为每个玩家输入产出 `estimatedMinutes`（可区间化）。
2. 若同轮存在“明确超时差”：
   - 条件：某玩家 `estimatedMinutes - 其他玩家主流耗时 >= 60` 分钟
   - 示例：多数玩家是 `social`（短耗时），有玩家声明“睡觉/休息 4H”
3. 满足上述条件时，直接拒绝该轮执行，返回 `round_rejected_time_divergence`。
4. 拒绝返回必须包含可解释理由（中文文案给前端直接展示）。
5. 例外：当该玩家输入属于“场景转换必要动作”（如明确离队前往其他场景并触发分房）时，可跳过该拒绝规则。

注入策略：

1. 对于 `input` 玩家，注入其输入内容。
2. 对于 `skip` 玩家，注入“本轮跳过”标记，不注入行动文本。

单人注入对齐要求（关键）：

1. 单人当前注入项 `message/selectedSkill/skillSelectionMode/language/turnId` 在多人模式必须继续存在，只是从“单玩家一份”变成“每玩家一份输入记录”。
2. 每个玩家输入项都要带：
   - `playerId`
   - `characterId`
   - `content`
   - `selectedSkill`
   - `skillSelectionMode`
3. 回合级仍保留：
   - `roundTurnId`（对应单人 turnId 语义）
   - `language`
   - `resumeFromInterrupt`（技能中断续跑时）
   - `isRestAction`（休息回合）
4. 结论：大部分 DGS/Graph 注入内容保持单人一致，仅把“单玩家输入对象”扩展为“多玩家输入数组”。

### 5.2 战斗轮

战斗轮每个玩家必须输入，不允许 `skip`：

1. 任一玩家未提交时，战斗轮不可结算。
2. 可配置超时机制（后续产品决策），超时前默认等待。

多人战斗轮结构与单人一致，分为玩家轮次和 NPC 轮次：

1. **玩家轮次**：所有玩家都必须提交输入，作为"一轮玩家行动"。所有玩家输入收齐后统一注入到 `combatActionAgentA`，由 LLM 根据玩家描述自行判断攻击目标、技能选择等——不需要在规则层面指定行动顺序或目标分配。
2. **NPC 轮次**：由 `combatActionAgentB` 处理。NPC 的攻击目标选择同样交给 LLM 根据场景上下文自行判断，不做硬编码分配。
3. **结算流程**：`combatActionA`（全体玩家行动）→ `combatEndCheck`（战斗是否结束）→ `combatActionB`（NPC 反击）→ `battleKeeperAgent`（战斗叙事），与单人战斗流水线结构一致。
4. **注入方式**：类似多人非战斗轮，将所有玩家的输入内容按 `playerId` 打包注入，LLM 在同一次推理中处理全部玩家行动。

### 5.3 休息一致性规则（sceneRoom 维度）

同一 `sceneRoom` 内，休息必须全员一致，不允许“部分人休息”：

1. 进入休息决策阶段后，房间内每位玩家都要提交 `decision`：
   - `rest`（并填写 `restHours`）
   - `continue`
2. 若任一玩家选择 `continue`，则本次休息不成立（全员不休息），回到普通回合流程。
3. 仅当所有玩家都选择 `rest` 且 `restHours` 完全一致时，才执行休息结算。
4. 休息结算对该 `sceneRoom` 的所有玩家同时生效（统一推进时间、统一应用恢复与疲劳规则）。
5. 若出现“都选 rest 但时长不一致”，则休息不执行，房间保持在休息决策阶段，直至玩家改为一致。

---

## 6. Agent 改造策略（必须复制并改写）

按你的要求，不走最小适配层，直接复制并改写整套 Agent：

建议新目录（与单人 `dynamicBasicAgent/` 一一对应）：

1. `src/dynamicworldagent/multiplayerAgent/orchestrator/*`
2. `src/dynamicworldagent/multiplayerAgent/memory/*`
3. `src/dynamicworldagent/multiplayerAgent/action/*`
4. `src/dynamicworldagent/multiplayerAgent/character/*`
5. `src/dynamicworldagent/multiplayerAgent/director/*`
6. `src/dynamicworldagent/multiplayerAgent/keeper/*`
7. `src/dynamicworldagent/multiplayerAgent/combat/*`（含 combatActionAgentA/B、battleKeeperAgent）
8. `src/dynamicworldagent/multiplayerAgent/heartbeat/*`（NPC 定时行动 Agent）
9. `src/dynamicworldagent/multiplayerAgent/knowledge/*`（会话检索 Agent）

注意：单人系统没有独立的 `entry/` 目录——Entry 节点逻辑在 `graph/dynamicGraph.ts` 内定义，多人版同样在 `multiplayerGraph/` 中处理。

### 6.1 硬性约束：仅改 `multiplayer` 副本，不改单人原件

为避免单人回归风险，本项目多人实现采用“双轨代码”：

1. 先完整复制单人文件，再改名到 `multiplayer` 命名空间。
2. 多人需求只在 `multiplayer` 副本中修改。
3. 原单人目录、原单人类型、原单人路由/控制器禁止改动（除新增挂载入口、注册路由这类“只增不改”接线代码）。

建议复制范围（与单人一一对应）：

1. `src/dynamicworldagent/dynamicBasicAgent/*` -> `src/dynamicworldagent/multiplayerAgent/*`
   - 包含所有子目录：orchestrator/memory/action/character/director/keeper/combat/heartbeat/knowledge
2. `src/dynamicworldagent/graph/*` -> `src/dynamicworldagent/multiplayerGraph/*`
   - 包含 `dynamicGraph.ts`（Entry 节点、全部路由逻辑、状态机流转）
3. `src/dynamicworldagent/state/*` -> `src/dynamicworldagent/multiplayerState/*`
4. `src/dynamicworldagent/visual/*` -> `src/dynamicworldagent/multiplayerVisual/*`
   - 场景图片/地图生成（多人模式按 sceneRoom 分别生成）
5. `src/shared/state/*` 中多人专用类型 -> `src/shared/state/multiplayer*`
6. `client/server/turn/*` 的多人控制器 -> `client/server/multiplayer/turn/*`
7. `client/server/game/*` 的多人初始化 -> `client/server/multiplayer/game/*`
8. `client/server/checkpoint/*` 的多人存档 -> `client/server/multiplayer/checkpoint/*`

命名约定（示例）：

1. `DynamicGameState` -> `MultiplayerDynamicGameState`
2. `DynamicGraphState` -> `MultiplayerGraphState`
3. `OrchestratorAgent` -> `MultiplayerOrchestratorAgent`
4. `ActionAgent` -> `MultiplayerActionAgent`
5. 其余 Agent/Manager/Template 同步加 `Multiplayer` 前缀

评审门禁（必须满足）：

1. 单人核心目录无功能性 diff（仅允许 import 接线新增）。
2. 多人功能变更全部发生在 `multiplayer` 新目录。
3. 单人回归测试通过（单人接口与流程行为不变）。

每个 Agent 的输入/输出都要多玩家化：

1. 输入带 `roundInputs[]`（含 `playerId`）。
2. 输出带 `actorPlayerId` / `targetPlayerIds`。
3. Action 结果、Clue、状态变化都绑定 `playerId`。
4. Action Agent 必须输出“轮级统一时间”，而不是按玩家分别输出时间。
5. Orchestrator 必须输出回合时间一致性判定结果（通过/拒绝 + 理由 + 是否场景转换例外）。

示例输出结构（统一约定）：

```ts
interface MultiActionResult {
  playerId: string;
  characterId: string;
  actionType: string;
  result: string;
  diceRolls: string[];
  targetScenarioId?: string | null;
  targetSnapshotId?: string | null;
}

interface MultiRoundActionResolution {
  sceneRoomId: string;
  roundNumber: number;
  roundGameTime: string; // 本轮唯一时间戳（游戏内时间）
  roundTimeElapsedMinutes?: number; // 本轮统一推进分钟数
  playerResults: MultiActionResult[];
}

interface MultiRoundValidation {
  status: "passed" | "rejected";
  code?: "round_rejected_time_divergence";
  reason?: string;
  estimatedMinutesByPlayer?: Record<string, number>;
  exemptedBySceneTransition?: boolean;
}
```

---

## 7. 多场景分组与快照策略

### 7.1 场景分组

当本轮结算后，若玩家目标场景不同：

1. 先按 `targetScenarioId` 分组（场景层）。
2. 同一场景内再按 `targetSnapshotId` 分组（快照层）。
3. 每个分组映射到一个 `sceneRoom`（存在则复用，不存在则新建）。
4. 玩家迁移到对应场景房间，房间独立推进。

### 7.2 Snapshot 生成

`target scene snapshot` 改造要求：

1. 不再按单角色生成。
2. 对每个场景分组一次性生成该组“完整 snapshots”（包含该组所有玩家与相关 NPC 状态）。
3. Snapshot 结果回写到 DGS 的 `sceneRooms[sceneRoomId]` 下。

### 7.3 ActionLog Timeline

`actionlog timeline` 保持现有结构为主，仅新增：

1. `playerId`
2. `sceneRoomId`

---

### 7.4 场景图片生成（按 sceneRoom 分别生成）

多人模式下，场景图片和地图按 `sceneRoom` 维度分别生成：

1. 每个 `sceneRoom` 独立触发场景图片生成（`sceneImage`），内容基于该房间的当前场景快照。
2. 地图生成（`mapImage`）同样按 `sceneRoom` 当前场景生成。
3. 不同 `sceneRoom` 可能处于不同场景，因此图片内容不同。
4. 图片生成结果通过 WS 按 `sceneRoom` 广播给对应房间成员。

---

## 8. 玩家离线处理

规则：任一玩家离线，全员自动退出。

1. **检测**：服务端通过 WebSocket 心跳检测玩家连接状态。当某玩家断开连接且超过心跳超时（当前 60 秒），判定为离线。
2. **处理**：一旦检测到任一玩家离线，服务端立即：
   - 向所有在线成员广播 `room_all_exit` 事件（包含离线玩家信息）。
   - 将房间状态设置为 `closed`。
   - 中止当前正在执行的 Graph 调用（如有）。
3. **不做 AI 接管或冻结**：不会自动用 AI 替代离线玩家，也不会冻结其角色。
4. **恢复方式**：如需继续游戏，Host 须创建新房间并从最近的存档恢复（参见 16.4 节）。
5. **建议**：在关键节点（场景切换后、战斗结束后等）提示 Host 保存存档，降低离线导致的进度损失。

---

## 9. 异步推进与”休息时间再注入”

当玩家分组后，不同 `sceneRoom` 可继续各自推进。

规则：

1. 各房间推进产生的玩家局部状态先写入该房间的 pending 更新区。
2. 达到休息时间触发点（或满足统一结算点）时，再将这些局部更新注入共享 state。
3. 注入时按时间戳顺序合并，冲突字段采用”后写覆盖 + 审计日志”策略。
4. 对休息行为，必须先满足 `sceneRoom` 全员一致休息决议，再执行”休息结果注入共享 state”。

---

## 10. API 设计

### 10.1 Lobby / Room

1. `POST /api/multiplayer/rooms/create`
   - 创建房间，返回 `roomId + roomCode`
2. `POST /api/multiplayer/rooms/join`
   - body: `{ roomCode }`
3. `POST /api/multiplayer/rooms/:roomId/select-module`
   - 仅 Host
4. `POST /api/multiplayer/rooms/:roomId/select-character`
5. `POST /api/multiplayer/rooms/:roomId/confirm`
6. `POST /api/multiplayer/rooms/:roomId/start`
   - 仅 Host，且所有成员确认后可执行

### 10.2 Round Input

1. `POST /api/multiplayer/scene-rooms/:sceneRoomId/input`
   - 非战斗：`input|skip`
   - 战斗：仅 `input`
   - body（input）: `{ content, selectedSkill?, skillSelectionMode? }`
   - body（skip）: `{ inputType: "skip" }`
2. `GET /api/multiplayer/scene-rooms/:sceneRoomId/state`
3. `GET /api/multiplayer/rooms/:roomId/overview`

当回合被 Orchestrator 拒绝时，返回：

1. HTTP `409`
2. body:
   - `success: false`
   - `code: "round_rejected_time_divergence"`
   - `reason: string`（必须是可展示文案，说明“同轮时间差过大，请拆分场景或统一行动节奏”）
   - `details.estimatedMinutesByPlayer`（可选，便于前端提示）

### 10.3 Rest Decision（sceneRoom 全员一致）

1. `POST /api/multiplayer/scene-rooms/:sceneRoomId/rest/decision`
   - body: `{ decision: "rest" | "continue", restHours?: number }`
2. `GET /api/multiplayer/scene-rooms/:sceneRoomId/rest/status`
   - 返回当前投票状态与未提交成员。
3. 服务端判定：
   - 全员 `continue` 或存在 `continue` -> 本次休息取消，继续普通流程。
   - 全员 `rest` 且 `restHours` 一致 -> 执行休息结算并广播结果。
   - 全员 `rest` 但时长不一致 -> 维持投票阶段，要求重新选择。

### 10.4 Multiplayer Checkpoint（全量存档，仅房主操作）

1. `POST /api/multiplayer/rooms/:roomId/checkpoints/save`
   - 权限：**仅 Host** 可执行。
   - 行为：保存当前房间的全量状态（所有玩家 + 所有 sceneRoom + 全局 world state）。
   - 写入策略：主存档只生成一份 `multiplayer_checkpoint`，同时为每个成员写一条”可见索引”记录到其存档库。
2. `GET /api/multiplayer/checkpoints/list`
   - 行为：返回当前用户可见的多人存档列表（来自其成员索引）。
   - 仅 Host 的存档列表用于”从存档启动游戏”。
3. `POST /api/multiplayer/rooms/:roomId/checkpoints/:checkpointId/load`
   - 权限：**仅 Host** 可执行。
   - 前置条件：Host 必须已创建房间（`status=waiting`），且所有原存档成员已通过 5 位码加入并通过身份验证。
   - 行为：加载全量多人存档，恢复所有玩家与房间状态，房间状态切换为 `playing`。
   - 验证：加载时校验当前房间成员与存档中的成员一致（userId 匹配）。

**从存档启动游戏的完整流程：**

1. Host 创建房间（获得 5 位码）。
2. 其他玩家通过 5 位码加入房间。
3. 服务端校验加入的玩家身份与存档成员匹配。
4. 全员到齐后，Host 选择存档并执行加载。
5. 加载成功后房间进入 `playing` 状态，跳过选模组/选角步骤。

---

## 11. WebSocket 事件

### 11.1 订阅

1. `subscribe_scene_room`（sceneRoom 维度）
   - 玩家连接后自动订阅其 `currentSceneRoomId` 对应的频道。
   - 场景分组后自动切换订阅到新的 sceneRoom。
   - 房间级事件（如成员加入、游戏开始）通过向该房间所有 sceneRoom 广播实现，无需单独的 room 订阅。

### 11.2 广播

1. `room_member_joined`（向房间所有成员广播）
2. `room_member_confirmed`
3. `room_started`
4. `room_all_exit`（玩家离线触发全员退出通知）
5. `scene_round_input_submitted`
6. `scene_round_ready`
7. `scene_round_resolved`
8. `scene_room_split`
9. `scene_room_merged`（后续可选）
10. `keeper_stream_start/delta/end`（按 sceneRoom 广播）
11. `multiplayer_checkpoint_saved`（通知房主存档成功）
12. `multiplayer_checkpoint_loaded`（全员通知读档成功）
13. `scene_rest_vote_updated`（休息投票变更）
14. `scene_rest_resolved`（休息决议结果：continue/rest + hours）
15. `scene_round_rejected`（回合被拒绝，含拒绝原因与建议）

---

## 12. 前端改造

新增一个简单多人窗口页面：

1. 创建房间（显示 5 位码）
2. 输入 5 位码加入
3. 房间成员列表
4. Host 选模组
5. 玩家选角 + 确认
6. Host 开始游戏

游戏内：

1. SceneRoom 标签切换
2. 当前轮提交区（输入 / skip）
3. 战斗轮强制输入提示
4. 回合完成进度条（当前房间 N/N 已提交）
5. 休息决策面板（全员选择是否休息；若休息则统一选择时长）
6. 回合拒绝提示条（展示 Orchestrator 的拒绝原因与“建议分场景推进”提示）

---

## 13. 实施顺序

### 阶段 1：Lobby 与房间基础

1. Prisma 新表 + migration
2. 创建/加入/确认/开局 API
3. 基础多人窗口 UI

### 阶段 2：DGS 多玩家化

1. 新增 `MultiplayerDGS`
2. 初始化注入所有玩家角色
3. roundInputs 聚合与校验

### 阶段 3：复制并改写 Agent

1. 复制单人 Agent 到 `multiplayerAgent` 目录
2. 全链路改造为多玩家输入输出
3. 输出结构统一携带 `playerId`

### 阶段 4：分场景与快照

1. 按目标场景分组
2. 多 sceneRoom 独立推进
3. 多角色完整 snapshot 生成

### 阶段 5：稳定性与回归

1. 压测（多人并发提交）
2. 玩家离线自动全员退出流程验证
3. 边界场景（战斗轮缺输入、全员离线、存档恢复成员校验）

---

## 14. 测试验收标准

1. 5 位房间码创建/加入流程稳定。
2. 只有 Host 能选模组与开始游戏。
3. 所有人确认后才能开始。
4. 开局后 DGS 中包含全部玩家角色。
5. 非战斗轮每玩家可 input/skip，且每轮必须全员提交后才结算。
6. 战斗轮全员必须 input，不允许 skip。
7. Agent 输出中所有玩家相关信息都带 `playerId`。
8. 场景切换会按角色分组形成多 sceneRoom。
9. 每个目标场景一次性生成对应角色组完整 snapshots。
10. `actionlog timeline` 可继续使用，新增 `playerId/sceneRoomId` 可追踪。
11. 其他房间正常推进，休息时间触发后可正确注入共享 state。
12. 多人存档为全量保存，仅房主可保存，且每次保存后所有成员在各自存档库都能看到同一份存档记录。
13. 从存档恢复需房主先建房、原成员加入验证后由房主加载，可完整恢复所有玩家状态、所有 sceneRoom 状态与全局世界状态。
14. 同一 `sceneRoom` 的休息必须全员一致；不允许出现部分玩家休息、部分玩家继续。
15. 全员 `rest` 但休息时长不一致时，不执行休息且必须重新达成一致。
16. 每一轮只存在一个统一 `roundGameTime`，该轮所有玩家 action 记录时间一致。
17. 当同轮耗时差达到 1 小时及以上且非场景转换需求时，回合必须被拒绝并返回明确理由。
18. 场景转换例外路径可正常执行，并在审计日志标记 `exemptedBySceneTransition=true`。
19. 任一玩家离线后，全员自动退出，房间状态变为 `closed`。
20. 不存在 `isSimulatedQuery` / `simulatedQueryCount` 相关逻辑，多人 Graph 中无模拟查询路径。
21. 战斗轮结构与单人一致（玩家轮次 + NPC 轮次），所有玩家输入统一注入，LLM 自行判断行动顺序和目标。
22. 每个 `sceneRoom` 独立生成场景图片，不同 sceneRoom 展示不同场景的图片。

---

## 15. 影响文件清单（实现入口）

后端：

1. `prisma/schema.prisma`（新增 6 张多人表 + 2 张存档表）
2. `client/server/websocket/WebSocketManager.ts`（sceneRoom 订阅 + 离线检测）
3. `client/server/websocket/notifier.ts`（新增多人广播事件）
4. 新增 `client/server/multiplayer/*`（routes/controller/service）
   - `turn/`（多人回合控制器）
   - `game/`（多人游戏初始化）
   - `checkpoint/`（全量存档 + 成员存档索引 + 从存档恢复流程）
5. `client/server/core/ServerState.ts`（新增 multiplayer runtime 索引）
6. 新增 `src/dynamicworldagent/multiplayerState/*`（MultiplayerDynamicGameState）
7. 新增 `src/dynamicworldagent/multiplayerAgent/*`（复制并改写全 Agent，含 combat/heartbeat/knowledge）
8. 新增 `src/dynamicworldagent/multiplayerGraph/*`（多人 Graph 流水线，删除 simulatedQuery 路径）
9. 新增 `src/dynamicworldagent/multiplayerVisual/*`（按 sceneRoom 生成场景图片）

前端：

1. 新增多人 Lobby 页面与组件
2. `client/src/contexts/GameSessionContext.tsx`（扩展多人会话状态）
3. `client/src/hooks/useWebSocket.ts`（按 room/sceneRoom 订阅）
4. `client/src/components/GameChat.tsx`（支持全员轮输入与 sceneRoom 切换）

---

## 16. 多人存档策略（新增确认）

### 16.1 保存语义

多人模式只支持”全量保存”，且**仅房主可触发保存**：

1. 一次保存必须覆盖：
   - 所有玩家角色状态
   - 所有 sceneRoom 的回合状态与场景状态
   - 全局 DGS/world state
2. 保存结果只生成一个逻辑存档实体（同一份内容）。
3. 只有 Host 有保存权限，其他玩家不能主动保存。

### 16.2 存档分发到所有成员

为满足”保存在所有人存档库里”，采用”主存档 + 成员索引”：

1. 主表：`multiplayer_checkpoints`
   - 存放完整快照 payload（唯一内容源）。
   - 记录 `createdBy`（host userId）。
2. 索引表：`multiplayer_checkpoint_members`
   - 每个成员一条可见记录（`userId/checkpointId`）。
3. 列表查询按成员索引查，保证每个玩家都能在自己的存档库看到同一份多人存档。
4. 仅 Host 的存档列表用于”从存档启动游戏”功能。

### 16.3 一致性要求

1. 保存操作使用单事务：
   - 写主存档
   - 批量写所有成员索引
2. 任一写入失败则整体回滚，避免”有人看到存档、有人看不到”的不一致。
3. 存档成功后通过 WS 向房间全员广播 `multiplayer_checkpoint_saved`。

### 16.4 从存档启动

从存档恢复游戏不是”直接加载”，而是需要重新组建房间：

1. Host 先创建新房间。
2. 原存档中的其他成员通过 5 位码加入。
3. 服务端校验加入成员的 userId 与存档成员列表匹配。
4. 全员到齐后 Host 选择存档执行加载，跳过选模组/选角流程，直接进入 `playing`。
5. 加载时恢复全量状态：所有玩家角色、所有 sceneRoom、全局 world state。

---

## 17. 结论

该版本方案已经按你定义的流程收敛为”强约束多人实现路线”：

1. 5 位房间码 + Host 房间流程
2. DGS 全玩家注入（含按玩家维度的 staminaState）
3. 非战斗全员 input/skip、战斗全员 input（战斗结构与单人一致，LLM 自行判断目标和顺序）
4. 复制并改写所有 Agent（含 combat/heartbeat/knowledge），并统一 `playerId` 输出
5. 按角色分组场景拆分与多角色完整 snapshot 生成
6. 其他玩家继续推进，休息时间点再注入共享 state
7. 多人存档采用全量保存（仅房主操作），从存档恢复需重新建房 + 成员验证
8. 休息系统采用 sceneRoom 全员一致决议，且休息时长必须一致
9. 任一玩家离线全员自动退出，不做 AI 接管
10. 删除 simulatedQuery 机制，多人模式不使用
11. 场景图片按 sceneRoom 分别生成
