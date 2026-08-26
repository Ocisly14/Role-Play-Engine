// scripts/fixtures/agentDecisionCases/core.ts

import type { SimScenario } from "./types.js";

// =========================================================================
// LAYER 2 — engine action definitions
// =========================================================================

export const CORE_SCENARIOS: SimScenario[] = [
  {
    id: "def-movement",
    group: "core",
    title: "跨场景赶路 → movement",
    targetDefs: ["movement"],
    cases: [
      {
        label: "警探：调度让他去现场",
        ticks: 6,
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "马上赶到{{destName}}，那边出事了；这里没有别的事需要你。",
          },
        ],
        openingEvent: {
          description:
            "无线电里传来调度的呼叫：{{destName}}那边出事了，要你立刻过去",
          impact: 2,
        },
      },
      {
        label: "毒贩：交货时间到了",
        ticks: 6,
        actors: [
          {
            npc: "Angela",
            goal: "十五分钟内赶到{{destName}}交货，晚了对方会翻脸；这里已经没有你要等的人。",
          },
        ],
      },
      {
        label: "老站务：交班后回住处",
        ticks: 6,
        actors: [
          {
            npc: "Haran Greenwood",
            goal: "接班的人已经到了，值班簿也签了字，现在动身回{{destName}}，别在外面多待。",
          },
        ],
      },
      {
        label: "花店少女：亲自送花过去",
        ticks: 6,
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "花已经扎好，收花人在{{destName}}等着；亲自把花送过去。",
          },
        ],
      },
      {
        label: "打手：老板叫他过去",
        ticks: 6,
        actors: [
          { npc: "Kovind", goal: "老大让你现在就去{{destName}}，别让他等。" },
          { npc: "Philip Scaletta", goal: "别惹这个人，等他走了再说。" },
        ],
      },
    ],
  },
  {
    id: "def-character_interaction",
    group: "core",
    title: "向同场景的人问话 → character_interaction",
    targetDefs: ["character_interaction", "charm"],
    cases: [
      {
        label: "侦探：赶在对方走之前问话",
        ticks: 6,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "他是昨晚唯一在现场的人。在他走之前问清楚昨晚到底发生了什么。",
          },
          { npc: "Philip Scaletta", goal: "收拾东西赶紧走，别被问昨晚的事。" },
        ],
      },
      {
        label: "书商：问客人书的来路",
        ticks: 3,
        actors: [
          {
            npc: "Solomon",
            goal: "弄清他手上那本破旧的书是从哪儿来的，再决定收不收。",
          },
          {
            npc: "Marks White",
            goal: "把手上这本旧书卖掉，但别说清它是从哪儿来的。",
          },
        ],
      },
      {
        label: "花店少女：招呼犹豫的客人",
        ticks: 3,
        // Nancy 技能表里最高的是 Charm 65，goal 又是"让人好受一点"——charm.md
        // 的 "win genuine liking through warmth" 正是这个，interpreter 归到
        // charm 或 character_interaction 都合理。
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "让每一个走进店里的人都好受一点；门口那个人站了很久了，去问问她。",
          },
          {
            npc: "Shandra Hernandez",
            goal: "在白花那一排前面站着，一时不知道该不该进去。",
          },
        ],
      },
      {
        label: "律师：向当事人确认事实",
        ticks: 3,
        actors: [
          {
            npc: "Mrs. Barklyite (Lucia Shiny)",
            goal: "在写进辩护意见之前，把那晚的每一个时间点都当面问清楚。",
          },
          { npc: "Lux Lynch", goal: "该说的都说了，别再多说；含糊过去就行。" },
        ],
      },
      {
        label: "老站务：提醒站台上的乘客",
        ticks: 3,
        actors: [
          {
            npc: "Haran Greenwood",
            goal: "那位乘客在等的那班车今晚改点了，该说的还是要说一句，别让人白等。",
          },
          { npc: "Nancy Charlotte", goal: "拎着箱子等车，低头看时刻表。" },
        ],
      },
    ],
  },
  {
    id: "def-item_exchange",
    group: "core",
    title: "把东西交到对方手上 → item_exchange",
    // item_exchange 是唯一 outputSchema 带 item.move 的定义；若 interpreter 把
    // 这类意图归到 character_interaction，物品不会真的换手——总结里会显示成
    // "说了但世界没动"，那是引擎侧值得注意的现象，不是布景问题。
    targetDefs: ["item_exchange"],
    cases: [
      {
        label: "钟表匠：把钥匙交出去",
        ticks: 6,
        actors: [
          {
            npc: "Marks White",
            goal: "他要那把黄铜钥匙才能打开柜子；把钥匙交给他，让他自己去取。",
            items: ["key"],
          },
          { npc: "Philip Scaletta", goal: "拿到那把黄铜钥匙去开柜子。" },
        ],
      },
      {
        label: "院长：把急救包递过去",
        ticks: 6,
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "把急救包交给伸手来要的南希——她自己划伤了手，血一直没止住。",
            items: ["kit"],
          },
          {
            npc: "Nancy Charlotte",
            // 原来的 goal 让她去救一个场上并不存在的"伤者"，感知会和目标打架。
            goal: "手掌被割开了一道口子，血一直往外冒；跟院长要那只急救包。",
            conditions: ["右手掌被划开一道口子，血一直渗出来"],
          },
        ],
      },
      {
        label: "毒贩：一手交货",
        ticks: 6,
        actors: [
          {
            npc: "Angela",
            goal: "钱已经收了，把储物柜的黄铜钥匙交给买家，钱货两清，别多说一个字。",
            items: ["key"],
          },
          { npc: "Kovind", goal: "钱付了，等着拿到储物柜钥匙。" },
        ],
      },
      {
        label: "混混：把笔记本交出去了事",
        ticks: 6,
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "他比你壮一圈，把那本线索笔记本给他把事了了，先保住自己。",
            items: ["notebook"],
          },
          {
            npc: "Kovind",
            goal: "拿到那本线索笔记本，这事就算了；拿不到就动手。",
          },
        ],
      },
      {
        label: "花店少女：把钥匙还给客人",
        ticks: 6,
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "客人把黄铜钥匙落在柜台上了，他就站在面前，把钥匙还给他。",
            items: ["key"],
          },
          { npc: "Haran Greenwood", goal: "取回落在花店柜台上的钥匙。" },
        ],
      },
    ],
  },
  {
    id: "def-action",
    group: "core",
    title: "就地摆弄/阅读物件 → action",
    targetDefs: ["action", "movement"],
    cases: [
      {
        label: "书商：读桌上那本笔记",
        ticks: 3,
        actors: [
          {
            npc: "Solomon",
            goal: "把桌上那本线索笔记本从头到尾读一遍，看看上面记了什么。",
          },
        ],
        sceneItems: ["notebook"],
      },
      {
        label: "老站务：把灯点上",
        ticks: 3,
        actors: [
          {
            npc: "Haran Greenwood",
            goal: "电灯又跳闸了，先把桌角那盏旧煤油灯点上，别摸黑。",
          },
        ],
        sceneConditions: [
          "电灯跳闸，屋里一片漆黑，桌角有一盏还有油的旧煤油灯和一盒火柴",
        ],
      },
      {
        label: "钟表匠：把工具收起来",
        ticks: 3,
        actors: [
          {
            npc: "Marks White",
            goal: "把工作台上摊开的那套撬锁工具收进抽屉锁好，别让进店的人看见。",
          },
        ],
        // 道具要么在场景里、要么在背包里，不能一边写进 inventory 一边说"摊在台面上"。
        sceneItems: ["lockpick"],
        sceneConditions: [
          "工作台上摊着一排镊子和螺丝刀，撬锁工具包敞着口摆在旁边",
        ],
        // 「有人正在上楼」原本没有任何配角或事件支撑，主角感知里根本没这个人。
        openingEvent: {
          description: "楼下门铃响了，有人推门进店，脚步声正往这边过来",
          impact: 2,
        },
      },
      {
        label: "花店少女：搬花进屋避寒",
        ticks: 3,
        // "搬进屋里"跨了门内外，interpreter 可能顺手拆出一个 movement step。
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "温度还在往下掉，把门口那几桶花搬进屋里，别让它们冻坏。",
          },
        ],
        sceneConditions: ["门口几桶花已经开始打蔫，屋里的暖气还开着"],
      },
      {
        label: "警探：把笔记本收进证物袋",
        ticks: 3,
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "桌上那本线索笔记本的字迹和现场留下的字条很像，把它作为证物妥善收起来。",
          },
        ],
        sceneItems: ["notebook"],
      },
    ],
  },
];
