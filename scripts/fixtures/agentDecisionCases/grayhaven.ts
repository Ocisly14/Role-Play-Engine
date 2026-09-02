// scripts/fixtures/agentDecisionCases/grayhaven.ts
//
// Grayhaven (灰港镇) case table — a COMPACT smoke suite for the current
// engine architecture on the new module, selected by `--module grayhaven`.
// Eight scenarios, one case each, ~50 ticks total. Each case aims at one
// thing the new architecture does differently:
//
//   gh-street-node    顶层街面场景：可站立、可感知、可相遇（junction 已并入场景）
//   gh-cross-town     跨场景寻路：室内 → 街面节点 → 另一栋楼（抬升边/新拓扑）
//   gh-hidden-clue    hidden 物品：揭示前不可引用，Engine 全知可揭示
//   gh-skill-17       17 域技能声明，无 legacy 兜底
//   gh-stranger-alias 陌生人别名（stranger_a）：Vance 对全镇、全镇对 Vance
//   gh-write-memory   异常刺激 → writeMemory（opening event 走 scripted-event 路径）
//   gh-drive-truck    载具日常：上车（position→驾驶室）→ 说出路线 → Engine 标注
//                     movement.vehicleId → 车按 driveTimeMinutes 走、人不动
//   gh-sanity-check   恐怖揭示 → Engine 声明 sanityChecks → 代码掷骰并结算
//
// 技能层（grayhavenSkill*.ts，每域一景三人设：老手/无训练硬上/情境召唤）：
//   荒野 Survival & Navigation / Watercraft Operation / Occult
//   专业 Medicine & Psychology / Knowledge & Craft / Science & Nature
//   暗面 Stealth & Security / Languages / Ranged Combat
// 刻意缺席（cassandra 同款原则——没有舞台就不造舞台）：
//   Melee Combat（日常小镇无自然打斗）、Swimming（冷雾海无正当下水理由）、
//   Aircraft Operation（无飞行器）。凑数造景正是这张表要抓的 bug。
//
// Same rules as the casssandra table: NO GRADING — each run yields an
// objective record for a human to read. Goals become `long_term_intent`
// memories, the production path.

import type { SimScenario } from "./types.js";
import { GRAYHAVEN_SKILL_PRO } from "./grayhavenSkillPro.js";
import { GRAYHAVEN_SKILL_SHADOW } from "./grayhavenSkillShadow.js";
import { GRAYHAVEN_SKILL_WILD } from "./grayhavenSkillWild.js";

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
    title: "街面节点：两个孩子在主街北口相遇后去街机厅",
    targetDefs: ["Athletics"],
    cases: [
      {
        label: "Tommy+Denny｜顶层场景可站立/感知/结伴移动",
        ticks: 6,
        scene: "主街北口",
        actors: [
          {
            npc: "npc_tommy_reyes",
            goal: "妈妈准了你半小时假。你和 Denny 约好在主街北口碰头，一起去街机厅打《星港》里那台新街机。",
          },
          {
            npc: "npc_denny_holt",
            goal: "你兜里揣着攒了两周的二十五美分硬币，和 Tommy 约在主街北口碰头，一起去街机厅。",
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
    id: "gh-drive-truck",
    group: "core",
    title: "载具日常：Frank 开货车去中转棚提货",
    targetDefs: ["Land Vehicle Operation"],
    cases: [
      {
        // 观察点（不评分，逐条人读）：
        //   1. 上车 = Engine 的 character.position delta 进 SCN_truck_cab；
        //      到位后 Engine 应按新规则给他安置一个舱内 spot
        //   2. 开车的 act 里他有没有【说出路线】——他的档案 map 记忆里有
        //      完整送货动线，goal 故意只说"去提货"不给路
        //   3. Engine 标注 movement.vehicleId + route；运行时只发
        //      vehicle.position（霍尔特巷 2′ + 旧海岸公路 3′，驾车≈5 tick），
        //      Frank 的 position 全程钉在驾驶室
        //   4. 到场后下车走向中转棚——车留在旅馆前院，路人可见可指
        label: "Frank｜上车→说路线→驾车 5 分钟→到场下车",
        ticks: 12,
        scene: "霍尔特家院门",
        actors: [
          {
            npc: "npc_frank_holt",
            goal: "到点了。像八年来的每个工作日一样：开你的货车去汽车旅馆旁的货运中转棚，把今天要送上山的板条箱装车。雷打不动，越准时越好。",
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
  {
    id: "gh-sanity-check",
    group: "world",
    title: "Sanity：Earl 发现雷德利站保存了他的整个人生",
    targetDefs: [],
    cases: [
      {
        // 这不是 openingEvent.harm：固定扣 SAN 会绕过正在测试的正式链路。
        // Earl 必须先主动读取检索台，World Action Engine 才能在揭示事实的
        // occurrence 上声明 sanityChecks；随后由代码掷 d100、计算损失并
        // 写入有时限的精神状态。SAN 压到 1 是测试夹具：99% 的掷骰会失败，
        // 让摘要稳定显示 SAN 变化和 condition；若恰好掷出 1，可从专用脚本
        // 自动保存的原始 Engine 输出核对 sanityChecks 确实已经声明。
        label: "Earl｜检索台展开一份不可能存在的完整人生记录",
        ticks: 8,
        scene: "雷德利站·档案室",
        actors: [
          {
            npc: "npc_earl_pruitt",
            san: 1,
            goal: "你已经闯进雷德利站档案室。带红环的旧插槽刻着你的名字，中央检索台也在等你靠近。走到台前，亲手调出 Earl Pruitt 的记录并读清楚；无论机器亮出什么，都要确认它究竟保存了你的什么。",
          },
        ],
      },
    ],
  },
  ...GRAYHAVEN_SKILL_WILD,
  ...GRAYHAVEN_SKILL_PRO,
  ...GRAYHAVEN_SKILL_SHADOW,
];
