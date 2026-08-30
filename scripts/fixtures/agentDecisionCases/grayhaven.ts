// scripts/fixtures/agentDecisionCases/grayhaven.ts
//
// Grayhaven (灰港镇) case table — a COMPACT smoke suite for the current
// engine architecture on the new module, selected by `--module grayhaven`.
// Six scenarios, one case each, ~30 ticks total. Each case aims at one thing
// the new architecture does differently:
//
//   gh-street-node    顶层街面场景：可站立、可感知、可相遇（junction 已并入场景）
//   gh-cross-town     跨场景寻路：室内 → 街面节点 → 另一栋楼（抬升边/新拓扑）
//   gh-hidden-clue    hidden 物品：揭示前不可引用，Engine 全知可揭示
//   gh-skill-17       17 域技能声明，无 legacy 兜底
//   gh-stranger-alias 陌生人别名（stranger_a）：Vance 对全镇、全镇对 Vance
//   gh-write-memory   异常刺激 → writeMemory（opening event 走 scripted-event 路径）
//
// Same rules as the casssandra table: NO GRADING — each run yields an
// objective record for a human to read. Goals become `long_term_intent`
// memories, the production path.

import type { SimScenario } from "./types.js";

/** The 14 Grayhaven residents, for --list and --full generation. */
export const GRAYHAVEN_ROSTER: Array<{ id: string; note: string }> = [
  { id: "npc_dolores_medeiros", note: "58 女 · 蓝鸟餐馆老板娘 · 全镇消息中枢" },
  { id: "npc_marisol_reyes", note: "41 女 · 杂货店兼邮局店主 · 账目一丝不苟" },
  { id: "npc_tommy_reyes", note: "12 男 · Marisol 的儿子 · 后仓帮工，好奇心重" },
  { id: "npc_dev_batra", note: "45 男 · 电视维修铺老板 · 全镇唯一懂电子的人" },
  { id: "npc_anita_batra", note: "42 女 · Batra 家主妇 · 厨艺与账目双料好手" },
  { id: "npc_priya_batra", note: "13 女 · Batra 家女儿 · 爱拆收音机" },
  { id: "npc_ray_holt", note: "52 男 · 警长 · Holt 家长子，镇上的定盘星" },
  { id: "npc_frank_holt", note: "47 男 · 承包商/货运司机 · 每周往山上送货" },
  { id: "npc_susan_holt", note: "44 女 · 诊所护士 · Holt 家的当家人" },
  { id: "npc_denny_holt", note: "11 男 · Holt 家小儿子 · 街机厅常客" },
  { id: "npc_cole_baxter", note: "29 男 · 副警长 · 认真但资历浅" },
  { id: "npc_doc_weaver", note: "63 男 · 镇医 · 坐诊兼居住在诊所" },
  { id: "npc_earl_pruitt", note: "71 男 · 退休灯塔守 · 独居崖径旁小屋" },
  { id: "npc_vance", note: "38 男 · 外来者 · 住汽车旅馆，无人认识他" },
];

export const GRAYHAVEN_SCENARIOS: SimScenario[] = [
  {
    id: "gh-street-node",
    group: "multi",
    title: "街面节点：两个孩子在主街北段相遇后去街机厅",
    targetDefs: ["Athletics"],
    cases: [
      {
        label: "Tommy+Denny｜顶层场景可站立/感知/结伴移动",
        ticks: 6,
        scene: "主街北段",
        actors: [
          {
            npc: "npc_tommy_reyes",
            goal: "妈妈准了你半小时假。你和 Denny 约好在主街北段碰头，一起去街机厅打《星港》里那台新街机。",
          },
          {
            npc: "npc_denny_holt",
            goal: "你兜里揣着攒了两周的二十五美分硬币，和 Tommy 约在主街北段碰头，一起去街机厅。",
          },
        ],
      },
    ],
  },
  {
    id: "gh-cross-town",
    group: "core",
    title: "跨场景寻路：从蓝鸟餐馆走到杂货店兼邮局",
    targetDefs: [],
    cases: [
      {
        label: "Dolores｜室内→街面节点→另一栋楼",
        ticks: 6,
        scene: "堂座",
        actors: [
          {
            npc: "npc_dolores_medeiros",
            goal: "早市空档，你要去杂货店兼邮局给波特兰的妹妹寄信，顺便在 Marisol 那儿听听有没有新鲜事。信就揣在围裙口袋里。",
          },
        ],
      },
    ],
  },
  {
    id: "gh-hidden-clue",
    group: "world",
    title: "hidden 物品：账对不上,店堂里藏着重复的进货单",
    targetDefs: ["Investigation"],
    cases: [
      {
        label: "Marisol｜彻查收银台（duplicate_bills 藏在店堂）",
        ticks: 7,
        scene: "兼邮局·店堂",
        actors: [
          {
            npc: "npc_marisol_reyes",
            goal: "上周的账怎么都对不上：进货额比你记得的多出一截。趁店里没客人，你要把收银台、账本和票据彻底翻一遍，找出问题在哪。",
          },
        ],
      },
    ],
  },
  {
    id: "gh-skill-17",
    group: "skill",
    title: "17 域技能声明：修理一台雪花屏电视",
    targetDefs: ["Repair & Engineering"],
    cases: [
      {
        // 4 tick 故意小于修理的默认时长：观察点是 Engine 给这单活定出
        // resolvedDurationTicks，动作以"仍在途"收尾即是预期记录。
        label: "Dev｜Repair & Engineering（无 legacy 兜底）",
        ticks: 4,
        scene: "店堂工作台",
        actors: [
          {
            npc: "npc_dev_batra",
            goal: "工作台上摆着 Reyes 家送来的那台雪花屏电视，约好今天下午来取。你要在这之前把它修好——这单修好了，这个月的房租才不紧张。",
          },
        ],
      },
    ],
  },
  {
    id: "gh-stranger-alias",
    group: "multi",
    title: "陌生人别名：外来者走进蓝鸟餐馆",
    targetDefs: ["Social"],
    cases: [
      {
        label: "Vance+Dolores｜互不相识（stranger_a 引用）",
        ticks: 7,
        scene: "堂座",
        actors: [
          {
            npc: "npc_vance",
            goal: "以过路推销员的身份在餐馆吃份早餐，和老板娘搭上话，顺口打听镇上最近有没有什么反常的事——灯闪、杂音之类。不暴露你的真实来意。",
          },
          {
            npc: "npc_dolores_medeiros",
            goal: "照常开店招呼客人。店里进来一张生面孔——灰港几年没来过生人了，留意他是什么路数。",
          },
        ],
      },
    ],
  },
  {
    id: "gh-write-memory",
    group: "tool",
    title: "异常刺激 → writeMemory：小屋里的收音机自己响了",
    targetDefs: [],
    cases: [
      {
        label: "Earl｜opening event 走 scripted-event 路径",
        ticks: 4,
        scene: "Earl 的小屋",
        actors: [
          {
            npc: "npc_earl_pruitt",
            goal: "照常过一个安静的早晨：烧水、泡茶、听广播里的天气预报。",
          },
        ],
        openingEvent: {
          description:
            "桌上的收音机毫无征兆地自己响了一声，窜出一段不像任何电台的规律性杂音——嗒、嗒嗒、嗒——持续了几秒，又恢复成正常的播报，好像什么都没发生过。",
          impact: 2,
        },
      },
    ],
  },
];
