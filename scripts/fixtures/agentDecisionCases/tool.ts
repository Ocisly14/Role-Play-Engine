// scripts/fixtures/agentDecisionCases/tool.ts

import type { SimScenario } from "./types.js";

// =========================================================================
// LAYER 1 — agent tools
// =========================================================================

export const TOOL_SCENARIOS: SimScenario[] = [
  {
    id: "tool-act-urgent",
    group: "tool",
    title: "突发事件逼出行动（act）",
    cases: [
      {
        label: "警探：楼下发现尸体",
        ticks: 3,
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "查清镇上接连发生的命案，不惜代价；一有情况立刻亲自到场。",
          },
          {
            npc: "Lux Lynch",
            goal: "别被卷进这桩案子，能推就推，别让人注意到你。",
          },
        ],
        openingEvent: {
          // 原文写"楼下停车场"，但全模组没有停车场这个地点：角色无 id 可引用、
          // 寻路无处可去，实跑时连续 7 个 tick 反复发同一个到不了的行动。改到
          // 门外街口 JUNC_8，那里真有 ITEM_JUNC8_1 警车与 ITEM_JUNC8_2 明亮路灯。
          description:
            "警察局门口那盏路灯下、停着的警车旁边倒着一具尸体，血还是温的，门厅里有人在大声喊人",
          impact: 3,
        },
      },
      {
        label: "花店少女：橱窗被砸",
        ticks: 3,
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "守住这家小店，这是母亲留给你的全部。",
          },
          {
            npc: "Philip Scaletta",
            goal: "别惹麻烦，看看有没有便宜可占，随时准备走人。",
          },
        ],
        openingEvent: {
          description:
            "临街的整面橱窗玻璃被砸碎，碎玻璃洒了一地，冷风灌进屋里，街上有人影跑远",
          impact: 2,
        },
      },
      {
        label: "打手：老板的货被撬了",
        ticks: 3,
        actors: [
          {
            npc: "Kovind",
            goal: "在老板问责之前把丢的货和动手的人找出来，谁挡路就收拾谁。",
          },
          {
            npc: "Angela",
            goal: "撇清自己和这批货的关系，别让打手把火烧到你身上。",
          },
        ],
        openingEvent: {
          description: "屋角三只木箱全被撬开，里面空了，撬棍还扔在地上",
          impact: 2,
        },
      },
      {
        label: "老站务：信号灯全灭",
        ticks: 3,
        actors: [
          {
            npc: "Haran Greenwood",
            goal: "四十年没出过事故，今晚也不能出；有异常必须立刻处置。",
          },
          { npc: "Marks White", goal: "等你的班车，别多管闲事。" },
        ],
        openingEvent: {
          description:
            "整排信号灯毫无预兆地全部熄灭，值班表上写着六分钟后有一班货运通过这段",
          impact: 2,
        },
      },
      {
        label: "院长：有人在门口倒下",
        // 要看到院长真的提交救人动作：commit 需要 2 + elapsedMinutes 个 tick，
        // first_aid 的 durationGuidance 默认 5，3 tick 里动作只会停在"仍在途"。
        ticks: 8,
        actors: [
          { npc: "Vincent Galenus", goal: "不要再有人死在你面前了。" },
          {
            npc: "Nancy Charlotte",
            goal: "撑住，别晕过去。",
            hp: 5,
            conditions: ["胸口剧痛，呼吸困难，嘴唇发青"],
          },
        ],
        openingEvent: {
          description: "一个人在门口捂着胸口跪倒在地，嘴唇发青，喘不上气",
          impact: 2,
          // 标成南希自己做的事，否则她也会收到一条"有人倒下了"的旁观记忆——
          // 而倒下的正是她本人。
          by: "Nancy Charlotte",
        },
      },
    ],
  },
  {
    id: "tool-continue-inertia",
    group: "tool",
    title: "手上有活 + 无关动静 → 惯性（continue，不中断在途动作）",
    cases: [
      {
        label: "老站务：远处一声喇叭",
        ticks: 5,
        actors: [
          {
            npc: "Haran Greenwood",
            goal: "在交班之前把今天的值班簿一行行抄完，这是雷打不动的规矩；别的事都可以等。",
          },
        ],
        sceneConditions: ["值班台上摊着抄了一半的值班簿和一支钢笔"],
        openingEvent: {
          description: "很远的街上传来一声汽车喇叭，随即归于安静",
          impact: 2,
          afterTicks: 2,
        },
      },
      {
        label: "钟表匠：楼上有人走动",
        ticks: 5,
        actors: [
          {
            npc: "Marks White",
            goal: "今晚必须把客人这只金怀表修好，明早就来取；手上的活不能停。",
          },
        ],
        // 怀表只写在目标文字里的话，agent 想继续摆弄它时只能自造一个 item id，
        // 会被 citation 防护拦下（同 world-scene-destroy 里的教训）——真实布上场。
        sceneItems: ["watch"],
        sceneConditions: [
          "工作台上摆着镊子和放大镜，那只金怀表就搁在绒布上，刚拆开表盖",
        ],
        openingEvent: {
          description: "楼上传来两三下脚步声，随即没了动静",
          impact: 2,
          afterTicks: 2,
        },
      },
      {
        label: "书商：街上有人吵架",
        ticks: 5,
        actors: [
          {
            npc: "Solomon",
            goal: "在天亮前把这本书缺失的那一章查清楚，逐页比对不能中断。",
          },
        ],
        sceneConditions: ["柜台上摊着一本翻到一半的旧书和一叠目录卡"],
        openingEvent: {
          description: "街对面两个醉汉互相叫骂，声音隔着玻璃传进来，很快走远",
          impact: 2,
          afterTicks: 2,
        },
      },
      {
        label: "毒贩：等人，不该乱动",
        ticks: 5,
        actors: [
          {
            npc: "Angela",
            goal: "在这里等约好的人出现，交完货就走；在他出现之前不要引起任何注意。",
          },
        ],
        openingEvent: {
          description: "街口开过一辆送奶车，司机看都没往这边看",
          impact: 2,
          afterTicks: 2,
        },
      },
      {
        label: "律师：无关的电话铃",
        ticks: 5,
        actors: [
          {
            npc: "Mrs. Barklyite (Lucia Shiny)",
            goal: "明天上午开庭，今晚必须把庭辩提纲逐条标注完，中途不能被打断。",
          },
        ],
        sceneConditions: ["桌上摊着庭辩提纲和几卷判例汇编"],
        openingEvent: {
          description: "隔壁办公室的电话响了两声就被人接起，说的是别的案子",
          impact: 2,
          afterTicks: 2,
        },
      },
    ],
  },
  {
    id: "tool-recall-past",
    group: "tool",
    title: "被问到几天前的事 → 先查记忆（recallMemory）",
    cases: [
      {
        label: "侦探：委托人追问上周的通话",
        ticks: 7,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "查清这桩案子，同时绝不说没把握的话——被问到细节要先想清楚再回答。",
            recallSeeds: [
              {
                type: "general",
                content:
                  "上周三凌晨1点17分接到一通匿名电话，男声，说“钟楼下面有东西被埋着”，通话十一秒后挂断，来电显示是公用电话亭。",
                date: "2003-11-26",
              },
              {
                type: "general",
                content: "打匿名电话的人认识死者，而且怕被认出声音。",
                date: "2003-11-26",
              },
            ],
          },
          {
            npc: "Bruno Galilei",
            goal: "向她问清楚上周三夜里那通匿名电话报案人到底说了什么、几点打来的，必须要确切答复。",
          },
        ],
      },
      {
        label: "腐败警察：那张签收单是谁签的",
        ticks: 7,
        actors: [
          {
            npc: "Lux Lynch",
            goal: "绝不能让人查到你和那批证物的关系；被问到细节先在脑子里核对清楚再开口。",
            recallSeeds: [
              {
                type: "secret",
                content:
                  "11月18日晚上10点40分，我在证物室签收单上签了字，但箱子里少了一包东西——是我拿走的。",
                date: "2003-11-18",
              },
            ],
          },
          {
            npc: "Mrs. Barklyite (Lucia Shiny)",
            goal: "逐条追问他上个月那批证物的签收时间、经手人和去向，任何含糊都要追下去。",
          },
        ],
      },
      {
        label: "市长：对方引用一场旧会面",
        ticks: 7,
        actors: [
          {
            npc: "Patrizio von Samsa",
            goal: "在没弄清对方底牌之前绝不承认任何事；先在心里核实他说的会面到底发生过什么。",
            recallSeeds: [
              {
                type: "general",
                content:
                  "11月20日下午在市政厅办公室会见一名自称受托人的男子，他要求把河滨那块地的评估推迟到明年春天，我只说“再看看”，没有答应。",
                date: "2003-11-20",
              },
            ],
          },
          {
            npc: "Philip Scaletta",
            goal: "咬定上个月他在办公室里点过头，逼他认下这件事。",
          },
        ],
      },
      {
        label: "混混：欠的钱是哪天借的",
        ticks: 7,
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "先别挨打，能拖一天是一天；被问到日期数目必须答得上来。",
            recallSeeds: [
              {
                type: "general",
                content:
                  "11月29日下午在台球厅借了四百块，说好一周内还，多一天加五十。",
                date: "2003-11-29",
              },
            ],
          },
          {
            npc: "Kovind",
            goal: "当面盘问他哪天借的、说好几天还，说错一个字就动手。",
          },
        ],
      },
      {
        label: "书商：谁买走了那本书",
        ticks: 7,
        actors: [
          {
            npc: "Solomon",
            goal: "保护买家的隐私，但也别平白得罪出得起价的人；回答之前先把当年的交易想清楚。",
            recallSeeds: [
              {
                type: "general",
                content:
                  "9月14日把那本1897年拉丁文抄本卖给了一位自称替教会办事的年轻男子，付现金，没留姓名，只留了一个邮政信箱号。",
                date: "2003-09-14",
              },
            ],
          },
          {
            npc: "Angela",
            goal: "问出那本1897年抄本几个月前被谁买走了，愿意出三倍价钱。",
          },
        ],
      },
    ],
  },
  {
    id: "tool-write-belief",
    group: "tool",
    title: "形成新判断 → 记下来（writeMemory）",
    cases: [
      {
        label: "警探：他的鞋上有松针",
        ticks: 3,
        actors: [
          {
            npc: "Bruno Galilei",
            // 原文写"发现矛盾要记下自己的判断"等于直接下令 writeMemory（参照
            // skill-dodge 的注释精神），改成人格级动机，能不能自己认出该记下来
            // 才是这个场景要观察的。
            goal: "查清镇上的命案，同时留意谁的话信不过——尤其是嘴上信誓旦旦的人。",
            todayMemories: [
              {
                type: "general",
                content:
                  "他一口咬定整晚都在档案室清卷宗没离开过，可他袖口沾着还没干的泥点，鞋跟里嵌着松针——警局里外没有一棵松树。",
              },
            ],
          },
          {
            npc: "Lux Lynch",
            goal: "坚持说自己整晚都在档案室清卷宗，别让他看出破绽。",
          },
        ],
      },
      {
        label: "侦探：两个证词对不上",
        ticks: 3,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "把这条时间线钉死，再决定要不要当面跟他摊牌。",
            todayMemories: [
              {
                type: "general",
                content:
                  "他说九点就锁门走了，可我今早在门口捡到的收据打印时间是九点四十一分，收银机就在他背后。",
              },
            ],
          },
          { npc: "Philip Scaletta", goal: "咬死自己九点就锁门走了。" },
        ],
      },
      {
        label: "律师：合同里的日期不对",
        ticks: 3,
        actors: [
          {
            npc: "Mrs. Barklyite (Lucia Shiny)",
            goal: "在开庭前找出对方证据链上能拿来用的漏洞，越细越好。",
            todayMemories: [
              {
                type: "general",
                content:
                  "我翻到附件第三页，转让日期写着11月2日，可主合同签署页是11月9日——附件不可能早于主合同生效。",
              },
            ],
          },
          {
            npc: "Patrizio von Samsa",
            goal: "让她相信那份附件完全合规，别再往下追。",
          },
        ],
      },
      {
        label: "院长：用药记录被人改过",
        ticks: 3,
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "弄清那晚到底是谁下的医嘱，哪怕结果指向你自己。",
            todayMemories: [
              {
                type: "general",
                content:
                  "护理记录上那一栏的字迹和上下行不一样，墨色更新，剂量被人从原来的数字改成了现在这个，而且没有签名。",
              },
            ],
          },
          {
            npc: "Nancy Charlotte",
            goal: "把花送到那间病房去，顺便问问病人这几天恢复得怎么样。",
          },
        ],
      },
      {
        label: "腐败警察：有人在试探我",
        ticks: 3,
        actors: [
          {
            npc: "Lux Lynch",
            goal: "别被查到；他要是话里有话，你得先摸清他到底想套什么，再决定怎么应对。",
            todayMemories: [
              {
                type: "general",
                content:
                  "他今天第三次“随口”提起证物室的排班，每次都问得像闲聊，可他从来不管那块的事。",
              },
            ],
          },
          {
            npc: "Bruno Galilei",
            goal: "不动声色地摸清证物室那几天的排班和经手人。",
          },
        ],
      },
    ],
  },
  {
    id: "tool-map-route",
    group: "tool",
    title: "去不熟的地方 → 先看地图（getMapSnapshot）再动身",
    targetDefs: [],
    cases: [
      {
        label: "猎人：夜里进城办事",
        ticks: 5,
        actors: [
          {
            npc: "Johnny",
            goal: "二十分钟内赶到{{destName}}去见线人。你对镇里的路不熟，动身前先确认自己知不知道怎么走。",
          },
        ],
      },
      {
        label: "混混：得绕开主路",
        ticks: 5,
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "有人在大街那头等着堵你。避开主路去{{destName}}，动身前先想清楚有哪几条路可走。",
          },
        ],
      },
      {
        label: "花店少女：第一次去送货",
        ticks: 5,
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "把这束花按时送到{{destName}}。你几乎没出过这条街，先弄清楚怎么走。",
          },
        ],
      },
      {
        label: "毒贩：临时改了交货点",
        ticks: 5,
        actors: [
          {
            npc: "Angela",
            goal: "对方临时把交货点改到{{destName}}，只给二十分钟。你在那一带走动不多，先确认路线再出发。",
          },
        ],
      },
      {
        label: "钟表匠：上门取件",
        ticks: 5,
        actors: [
          {
            npc: "Marks White",
            goal: "客人要你亲自去{{destName}}取一只座钟。你很多年没往那个方向走过了，出门前先把路想清楚。",
          },
        ],
      },
    ],
  },
];
