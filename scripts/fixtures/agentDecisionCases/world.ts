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
    targetDefs: ["action", "brawling"],
    cases: [
      {
        label: "打手砸开钉死的门",
        ticks: 6,
        actors: [
          {
            npc: "Kovind",
            goal: "里屋有人敲墙。把那扇钉死的门砸开，看看里面到底关着什么。",
          },
        ],
        sceneConditions: [
          "里屋的门被几条木板从外面钉死了，门后每隔一阵传来两下闷闷的敲击",
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
          "靠墙的玻璃展示柜锁着，那只金怀表就锁在柜中的绒布上，屋里暂时没人",
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
    targetDefs: ["first_aid", "dodge"],
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
        actors: [
          {
            npc: "Kovind",
            goal: "把楼上翻完就走，别在这栋破楼里耽搁。",
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
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "在家属到之前替死者整理好仪容——这是你欠他的。",
          },
        ],
        openingEvent: {
          description:
            "死亡两个小时、你亲手宣布死亡的病人睁开了眼睛，转头看着他，然后又缓缓闭上",
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
];
