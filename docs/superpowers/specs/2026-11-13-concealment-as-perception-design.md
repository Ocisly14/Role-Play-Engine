# 隐藏不是属性：把「藏起来」改成「还没被注意到」（讨论稿）

> 状态：**讨论中，未定稿**。标「已定」的是讨论里确认过的；标「提议」的是起草时补的，尚未确认。
> 关联：[2026-11-13-decisions-api-fast-paths-design.md](2026-11-13-decisions-api-fast-paths-design.md)（第二层感知判断、候选路线都依赖那份设计里的 Decisions 客户端）。

## 1. 核心想法（已定）

隐藏不是物品的属性。东西或暗门就在那里，只是还没被谁注意到。被发现时，变化的要么是**人的认知**（他知道了），要么是**物体本身的状态**（夹层被划开、书架被推开）。两种变化都会留下痕迹，所以之后不需要再判断「有没有被发现过」：角色用合理的方法去拿、去开、去穿过，引擎照常判断能不能成。

## 2. 现状与问题

**现在的做法**
- 物品带 `hidden`；通道带 `hidden` 和 `discoveredBy`（[types.ts:272](../../../src/state/types.ts)）。
- `resolvePerceivedLocation`（`src/state/perceivedLocation.ts`）是感知侧唯一的关卡：隐藏物品不进场景列表；隐藏通道只对 `discoveredBy` 里的人出现。`perceivableDirectory` 同样过滤 `hidden` 物品。
- 加载器（`moduleSchemaV2.ts` 约 726 行）：非隐藏物品必须在描述里被引用一次，隐藏物品和隐藏通道的目标不许被引用。
- 引擎看得到全部隐藏状态；变化由结算 LLM 写：`set hidden`、`connectionHidden`、`connectionDiscovered`。脚本事件有 `connection.setHidden`。
- grayhaven 里有 7 处 `hidden: true`：3 处在场景文件、4 处在 NPC 随身物品。

**问题**
1. **秘密是相对于人的，物品却只有一个对全世界的开关。** 汽车旅馆 4 号房的「行李箱夹层」对所有人隐藏，包括把东西藏进去的人，他自己也引用不了。Tommy 的雪茄盒在身上时他能用；藏到床垫下就成了带 `hidden` 的场景物品，他自己也引用不了。
2. **私下发现表达不了。** 搜到夹层的人，要么 `hidden:false` 全屋公开，要么自己也看不到、拿不到。规则里写着「私下知道不等于对全场揭示」，但物品没有机制支撑。
3. **被人告知不算数。** 不在 `discoveredBy` 里，就看不到、走不了。
4. **作者没法写发现条件**，全靠 LLM 从描述里推。
5. **移动不检查通道是否隐藏。** `placesAdjacent`（`movementRuntime.ts:129`）不看 `hidden` / `discoveredBy`，而路线的每一段都靠它判断相邻。现在挡住角色穿过没发现的暗门的，只有开始判定 LLM 提取路线这一道。

## 3. 目标 / 非目标 / 反目标

**目标**
- 世界里不再有「对谁隐藏」的状态；只保留物体自身的物理状态。
- 私下发现、被人告知、自己藏的东西，都能表达。
- 移动不会让人无意中穿过没注意到的通道。

**非目标**
- 不给模块作者加「发现条件」字段（难度、所需技能）。东西本身的描述就是条件，由引擎判断。
- 不替角色维护「见过的东西」索引。

**反目标**
- 没被注意到的东西出现在角色的感知或可引用集合里（泄密）。
- 角色凭猜出来的 id 指着一个从没给他看过的物品或地点，边界照样放行。
- 角色引用了自己确实见过、记得的东西，却被边界拒绝。
- 只说「去厨房」的人穿过了他不知道的暗门。

## 4. 方案对比（已定）

| 问题 | 选项 | 选择 |
|---|---|---|
| 隐藏是什么 | 世界属性（`hidden` / `discoveredBy`）/ **感知问题：没被注意到** | 感知问题 |
| 「知道它」怎么来 | **由感知流和记忆里出现过的 tag 推出**（压缩掉、没写进记忆就忘了）/ 代码维护一份永不遗忘的「见过的东西」索引（等于替角色记事，违背「记忆只由角色自己写」） | 前者 |
| 通道 | 去掉一切状态 / **保留一个物理状态：是否暴露在外** | 保留物理状态 |

通道为什么要保留状态：通道不能被引用，描述里引用的是它通向的地点；而加载规则允许两条通道通向同一地点（一明一暗），只看「地点被引用了」分不出暗门有没有暴露。「书架挡着」还是「已被推开」是门本身的物理状态，不是「对谁隐藏」。

## 5. 设计

### 5.1 物品（已定）

