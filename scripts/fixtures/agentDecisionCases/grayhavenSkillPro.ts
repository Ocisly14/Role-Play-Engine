// scripts/fixtures/agentDecisionCases/grayhavenSkillPro.ts
//
// Grayhaven skill-domain cases — three domains, three personas each (此道
// 老手 / 无训练硬上 / 情境召唤), same pattern as skill.ts but staged on the
// Grayhaven module and its real scenes/items. Every place named in a goal or
// condition was checked against testmods/grayhaven/Grayhaven_Scenarios/ for
// existence, reachability and unique-substring scene matching; every acted-on
// object is a real item of the staged scene (or injected via sceneItems).
//
//   Medicine & Psychology — Weaver treats Denny's asthma in the exam room
//     (老手); Earl patches his own cliff-path gash alone in his cabin with an
//     injected first-aid kit (无训练硬上); Ray sits with a nightmare-shaken
//     Denny at the family table, his instinct is deflection (情境召唤).
//   Knowledge & Craft — Anita diagnoses a failing pastry batch before the
//     fisherman's-festival order (老手); Marisol has to account for an
//     unordered crate in the storeroom against her own ledger (无训练硬上,
//     relatively — lowest Knowledge & Craft of the trio, and the ask is
//     provenance, not arithmetic); Dolores, mid-rush, has a supplier invoice
//     that doesn't balance and a line of customers pulling her attention
//     elsewhere (情境召唤).
//   Science & Nature — Dev reasons about the townwide interference pattern,
//     not just one broken set (老手); Priya, alone in her room, has to
//     characterize a live burst of static with no adult backup (无训练硬上);
//     Weaver's own appointment book shows a rising curve he could read as
//     pure clinic caseload or as a pattern worth explaining (情境召唤).
//
// No Redley Station ground truth and no deep-forest place names appear in
// any goal or condition — the module's zero-truth-layer and cognitive-tier
// rules stay intact.

import type { SimScenario } from "./types.js";

