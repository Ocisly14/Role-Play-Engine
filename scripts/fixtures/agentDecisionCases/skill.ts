// scripts/fixtures/agentDecisionCases/skill.ts

import type { SimScenario } from "./types.js";

// =========================================================================
// LAYER 2 — skill domains. One scenario per domain, three personas each:
// someone the domain is second nature to, someone who reaches for it
// untrained, and someone whose situation invites it but whose instincts
// might not.
//
// Rewritten for the 17 broad domains (src/engine/rules/skillCatalog.ts).
// The old table was organised around 57 fine-grained CoC skills — four
// separate scenarios for perception / listen / research / track that are all
// one Investigation now.
//
// THREE DOMAINS ARE ABSENT ON PURPOSE. Swimming, Watercraft Operation and
// Aircraft Operation have no stage in this module: it contains no water, no
// boats and no aircraft. Inventing a lake to reach 17/17 coverage would
// reproduce the exact bug this table exists to catch — a case naming a place
// with no entity and no route, which the character can decide to go to and
// then never reach. Coverage against casssandra tops out at 14/17.
//
// Authoring rules, learned from a live run that looped for 7 ticks because a
// case invented a car park behind the police station:
//   1. Every place named in a goal or condition must be a real scene the
//      actor can reach. Check the staged scene's connections first.
//   2. Every object acted on must be either a real item of that scene or
//      staged through `sceneItems`. Scenery in prose is fine; targets are not.
//   3. Every person to be confronted must be in `actors` — nobody else is on
//      stage.
//   4. Goals must not name the skill. The character picks the approach; the
//      Engine judges whether it applies. A goal that says "用侦查技能" tests
//      obedience, not behaviour.
// =========================================================================