- 去掉 `hidden`。
- **明面上的东西** = 在所在地点（场景或道路）的描述里被 `[id]` 引用的物品。
- **没被注意到的东西** = 只在 `references` 里、描述里没有引用的物品。现有的 7 个 `hidden:true` 本来就满足这一点，迁移只需删掉字段。
- 持有者知道自己身上的东西：随身物品对持有者永远可引用（与现在一致）。

### 5.2 通道（已定）

- `hidden` 改为 `concealed`，含义是「物理上被挡着、看不出是一扇门」，对所有人一样。
- 去掉 `discoveredBy` 和结算操作 `connectionDiscovered`。私下知道属于人的认知。
- `connectionHidden` 改为 `connectionConcealed {connectionId, concealed}`，只用于物理状态真的改变时（书架被推开、门被重新挡上）。脚本事件 `connection.setHidden` 同步改名。
- 加载规则不变：`concealed` 通道的目标不得只因这条通道而被描述引用。

### 5.3 注意到：第二层感知交给 Decisions（已定）

每个人每次渲染之前：

1. 代码列出他所在地点里**没被引用的物品**和**被挡住的通道**，减去他已经知道的（见 5.4）。
2. 列表为空：不发请求。绝大多数地点都是这种情况，零成本。
3. 列表不为空：问 Decisions API，每样东西一道 predicate「他此刻会不会注意到它」。依据：这样东西自己的描述、他正在做什么（翻箱子还是路过）、光线等环境、他在场景里的位置。
4. 注意到的：物品加进他这一 tick 的场景物品和可引用集合；被挡住的通道以「通向哪个地点」的形式交给 renderer，引用目标地点的 tag。renderer 给它们打 tag，从此留在他的感知流里。
5. 拿不准、超时、报错：判为没注意到（已定）。保守一侧是保密；他仍然可以主动去搜。

对唤醒闸门的人（见关联文档 6.1），这些题目和闸门题放在同一个请求里（已定）。闸门因此可能看到他还没注意到的东西并把他唤醒；被唤醒本身不告诉他任何事，不算泄密。

### 5.4 可引用集合：只能指提示里给他看过的东西（已定）

**不允许猜 id。** 现在物品和地点的 id 全世界都能引用（`perceivableDirectory.ts` 约 138 行「every real id in the world」），角色写出一个从没见过 tag 的 id（如 `SCN_bluebird_dining`）边界照样放行。这违背了「地图记忆和自己写下的东西之外的地点，对他来说不存在」。改为物品和地点都只能指提示里出现过的。

一个人能指着的**物品**（车辆同理）=

- 当前所在地点描述里引用的（明面上的）；
- 自己的随身物品；
- 这一 tick 被他注意到的（5.3）；
- 这一 tick 他以 full / limited 感知到的事件里引用的（搜查的人找到了夹层）；
- **他的感知流里出现过的 tag**（含感知压缩后的摘要）；
- **他的记忆里出现过的 tag**。

一个人能指着的**地点** =

- 当前所在地点，以及 renderer 给他看的相邻地点（含相邻地点描述里引用的地点）；
- **他的感知流里出现过的 tag**；
- **他的记忆里出现过的 tag**（含模块预置的地图记忆，见 5.7）。

人物不变：认识的人用真实 id，同处一地的陌生人用别名。

`buildPerceivableDirectory` 按这个规则重写，代码从感知流和记忆里解析 `[...]` tag；renderer 的 `buildCitationTags` 读的是同一个函数，「看得到」和「能引用」继续是同一个集合。

感知压缩把某个 tag 压掉、他又没写进记忆，那他就是忘了。被告知的人没有 tag，可以指着看得见的东西（书架）去做，由引擎判断能不能成。

**保留 tag（已定）**：角色自己写的文字里，凡是提到具体的人、物、地点，都要带上它的 `[tag]`。三处提示都要写明：`writeMemory`、`memoryConsolidator`（整理记忆）、`perceptionCompactor`（压缩感知；至少保留他想记住的东西的 tag）。代码无法检测「该带却没带」，只能靠提示。

### 5.5 引擎（已定）

- 引擎仍然看得到全部。上下文里标出哪些物品没被引用、哪些通道被挡着，规则写明「引擎知道的东西不等于观察者知道」（现有原则不变）。
- **私下发现**：搜查等行动成功时，结算只写一条事件：发现者以 full 感知，事件引用被发现的物品。不改世界状态。发现者通过 5.4 第四项获得它的 tag。
- **公开暴露**：结算改写地点描述，把物品引用进去（`sceneChanges setDescription`），或写 `connectionConcealed false`。之后所有人进门就能看到。
- **取走**：照常 `itemChanges move`，必要时改写容器的描述（夹层被划开）。
- 结算操作里去掉 `set.hidden` 和 `connectionDiscovered`；规则文档 `item-changes.md`、`scene-changes.md`、`perception.md` 相应改写。

