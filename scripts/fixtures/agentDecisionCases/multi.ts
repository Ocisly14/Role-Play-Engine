// scripts/fixtures/agentDecisionCases/multi.ts

import type { SimScenario } from "./types.js";

// =========================================================================
// LAYER 3 — multi-NPC topology: 3-way standoffs, moving together, chases.
// Nothing here targets one definition; the point is watching several agents
// read the same scene from conflicting sides at once.
// =========================================================================

export const MULTI_SCENARIOS: SimScenario[] = [
  {
    id: "multi-three-standoff",
    group: "multi",
    title: "三方对峙：两个目标冲突的配角夹着主角",
    cases: [
      {
        label: "收账现场来了担保人",
        ticks: 6,
        actors: [
          {
            npc: "Kovind",
            goal: "今天必须把钱拿到手；那个担保人要是护着他，连她一起算账。",
          },
          {
            npc: "Philip Scaletta",
            goal: "再拖一次，把担保人推到前面挡着，自己找机会溜。",
          },
          {
            npc: "Angela",
            goal: "这笔账是你担保的。别让场面见血——见血这条街生意全完，想办法把事压下去。",
          },
        ],
      },
      {
        label: "盘问时上司在场",
        ticks: 6,
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "当面问清他那批证物的签收去向，谁打岔都不能停。",
          },
          {
            npc: "Lux Lynch",
            goal: "含糊过去，多看市长的眼色，他兜得住你。",
          },
          {
            npc: "Patrizio von Samsa",
            goal: "把话题从证物上引开，这个警察不能再查下去，但手段要体面。",
          },
        ],
      },
      {
        label: "劝证人出庭，有人搅局",
        ticks: 6,
        actors: [
          {
            npc: "Mrs. Barklyite (Lucia Shiny)",
            goal: "把利害一条条摆清楚，让老站务答应出庭；那个混混在旁边捣什么鬼，别让他得逞。",
          },
          {
            npc: "Haran Greenwood",
            goal: "两头都不想得罪，也怕真惹上麻烦——找个由头把这场谈话应付过去，别点头答应，也别把哪边惹毛了。",
          },
          {
            npc: "Philip Scaletta",
            goal: "受人之托：想办法让老头别出庭，吓唬也行，许好处也行。",
          },
        ],
      },
      {
        label: "处置伤员，家属不让碰",
        ticks: 6,
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "她的伤口必须现在处理，说服那个挡在床前的男人让开。",
          },
          {
            npc: "Nancy Charlotte",
            goal: "胳膊疼得厉害，但更怕这两个人吵起来。",
            hp: 7,
            conditions: ["左前臂一道深割伤，草草缠了块布，还在渗血"],
          },
          {
            npc: "Johnny",
            goal: "你不信这个医院——上次进来的人没能出去。拦着，要带她走。",
          },
        ],
      },
      {
        label: "一块石板两个买家",
        ticks: 6,
        actors: [
          {
            npc: "Solomon",
            goal: "决定这块石板卖不卖、卖给谁——出高价的那位来路不明，压价的这位是老主顾。",
          },
          {
            npc: "Marks White",
            goal: "用老交情把价压下来，这块石板转手就是三倍利。",
          },
          {
            npc: "Angela",
            goal: "当场出三倍价买下这块石板，别让那个钟表匠截走。",
          },
        ],
        sceneItems: ["symbol"],
      },
    ],
  },
  {
    id: "multi-move-together",
    group: "multi",
    title: "两人同行：目标绑定彼此，一起赶到另一栋楼",
    targetDefs: ["movement"],
    cases: [
      {
        label: "院长送伤员转院",
        ticks: 10,
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "这里的设备处理不了她的伤，亲自把她送到{{destName}}，路上一步都不能离开她。",
          },
          {
            npc: "Nancy Charlotte",
            goal: "跟着院长去{{destName}}处理伤口，路上别掉队。",
            hp: 8,
            conditions: ["右手掌割伤，缠着绷带，还能走路"],
          },
        ],
      },
      {
        label: "打手护送交货",
        ticks: 10,
        actors: [
          {
            npc: "Kovind",
            goal: "老板的令：把安吉拉平安送到{{destName}}，人在货在。现在就动身。",
          },
          {
            npc: "Angela",
            goal: "跟着打手去{{destName}}交货，路上贴着他走，别单独行动。",
          },
        ],
      },
      {
        label: "侦探转移证人",
        ticks: 10,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "这里已经不安全了。现在就带着他转移到{{destName}}，别走散。",
          },
          {
            npc: "Philip Scaletta",
            goal: "有人要灭你的口，跟紧这位侦探去{{destName}}，她去哪你去哪。",
          },
        ],
      },
      {
        label: "站务领客人去取件",
        ticks: 10,
        actors: [
          {
            npc: "Haran Greenwood",
            goal: "这位客人不认路，亲自把他领到{{destName}}，交到人手里再回来。",
          },
          {
            npc: "Marks White",
            goal: "跟着站务去{{destName}}取那只座钟，别自己乱走。",
          },
        ],
      },
      {
        label: "搭档一起赶现场",
        ticks: 10,
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "调度要你们两个立刻赶到{{destName}}，带上搭档一起走，谁都不许单独行动。",
          },
          {
            npc: "Lux Lynch",
            goal: "跟着搭档去{{destName}}，千万别落单——你现在最怕一个人。",
          },
        ],
      },
    ],
  },
  {
    id: "multi-move-chase",
    group: "multi",
    title: "一追一逃：一个要走，一个要跟住",
    targetDefs: ["movement", "track", "stealth"],
    cases: [
      {
        label: "混混甩债主",
        ticks: 10,
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "趁他没堵住门，现在就动身去{{destName}}避风头，把他甩掉。",
          },
          {
            npc: "Kovind",
            goal: "盯死他。他今天去哪你去哪，别让他从你眼皮底下消失。",
          },
        ],
      },
      {
        label: "毒贩觉出被盯梢",
        ticks: 10,
        actors: [
          {
            npc: "Angela",
            goal: "街面上像是有人在盯你送货的路子，保不齐是市长那边的眼线。趁现在还没被咬住，把货送到{{destName}}，越快越好。",
          },
          {
            npc: "Lux Lynch",
            goal: "市长要你盯死这个女人，看她到底把货送到哪儿——这差事你不想接，但不能不办，交不出结果他饶不了你。",
          },
        ],
      },
      {
        label: "猎人盯梢老对头",
        ticks: 10,
        actors: [
          {
            npc: "Johnny",
            goal: "又是这个混混——上次他敢骚扰海伦，这次躲躲闪闪的准没干净事。他去哪你跟到哪，弄清他到底在搞什么。",
          },
          {
            npc: "Philip Scaletta",
            goal: "办完这单就走：现在动身去{{destName}}，路上少跟人搭话。",
          },
        ],
      },
      {
        label: "侦探盯市长",
        ticks: 10,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "远远跟住市长，看他今晚到底去哪、见谁，绝不能被他发现。",
          },
          {
            npc: "Patrizio von Samsa",
            goal: "现在动身去{{destName}}赴一场不想让人知道的会面，路上留意有没有人跟着。",
          },
        ],
      },
      {
        label: "警探追嫌疑人",
        ticks: 10,
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "她一动你就跟上，人赃俱获之前不要打草惊蛇。",
          },
          {
            npc: "Angela",
            goal: "货不能留在身上。立刻动身把它送到{{destName}}，越快越好。",
          },
        ],
      },
    ],
  },
];