export const GRAYHAVEN_SKILL_PRO: SimScenario[] = [
  // -----------------------------------------------------------------------
  {
    id: "gh-skill-medicine-psychology",
    group: "skill",
    title: "Medicine & Psychology：诊室里的哮喘、崖屋里的伤、饭桌前的噩梦",
    targetDefs: ["Medicine & Psychology"],
    cases: [
      {
        label: "Doc Weaver｜诊室里的哮喘发作（老手）",
        ticks: 7,
        scene: "诊所·诊室",
        actors: [
          {
            npc: "npc_doc_weaver",
            goal: "Denny 定期来复查哮喘，刚在诊查床上坐下没几分钟，就开始喘不上气，脸色一点点发青，一句完整的话都说不全。他爸妈都不在，你得让他撑过这一阵。",
          },
          {
            npc: "npc_denny_holt",
            goal: "你胸口发紧，喘不上气，眼前有点发黑，手指抖得握不住吸入器——你信 Weaver 医生，但这次比平时凶。",
            conditions: ["哮喘急性发作，呼吸急促，脸色发青，说不出完整的句子"],
          },
        ],
        sceneConditions: [
          "诊查床边的输液架和体重秤都在原位，磨砂玻璃窗透进一片均匀的灰光",
          "候诊室那头暂时没有别的病人按铃",
        ],
      },
      {
        label: "Earl Pruitt｜崖径摔伤，屋里没有旁人（无训练硬上）",
        ticks: 6,
        scene: "Earl 的小屋",
        actors: [
          {
            npc: "npc_earl_pruitt",
            goal: "崖径第三个弯回来时你没站稳，右腿被碎石划开一道口子，血还在渗。天黑前你想把它处理妥当——附近没别人，你也不打算为这点事去麻烦谁。",
            hp: 6,
            conditions: ["右小腿有一道割伤，还在渗血，走动时抽痛"],
          },
        ],
        sceneItems: ["kit"],
        sceneConditions: [
          "屋里潮气很重，纸页都有点发软，油布雨衣挂在门后还滴着水汽",
          "灶台上的咖啡壶凉了，没人顾得上生火",
        ],
      },
      {
        label: "Ray Holt｜Denny 从噩梦里惊醒（情境召唤）",
        ticks: 7,
        scene: "Holt 家起居餐厨",
        actors: [
          {
            npc: "npc_ray_holt",
            goal: "Denny 半夜从噩梦里惊醒，缩在餐桌边，手心全是汗，话说到一半又咽回去。Frank 和 Susan 都不在家，只有你在。",
          },
          {
            npc: "npc_denny_holt",
            goal: "你做了个说不清楚的噩梦，心跳还没平复，手一直在抖，可你不想让爷爷追问下去。",
            conditions: ["从噩梦中惊醒，手心冒汗，说话断断续续"],
          },
        ],
        sceneConditions: [
          "橡木长桌上还摆着没收走的晚饭碗碟，壁炉台上 Glen 的新兵照被灯光照得发亮",
          "木壳电视机屏幕关着，没人开它",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "gh-skill-knowledge-craft",
    group: "skill",
    title: "Knowledge & Craft：后厨的配方、后仓的来路不明、堂座的账",
    targetDefs: ["Knowledge & Craft"],
    cases: [
      {
        label: "Anita Batra｜渔汛节点心单前，配方不对劲（老手）",
        ticks: 7,
        scene: "后厨",
        actors: [
          {
            npc: "npc_anita_batra",
            goal: "渔汛节的点心单等着你拍板，新到的一批小豆蔻闻着不像常用的那种，今早试烤的葡式蛋挞也总差点意思。趁 Dolores 还没下来催，你要弄清楚问题出在哪，把节庆的点心救回来。",
          },
        ],
        sceneConditions: [
          "灶上的炖鱼汤咕嘟着，油和糖的香气在后厨两头拉扯",
          "楼梯口挂着 Dolores 换下的围裙，楼上还没有动静",
        ],
      },
      {
        label: "Marisol Reyes｜后仓那箱来路不明的罐头（无训练硬上）",
        ticks: 8,
        scene: "后仓",
        actors: [
          {
            npc: "npc_marisol_reyes",
            goal: "盘点时后仓角落那箱罐头，你翻遍订货单和进货簿都对不上号——但你的账本还摊在店堂柜台上。这批货到底从哪儿来的、能不能算进账，你得弄明白，不然这个月的账又要多一笔说不清的窟窿。",
          },
        ],
        sceneConditions: [
          "高窗只透进一点光，白天也看不真切，箱子侧面的粉笔日期字迹有些模糊",
          "店堂那头传来门铃响了一声，又没人进来",
        ],
      },
      {
        label: "Dolores Medeiros｜供货单价目跳了一截（情境召唤）",
        ticks: 6,
        scene: "堂座",
        actors: [
          {
            npc: "npc_dolores_medeiros",
            goal: "这周的供货单价目跳了一截，你翻着自己那本账本核对，数字兜来兜去总兜不平——可柜台前客人排着队，你没多少功夫细算。",
          },
        ],
        sceneConditions: [
          "咖啡机嘶嘶冒着气，柜台前排队的人已经等得有点不耐烦",
          "点心柜里的葡式蛋挞只剩最后一排",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "gh-skill-science-nature",
    group: "skill",
    title: "Science & Nature：维修铺的干扰、改装收音机、预约簿上的曲线",
    targetDefs: ["Science & Nature"],
    cases: [
      {
        label: "Dev Batra｜串台的干扰到底从哪儿来（老手）",
        ticks: 7,
        scene: "店堂工作台",
        actors: [
          {
            npc: "npc_dev_batra",
            goal: "这几个月雪花屏和串台的报修单堆得反常，可拆开的每台电视本身都挑不出毛病。窗台那台收音机这会儿又串进一段有规律的杂音——趁它还在响，你想把这股干扰到底是什么、从哪个方向来的，弄出个说得过去的解释。",
          },
        ],
        openingEvent: {
          description:
            "窗台收音机的杂音忽然变强，带着一种规律的节奏——嗡、嗡嗡、嗡——持续了几秒又弱下去",
          impact: 2,
        },
        sceneConditions: [
          "工作台上示波器、烙铁架、万用表各归其位，维修记录本摊在台面正中",
          "靠墙待修电视架上，纸签写着的姓氏比往年任何时候都多",
        ],
      },
      {
        label: "Priya Batra｜改装收音机又响了，屋里只有你（无训练硬上）",
        ticks: 7,
        scene: "Priya 的房间",
        actors: [
          {
            npc: "npc_priya_batra",
            goal: "改装收音机又串进那种带节奏的杂音，这次比平时清楚——录音机还没攒好，这可能是凑齐一份没人能反驳的证据的最好机会，可屋里只有你一个人，得赶紧弄明白规律在哪。",
          },
        ],
        openingEvent: {
          description:
            "改装收音机忽然清晰地传出那种带节奏的杂音，比平时响得多，天线在窗框外轻轻震了一下",
          impact: 2,
        },
        sceneConditions: [
          "墙上那张手画的 KGRV 频段刻度表上，铅笔标着几个打问号的位置",
          "证据登记簿摊在台角，翻到 A、B、C 分级那一页",
        ],
      },
      {
        label: "Doc Weaver｜预约簿上的曲线还在爬（情境召唤）",
        ticks: 7,
        scene: "候诊室",
        actors: [
          {
            npc: "npc_doc_weaver",
            goal: "预约簿上「睡不好」和「耳朵嗡嗡响」的登记又多了几行，你自己那本没写名字的统计表这周还没顾上更新。趁两诊之间的空档，你想弄明白这波数字往上爬，到底是巧合，还是背后有一个共同的由头。",
          },
        ],
        sceneConditions: [
          "候诊室里暂时没有病人，长椅上的坐垫还留着上一位的痕迹",
          "墙上从六十年代挂到今天的体检宣传画，纸边卷了角",
        ],
      },
    ],
  },
];