export const SKILL_SCENARIOS: SimScenario[] = [
  // -----------------------------------------------------------------------
  {
    id: "skill-investigation",
    group: "skill",
    title: "Investigation — 察觉、搜寻、追踪、查阅",
    targetDefs: ["Investigation"],
    cases: [
      {
        label: "警探：档案室里少了一份卷宗",
        ticks: 4,
        scene: "档案室",
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "弄清楚谁动过那批旧卷宗，少的那一份又是哪一件案子的。",
          },
        ],
        sceneConditions: [
          "卷宗档案柜有一格的卷宗被挤得东倒西歪，索引卡抽屉里有一张卡片的边角是新折的",
          "半坏的荧光灯管每隔几秒闪一下，光线时明时暗",
        ],
      },
      {
        label: "侦探：林子里的痕迹",
        ticks: 6,
        scene: "森林深处",
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "顺着地上的痕迹弄明白，前几天从这里过去的到底是什么东西、往哪个方向去了。",
          },
        ],
        sceneConditions: [
          "泥地上的巨大足迹只剩半个还清楚，其余被雨水泡糊了",
          "带抓痕的树干上，抓痕的高度远高于成年人伸手能够到的地方",
        ],
      },
      {
        label: "腐败警察：他想知道那晚谁签的字",
        ticks: 4,
        scene: "法医工作室",
        actors: [
          {
            npc: "Lux Lynch",
            goal: "赶在别人进来之前，把那张签收单上是谁的字弄清楚——最好那不是你自己的。",
          },
        ],
        sceneConditions: [
          "空置证物架最下层压着一沓签收单，最上面一张的签名被水渍晕开了一半",
          "墙角的半球摄像头亮着一点红光",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "skill-social",
    group: "skill",
    title: "Social — 说服、恐吓、欺瞒、看穿人心",
    targetDefs: ["Social"],
    cases: [
      {
        label: "市长：让律师改口",
        ticks: 5,
        scene: "私人书房",
        actors: [
          {
            npc: "Patrizio von Samsa",
            goal: "让她相信那份文件不必递上去，最好是她自己想通的，别留下你施压的痕迹。",
          },
          {
            npc: "Mrs. Barklyite (Lucia Shiny)",
            goal: "该递的文件一定要递，别被他绕进去；他每退一步你都要问清楚为什么。",
          },
        ],
        sceneConditions: [
          "镇务文件摊在书桌上，最上面那一份翻到了签字页",
          "壁炉里还留着没清干净的灰烬",
        ],
      },
      {
        label: "混混：欠钱的当面撞上债主",
        ticks: 5,
        scene: "地下赌场",
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "钱现在拿不出来，想办法让他今天先放过你，别挨打也别把话说死。",
          },
          {
            npc: "Kovind",
            goal: "今天必须见到钱，或者见到他答应个准信；他要是又想溜，别让他走出这间屋子。",
          },
        ],
        sceneConditions: [
          "赌桌旁的人都停下了手上的牌，看着门口这边",
          "酒水吧台后面的人擦着杯子，没有要出声的意思",
        ],
      },
      {
        label: "花店店主：她不擅长这个",
        ticks: 4,
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "这个人在店里不肯走，也不说要买什么。让他离开，但别把事情闹大。",
          },
          {
            npc: "Johnny",
            goal: "在这儿等着，等到她答应告诉你那个女人昨天来店里说了什么为止。",
          },
        ],
        sceneConditions: [
          "包装台上的鲜切花束还没扎完，花艺剪搁在一旁",
          "门口的粉笔价目板被进门的人蹭歪了",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "skill-stealth-security",
    group: "skill",
    title: "Stealth & Security — 潜行、隐匿、开锁、易容、伪造",
    targetDefs: ["Stealth & Security"],
    cases: [
      {
        label: "毒贩：教堂里那扇门后面",
        ticks: 6,
        scene: "教堂主殿",
        actors: [
          {
            npc: "Angela",
            goal: "趁主殿里没人注意，摸到雕像后面那扇暗门那边去，别让任何人看见你往那儿走。",
          },
        ],
        sceneConditions: [
          "耶稣受难雕像后方的墙面上有一道与砖缝不齐的细线",
          "彩色玻璃把光切成一块块，靠墙的地方几乎是暗的",
        ],
      },
      {
        label: "混混：书房里那个带锁的抽屉",
        ticks: 6,
        scene: "私人书房",
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "书房里现在没人。把那个带锁的抽屉打开，看看里面是什么，别留下撬过的痕迹。",
          },
        ],
        sceneItems: ["lockpick"],
        sceneConditions: [
          "书桌下方的带锁抽屉是唯一锁着的，锁孔是老式的",
          "走廊那头暂时没有脚步声",
        ],
      },
      {
        label: "打手：展柜里的那只金表",
        ticks: 5,
        scene: "怀特的钟表店",
        actors: [
          {
            npc: "Kovind",
            goal: "把展柜里那只金怀表弄到手，店主随时可能从后面出来，动作要快。",
          },
        ],
        sceneConditions: [
          "精致怀表展柜锁着，玻璃罩下的绒布上摆着一排怀表",
          "挂钟墙上十几只钟同时走着，秒针的声音盖过了别的动静",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "skill-melee-combat",
    group: "skill",
    title: "Melee Combat — 徒手与手持武器的近身格斗",
    targetDefs: ["Melee Combat"],
    cases: [
      {
        label: "打手：把人从赌桌边拖出去",
        ticks: 4,
        scene: "地下赌场",
        actors: [
          {
            npc: "Kovind",
            goal: "这个人今天必须离开这儿。他要是不肯自己走，就把他弄出去。",
          },
          {
            npc: "Philip Scaletta",
            goal: "别被他抓住，也别被打；能拖到有人劝架最好。",
          },
        ],
        sceneConditions: [
          "赌桌之间的过道很窄，两边都是坐着的人",
          "酒水吧台后面的人往后退了半步",
        ],
      },
      {
        label: "猎人：他先动的手",
        ticks: 4,
        actors: [
          {
            npc: "Johnny",
            goal: "这人刚才推了你一把。让他知道下次别再碰你。",
          },
          {
            npc: "Philip Scaletta",
            goal: "刚才是你先推的，但现在得想办法别挨这一下。",
          },
        ],
        sceneConditions: ["两个人之间不到一臂的距离，谁也没有退开的意思"],
      },
      {
        label: "警探：他要跑",
        ticks: 4,
        scene: "警察局前",
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "别让他跑掉。人必须留在这儿。",
          },
          {
            npc: "Angela",
            goal: "现在就走，别让他碰到你，也别让他看清你手里拿的东西。",
          },
        ],
        sceneConditions: [
          "警车停在路灯下，车和台阶之间只有一条能过人的空隙",
          "明亮路灯把两个人的影子拉得很长",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "skill-ranged-combat",
    group: "skill",
    title: "Ranged Combat — 枪械、弓弩与投掷",
    targetDefs: ["Ranged Combat"],
    cases: [
      {
        label: "猎人：林子里有东西在动",
        ticks: 5,
        scene: "森林深处",
        actors: [
          {
            npc: "Johnny",
            goal: "有东西在树后面动，比人大得多。别让它靠近你。",
          },
        ],
        sceneConditions: [
          "带抓痕的树干后面二十步左右，有什么东西压过灌木的声音，一直没有停",
          "泥地上的巨大足迹是新的",
        ],
      },
      {
        label: "警探：他掏出了枪",
        ticks: 4,
        scene: "警察局前",
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "对面那个人手里有枪，已经抬起来了。你不能让他先开这一枪。",
          },
          {
            npc: "Kovind",
            goal: "警察挡在你和车之间。你不打算被抓，也不打算空手走。",
          },
        ],
        sceneConditions: ["警车横在两人之间，车身能挡住半个人"],
      },
      {
        label: "花店店主：柜台底下那把枪",
        ticks: 4,
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "有人进来了，手里拿着东西朝你走。柜台底下有一把枪，你从来没用过。",
          },
          {
            npc: "Philip Scaletta",
            goal: "收银抽屉里的钱今天必须拿到，她一个人看店，别磨蹭。",
          },
        ],
        sceneItems: ["pistol"],
        sceneConditions: [
          "收银抽屉还开着，包装台挡在她和门之间",
          "花艺剪就搁在手边的包装台上",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "skill-athletics",
    group: "skill",
    title: "Athletics — 攀爬、跳跃、闪避、投掷、骑乘",
    targetDefs: ["Athletics"],
    cases: [
      {
        label: "警探：钟楼上的东西",
        ticks: 6,
        scene: "钟楼",
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "有东西卡在大钟的机件里，你得爬上去把它取下来看清楚。",
          },
        ],
        sceneConditions: [
          "通往大钟的木梯缺了两级，剩下的踏板边缘都朽了",
          "大钟的齿轮之间卡着一块不属于钟的深色布料",
        ],
      },
      {
        label: "混混：楼要塌了",
        ticks: 5,
        scene: "坍塌小楼",
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "这栋楼正在往下掉东西。从这儿出去，别被砸到。",
          },
        ],
        sceneConditions: [
          "坍塌的建筑残骸堵住了原来的出口，只剩窗框那一处还能过人",
          "头顶的木梁每隔一会儿就响一声，灰不停往下落",
        ],
        openingEvent: {
          description: "头顶一根木梁断了，半边天花板塌下来，碎砖砸在脚边",
          impact: 2,
        },
      },
      {
        label: "老站务：他跳下了月台",
        ticks: 5,
        actors: [
          {
            npc: "Haran Greenwood",
            goal: "有人跳下月台往轨道那边去了。你六十五岁，但这是你的站。",
          },
        ],
        sceneConditions: [
          "月台边缘到轨道有一人多高，破旧的长椅挡在最近的下行口前面",
          "锈迹斑斑的站牌下面站着几个看热闹的乘客",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "skill-medicine-psychology",
    group: "skill",
    title: "Medicine & Psychology — 急救、诊治、精神与心理",
    targetDefs: ["Medicine & Psychology"],
    cases: [
      {
        label: "侦探：病房里的人在失血",
        ticks: 5,
        scene: "病房",
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "这个人正在失血，医生还没到。你手上有的只是最基本的那点训练。",
          },
          {
            npc: "Nancy Charlotte",
            goal: "你的血一直在流，你怕得说不出完整的话。",
            hp: 4,
            conditions: ["右前臂割伤，正在持续出血"],
          },
        ],
        sceneConditions: [
          "推床停在病房门列外面，输液架就在旁边",
          "床头监护仪的报警声一直没停",
        ],
      },
      {
        label: "院长：停尸间里的人睁开了眼",
        ticks: 5,
        scene: "停尸间",
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "在家属到之前把死者的仪容整理好——这是你欠他的。",
            san: 37,
          },
        ],
        sceneConditions: [
          "冷藏柜前的推床上躺着两小时前你亲手宣布死亡的病人",
          "尸体档案记录摊在旁边，死亡时间那一栏是你自己的字",
        ],
        openingEvent: {
          description:
            "推床上那位两小时前被宣布死亡的病人睁开了眼睛，转头看着你，然后又缓缓闭上",
          impact: 2,
        },
      },
      {
        label: "律师：大厅里有人倒下了",
        ticks: 4,
        scene: "医院大厅",
        actors: [
          {
            npc: "Mrs. Barklyite (Lucia Shiny)",
            goal: "有人在你面前倒下了。你不懂医术，但你是离他最近的人。",
          },
        ],
        sceneConditions: [
          "候诊椅之间的地上躺着一个人，接待窗口后面暂时没人",
          "科室指示牌指着走廊深处，排班白板上今天的急诊那一格是空的",
        ],
        openingEvent: {
          description: "候诊椅那边一个男人从椅子上滑下去，倒在地上不动了",
          impact: 2,
        },
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "skill-knowledge-craft",
    group: "skill",
    title: "Knowledge & Craft — 人文、法律、财务、鉴定与手艺",
    targetDefs: ["Knowledge & Craft"],
    cases: [
      {
        label: "钟表匠：这只表是假的还是真的",
        ticks: 4,
        actors: [
          {
            npc: "Marks White",
            goal: "有人要把这只表押给你。开价之前，先弄清楚它到底值多少、是不是原装。",
          },
        ],
        sceneItems: ["watch"],
        sceneConditions: [
          "维修登记簿摊开着，钟表维修微型工具与零件散在台面上",
          "台上那只怀表的机芯夹板上，有一处打磨过的痕迹",
        ],
      },
      {
        label: "律师：账目对不上",
        ticks: 5,
        scene: "医院大厅",
        actors: [
          {
            npc: "Mrs. Barklyite (Lucia Shiny)",
            goal: "这份账目里有一处对不上。找出是哪一笔，以及它为什么被这样记。",
          },
        ],
        sceneConditions: [
          "医院档案摊在候诊椅上，其中一册的页码是跳的",
          "来访登记表上有几行的日期被人涂改过",
        ],
      },
      {
        label: "占星师：这本书值不值那个价",
        ticks: 4,
        actors: [
          {
            npc: "Solomon",
            goal: "有人要卖给你这本书。判断它的年代和来路，再决定给不给他开这个价。",
          },
        ],
        sceneConditions: [
          "丝绒圆桌上摊着一本书，装订线是后来重新缝过的",
          "铜质油灯的光刚好够看清扉页上褪色的印记",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "skill-science-nature",
    group: "skill",
    title: "Science & Nature — 生物、化学、物理与博物",
    targetDefs: ["Science & Nature"],
    cases: [
      {
        label: "院长：容器里的东西不该长成这样",
        ticks: 5,
        scene: "实验室",
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "弄清楚容器里那个样本到底是什么、还活着没有，别让它出来。",
            san: 37,
          },
        ],
        sceneConditions: [
          "蜘蛛样本容器的封口内侧凝着一层水汽，里面的东西换了个姿势",
          "实验档案里关于这个样本的那几页被撕掉了",
        ],
      },
      {
        label: "腐败警察：少掉的那格药",
        ticks: 4,
        scene: "药品管理室",
        actors: [
          {
            npc: "Lux Lynch",
            goal: "有人报了药品失窃。弄清楚少的是什么药、拿它能做什么——以及这事值不值得你上报。",
          },
        ],
        sceneConditions: [
          "药品货架上有一格空了，标签还在",
          "那一格的标签写着「魔鬼呼吸（东莨菪碱）」",
        ],
      },
      {
        label: "侦探：她不是学这个的",
        ticks: 5,
        scene: "实验室",
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "这间实验室在做的事和医院的名义对不上。看懂这里在养什么、为了什么。",
          },
        ],
        sceneConditions: [
          "新型医疗器械的接口和注射器的规格对不上，像是为别的东西配的",
          "蜘蛛样本容器一共有六个，只有一个是空的",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "skill-occult",
    group: "skill",
    title: "Occult — 民俗、超自然与禁忌知识",
    targetDefs: ["Occult"],
    cases: [
      {
        label: "钟表匠：刻在表壳内侧的符号",
        ticks: 4,
        actors: [
          {
            npc: "Marks White",
            goal: "这只表的内壳刻着一个记号，不是任何一家厂的标。弄清它是什么意思。",
          },
        ],
        sceneItems: ["symbol", "watch"],
        sceneConditions: [
          "台上摊着刚拆开的表壳，内侧刻着一个不属于制表业的记号",
          "维修登记簿上，同一位客人半年内送修过三次",
        ],
      },
      {
        label: "占星师：门后面那张网",
        ticks: 6,
        scene: "暗门·蛛网",
        actors: [
          {
            npc: "Solomon",
            goal: "看清这张网是什么东西织的，以及它为什么织在这里。别碰它。",
            san: 65,
          },
        ],
        sceneConditions: [
          "巨网从墙角一直铺到穹顶，丝的粗细不像任何一种蜘蛛能吐出来的",
          "网的中心有一处凹陷，像是有什么东西刚离开",
        ],
      },
      {
        label: "市长：他知道这是什么，但他不能说",
        ticks: 5,
        scene: "教堂主殿",
        actors: [
          {
            npc: "Patrizio von Samsa",
            goal: "雕像后面那道缝里露出来的东西不该被别人看见。在有人问起之前处理掉。",
          },
          {
            npc: "Bruno Galilei",
            goal: "市长这个点出现在教堂里不正常。弄清楚他在这儿做什么。",
          },
        ],
        sceneConditions: [
          "耶稣受难雕像的底座和地面之间有一道新的缝，缝里塞着东西",
          "圣经摊开在讲台上，压着的那一页边缘有烧焦的痕迹",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "skill-repair-engineering",
    group: "skill",
    title: "Repair & Engineering — 机械、电气与设备操作",
    targetDefs: ["Repair & Engineering"],
    cases: [
      {
        label: "老站务：小屋里的灯全灭了",
        ticks: 5,
        actors: [
          {
            npc: "Haran Greenwood",
            goal: "站上的电全断了，天要黑了。在下一班车进站之前把电弄回来。",
          },
        ],
        sceneConditions: [
          "Haran的工作小屋里的灯和月台的灯同时灭了，只有远处路口还亮着",
          "小屋墙上的配电盒盖子是开着的，里面有一股焦味",
        ],
      },
      {
        label: "打手：酿酒设备停了",
        ticks: 6,
        scene: "酒厂厂区",
        actors: [
          {
            npc: "Kovind",
            goal: "这批货今晚必须出。设备停了，把它弄转起来，别叫人。",
          },
        ],
        sceneConditions: [
          "伏特加酿造设备的主管路上有一处接口在漏，地上积了一滩",
          "空置木质酒桶堆在通道口，挡住了通往阀门的那一侧",
        ],
      },
      {
        label: "钟表匠：这不是钟",
        ticks: 5,
        scene: "五金店",
        actors: [
          {
            npc: "Marks White",
            goal: "这台机器和你修了三十年的东西不一样，但眼下只有你在。让它别再响了。",
          },
        ],
        sceneConditions: [
          "Harrison的小发明在货架上自己动了起来，齿轮咬合的声音越来越急",
          "深绿货架上的待售五金被震得往下掉，铁丝卷滚到了脚边",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "skill-land-vehicle",
    group: "skill",
    title: "Land Vehicle Operation — 驾驶与陆上机械操作",
    targetDefs: ["Land Vehicle Operation"],
    cases: [
      {
        label: "腐败警察：把车开走",
        ticks: 5,
        scene: "警察局前",
        actors: [
          {
            npc: "Lux Lynch",
            goal: "趁现在没人，把警车开离警局，别让值班的看见是你开走的。",
          },
        ],
        sceneConditions: [
          "警车停在明亮路灯正下方，车头朝着警局台阶",
          "警局公告牌旁边的门开着，里面有人声",
        ],
      },
      {
        label: "警探：追那辆车",
        ticks: 6,
        scene: "警察局前",
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "刚开走的那辆车不能让它出镇。上车追上去。",
          },
        ],
        sceneConditions: ["警车就停在路灯下，钥匙还插在上面"],
        openingEvent: {
          description: "街口那头一辆车突然加速开走，轮胎在路面上擦出一声尖响",
          impact: 2,
        },
      },
      {
        label: "毒贩：她从没开过这种车",
        ticks: 5,
        scene: "星辰大道北端",
        actors: [
          {
            npc: "Angela",
            goal: "货必须今晚送到，路边这辆车是唯一的指望，虽然你没开过这么大的车。",
          },
        ],
        sceneConditions: [
          "路边停着一辆车头很长的旧货车，驾驶室的门没锁",
          "街上这个点没什么人，但远处有脚步声在靠近",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "skill-survival-navigation",
    group: "skill",
    title: "Survival & Navigation — 辨向、野外生存与恶劣环境",
    targetDefs: ["Survival & Navigation"],
    cases: [
      {
        label: "猎人：天黑前得走出去",
        ticks: 7,
        scene: "森林深处",
        actors: [
          {
            npc: "Johnny",
            goal: "天要黑了，你在林子里绕了太久。找到出去的方向，别在这儿过夜。",
          },
        ],
        sceneConditions: [
          "残破伐木标桩上的字被苔藓盖住了，只认得出半个方向",
          "光线在往下暗，树冠密得看不见天",
        ],
      },
      {
        label: "侦探：伐木场后面那条路",
        ticks: 6,
        scene: "伐木场废墟",
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "那条荒废的泥径通向林子深处。弄清楚它通到哪儿，能不能走。",
          },
        ],
        sceneConditions: [
          "废弃的伐木机器旁边有一条被踩出来的窄道，比周围的草矮一截",
          "腐烂的木头碎片一直铺到泥径入口，上面有新压过的痕迹",
        ],
      },
      {
        label: "警探：他在林子里没方向",
        ticks: 6,
        scene: "森林深处",
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "你追着人进了林子，现在不知道自己在哪儿。先弄清方向再说别的。",
          },
        ],
        sceneConditions: [
          "四周的树看上去都一样，来时的脚印被落叶盖住了",
          "带抓痕的树干在你右手边，刚才它应该在左边",
        ],
      },
    ],
  },

  // -----------------------------------------------------------------------
  {
    id: "skill-languages",
    group: "skill",
    title: "Languages — 阅读、书写、翻译与专门语域",
    targetDefs: ["Languages"],
    cases: [
      {
        label: "占星师：这几行不是英文",
        ticks: 5,
        actors: [
          {
            npc: "Solomon",
            goal: "把这一页上的字读出来，弄清楚它说的是什么。",
          },
        ],
        sceneConditions: [
          "丝绒圆桌上那本书翻到中间，这几页的文字和前后不是一种",
          "页边有人用铅笔写了几个词，字迹很新",
        ],
      },
      {
        label: "侦探：她只认得几个词",
        ticks: 5,
        scene: "占卜馆",
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "这页纸是关键，但上面的字你不认识。想办法弄懂它写了什么。",
          },
          {
            npc: "Solomon",
            goal: "她拿来的东西你认得，但你不打算全都告诉她。",
          },
        ],
        sceneConditions: [
          "深紫色帘幕后面透进来的光正好落在桌上那页纸上",
          "墙架上的铜制星盘旁边摆着几本摊开的对照用书",
        ],
      },
      {
        label: "市长：文件上的措辞",
        ticks: 4,
        actors: [
          {
            npc: "Patrizio von Samsa",
            goal: "这份文件的措辞里藏着一个你不能签的条款。在签字之前把它找出来。",
          },
        ],
        sceneConditions: [
          "镇务文件最上面那一份是外来的，用词和本地公文的习惯不一样",
          "带锁抽屉开着，里面是同一批文件的旧版本",
        ],
      },
    ],
  },
];
