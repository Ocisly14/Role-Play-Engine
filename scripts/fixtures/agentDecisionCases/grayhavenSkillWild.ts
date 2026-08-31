// scripts/fixtures/agentDecisionCases/grayhavenSkillWild.ts
//
// Grayhaven skill-domain cases — THE WILD (Survival & Navigation, Watercraft
// Operation, Occult). Three scenarios, three personas each: someone the
// domain is second nature to, someone untrained pushed into it by
// circumstance, and someone whose situation calls for it but whose instincts
// may not reach for it.
//
// Cognitive layering red line: the forest beyond 灰溪渡口 (creek_ford) —
// fog_hollow / redwood_ring / railbed / sawmill — is only ever named in a
// goal for Earl, Ray, or the kid trio (Tommy/Denny/Priya, and only as far as
// the sawmill). Everyone else's goal stops at 林道口 (trailhead); getting
// properly lost past that point is the intended record, not a bug to fix.
// Redley Station stays rumor-level throughout — nothing here asserts it is
// real.
//
// Topology checked against testmods/grayhaven/Grayhaven_Scenarios/*.json:
//   SCN_trailhead(林道口) --70m--> SCN_creek_ford(灰溪渡口) --110m-->
//   SCN_fog_hollow(雾谷) --50m--> SCN_redwood_ring(红杉环) --130m-->
//   SCN_fence(围栏); SCN_trailhead --60m--> SCN_railbed(旧铁路路基)
//   --120m--> SCN_sawmill(旧锯木厂) --60m--> SCN_fog_hollow;
//   SCN_dock(码头与海滩) --30m--> SCN_lighthouse_cliff(灯塔崖), with
//   SCN_earl_cabin off a 15%-mark turnoff on that same road.
// Skill values checked against testmods/grayhaven/grayhaven_npc/*.json.

import type { SimScenario } from "./types.js";

