// scripts/fixtures/agentDecisionCases/grayhavenSkillShadow.ts
//
// Grayhaven skill-domain cases — three domains, three personas each (老手 /
// 无训练硬上 / 情境召唤), staged against the real Grayhaven_Scenarios JSON
// and grayhaven_npc rosters. See scripts/fixtures/agentDecisionCases/skill.ts
// for the pattern this follows and types.ts for the SimCase contract.
//
//   gh-skill-stealth-security  后院豁口的私门 / 雾夜铁皮棚 / 打烊前的临街门
//   gh-skill-languages         孟买来的旧信 / 外婆的葡语食谱 / 看不懂的信封
//   gh-skill-ranged-combat     配枪保养 / 迟来的年检 / 码头蟹笼里的东西
//
// Every place named below was checked against testmods/grayhaven/
// Grayhaven_Scenarios/*.json for existence and reachability; every acted-on
// object is either a real item on that scene's `references.items`, a real
// item already in the actor's own inventory (testmods/grayhaven/
// grayhaven_npc/*.json), or injected via `sceneItems`. No goal names a
// skill — the character picks the approach, the Engine judges it.

import type { SimScenario } from "./types.js";

export const GRAYHAVEN_SKILL_SHADOW: SimScenario[] = [
  // -----------------------------------------------------------------------
  {
    id: "gh-skill-stealth-security",
    group: "skill",
    title: "Stealth & Security：后院豁口、雾夜铁皮棚与打烊前的临街门",
    targetDefs: ["Stealth & Security"],
    cases: [
      {
        // 老手：Vance（Stealth & Security 80）。他的私下记忆里就有这个习惯
        // ——"有些雾夜，我会站着望向中转棚，等一个说不出名字的东西"，外廊
        // 的场景描述也写着"偶尔有人在雾夜里坐在那儿，朝公路岔口的方向望
        // 着"。棚门锁从不锁死，摸过去、看一眼、回来，全程可达且是他自己
        // 的地盘。
        label: "Vance｜雾夜里去看铁皮棚",
        ticks: 7,
        scene: "汽车旅馆外廊",
        actors: [
          {
            npc: "npc_vance",
            goal: "后半夜，你想照老习惯不声不响地摸过公路，到那间铁皮棚跟前，看一眼今晚过手的到底是什么箱子；回来前不能让旅馆或路上任何一个人瞧出你出过门，棚门那把从不锁上的挂锁也不能被碰得走了样。",
          },
        ],
        sceneConditions: [
          "雾比平常更浓，公路对面只剩一团模糊的轮廓",
          "岔路口那盏灯懒洋洋地明灭，暗的间隔比亮的长",
        ],
      },
      {
        // 无训练硬上：Denny（无 Stealth & Security 数值，默认基础值）。他
        // 自己的 secret 记忆写着"我夜里从后院栅栏的豁口溜出去过，没人发
        // 现"，SCN_holt_backyard 的豁口正连到 SCN_trailhead。这次要经过
        // 起居餐厨，Susan 的 map 记忆里明说"就怕哪天夜里 Denny 不打起居
        // 室过，直接从那儿溜出去"——把她钉在同一个房间里，制造"被谁发
        // 现"的对手戏。
        label: "Denny+Susan｜半夜穿过起居室",
        ticks: 6,
        scene: "Holt 家起居餐厨",
        actors: [
          {
            npc: "npc_denny_holt",
            goal: "大伙儿都该睡了，你想不出声地穿过起居室，从后院那道豁口溜出去，趁夜里没人拦着去林道口一趟，天亮前赶回来——而且不能让任何人知道你出过门，尤其是妈妈。",
          },
          {
            npc: "npc_susan_holt",
            goal: "半夜你睡不着，披了件毛衣坐在餐厨的长桌边就着一点光整理心事；家里要是有谁这个点该在床上却不在，你不会假装没看见。",
          },
        ],
        sceneConditions: [
          "橡木长桌上只留着一盏没关的小灯，其余屋子都黑着",
          "后院纱门的弹簧一向松，猛一推会砰地响一声",
        ],
      },
      {
        // 情境召唤：Tommy（Stealth & Security 55，中高但性格是"先跳后看"、
        // 靠胆量下战书）。店堂的临街门挂着铃铛，收银台正对着门——场面明
        // 明需要不动声色，但他的本能未必肯挑这条路，可能直接开口撒谎、
        // 硬闯，而不是真的等一个不被看见的时机。Marisol 在场（对手戏）。
        label: "Tommy+Marisol｜打烊前的临街门",
        ticks: 6,
        scene: "杂货店兼邮局·店堂",
        actors: [
          {
            npc: "npc_tommy_reyes",
            goal: "打烊前你想神不知鬼不觉地从临街那道门溜出去，跟 Denny、Priya 碰头去林道口，可妈妈就坐在收银台后头对账，一抬眼就看得见门口；别让她拦住你，也别让她起疑心。",
          },
          {
            npc: "npc_marisol_reyes",
            goal: "打烊前你想把今天的账彻底对完，愁的是那笔总也说不清的差额；Tommy 这几天早出晚归让你不放心，他要是想趁你不注意溜出去，你不会不管。",
          },
        ],
        sceneConditions: [
          "临街门上那串铃铛只要门一晃就会响，收银台正对着门口",
          "账本摊在收银机旁，铅笔字迹反复擦改，Marisol 头也没怎么抬",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "gh-skill-languages",
    group: "skill",
    title: "Languages：孟买来的旧信、外婆的葡语食谱与看不懂的信封",
    targetDefs: ["Languages"],
    cases: [
      {
        // 老手：Anita（native 是英语/古吉拉特语，learned Hindi 60——一个
        // 真正的"非母语但流利"的语言域数字，母语不判定，这里才是她的
        // 本行）。真实物品：她自己 NPC 档案里的樟木箱（item.batra_master.
        // sari_trunk）已经写明"箱底压着从孟买带来的旧信"，不用另造道具。
        label: "Anita｜樟木箱底那沓旧信",
        ticks: 6,
        scene: "Batra 家·主卧",
        actors: [
          {
            npc: "npc_anita_batra",
            goal: "渔汛节快到了，你想翻樟木箱找那件纱丽出来穿，箱底压着的那沓从孟买带来的旧信却先滑了出来。最上面那封是舅舅去年写的，字迹潦草，你上回读到一半就搁下了、没弄懂后半段说的是什么事——Dev 还在楼下店里忙，你想自己先弄明白。",
          },
        ],
      },
      {
        // 无训练硬上：Priya（learned Hindi 只有 35，比妈妈弱得多）。父母
        // 都在楼下店里忙，一封写着"急"的信直接落到她手上，逼着她自己
        // 先啃一遍。信件用 sceneItems 的 notebook 道具具现（同 skill.ts
        // 里把 symbol/watch 借去表意的做法），并在场景描述里点明它是什
        // 么、写着什么语言——不是布景，是要读的东西。
        label: "Priya｜外婆写着「急」的信",
        ticks: 6,
        scene: "Batra 家·起居厨房",
        actors: [
          {
            npc: "npc_priya_batra",
            goal: "邮差把一封从孟买寄来的信直接交到你手上，信封角上是外婆的笔迹，还画着一个「急」字。爸妈都在楼下应付一堆等修的电视，你不想为一封信喊他们上来白等半天，可你自己认得的字没那么多。",
          },
        ],
        sceneItems: ["notebook"],
        sceneConditions: [
          "餐桌上摊着那封信，信封已经拆开，信纸上密密麻麻是外婆的字，只有末尾几行是英文",
          "灶上的茶壶还温着，楼下传来烙铁碰焊锡的滋滋声",
        ],
      },
      {
        // 情境召唤：Dolores——母语英语与葡语双母语，母语从不判定，这里
        // 的关键不是"她能不能读懂"，而是"她愿不愿意把它摊开在Anita面
        // 前"。真实物品：SCN_bluebird_upstairs 场景本身就有一本"外祖母
        // 传下的葡语手抄食谱"（item.bluebird_upstairs.recipe_book），不
        // 用另造道具。Dolores 的 secret 记忆里她对雾灯故事其实心存忌讳
        // ——场面明明该顺手就翻译给身边的 Anita，她的本能未必肯接。
        label: "Dolores+Anita｜食谱翻到不是食谱的那页",
        ticks: 6,
        scene: "蓝鸟餐馆·楼上住处",
        actors: [
          {
            npc: "npc_dolores_medeiros",
            goal: "你正翻那本外婆传下的手抄食谱，想替渔汛节挑一样新点心方子，Anita 就坐在旁边等你拿主意；翻到中间那页，夹着一段不是配方、是外婆亲笔另外写的话，你的手停了一下。",
          },
          {
            npc: "npc_anita_batra",
            goal: "Dolores 说要在她那本老食谱里给渔汛节挑个新方子，你在旁边等着看她挑；她翻着翻着忽然不说话了，你看得出她翻到了什么不是配方的东西。",
          },
        ],
        sceneConditions: [
          "手抄食谱摊在浆洗桌布上，纸页发脆，蛋挞那一页被翻得最旧",
          "窗边摇椅空着，楼下堂座的动静顺着楼梯隐约传上来",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "gh-skill-ranged-combat",
    group: "skill",
    title: "Ranged Combat：配枪保养、迟来的年检与码头蟹笼里的东西",
    targetDefs: ["Ranged Combat"],
    cases: [
      {
        // 老手：Cole（Ranged Combat 65，认真到近乎刻板）。灰港没有靶场，
        // 用他自己加的保养 + 空枪出枪定位流程立住"本行"，行动对象是他
        // 自己档案里真实的配枪（item.cole.service_revolver）。全程不涉及
        // 对人开枪。
        label: "Cole｜每周的配枪保养",
        ticks: 6,
        scene: "警长办公室·前厅",
        actors: [
          {
            npc: "npc_cole_baxter",
            goal: "每周这个时候，你都要把配枪整个拆开擦一遍、点清弹药数目，再空枪走一遍出枪定位的动作——这套流程规程里没写，是你自己加的，可你想着总有用得上的一天，不想手生。",
          },
        ],
        sceneConditions: [
          "办公桌收拾得像检阅前的营房，笔按长短排列",
          "调度电台大多数时候只应之以杂音",
        ],
      },
      {
        // 无训练硬上：Ray（Ranged Combat 45，配枪保养得很好但"很少愿意
        // 把它从枪套里拿出来"——生疏是性格不是数值）。Cole 把年度检查
        // 摆上桌，逼着他今天当着晚辈的面走一遍流程；对手戏是 Cole。行动
        // 对象是 Ray 自己档案里真实的配枪与备用子弹。不涉及对人开枪。
        label: "Ray+Cole｜轮到你了",
        ticks: 6,
        scene: "警长办公室·里间",
        actors: [
          {
            npc: "npc_ray_holt",
            goal: "Cole 把清单和油布往你桌上一放，说该做年度配枪检查了；你自己的枪有多少年没正经拆开过，你心里有数，可不想在这小子面前显得手生。",
          },
          {
            npc: "npc_cole_baxter",
            goal: "年度配枪检查该在这周做完，你已经把清单和油布摆在了 Ray 桌上；他这些年很少把枪从枪套里请出来，你想请他今天当着你的面走一遍分解、点数、试撞针的流程。",
          },
        ],
        sceneConditions: [
          "窗台上那座钓鱼奖杯氧化发暗，桌上填了一半的填字游戏摊着",
          "上锁的旧案档案柜立在墙角，Ray 从不去开它",
        ],
      },
      {
        // 情境召唤：Earl（Ranged Combat 40，性格是"信观测胜过安慰"，习
        // 惯把一切记进日志本，而不是第一时间声张）。码头蟹笼堆里卡着一
        // 把不该在那儿的手枪——场面明明需要有人上手弄清楚它是什么、该
        // 不该报给 Cole，但他的本能可能是先记下来、留着观察，而不是立
        // 刻处理或声张。手枪用 sceneItems 的 pistol 道具具现（types.ts
        // 里现成的 PropKey）。全程不涉及对人开枪。
        label: "Earl｜蟹笼堆里不该有的东西",
        ticks: 7,
        scene: "码头与海滩",
        actors: [
          {
            npc: "npc_earl_pruitt",
            goal: "退潮这会儿你照常沿码头走一圈，蟹笼堆最底下那层脚边卡着一样不属于渔具的东西，压在干硬的海藻底下，金属反光——弯不弯腰把它弄出来看清楚，自己定；看清楚以后，要不要去跟 Cole 说，也是你自己的事。",
          },
        ],
        sceneItems: ["pistol"],
        sceneConditions: [
          "蟹笼堆最底下那只挪了个角度，像是被人碰过又想放回原位",
          "海滩尽头罐头厂废墟的锈铁皮在风里响，这个点码头上没有别人",
        ],
      },
    ],
  },
];
