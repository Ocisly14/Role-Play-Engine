// scripts/fixtures/agentDecisionCases/world.ts

import type { SimScenario } from "./types.js";

// =========================================================================
// LAYER 3 — world coupling: NPCs changing the scene, and the scene actually
// hitting back (HP loss, SAN shock through the scripted-event runner).
// =========================================================================

export const WORLD_SCENARIOS: SimScenario[] = [
  {
    id: "world-scene-destroy",
    group: "world",
    title: "对场景动手：砸、烧、拆——世界状态该跟着变",
    targetDefs: ["Melee Combat"],
    cases: [
      {
        label: "打手砸开钉死的门",
        ticks: 6,
        // 原来没写 scene，舞台落在 Kovind 自己的地下赌场——那是无窗砖石地窖，
        // 唯一的连接是往上通教堂主殿，没有"里屋"可砸开。教堂主殿旁边真有一扇
        // 通往 SCN_17_SUB_3 暗门·蛛网 的隐藏门，门砸开之后角色真能进去。
        scene: "教堂主殿",
        actors: [
          {
            npc: "Kovind",
            goal: "雕像后方那扇暗门后面有人敲墙。把钉死的门板砸开，看看里面到底关着什么。",
          },
        ],
        sceneConditions: [
          "雕像后方那扇石板暗门被几条木板从外面钉死了，门后每隔一阵传来两下闷闷的敲击",
        ],
      },
      {
        label: "腐败警察烧记录",
        ticks: 6,
        actors: [
          {
            npc: "Lux Lynch",
            goal: "把桌上那沓能咬死你的签收记录全烧掉，一页都不能留下。",
          },
        ],
        sceneConditions: [
          "桌上摊着一沓证物室签收记录，墙角的铁皮炉子里还有没熄的炭火",
        ],
      },
      {
        label: "混混砸玻璃柜",
        ticks: 6,
        // 原来没写 scene，舞台落在 Philip 自己的廉租房——沙发、电视、小冰箱，
        // 没有上锁的玻璃展柜，"趁屋里没人"在自家客厅也讲不通。这段文字本来
        // 就是给钟表店写的：那里真有 ITEM_SCN12_1 精致怀表展柜。
        scene: "怀特的钟表店",
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "柜子里那只金怀表值一个月的房钱。没钥匙没工具，砸开它，拿了就走。",
          },
        ],
        // 怀表必须真实布上场：只写在场景条件的文字里的话，agent 想拿它时
        // 只能自造一个 item id，被 citation 防护拦下（实测两轮都撞上）。
        sceneItems: ["watch"],
        sceneConditions: [
          "靠墙的精致怀表展柜锁着，那只金怀表就锁在柜中的绒布上，店里暂时没人",
        ],
      },
      {
        label: "花店少女推货架堵门",
        ticks: 6,
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "后门在响，警察来不及了——把靠墙那排货架推倒，把后门死死堵住。",
          },
        ],
        sceneConditions: ["后门旁靠墙立着一排装满花盆的木货架"],
        openingEvent: {
          description: "后门的锁孔传来金属刮擦声，有人在外面撬锁，门闩在晃",
          impact: 2,
        },
      },
      {
        label: "猎人劈开倒木",
        scene: "森林深处",
        ticks: 6,
        actors: [
          {
            npc: "Johnny",
            goal: "风雪天黑前必须把回屋的小径清出来，把那根倒木劈开挪走。",
          },
        ],
        sceneConditions: [
          "一根成人腰粗的倒木横死在小径中间，两侧是过不去的灌木和陡坡",
        ],
      },
    ],
  },
  {
    id: "world-harm-react",
    group: "world",
    title: "场景真的伤到人：openingEvent 带 harm，看伤者怎么处置",
    targetDefs: ["Medicine & Psychology", "Athletics"],
    cases: [
      {
        label: "花店少女被花盆砸中",
        ticks: 8,
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "守住这家小店，也照顾好自己——你倒下了店就完了。",
            hp: 9,
          },
        ],
        sceneItems: ["kit"],
        openingEvent: {
          description:
            "头顶的木架毫无预兆塌了半边，一只花盆重重砸在她的额头上，碎土混着血糊了她一脸",
          impact: 2,
          harm: {
            target: "Nancy Charlotte",
            hp: -2,
            conditions: ["额头被花盆砸开一道口子，血流进眼睛里"],
          },
        },
      },
      {
        label: "老站务被行李车撞倒",
        ticks: 8,
        actors: [
          {
            npc: "Haran Greenwood",
            goal: "四十年没出过事故，站上任何异常都要处置——包括你自己出的事。",
            hp: 10,
          },
        ],
        // 未布 kit：有意设计——观察这位循规蹈矩的老站务手头没有医疗资源时
        // 怎么按流程处置自己的伤情（求助 vs 徒手应付），而不是默认给资源。
        openingEvent: {
          description:
            "装满行李的推车顺着坡道冲下来，车角正撞在他的右腿上，把他整个人带倒摔在月台上，箱子散了一地",
          impact: 2,
          harm: {
            target: "Haran Greenwood",
            hp: -2,
            conditions: ["被行李车撞倒，右腿一吃力就钻心地疼"],
          },
        },
      },
      {
        label: "钟表匠被主发条崩伤",
        ticks: 8,
        actors: [
          {
            npc: "Marks White",
            goal: "今晚必须把这只怀表修好交差，手上的活不能砸。",
            hp: 9,
          },
        ],
        // 怀表是真实道具（watch）：goal 点名"这只怀表"，不布上场会让 agent
        // 想接着手上的活时只能自造一个 item id，被 citation 拦下。
        sceneItems: ["kit", "watch"],
        openingEvent: {
          description:
            "拆到一半的主发条突然崩开，钢条抽在他手背上，豁开一道往外渗血的口子",
          impact: 2,
          harm: {
            target: "Marks White",
            hp: -2,
            conditions: ["右手背被崩开的发条豁开一道口子，血一直往外渗"],
          },
        },
      },
      {
        label: "院长被氧气瓶砸中",
        ticks: 8,
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "医院不能再出事故——就算伤的是你自己，也要按规程处置。",
            hp: 10,
            items: ["kit"],
          },
        ],
        openingEvent: {
          description:
            "靠墙的氧气瓶架被撞垮，最上面那只铁瓶砸在他的小腿上，滚到墙角还在嘶嘶漏气",
          impact: 2,
          harm: {
            target: "Vincent Galenus",
            hp: -2,
            conditions: ["左小腿被氧气瓶砸中，胫骨处迅速肿起来"],
          },
        },
      },
      {
        label: "打手踩穿朽地板",
        ticks: 8,
        // 原来没写 scene，舞台落在地下赌场——砖石砌的无窗地窖，既没有木地板
        // 也没有可以踩塌下去的下层。坍塌小楼(SCN_2_SUB_2)是真的半塌两层楼，
        // 有断裂木梁，头顶还会不时传来木料的响声。
        scene: "坍塌小楼",
        actors: [
          {
            npc: "Kovind",
            goal: "把这半边没塌的楼翻完就走，别在这栋随时会再塌的破楼里耽搁。",
            hp: 11,
          },
        ],
        sceneConditions: ["这层楼的木地板到处发黑发软，踩上去咯吱作响"],
        // 未布 kit：有意设计——这个角色的 goal 只盯着任务、没有自我照护的
        // 语境，观察他是无视伤情硬撑，还是被迫先处理伤口。
        openingEvent: {
          description:
            "他脚下的朽木地板整块塌了下去，一条腿直接陷进洞里，断茬扎进小腿",
          impact: 2,
          harm: {
            target: "Kovind",
            hp: -3,
            conditions: ["左小腿被断裂的木茬划开，腿还半卡在地板洞里"],
          },
        },
      },
    ],
  },
  {
    id: "world-san-shock",
    group: "world",
    title: "恐怖冲击：openingEvent 带 SAN 伤害，看理智掉了之后人怎么办",
    cases: [
      {
        label: "书商看见插图转头",
        ticks: 5,
        actors: [
          {
            npc: "Solomon",
            // "抄本"没有对应道具；剪报是 notebook 本身就夹带的东西，把插图
            // 挪到剪报上，避免 agent 细看时引用一个不存在的手抄本 item id。
            goal: "把新到手的这沓剪报逐张核对清楚，判断线索的真伪和来路。",
            items: ["notebook"],
          },
        ],
        openingEvent: {
          description:
            "笔记本里夹着的一张剪报配图上，那东西缓缓转过头来，正对上他的视线——他清清楚楚看见它动了",
          impact: 2,
          harm: { target: "Solomon", san: -4 },
        },
      },
      {
        label: "花店少女看见墙上爬的东西",
        ticks: 5,
        actors: [
          {
            npc: "Nancy Charlotte",
            // 模组里花店周边没有"后巷"场景；改成她留在店内、透过临街玻璃
            // 门目击对面的墙，不发明新场景。
            goal: "打烊前把柜台账目核对完，锁门回家。",
          },
        ],
        openingEvent: {
          description:
            "临街的玻璃门外，街对面墙根的阴影里蹲着一个人形的轮廓，一动不动；数到第三个呼吸，它贴着砖墙垂直爬了上去，消失在檐口后面",
          impact: 2,
          harm: { target: "Nancy Charlotte", san: -5 },
        },
      },
      {
        label: "腐败警察看见断手蜷指",
        ticks: 5,
        actors: [
          {
            npc: "Lux Lynch",
            goal: "把这批证物入柜登记完就下班，别节外生枝。",
          },
        ],
        openingEvent: {
          description:
            "证物袋里那只早已冰凉的断手，五根手指在他眼前慢慢蜷了起来，隔着塑料袋抓向他",
          impact: 2,
          harm: { target: "Lux Lynch", san: -6 },
        },
      },
      {
        label: "院长看见死者睁眼",
        ticks: 5,
        // 原来没写 scene，舞台落在 Vincent 的药品管理室——刷卡进出的药房，
        // 没有尸体、没有停尸台，家属也不可能被领进去。停尸间(SCN_1_SUB_2)
        // 才是这一幕的地方，那里有不锈钢解剖台与冷藏柜。
        scene: "停尸间",
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "在家属到之前替死者整理好仪容——这是你欠他的。",
          },
        ],
        openingEvent: {
          description:
            "解剖台上那位死亡两个小时、你亲手宣布死亡的病人睁开了眼睛，转头看着他，然后又缓缓闭上",
          impact: 2,
          harm: { target: "Vincent Galenus", san: -5 },
        },
      },
      {
        label: "猎人看见反关节的鹿",
        scene: "森林深处",
        ticks: 5,
        actors: [
          {
            npc: "Johnny",
            goal: "把今天下的几个套子收一遍，天黑前回屋。",
          },
        ],
        openingEvent: {
          description:
            "林子里那头倒着的鹿站了起来——它的四条腿全都反着弯，像人一样直立着，隔着树盯着他",
          impact: 2,
          harm: { target: "Johnny", san: -5 },
        },
      },
    ],
  },
  {
    id: "world-item-craft",
    group: "world",
    title: "拆一件、造一件：物品的五种操作走一条链",
    targetDefs: ["Repair & Engineering", "Knowledge & Craft"],
    // The item side of WorldDelta has five operations — create · move ·
    // modify · damage · destroy (worldDeltaSchema.ts:195) — and before this
    // scenario `create` was the only one nothing in the table ever asked for.
    // The other four fall out of destruction, which `world-scene-destroy`
    // already covers; making a thing that did not exist a minute ago does not.
    //
    // Every case here stages the same shape and nothing else: the character
    // needs a thing the world does not contain, the only material is an object
    // they must take apart, and the taking-apart costs them something they
    // would rather keep. That forces the whole chain in one action —
    // damage/destroy the donor, create the product, move it where it is needed
    // — and then leaves ticks on the clock for the part that has never once
    // been exercised: whether a just-created item is CITABLE. An id the Engine
    // mints this tick has to reach the perceivable directory, get a bracketed
    // tag from the renderer, and come back through the trust boundary in the
    // next `act`. If any link is missing the character makes something and
    // then cannot touch it.
    cases: [
      {
        label: "钟表匠：拆一座钟，救一只表",
        // Three actions have to fit end to end: take the donor apart, make the
        // part, then FIT it — and only the third one answers the question the
        // case exists for. Repair & Engineering's default is 15 minutes, so
        // anything under ~40 ends mid-chain with nothing observed.
        ticks: 40,
        scene: "怀特的钟表店",
        actors: [
          {
            npc: "Marks White",
            // The donor is his own saleable stock, worth more than the repair.
            // Without that the choice is free and the case measures nothing.
            goal: "客人天黑前来取这只怀表，而它缺的那个零件你手上没有现成的。陈列架上那几座珐琅座钟里有尺寸对得上的——拆一座，取出零件，装进怀表。座钟比这单修理费值钱，但话是你说出去的。",
          },
        ],
        // On the bench, not in his pocket: the scene condition below says it is
        // lying open on the velvet, and a prop cannot be in two places.
        sceneItems: ["watch"],
        sceneConditions: [
          "工作台的绒布上摊着一只拆开的怀表，机芯里少了一枚齿轮，旁边是拆下来的表壳和螺丝",
          "零件匣里的黄铜齿轮尺寸都偏大，没有一枚配得上这只表的机芯",
        ],
      },
      {
        label: "老站务：拆长椅，做一块警示牌",
        ticks: 40,
        scene: "月台",
        actors: [
          {
            npc: "Haran Greenwood",
            // Forty years of never improvising, against a deadline that leaves
            // him nothing else. The rule-follower is the point: watch whether
            // he breaks station property at all.
            goal: "月台边缘塌了一段，下一班车四十分钟后进站，站上没有备用的警示牌。破长椅的木板还能用，小屋里有道钉锤和钢丝钳——拆几块板子，做一块立得住的警示牌，插在塌口前面。",
          },
        ],
        sceneConditions: [
          "月台靠东头的边缘塌下去一块，露出下面的碎石和一道半米宽的豁口",
          "值班小屋的门开着，墙钩上挂着道钉锤和钢丝钳，搁板上码着一卷信号旗",
        ],
      },
      {
        label: "猎人：拆祭台的铁环，做一个绊索",
        ticks: 40,
        scene: "森林深处",
        actors: [
          {
            npc: "Johnny",
            // No workbench, no shop, no tools beyond what a hunter carries:
            // the same chain with the crudest possible means.
            goal: "树干上那些抓痕和泥地里的足迹不是野兽留下的，而天快黑了。石台上有几个铁环，标桩埋在腐叶里还能拔出来——拆下来，在这块空地的来路上做一个绊索，那东西要是回来，你得先听见。",
          },
        ],
        sceneConditions: [
          "献祭石台边缘的几个束缚铁环松了，锈迹下的螺栓能徒手拧动",
          "残破伐木标桩半埋在腐叶里，木身还算结实",
        ],
      },
    ],
  },

];
