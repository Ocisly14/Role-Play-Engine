// scripts/fixtures/agentDecisionCases/grayhavenSetting.ts
//
// Bluebird diner, authored as setting + props (schema v3 demo —
// docs/superpowers/specs/2026-11-18-setting-and-props-design.md). Each case
// puts a character where a loose thing, or a thing in a container, is the
// point of the minute:
//
//   gh-setting-glass-case  蛋挞在玻璃点心柜里（透明容器）：渲染器写出来 → 能指着它点单
//   gh-setting-till        收银机抽屉合着：打开抽屉才看见现金和赊账纸条；放回去走 place，不改布景
//   gh-setting-kitchen     后厨道具：火柴（灶边）点坏了点火器的灶、刀座里的老鱼刀剖鱼；用完放回原处
//   gh-setting-upstairs    楼上床头柜：老花镜、止痛片；把信收进衣柜 = 放进容器
//
// What to read in each record (NO grading): which [item.*] tags the rendered
// paragraph carries; whether the actor cites a prop it was shown; the Engine's
// itemChanges (move / place with placement + container) and whether any
// sceneChanges setSetting appears — none should, nothing here changes the
// place itself.
//
// Things in a container are judged by the renderer: it is handed what is out
// of plain view with the container's own description and decides whether
// this viewpoint perceives it this minute. Read the dumped renderer inputs
// and outputs (--dump-prompts) to check it never writes what a closed
// drawer hides.

import type { SimScenario } from "./types.js";

export const GRAYHAVEN_SETTING: SimScenario[] = [
  {
    id: "gh-setting-glass-case",
    group: "world",
    title: "透明容器：生客想吃点东西，蛋挞在玻璃点心柜里",
    targetDefs: [],
    cases: [
      {
        label: "Vance+Dolores｜点心柜里的蛋挞（container = pastry_case，×18）",
        ticks: 8,
        scene: "堂座",
        actors: [
          {
            npc: "npc_vance",
            goal: "赶了一天路还没吃东西。在这家餐馆坐到柜台前，看看有什么现成能吃的，点一份，吃完再走。",
          },
          {
            npc: "npc_dolores_medeiros",
            goal: "照常看店。有客人坐到柜台前就招呼他，他要什么就给他拿什么。",
          },
        ],
      },
    ],
  },
  {
    id: "gh-setting-till",
    group: "world",
    title: "合着的抽屉：打烊前清点收银机",
    targetDefs: ["Investigation"],
    cases: [
      {
        label: "Dolores｜打开收银机清点现金和赊账（container = cash_register）",
        ticks: 14,
        scene: "堂座",
        actors: [
          {
            npc: "npc_dolores_medeiros",
            goal: "该打烊了。把收银机的抽屉打开，点清今天的现金，把赊账的纸条也过一遍，看谁欠得最久——点完照原样收好。",
          },
        ],
      },
    ],
  },
  {
    id: "gh-setting-kitchen",
    group: "world",
    title: "后厨道具：点坏了点火器的灶、用老鱼刀剖鱼",
    targetDefs: ["Knowledge & Craft"],
    cases: [
      {
        label: "Anita｜火柴（灶边）+ 老鱼刀（刀座里），用完放回原处",
        ticks: 20,
        scene: "后厨",
        actors: [
          {
            npc: "npc_anita_batra",
            goal: "明早的炖鱼汤今晚就得把鱼收拾好。灶有一个点火器坏了；先把灶点着烧水，再拿刀把冷柜里的鱼剖干净。收拾完，用过的东西放回原来的地方。",
          },
        ],
      },
    ],
  },
  {
    id: "gh-setting-upstairs",
    group: "world",
    title: "楼上床头：止痛片和老花镜；把信收进衣柜",
    targetDefs: [],
    cases: [
      {
        label: "Dolores｜床头柜上的道具 + 把来信收进衣柜（放进容器）",
        ticks: 14,
        scene: "蓝鸟餐馆·楼上住处",
        actors: [
          {
            npc: "npc_dolores_medeiros",
            goal: "头又疼了。找片止痛药吃了，戴上老花镜把最近那封信再读一遍；读完把那一叠信收进衣柜里，别摊在外头。",
          },
        ],
      },
    ],
  },
];