export const GRAYHAVEN_SKILL_WILD: SimScenario[] = [
  // -----------------------------------------------------------------------
  {
    id: "gh-skill-survival-nav",
    group: "skill",
    title:
      "Survival & Navigation：雾谷四岔、灰溪涨水——灰港的林子只认记忆，不认运气",
    targetDefs: ["Survival & Navigation"],
    cases: [
      {
        // 老手：Earl（Survival & Navigation 80）。雾谷是舞台招牌——四条岔口
        // 在雾里长得一模一样。他的地图记忆里有全部四条路的耗时，长期意图
        // 直接对接他角色卡的 longTermIntent（雾里的灯光究竟是什么）。
        label: "Earl｜雾谷四岔：雾里瞥见一点不该有的光，认对岔口才追得上",
        ticks: 8,
        scene: "雾谷",
        actors: [
          {
            npc: "npc_earl_pruitt",
            goal: "起了这么大的雾，你却在谷底瞥见一点忽明忽暗的光——不是四条岔路里哪一条正常该有的东西，一眨眼又快被雾吞掉了。趁它还没全灭，认准是哪个岔口，追上去看清楚。",
          },
        ],
        sceneConditions: [
          "谷底的雾比你上次进来时还厚，十步外只剩树影的轮廓",
          "潭边的石头上有一小片新踩过的青苔痕迹，方向说不准",
        ],
      },
      {
        // 无训练硬上：Susan Holt（Survival & Navigation 未训练），Denny 的
        // 母亲。红线：她这辈子没进过林道口一步，goal 里只认得"林道口"，
        // 深处任何地名都不出现——迷路本身就是这个 case 的戏。
        label: "Susan｜只认得林道口的母亲，天黑前被逼着往林子边上闯",
        ticks: 8,
        scene: "林道口",
        actors: [
          {
            npc: "npc_susan_holt",
            goal: "天都快黑透了，Denny 还没回家吃饭。邻居说傍晚看见他往林道口那边跑，后来就没人再瞧见。你这辈子没在这片林子里走过一步，可现在没人能替你去找他——趁天还没全黑，自己往林子边上闯一闯，把他找回来。",
          },
        ],
        sceneConditions: [
          "天色已经暗下来一半，红杉的影子把林道口罩得比镇上暗得多",
          "步道登记箱的登记表被风掀起一角，最新一行的字迹认不出是谁写的",
        ],
      },
      {
        // 情境召唤：孩子团在锯木厂线附近（红线许可的最深处）。Tommy 是
        // "先跳后看"的行动派——面对天黑前认路回家这件事，他的本能未必是
        // 停下来辨认方向。Denny 作为同伴列进 actors，因为他确实在场。
        label: "Tommy+Denny｜前进营地天快黑了，认路回家这件事他俩接不接",
        ticks: 7,
        scene: "旧锯木厂",
        actors: [
          {
            npc: "npc_tommy_reyes",
            goal: "太阳已经斜到树梢那头，你和 Denny 说好日落前回到镇上，可你俩还窝在前进营地舍不得走。该往回走了——林子里哪个方向看着都差不多，岔路也不止一条，天黑之前你得把自己和 Denny 都带回镇上。",
          },
          {
            npc: "npc_denny_holt",
            goal: "Tommy 还不想走，可你答应过妈妈日落前到家，而且你不喜欢天黑以后待在这儿。你的胆子没 Tommy 大，但你脑子里记得来的时候路是怎么走的。",
          },
        ],
        sceneConditions: [
          "野黑莓丛的枝条被扒拉得东倒西歪，指尖染紫的痕迹还在",
          "光线已经在往下暗，锯台上的苔藓看不清纹路了",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "gh-skill-watercraft",
    group: "skill",
    title: "Watercraft Operation：码头系泊的渔船——没油，桨在舱里，雾在涨潮",
    targetDefs: ["Watercraft Operation"],
    cases: [
      {
        // 老手：Earl（Watercraft Operation 75，前灯塔守）。直接对接他角色卡
        // 里已有的具体观测记录（六月十二日南偏西南两英里处的灯光），给出
        // 划船出海的正当理由和真实压力：雾随时会全罩住，机会只有今晚。
        label: "Earl｜雾还没全罩住，划出去把方位看准这一次",
        ticks: 9,
        scene: "码头",
        actors: [
          {
            npc: "npc_earl_pruitt",
            goal: "雾正涨潮，你合计着南偏西南两英里外那盏灯今晚说不定又亮——从崖上看不真切。趁雾还没把海面全罩住，把船划出去，这次把方位看准了。你不年轻了，可这个雾今晚可能就这一次。",
          },
        ],
        sceneConditions: [
          "海雾已经吞掉了防波堤，几条系泊的渔船只剩模糊的轮廓",
          "浪比平时急了一截，系缆桩上的缆绳绷得很紧",
        ],
      },
      {
        // 无训练硬上：Cole Baxter（Watercraft Operation 5，副警长，认真过
        // 头）。压力给足：雾里有人在水面上喊救命，此刻没有旁人。
        label: "Cole｜雾里有人在水面喊救命，这会儿没别人在场",
        ticks: 8,
        scene: "码头",
        actors: [
          {
            npc: "npc_cole_baxter",
            goal: "雾里传来一声压着水声的喊叫，断断续续，像是海面上有人。这会儿码头上没有别的人，你穿着这身警服也顾不上想别的——把那条系着的小渔船解开推下水，划过去看清楚。",
          },
        ],
        sceneConditions: [
          "晒网架上的旧网被风吹得晃了一下，麻绳发出干涩的响声",
          "蟹笼堆的影子在雾里连成一片，看不出堆到哪儿算完",
        ],
        openingEvent: {
          description:
            "浓雾笼罩的海面上传来一声压着水声的呼喊，断断续续，听不清喊的是什么，又沉了下去",
          impact: 2,
        },
      },
      {
        // 情境召唤：Vance（Watercraft Operation 10，自认为的外勤特工，习惯
        // 把一切当评估）。崖间小径是码头到灯塔崖/Earl 小屋唯一的陆路，雾
        // 天走的人不算少；码头这几条船就在手边，但他从没划过船。goal 不
        // 替他做选择，只把两条路都摆出来——观察他接不接桨。
        label: "Vance｜想神不知鬼不觉摸到崖那头，船就在手边，可他没划过",
        ticks: 8,
        scene: "码头",
        actors: [
          {
            npc: "npc_vance",
            goal: "你想不声张地摸到灯塔崖那头看看。崖间小径是唯一的陆路，可雾天照样有人走动，脚步声在雾里传得远。码头这几条渔船就在手边——但你从没划过船，桨声传得比脚步声更远，划不好还会把自己晾在水面上。",
          },
        ],
        sceneConditions: [
          "系缆桩上刻着几代渔船的葡语船名，深浅不一",
          "雾从海面压过来，先吞掉了防波堤那一段",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "gh-skill-occult",
    group: "skill",
    title: "Occult：雾灯传说的活档案——民俗层面，从不是超自然实证",
    targetDefs: ["Occult"],
    cases: [
      {
        // 老手：Dolores（Occult 45），雾灯传说的活档案之一。直接对接她角色
        // 卡里的外祖母传说记忆和"堂座灯闪、收音机串台"的既有事实，民俗层
        // 面的辨认，不涉及任何超自然实证。
        label: "Dolores｜柜台收音机又抽了一下，跟外婆讲的调门一样",
        ticks: 7,
        scene: "堂座",
        actors: [
          {
            npc: "npc_dolores_medeiros",
            goal: "柜台收音机忽然抽了一下，冒出一小段不像哪个台该有的杂音——跟去年冬天以来那几次一个调门。外婆当年讲雾灯故事时，声音里就是这个味道。你想弄清楚这跟老故事是不是一码事，但打烊前你不打算让哪个客人看出你心里咯噔了一下。",
          },
        ],
        sceneConditions: [
          "点心柜的灯忽明忽暗地闪了两下，又稳住了",
          "堂座里几张卡座还坐着客人，没人像是注意到了",
        ],
        openingEvent: {
          description:
            "柜台收音机毫无征兆地窜出一段有规律的杂音——嗒、嗒嗒、嗒——持续了几秒，又变回正常的电台声，好像什么都没发生过",
          impact: 2,
        },
      },
      {
        // 无训练硬上：Ray（Occult 未训练，警长），三十六年来一直把这类
        // 报案轻轻滑走的人。这次 Cole 站在旁边等他开口，逼他真的看一次。
        // 红线：只到"这跟我记档的调门一样"的谈资级，不去坐实雷德利站。
        label: "Ray｜调度电台又响了那种调门，这次 Cole 就站在旁边等你开口",
        ticks: 7,
        scene: "警长办公室·前厅",
        actors: [
          {
            npc: "npc_ray_holt",
            goal: "调度电台里那阵不像杂音的杂音，Cole 就站在旁边等你说句话——这次别再说线路老、天气潮，把它当回事听一遍，弄清楚那到底是什么调门。",
          },
          {
            npc: "npc_cole_baxter",
            goal: "调度电台的杂音这次不对劲，跟你归档的那些「怪事报案」是一个调门。你想让警长真正听一次，别又被三言两语打发走。",
          },
        ],
        sceneConditions: [
          "事件报告档案柜的抽屉没关严，露出一截贴着日期标签的报告",
          "咖啡壶续了新的一壶，没人顾得上喝",
        ],
        openingEvent: {
          description:
            "调度电台里钻出一阵有规律的杂音——嗒、嗒嗒、嗒——持续了几秒，又变回平常的静电声",
          impact: 2,
        },
      },
      {
        // 情境召唤：Dev Batra（Occult 未训练，只信测量和维修记录的方法论
        // 者）。撞见怪事，本能却是找理性解释——这正是这个人设的看点。
        label: "Dev｜正修的电视雪花屏浮出规律图案，他的本能是先查线路",
        ticks: 7,
        scene: "店堂工作台",
        actors: [
          {
            npc: "npc_dev_batra",
            goal: "手里这台正在修的电视，雪花屏里忽然浮出一个有规律的图案——不属于任何一个频道该有的信号，持续了几秒又化回雪花，好像什么都没发生过。这单排到下个月都排不完，这台不能耽误——先弄清楚这机器到底是哪儿出了毛病。",
          },
        ],
        sceneConditions: [
          "维修记录本摊在台面上，最近几个月「雪花屏」和「串台」的条目挤成一片",
          "窗台收音机调在 KGRV，音量不大，混着烙铁的松香味",
        ],
        openingEvent: {
          description:
            "工作台上那台正在修的电视，雪花屏里忽然浮出一个有规律的图案，不像任何频道该有的信号，持续了几秒又化回雪花，好像什么都没发生过",
          impact: 2,
        },
      },
    ],
  },
];