### 5.6 移动（已定）

- 代码列候选路线时，默认只用**未被挡住**的通道。
- 被挡住的通道只有在行动者的话里明确说了要通过它（「推开书架钻过去」，并引用了它通向的地点）时，才放进候选，由 Decisions API 判断他的话是不是这个意思。
- 选中时，开始判定给出一个一次性的 `viaConcealedConnectionId`，与现有的 `passBlockedConnectionId`（`consumePassForStep`）同一套机制：推进到这一段时核对、放行、作废。`initMovementRuntime` / `placesAdjacent` / 逐分钟推进都拒绝任何没有这一授权就穿过被挡住通道的一段路。这是 Decisions 判错时的代码保险。
- **保留「同一栋楼内」的捷径（更正）**。讨论时曾定为去掉，写实现计划时重读代码发现判断有误：`initMovementRuntime` 在规划前就用 `placesAdjacent` 逐段检查路线，捷径只会在**两个直接相邻**的房间之间触发，它的 `blockCheck` 查的正是两者之间那道真实的门。去掉它，相邻房间会经由整栋楼挂靠的根节点（街上）绕行——拓扑里没有室内的门，`buildMovementRouteIgnoringBlocks` 只认根节点和道路——反而丢掉那道门的阻挡检查。暗门的防护只需要放在 `placesAdjacent`：被挡住的通道不算相邻，除非这次移动带着它的 `viaConcealedConnectionId`。

### 5.7 加载器、迁移与存档（已定，标注「提议」的除外）

- `moduleSchemaV2`：物品上出现 `hidden` 直接报错（与「v1 直接拒绝」同一做法）；通道的 `hidden` 改名 `concealed`。
- 迁移 grayhaven 的 7 处 `hidden: true`，逐个确认是物品还是通道；`data/Mods/` 下的模块同样处理。
- **预置记忆补 tag（已定）**：grayhaven 预置的 226 条记忆里没有一条带 tag，其中 100 条是地图记忆（如「顺主街往北走一刻钟就到蓝鸟后厨——先过街机厅……」）。不补 tag，角色就只能去当前看得到的相邻地点。要给地图记忆里提到的地点、以及其他记忆里提到的具体物品和地点补上 tag（「主街 [ROAD_main]」「蓝鸟后厨 [SCN_bluebird_kitchen]」）。`data/Mods/` 同样处理。
- 加载器检查：预置记忆里的 tag 必须指向真实存在的实体（提议：地图记忆至少带一个地点 tag）。
- 运行时存档里带 `hidden` / `discoveredBy` 的旧会话：按项目惯例直接拒绝旧版本，提高版本号。

## 6. 改动范围（初估）

- `src/state/`：`types.ts`、`moduleSchemaV2.ts`、`perceivedLocation.ts`、`perceivableDirectory.ts`、`DynamicGameState.ts`（去掉 `recordConnectionDiscovery`，`setConnectionHiddenById` 改名）。
- `src/roleSim/`：渲染前的「注意到」请求；`renderer/buildBundle.ts` 带上注意到的东西。
- `src/engine/`：`resolution/worldDeltaSchema.ts`（操作）、`worldDeltaValidator.ts`、`contextBuilder.ts`、`worldResolutionStagePrompts.ts`；`core/applier.ts`；`scriptedEvents/types.ts` 与 `core/scriptedEventRunner.ts`；`actions/movementRuntime.ts`、`subsystem/movement.ts`。
- `src/engine/rules/world/*.md`：三份规则文档。
- 模块数据：`testmods/grayhaven/`、`data/Mods/`、`testmods/DYNAMIC_WORLD_SCENE_SCHEMA.md`。
- CLAUDE.md：隐藏机制的描述。

## 7. 风险与待定

- **tag 遵守率**：「记得它」依赖角色写记忆、压缩感知时真的保留 `[tag]`（已定为提示要求，见 5.4）。遵守率要实测；漏掉的后果是遗忘，而不是泄密。
- **导航退化**：禁止猜地点之后，预置记忆补 tag 若有遗漏，角色会去不了本该认得的地方。影子模式下要看有多少移动因「目的地不可引用」被拒。
- **「注意到」的准确率**：中文输入、光线和遮挡的判断，都要在影子模式下测。
- **道路上的物品（已定）**：与场景同一规则——道路描述里引用的是明面上的，没引用的走 5.3 的「注意到」；带位置的物品还要同时满足现有的 5 分钟距离（`ROAD_ITEM_REACH_MINUTES`）。
