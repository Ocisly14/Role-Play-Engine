# tlou2 — 「如果汤米没有报出真名」

一个 schema v2 测试模组。复刻《The Last of Us Part II》里乔尔与汤米在杰克逊镇外风雪中初次救下艾比的那一幕，但**改掉一个变量**。

## 反事实假设

原作里，三人退到滑雪旅馆之后，汤米伸手自我介绍：「我是 Tommy，这是我哥 Joel。」艾比追了五年的两个名字，一次同时落地，伏击从那一秒开始成立。

本模组把这句话拿掉，并且**拿掉的方式是设定，不是概率**：

- 汤米被写成一个对生人本来就有分寸的人：不报名字、不说兄弟关系、不说镇子叫什么，**在生人面前彼此也不用名字称呼**。这是巡逻队的规矩，也是他自己的习惯，写在两人的 `general` 记忆里；`plan` 只放真实的计划——雪停后走旅馆车行道下县道回杰克逊，这几个人不带回去。
- 他递水递毯子、帮着生火的热心全部保留——张力留着，只有报名字这一件事是关死的。
- 更底层的保障是引擎本身：两拨人之间**没有任何 relationship 条目**，因此走 `perceivableDirectory` 的陌生人别名路径（`stranger_a` 等）。真名根本不在对方的上下文里，不是靠提示词请求模型别说。

于是要观察的就是：**引信不存在时，这台机器往哪儿转。**

## 测试目标

1. **隐藏动机与信息不对称** —— 艾比带着一个五年的目标坐在两个救了她命的陌生人对面，而她唯一的识别手段刚好失效。
2. **陌生人识别与关系建立** —— 六个角色里有两组互相认识、彼此之间全是生人，`knownAs` 该怎么长出来。

## 「谁知道什么」矩阵

| | 知道「Joel」这个名字 | 知道长相 | 知道对方动机 | 知道对方位置 |
|---|---|---|---|---|
| Abby | ✅ 名字 + 有个弟弟叫 Tommy + 兄弟俩 | ❌ 无照片无描述 | ❌ | ❌ |
| Owen / Mel / Manny | ✅ 同上 | ❌ | ❌ | ❌ |
| Joel | 自己 | — | ❌ 不知道有人在找他 | ❌ |
| Tommy | 哥哥 | — | ❌ | ❌ |

乔尔与汤米**完全不知道**有人在找他们。他们面对的只是「雪天里救下的一个陌生女人，可能有同伙」。

反向的不对称也保留了：旅馆里摆着**六套睡袋**、按六人份分好的口粮、擦出一块干净圆的窗。Joel 和 Tommy 能看出这支队伍人数不少、准备充分，因此不会把他们带回杰克逊；但这些迹象本身不构成敌意。

## 拓扑

```
SCN_frozen_creek ──8min── SCN_ridge_clearing ──12min── SCN_lodge_drive ──┐
      (艾比的背包)             (救援发生处)              (旅馆前车道)      │
                                    │                        │           25min
                                  15min                      ↓           │
                                    │                 SCN_lodge_porch     │
                             SCN_pine_hollow           (门廊·天气锚点)     │
                              (最易转向)                     ↓           │
                                    │              SCN_lodge_greatroom    │
                                    │                (开局:六人在此)       │
                                  20min             ↙            ↘        │
                                    │        SCN_lodge_kitchen  SCN_lodge_upstairs
                                    └──── SCN_county_road ───────────────┘
                                                   │
                                            SCN_jackson_town
                                             (成功终点)
```

- 5 个顶层户外道路节点 + 5 条道路 + 4 个旅馆内部场景，并在县道上直接连接一个归属 `OUTDOOR` 区域的杰克逊成功终点。
- 拓扑成环：「回杰克逊」和「去旅馆」都是走得通的真实选项，没有被作者掐掉。
- **`SCN_lodge_porch` 的 `parentLocationId` 是 `"OUTDOOR"`,这是故意的**：`tickOrchestrator.anchorIdsFor("region")` 只从场景的 `parentLocationId` 枚举天气区域且没有 `OUTDOOR` 兜底，必须有一个非端点、非 indoor 的场景把这个 anchor 点亮，`weatherPresets` 才会初始化。点亮之后 `getOutdoorLocationIdsInRegion` 会把所有无 parent 的户外场景和所有道路一起纳入。门廊是唯一不破坏道路端点校验的候选。

## 起始布置

| 角色 | 位置 |
|---|---|
| Abby Anderson | `SCN_lodge_greatroom`（刚被救回，力竭，虎口受伤） |
| Joel Miller | `SCN_lodge_greatroom` |
| Tommy Miller | `SCN_lodge_greatroom` |
| Owen Moore | `SCN_lodge_greatroom` |
| Mel | `SCN_lodge_greatroom`（带着热水和医疗用品） |
| Manny | `SCN_lodge_greatroom`（刚从二楼下来） |

时间 2038-12-06 14:20，天气 snow / intensity 4。开局是**救援之后，六个人刚在旅馆大厅聚齐的那一刻**。Joel 和 Tommy 已经救过 Abby；Owen、Mel 与 Manny 正用炉火、热水、食物和医疗作为回报。

`SCN_jackson_town` 是非强制的成功终点。模组不会用脚本把任何人送过去；当角色自行决定沿县道前往杰克逊并抵达该场景时，即可把本轮判为成功。

## 感染者

**不做成 NPC。** 它们以场景物件（三具尸体、踩烂的雪面、雪上的血点）和条件（远处未散的动静）存在。这个模组测的是社交高压舱，不是战斗，LLM 角色名额全部留给六个人。

## 环境压力

`scripted-events/blizzard.json` 两个配对事件，共用 `featureId: "blizzard"`：

- `evt_blizzard_closes_pass`：15:10 之后触发，封锁通往 `SCN_county_road` 的两条路的**四个端点连接**，并给洼地和车道各加一条雪墙条件。
- `evt_blizzard_eases`：约四小时后按同一 `featureId` 与**逐字相同的 `reason`** 撤销（Applier 的投票匹配同时比对 featureId 和 reason，不一致就撤不掉）。

四个端点全封而不是只封县道那一侧，是因为寻路的规划层只检查出发侧（`pathfinding.ts` 的 BFS 不查另一端），只封一端会让 NPC 白走二十分钟才在路尽头被拦。

这是**环境压力，不是剧情脚本**：它临时关掉「立刻回杰克逊」这个出口，把人推到同一个屋檐下，但不规定他们在屋檐下说什么。

## 看模拟记录时盯三处

1. **汤米有没有破功。** 他的 `act` 内容里出现真名，就是设定没兜住，需要把那条约定写得更硬。
2. **艾比有没有靠名字之外的东西拼出结论。** 德州口音、两匹长途巡逻配置的马、乔尔那只表蒙裂了的旧手表、两人自称从哪儿来——这些都在场，够不够是模拟的结果，不是作者的安排。
3. **旅馆那三个人怎么处理两个不肯报名的陌生人。** 以及乔尔上不上二楼，上去之后数不数睡袋。

## 与引擎无关的说明

`DESIGN.md` 引擎不读。引擎读的是 `module_setup.json`、`npc_injection_policy.json`、`Tlou2_Scenarios/`、`tlou2_npc/`、`scripted-events/`。

验证：`pnpm smoke:module --module tlou2`（零模型调用）。真跑：`pnpm sim:full --module tlou2`（`test:agent-decisions` 把模组目录写死成 grayhaven / data\_Mods 二选一，跑不了本模组）。
