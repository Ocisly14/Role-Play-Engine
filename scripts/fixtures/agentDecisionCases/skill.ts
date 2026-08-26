// scripts/fixtures/agentDecisionCases/skill.ts

import type { SimScenario } from "./types.js";

// =========================================================================
// LAYER 2 — skills. Five personas per skill: who reaches for it, who refuses.
// =========================================================================

export const SKILL_SCENARIOS: SimScenario[] = [
  {
    id: "skill-perception",
    group: "skill",
    title: "细致搜查 → perception",
    targetDefs: ["perception", "criminology"],
    cases: [
      {
        label: "侦探：房间被人翻过",
        ticks: 3,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "把这间屋子仔仔细细搜一遍，找出藏起来的东西。",
          },
        ],
        sceneConditions: [
          "抽屉半开着，地毯一角被掀起，墙角护壁板上有一道新划痕，屋里被人翻过",
        ],
      },
      {
        label: "警探：现场勘查",
        ticks: 3,
        // criminology.md 覆盖"现场重建"，与 perception 只差一线，归到哪边都说得通。
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "在痕迹被破坏之前把现场每一处细节看清楚。",
          },
        ],
        sceneConditions: [
          "死者倒下位置周围地面很干净，只有窗台下的灰尘被蹭掉一块，窗户没锁",
        ],
      },
      {
        label: "猎人：柴堆里有不该在的东西",
        ticks: 3,
        // 原布景写的是"雪面凹陷 + 灌木被压断"，那逐字命中 track.md 的
        // description，而 perception.md 明确把追踪排除出去——按引擎自己的规则，
        // 那个用例判失败才是正确行为。改成真正的"搜出藏起来的东西"。
        scene: "森林深处",
        actors: [
          {
            npc: "Johnny",
            goal: "把这堆柴火翻一遍，找出那个不该在这儿的东西。",
          },
        ],
        sceneConditions: [
          "墙根的柴堆码得整整齐齐，只有中间几根的断面是新的，缝里透出一点不属于木头的暗色",
        ],
      },
      {
        label: "钟表匠：这块表被人动过",
        ticks: 3,
        actors: [
          {
            npc: "Marks White",
            goal: "在动手修之前，先看清这只表被人做过什么手脚。",
          },
        ],
        sceneItems: ["watch"],
        sceneConditions: [
          "台上那只怀表外壳锃亮，后盖螺丝口却有细微的滑丝痕迹，像被外行人拧开过",
        ],
      },
      {
        label: "混混：找找有没有值钱的",
        ticks: 3,
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "屋里暂时没人，赶紧看看有没有能顺走的、值钱的东西。",
          },
        ],
        sceneConditions: [
          "柜子、抽屉和搭在椅背上的外套都在，走廊那头暂时没有脚步声",
        ],
      },
    ],
  },
  {
    id: "skill-listen",
    group: "skill",
    title: "隔墙偷听 → listen",
    targetDefs: ["listen"],
    cases: [
      {
        label: "腐败警察：他们在说我吗",
        ticks: 3,
        actors: [
          {
            npc: "Lux Lynch",
            goal: "听清隔壁那两个人到底在说什么，尤其是有没有提到你。",
          },
        ],
        sceneConditions: [
          "隔壁房间传来压低的说话声，听不清内容，其中一句里似乎有“证物”两个字；这面墙很薄",
        ],
      },
      {
        label: "混混：门外在商量怎么处理我",
        ticks: 3,
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "听清门外那两个人打算怎么处理你，再决定跑不跑。",
          },
        ],
        sceneConditions: [
          "门外两个人在低声商量，语速很快，其中一句里有你的名字；门板不厚",
        ],
      },
      {
        label: "花店少女：后巷里有人说话",
        ticks: 3,
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "先听清楚后门外面在说什么，别贸然开门。",
          },
        ],
        sceneConditions: [
          "后巷传来两个男人压得很低的说话声，只听得清“今晚”几个音；你就站在后门边",
        ],
      },
      {
        label: "侦探：电话那头的背景音",
        ticks: 3,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "在不惊动他的前提下，听清他在电话里对谁说了什么。",
          },
          {
            npc: "Kovind",
            goal: "背对着人压低嗓子把这通电话打完，别让屋里的人听见内容。",
          },
        ],
      },
      {
        label: "猎人：林子里的动静",
        scene: "森林深处",
        ticks: 3,
        actors: [
          { npc: "Johnny", goal: "先听清楚外面那是什么东西，再决定举不举枪。" },
        ],
        sceneConditions: [
          "外面传来断续的响动，不像风吹树枝，也不像鹿；四周很安静",
        ],
      },
    ],
  },
  {
    id: "skill-stealth",
    group: "skill",
    title: "藏匿潜行 → stealth",
    // stealth.md 的 description 明确排除"静止不动的藏匿"（那属于 action）。
    // 逐字守着定义规则的话，蹲在阴影里不动会落到 action，两边都合理。
    targetDefs: ["stealth", "action"],
    cases: [
      {
        label: "混混：有人上楼了",
        ticks: 3,
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "别被来人看见，先躲进阴影里看看是谁。",
          },
        ],
        sceneConditions: ["屋里没开灯，敞开的柜子投下一片阴影"],
        openingEvent: {
          description: "走廊尽头传来皮鞋踩地砖的声音，正朝这边过来",
          impact: 2,
        },
      },
      {
        label: "毒贩：巡逻车的灯扫过来",
        scene: "站外广场",
        ticks: 3,
        actors: [{ npc: "Angela", goal: "别被那辆车上的人看见。" }],
        sceneConditions: ["门口空地边上只有一排垃圾桶和门廊的阴影"],
        openingEvent: {
          description: "一束车灯从街口扫过来，慢慢往这边挪",
          impact: 2,
        },
      },
      {
        label: "猎人：接近目标",
        scene: "森林深处",
        ticks: 3,
        actors: [
          {
            npc: "Johnny",
            goal: "在他发现之前摸到近处，看清他在干什么。别弄出声音。",
          },
          {
            npc: "Philip Scaletta",
            goal: "蹲在地上翻找自己的东西，别被人打扰。",
          },
        ],
        sceneConditions: ["地上的雪很脆，稍一用力就会响"],
      },
      {
        label: "腐败警察：溜进证物室",
        ticks: 3,
        actors: [
          {
            npc: "Lux Lynch",
            goal: "趁没人的这几十秒溜进证物室，绝不能被任何人看到。",
          },
        ],
        sceneConditions: [
          "证物室的门虚掩着，走廊监控的红灯每隔十几秒亮一次，值班的人刚离开",
        ],
      },
      {
        label: "侦探：跟人但别被发现",
        ticks: 4,
        actors: [
          { npc: "Shandra Hernandez", goal: "跟住他，但绝不能让他发现你。" },
          {
            npc: "Kovind",
            goal: "快步离开这里，一边走一边留意后面有没有人跟着。",
          },
        ],
      },
    ],
  },
  {
    id: "skill-locksmith",
    group: "skill",
    title: "撬锁开柜 → locksmith",
    targetDefs: ["locksmith", "mechanical_repair"],
    cases: [
      {
        label: "混混：撬开抽屉",
        ticks: 4,
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "在有人回来之前把上锁的那格抽屉打开。",
            items: ["lockpick"],
          },
        ],
        sceneConditions: [
          "办公桌最下面那格抽屉上着一把老式弹子锁，钥匙不在，走廊现在没人",
        ],
      },
      {
        label: "钟表匠：老锁的活儿",
        ticks: 4,
        // locksmith.md 把"修理锁机构"划给 mechanical_repair，而这里主角是钟表匠、
        // 目标是"别损坏钟壳"，interpreter 很可能归到 mechanical_repair。
        actors: [
          {
            npc: "Marks White",
            goal: "不损坏钟壳，把那把十九世纪的小铜锁打开。",
            items: ["lockpick"],
          },
        ],
        sceneConditions: [
          "台上那只座钟的钟腔上着一把十九世纪的小铜锁，钥匙早就丢了，硬撬会毁掉钟壳",
        ],
      },
      {
        label: "打手：柜子必须打开",
        ticks: 4,
        actors: [
          {
            npc: "Kovind",
            goal: "把那个铁皮柜打开拿到里面的东西，最好别惊动楼里的人。",
            items: ["lockpick"],
          },
        ],
        sceneConditions: ["铁皮柜的挂锁把门锁死了，钥匙在不在场的人身上"],
      },
      {
        label: "毒贩：储物柜的锁换过了",
        scene: "月台",
        ticks: 4,
        actors: [
          {
            npc: "Angela",
            goal: "把那个储物柜打开，把里面的东西取走。",
            items: ["lockpick", "key"],
          },
        ],
        sceneConditions: [
          "储物柜的锁被人换成了新的，你手里的黄铜钥匙插不进去；这个时间几乎没人",
        ],
      },
      {
        label: "警探：门后可能还有人活着",
        ticks: 4,
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "尽快把反锁的门打开，同时尽量保住门锁上的痕迹。",
            items: ["lockpick"],
          },
        ],
        sceneConditions: ["里屋的门反锁着，门缝下透出灯光，敲了三次没人应"],
      },
    ],
  },
  {
    id: "skill-persuade",
    group: "skill",
    title: "讲道理说服 → persuade",
    targetDefs: ["persuade", "character_interaction"],
    cases: [
      {
        label: "律师：说服证人出庭",
        ticks: 6,
        actors: [
          {
            npc: "Mrs. Barklyite (Lucia Shiny)",
            goal: "把利害关系一条条说清楚，让他答应出庭作证。",
          },
          {
            npc: "Haran Greenwood",
            goal: "不想惹麻烦，不想出庭；但也没有起身就走。",
          },
        ],
      },
      {
        label: "市长：劝对方压下提案",
        ticks: 4,
        actors: [
          {
            npc: "Patrizio von Samsa",
            goal: "让他心甘情愿地把那份提案压到明年春天。",
          },
          {
            npc: "Mrs. Barklyite (Lucia Shiny)",
            goal: "下周就把这份提案交上去，除非有说得过去的理由。",
          },
        ],
      },
      {
        label: "警探：说服同事放行",
        ticks: 4,
        actors: [
          { npc: "Bruno Galilei", goal: "摆事实讲道理，说服他放你进证物室。" },
          { npc: "Lux Lynch", goal: "没有上级签字谁都不能进证物室，挡住他。" },
        ],
      },
      {
        label: "花店少女：劝房东宽限几天",
        ticks: 4,
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "好好跟这位房东太太说，争取把这个月的租金宽限到下周。",
          },
          { npc: "Angela", goal: "这个月的租金今天必须结清，别被拖过去。" },
        ],
      },
      {
        label: "书商：劝对方别买那本书",
        ticks: 4,
        actors: [
          { npc: "Solomon", goal: "让他自己打消买那本书的念头，别把话说破。" },
          {
            npc: "Philip Scaletta",
            goal: "非要买走那本书不可，钱已经掏出来了。",
          },
        ],
      },
    ],
  },
  {
    id: "skill-intimidate",
    group: "skill",
    title: "恐吓施压 → intimidate",
    targetDefs: ["intimidate", "character_interaction"],
    cases: [
      {
        label: "打手：收账",
        ticks: 6,
        actors: [
          { npc: "Kovind", goal: "今天必须把钱拿到手，或者让他再也不敢拖。" },
          {
            npc: "Philip Scaletta",
            goal: "再拖一次，找个理由说下周一定还，然后想办法溜出去。",
          },
        ],
      },
      {
        label: "市长：把话说到位",
        ticks: 4,
        actors: [
          {
            npc: "Patrizio von Samsa",
            goal: "让他明白把那份材料交出去会有什么后果，从此闭嘴。",
          },
          {
            npc: "Lux Lynch",
            goal: "你打算把手上那份材料交给报社，但你怕他。",
          },
        ],
      },
      {
        label: "腐败警察：吓住知情人",
        ticks: 4,
        actors: [
          { npc: "Lux Lynch", goal: "让他把那天晚上看到的事烂在肚子里。" },
          {
            npc: "Philip Scaletta",
            goal: "暗示自己那晚看见他在证物室，看他怎么反应。",
          },
        ],
      },
      {
        label: "猎人：赶走闯进地界的人",
        ticks: 4,
        actors: [
          { npc: "Johnny", goal: "让这个闯进你猎场的人现在就滚出去。" },
          {
            npc: "Kovind",
            goal: "站在这块地界里不走，笑着说这地方又不是他家的。",
          },
        ],
      },
      {
        label: "毒贩：警告下线",
        ticks: 4,
        actors: [
          {
            npc: "Angela",
            goal: "让他明白少的那部分必须补上，而且不能有下次。",
          },
          {
            npc: "Philip Scaletta",
            goal: "承认这次的量对不上，然后耸耸肩糊弄过去。",
          },
        ],
      },
    ],
  },
  {
    id: "skill-psychology",
    group: "skill",
    title: "察言观色判断真假 → psychology",
    targetDefs: ["psychology"],
    cases: [
      {
        label: "侦探：他哪一句是假的",
        ticks: 3,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "别打断他，从他的表情和小动作里判断他哪一句是假的。",
          },
          {
            npc: "Philip Scaletta",
            goal: "把“九点半以后就回家了”这套说辞讲完，别露破绽。",
          },
        ],
      },
      {
        label: "院长：病人在隐瞒什么",
        ticks: 3,
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "弄清这位女病人到底瞒着什么，才能决定怎么治。先观察，别逼问。",
          },
          {
            npc: "Nancy Charlotte",
            goal: "一口咬定自己睡得很好，别让人看出你在害怕。",
          },
        ],
      },
      {
        label: "书商：这人是真懂还是装的",
        ticks: 3,
        actors: [
          { npc: "Solomon", goal: "判断这个人到底是内行，还是在演给你看。" },
          {
            npc: "Patrizio von Samsa",
            goal: "装出很懂古籍的样子，顺着对方的话说下去。",
          },
        ],
      },
      {
        label: "律师：当事人在保护谁",
        ticks: 3,
        actors: [
          {
            npc: "Mrs. Barklyite (Lucia Shiny)",
            goal: "看清他到底在替谁遮掩。",
          },
          {
            npc: "Lux Lynch",
            goal: "讲到那晚同行的人就绕开，把话题拉回自己身上。",
          },
        ],
      },
      {
        label: "市长：他能不能被收买",
        ticks: 3,
        actors: [
          {
            npc: "Patrizio von Samsa",
            goal: "判断这个人真正在意什么，值不值得再谈下去。",
          },
          {
            npc: "Bruno Galilei",
            goal: "干脆地拒绝对方的提议，但别把话说死。",
          },
        ],
      },
    ],
  },
  {
    id: "skill-first_aid",
    group: "skill",
    title: "紧急止血救人 → first_aid",
    targetDefs: ["first_aid", "medicine"],
    cases: [
      {
        label: "院长：动脉出血",
        // 要在总结里看到 HP 真的回升，tick 必须覆盖 resolver 可能给的时长：
        // first_aid 的 durationGuidance 是 5（范围 1-15，"严重出血止血 5-10 分钟"），
        // commit 落在第 2+elapsed 个 tick。12 tick 覆盖到 10 分钟这一档；万一
        // interpreter 归到 medicine（默认 15 分钟），queueAtEnd 会显示"仍在途"。
        ticks: 12,
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "先把他的血止住，救活他。",
            items: ["kit"],
          },
          {
            npc: "Philip Scaletta",
            goal: "别晕过去，撑到有人把血止住。",
            hp: 4,
            conditions: ["左大腿内侧被割开一道深口，动脉出血，正在快速失血"],
          },
        ],
        sceneConditions: ["地板上有一滩正在扩散的血"],
      },
      {
        label: "花店少女：客人被玻璃割伤",
        ticks: 4,
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "先把他的血止住，再想别的。",
            items: ["kit"],
          },
          {
            npc: "Haran Greenwood",
            goal: "捂住手腕，别让血流得更快。",
            hp: 6,
            conditions: ["手腕被碎玻璃划开，血顺着指缝往下滴"],
          },
        ],
        sceneConditions: ["柜台前一地碎玻璃"],
      },
      {
        label: "猎人：同伴中了兽夹",
        scene: "森林深处",
        ticks: 4,
        actors: [
          {
            npc: "Johnny",
            goal: "先把他腿上的血止住，别让他失血过多。",
            items: ["kit"],
          },
          {
            npc: "Marks White",
            goal: "咬牙忍住，别乱动，等人把夹子弄开。",
            hp: 5,
            conditions: ["小腿被兽夹咬住，铁齿嵌进肉里，一直在流血"],
          },
        ],
      },
      {
        label: "警探：中枪的同事",
        ticks: 4,
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "撑到救护车来之前不能让他失血过多，先止血。",
            items: ["kit"],
          },
          {
            npc: "Lux Lynch",
            goal: "保持清醒，别昏过去。",
            hp: 3,
            conditions: ["肩膀中了一枪，制服被血浸透一大片，呼吸越来越浅"],
          },
        ],
      },
      {
        label: "打手：自己人挨了刀",
        ticks: 4,
        actors: [
          {
            npc: "Kovind",
            goal: "先把安吉拉的血止住，绝不能送医院。",
            items: ["kit"],
          },
          {
            npc: "Angela",
            goal: "捂住肚子，别让血流出来，也别让人送你去医院。",
            hp: 4,
            conditions: ["腹部被捅了一刀，指缝里全是血"],
          },
        ],
      },
    ],
  },
  {
    id: "skill-brawling",
    group: "skill",
    title: "徒手格斗 → brawling",
    targetDefs: ["brawling", "dodge"],
    cases: [
      {
        label: "打手：对方先动手",
        ticks: 3,
        actors: [
          {
            npc: "Kovind",
            goal: "有人扑上来掐你的脖子。先制住他，别让他掐到你的喉咙。",
          },
          {
            npc: "Philip Scaletta",
            goal: "翻过桌子扑上去掐住他的脖子，不能让他站稳。",
          },
        ],
        openingEvent: {
          description:
            "有人突然翻过桌子扑过来，双手掐向对方的脖子，两个人一起撞在柜子上",
          impact: 2,
          by: "Philip Scaletta",
        },
      },
      {
        label: "猎人：酒馆里被推了一把",
        ticks: 3,
        actors: [
          { npc: "Johnny", goal: "谁碰你，谁就得付出代价。" },
          { npc: "Kovind", goal: "继续挑衅他，看他敢不敢动手。" },
        ],
        openingEvent: {
          description: "有人推翻了他的酒，又一巴掌拍在他胸口，笑着问他能怎么样",
          impact: 2,
          by: "Kovind",
        },
      },
      {
        label: "警探：制服拒捕的人",
        ticks: 3,
        actors: [
          { npc: "Bruno Galilei", goal: "把他按住带回去，尽量不要伤到他。" },
          {
            npc: "Philip Scaletta",
            goal: "挣脱他的手往门口跑，一边跑一边挥胳膊挡开他。",
          },
        ],
        openingEvent: {
          description: "被抓住手腕的人猛地挣脱，挥着胳膊往门口冲",
          impact: 2,
          by: "Philip Scaletta",
        },
      },
      {
        label: "混混：被堵在墙角",
        ticks: 3,
        actors: [
          { npc: "Philip Scaletta", goal: "先脱身，能不硬碰就不硬碰。" },
          { npc: "Kovind", goal: "把他堵在墙角，揪住衣领，拳头已经举起来了。" },
        ],
        openingEvent: {
          description: "他被逼到墙角，衣领被人一把揪住，对方的拳头已经举起来",
          impact: 2,
          by: "Kovind",
        },
      },
      {
        label: "毒贩：有人来抢货",
        ticks: 3,
        actors: [
          { npc: "Angela", goal: "东西不能丢，人也不能倒。" },
          { npc: "Johnny", goal: "抢下她手里的包，快点得手走人。" },
        ],
        openingEvent: {
          description: "有人一把抓住她手里的包往外拽，另一只手朝她脸上挥过来",
          impact: 2,
          by: "Johnny",
        },
      },
    ],
  },
  {
    id: "skill-pistol",
    group: "skill",
    title: "开枪 → pistol",
    targetDefs: ["pistol"],
    cases: [
      {
        label: "警探：持刀者不听警告",
        ticks: 3,
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "他再上前一步就开枪。你的配枪已经出鞘指着他。",
            items: ["pistol"],
          },
          {
            npc: "Kovind",
            goal: "举着刀一步步逼近，不管对方怎么警告都不停下。",
          },
        ],
        openingEvent: {
          description: "持刀的人已经割伤了一个人，正举着刀朝这边逼近，只剩三米",
          impact: 2,
          by: "Kovind",
        },
      },
      {
        label: "腐败警察：对方也掏了枪",
        ticks: 3,
        actors: [
          { npc: "Lux Lynch", goal: "活下去，别管别的。", items: ["pistol"] },
          {
            npc: "Kovind",
            goal: "把枪从衣襟下抬起来对准他。",
            items: ["pistol"],
          },
        ],
        openingEvent: {
          description:
            "对面的人把手伸进外套，枪口正从衣襟下抬起来对着你，距离不到五米",
          impact: 2,
          by: "Kovind",
        },
      },
      {
        label: "打手：交火",
        ticks: 3,
        actors: [
          {
            npc: "Kovind",
            goal: "压制住对方，别让他再开第二枪。",
            items: ["pistol"],
          },
          { npc: "Johnny", goal: "从掩体后探身再开一枪。", items: ["pistol"] },
        ],
        openingEvent: {
          description:
            "一颗子弹打在旁边的墙上崩下一片灰，开枪的人正从掩体后再次探出身",
          impact: 3,
          by: "Johnny",
        },
      },
      {
        label: "猎人：野兽扑上来",
        scene: "森林深处",
        ticks: 3,
        actors: [
          { npc: "Johnny", goal: "在它扑到之前把它打倒。", items: ["pistol"] },
        ],
        openingEvent: {
          description:
            "灌木后窜出一头浑身是血的野兽，压低身子朝这边冲过来，距离二十米",
          impact: 3,
        },
      },
      {
        label: "毒贩：被人堵在巷子里",
        ticks: 3,
        actors: [
          {
            npc: "Angela",
            goal: "不能被抢，也不能被打死。",
            items: ["pistol"],
          },
          { npc: "Philip Scaletta", goal: "举着撬棍堵住她，逼她把东西留下。" },
        ],
        openingEvent: {
          description: "举着撬棍的人堵住了出口，一步步逼近，嘴里让人把东西留下",
          impact: 2,
          by: "Philip Scaletta",
        },
      },
    ],
  },
  {
    id: "skill-dodge",
    group: "skill",
    title: "闪避来袭 → dodge",
    // goal 走的是 prompt 里的「你的长期目标」栏。把"躲开。"写进那儿既语义错位，
    // 又等于直接下令，测出来的只是"agent 听不听话"。这里改成人格级目标，让
    // openingEvent 去提供即时刺激——能不能认出该闪避，才是这个场景要观察的。
    targetDefs: ["dodge"],
    cases: [
      {
        label: "花店少女：货架塌下来",
        ticks: 2,
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "守住这家小店，也别让自己受伤——你一个人撑着，进医院就全完了。",
          },
        ],
        openingEvent: {
          description:
            "头顶的木架毫无预兆地塌了，一整排花盆朝她的头砸下来，只有半秒钟",
          impact: 2,
        },
      },
      {
        label: "老站务：推车冲过来",
        ticks: 2,
        actors: [
          {
            npc: "Haran Greenwood",
            goal: "四十年没出过事故，站上任何异常都要第一时间处置，也别让自己搭进去。",
          },
        ],
        openingEvent: {
          description: "装满行李的推车顺着坡道直冲过来，正对着他，只剩两三步",
          impact: 2,
        },
      },
      {
        label: "混混：酒瓶砸过来",
        ticks: 2,
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "先保住自己，能不硬碰就不硬碰，找机会脱身。",
          },
          { npc: "Kovind", goal: "抄起酒瓶朝他的头抡下去。" },
        ],
        openingEvent: {
          description: "有人抄起酒瓶朝他的头抡过来，动作已经到了一半",
          impact: 2,
          by: "Kovind",
        },
      },
      {
        label: "侦探：车灯直冲过来",
        ticks: 2,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "把这桩案子查下去，但先活着——职业性的谨慎不能丢。",
          },
        ],
        openingEvent: {
          description: "一辆车没有减速地拐进巷子，车灯直冲着她，引擎声骤然拔高",
          impact: 3,
        },
      },
      {
        label: "院长：氧气瓶倒下来",
        ticks: 2,
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "医院里不能再出事故了，任何险情第一时间处置。",
          },
        ],
        openingEvent: {
          description: "靠墙的氧气瓶架被撞开，最上面那只铁瓶朝他这边倒过来",
          impact: 2,
        },
      },
    ],
  },
  {
    id: "skill-climb",
    group: "skill",
    title: "攀爬 → climb",
    targetDefs: ["climb", "jump"],
    cases: [
      {
        label: "猎人：爬上岩壁看地形",
        scene: "森林深处",
        ticks: 3,
        actors: [
          { npc: "Johnny", goal: "爬上那段岩壁，看清下面山坳里的情况。" },
        ],
        sceneConditions: [
          "唯一的观察点是一段三四米高的岩壁，岩缝够手抓，但结着薄冰",
        ],
      },
      {
        label: "混混：翻墙逃走",
        ticks: 3,
        actors: [
          { npc: "Philip Scaletta", goal: "翻过那堵墙，甩掉后面追你的人。" },
        ],
        sceneConditions: ["尽头是一堵两米多高的砖墙，墙头有半截铁管可以抓"],
        openingEvent: {
          description: "追赶的人已经拐进这条巷子，脚步声越来越近",
          impact: 2,
        },
      },
      {
        label: "打手：从消防梯上楼",
        ticks: 3,
        actors: [{ npc: "Kovind", goal: "顺着窗外那截消防梯爬上去。" }],
        sceneConditions: [
          "楼梯被人从里面锁死，唯一的路是窗外那截生锈的消防梯，最低一级离地一人多高",
        ],
      },
      {
        label: "侦探：翻进院子",
        ticks: 3,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "翻进院子里去看看，别把自己挂在墙头的尖头上。",
          },
        ],
        sceneConditions: [
          "铁栅栏门锁着，围墙不高但顶上有一排装饰尖头，院子里的灯全灭着",
        ],
      },
      {
        label: "腐败警察：火封了楼梯",
        ticks: 3,
        actors: [
          { npc: "Lux Lynch", goal: "从窗外那道铁梯爬下去，活着离开这栋楼。" },
        ],
        sceneConditions: [
          "楼梯口已经被火封死，热浪逼得人睁不开眼，唯一的出路是窗外那道铁梯",
        ],
      },
    ],
  },
  {
    id: "skill-drive_auto",
    group: "skill",
    title: "驾车 → drive_auto",
    targetDefs: ["drive_auto", "movement"],
    cases: [
      {
        label: "毒贩：甩掉后面的车",
        scene: "站外广场",
        ticks: 4,
        actors: [
          { npc: "Angela", goal: "在下一个路口甩掉后面那辆一直跟着的车。" },
        ],
        sceneConditions: [
          "你的车停在结冰的街道边，钥匙在手里；后视镜里那辆车已经跟了三个路口",
        ],
      },
      {
        label: "警探：追击嫌疑车辆",
        ticks: 4,
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "开车跟上那辆没挂牌的旅行车，别把它跟丢了。",
          },
        ],
        sceneConditions: [
          "那辆没挂牌的旅行车刚从路口拐出去，尾灯还看得见；你的车就在路边，引擎还是热的",
        ],
        // interpreter 会把这拆成 [drive_auto, movement] 两步，而队列每个 actor
        // 每 tick 只激活一步，第二步要等第一步 commit 之后——4 tick 内位移
        // 不会发生，总结里看到"仍在途"是正常的。
      },
      {
        label: "混混：开车逃跑",
        ticks: 4,
        actors: [{ npc: "Philip Scaletta", goal: "立刻把车开走，别被追上。" }],
        sceneConditions: [
          "钥匙插在方向盘上，两个人正从后面跑过来，还有二十来米",
        ],
      },
      {
        label: "打手：雪夜送人",
        ticks: 4,
        actors: [
          {
            npc: "Kovind",
            goal: "在他撑不住之前把车开到{{destName}}，医院去不得。",
          },
          {
            npc: "Philip Scaletta",
            goal: "别昏过去，撑到车开到地方。",
            hp: 4,
            conditions: ["腹部刀伤仍在渗血，意识开始模糊"],
          },
        ],
        sceneConditions: ["路面结了冰，雪打在挡风玻璃上几乎看不清路"],
      },
      {
        label: "侦探：远远跟着目标车",
        ticks: 4,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "开车远远跟住那辆车，别被对方察觉。",
          },
        ],
        sceneConditions: ["目标的车刚驶出停车场往北去，你的车停在街对面"],
      },
    ],
  },
  {
    id: "skill-research",
    group: "skill",
    title: "查阅文献档案 → research",
    targetDefs: ["research", "action"],
    cases: [
      {
        label: "书商：翻自己的旧目录",
        ticks: 4,
        actors: [
          {
            npc: "Solomon",
            goal: "在这些旧目录里查出那本书最早是从哪里流出来的。",
          },
        ],
        sceneConditions: [
          "靠墙一整排书架和成箱的旧目录，年份从上世纪一直排到今年",
        ],
      },
      {
        label: "律师：查判例",
        scene: "档案室",
        ticks: 4,
        actors: [
          {
            npc: "Mrs. Barklyite (Lucia Shiny)",
            goal: "把能支持这个主张的判例从这些汇编里找出来。",
          },
        ],
        sceneConditions: ["桌上堆着七八卷判例汇编，索引卡散了一半"],
      },
      {
        label: "侦探：翻旧报纸",
        ticks: 4,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "在这些旧报纸里翻出那桩旧案的报道。",
          },
        ],
        sceneConditions: ["架子上是一摞摞按年份捆好的旧报纸，落满灰"],
      },
      {
        label: "院长：查病案室",
        ticks: 4,
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "把那位病人的旧病历找出来，看清当年到底写了什么。",
          },
        ],
        sceneConditions: ["铁柜里的病案从1978年一直排到今年，标签有些已经模糊"],
      },
      {
        label: "警探：翻卷宗",
        ticks: 4,
        actors: [
          {
            npc: "Bruno Galilei",
            goal: "在这几百份卷宗里翻出之前那桩同类型案件的记录。",
          },
        ],
        sceneConditions: ["靠墙一整排铁皮档案柜，标签从1978年一直排到今年"],
      },
    ],
  },
  {
    id: "skill-occult",
    group: "skill",
    title: "辨认神秘符号 → occult",
    targetDefs: ["occult", "forbidden_lore", "archaeology", "anthropology"],
    cases: [
      {
        label: "书商：这套符号见过",
        ticks: 3,
        actors: [
          {
            npc: "Solomon",
            goal: "辨认出那块石板上的符号究竟属于哪一类仪式。",
          },
        ],
        sceneItems: ["symbol"],
      },
      {
        label: "市长：是不是自己人留的",
        ticks: 3,
        actors: [
          {
            npc: "Patrizio von Samsa",
            goal: "看清那块石板上的记号是不是自己人留下的，还是有别人在插手。",
          },
        ],
        sceneItems: ["symbol"],
        sceneConditions: ["石板上的刻痕很新，纹样和你熟悉的那一套只差了几笔"],
      },
      {
        label: "院长：病房墙上的刻痕",
        ticks: 3,
        actors: [
          {
            npc: "Vincent Galenus",
            goal: "弄清这些图案是什么意思，它和病人的状态有没有关系。",
          },
        ],
        sceneItems: ["symbol"],
        sceneConditions: [
          "床头墙面上被人用指甲刻满了同一个图案，和地上那块石板上的纹路一模一样",
        ],
      },
      {
        label: "花店少女：花圈上的怪符",
        ticks: 3,
        actors: [
          {
            npc: "Nancy Charlotte",
            goal: "弄明白那些符号是什么意思，心里实在不踏实。",
          },
        ],
        sceneItems: ["symbol"],
        sceneConditions: [
          "早上有人订的花圈丝带上写着一串奇怪符号，和柜台边那块石板上刻的很像；订花的人没留姓名",
        ],
      },
      {
        label: "侦探：现场留下的记号",
        ticks: 3,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "弄清那个记号代表什么，它可能指向凶手的圈子。",
          },
        ],
        sceneItems: ["symbol"],
        sceneConditions: [
          "现场唯一不属于这里的东西就是那块石板，纹路刻得很深，像是特意留给什么人看的",
        ],
      },
    ],
  },
  {
    id: "skill-track",
    group: "skill",
    title: "循迹追踪 → track",
    targetDefs: ["track", "movement"],
    cases: [
      {
        label: "猎人：雪地脚印",
        scene: "伐木场废墟",
        ticks: 5,
        actors: [
          { npc: "Johnny", goal: "顺着门外那串新鲜脚印追下去，看它通向哪里。" },
        ],
        sceneConditions: [
          "门外雪地上有一串新鲜脚印往树林方向去，边缘还没被风吹散；雪还在下",
        ],
      },
      {
        label: "警探：血迹拖痕",
        ticks: 5,
        actors: [{ npc: "Bruno Galilei", goal: "顺着那道血迹找到人。" }],
        sceneConditions: [
          "地上有一道断续的血迹从门口一直拖向外面，中间有几处手掌撑地的印子",
        ],
      },
      {
        label: "侦探：泥地上的车辙",
        ticks: 5,
        actors: [
          {
            npc: "Shandra Hernandez",
            goal: "顺着车辙判断那辆车往哪个方向走了。",
          },
        ],
        sceneConditions: [
          "泥地上有一道很新的车辙，一侧轮胎花纹缺了一块，一直延伸到围墙外的小路",
        ],
      },
      {
        label: "打手：追那个跑掉的人",
        ticks: 5,
        actors: [{ npc: "Kovind", goal: "顺着痕迹追上那个翻墙跑掉的人。" }],
        sceneConditions: ["墙头蹭掉的灰和地上的鞋印还清清楚楚，一路往北"],
      },
      {
        label: "老站务：站台上的脏脚印",
        ticks: 5,
        actors: [
          {
            npc: "Haran Greenwood",
            goal: "顺着那串带煤灰的脚印看看是谁从货运那边进来了。",
          },
        ],
        sceneConditions: [
          "干净的地面上有一串带煤灰的脚印，从货运月台一直延伸进来；这个时间不该有人从那边过来",
        ],
      },
    ],
  },
  {
    id: "skill-sleight_of_hand",
    group: "skill",
    title: "手上功夫顺走东西 → sleight_of_hand",
    targetDefs: ["sleight_of_hand", "stealth"],
    cases: [
      {
        label: "混混：摸走钥匙",
        ticks: 6,
        // 道具必须放在场景里，不能放进目标的口袋：renderer 只渲染 scene.items 和
        // 自己的 inventory，别人兜里的东西不在 [references] 里，主角引不到那个 id；
        // sleight_of_hand.md 的 stateDomains 也只 inject sceneItems + actorInventory，
        // resolver 同样拿不到合法 itemId 去写 item.move。
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "趁他背对着打电话，把柜台上那把黄铜钥匙摸走，别让他察觉。",
          },
          {
            npc: "Lux Lynch",
            goal: "背对着屋里的人把这通电话打完，顺便看住柜台上的钥匙。",
          },
        ],
        sceneItems: ["key"],
      },
      {
        label: "毒贩：趁他低头动手",
        ticks: 6,
        actors: [
          {
            npc: "Angela",
            goal: "趁他低头点钱的十几秒，把那本线索笔记本从桌上收走，别被看见。",
          },
          { npc: "Kovind", goal: "低头把这叠钱数完。" },
        ],
        sceneItems: ["notebook"],
      },
      {
        label: "钟表匠：在客人眼皮底下藏钥匙",
        ticks: 4,
        actors: [
          {
            npc: "Marks White",
            goal: "在他眼皮底下把工作台上那把黄铜钥匙收起来，别让他察觉。",
          },
          { npc: "Solomon", goal: "隔着工作台看着他的手，别让他做手脚。" },
        ],
        sceneItems: ["key"],
      },
      {
        label: "打手：把东西藏好",
        ticks: 4,
        actors: [
          {
            npc: "Kovind",
            goal: "门口要搜身了，在轮到你之前把身上那套撬锁工具藏好。",
            items: ["lockpick"],
          },
        ],
        sceneConditions: ["门口的人正在逐个搜身，队伍里还有两个人就轮到你"],
      },
      {
        label: "腐败警察：抽走一页记录",
        ticks: 6,
        actors: [
          {
            npc: "Lux Lynch",
            goal: "趁他转身接电话，把桌上那本笔记本弄走，不能留下任何痕迹。",
          },
          { npc: "Bruno Galilei", goal: "转身去接那通电话。" },
        ],
        sceneItems: ["notebook"],
      },
    ],
  },
  {
    id: "skill-bluff",
    group: "skill",
    title: "撒谎蒙混 → bluff",
    targetDefs: ["bluff", "character_interaction", "persuade"],
    cases: [
      {
        label: "混混：解释手里的文件",
        ticks: 3,
        actors: [
          {
            npc: "Philip Scaletta",
            goal: "编一个他会信的说法，把手里这本笔记本的来路糊弄过去。",
            items: ["notebook"],
          },
          {
            npc: "Bruno Galilei",
            goal: "问清他手里那本笔记本是从哪儿拿的，他没有权限拿。",
          },
        ],
      },
      {
        label: "毒贩：解释包里的东西",
        ticks: 3,
        actors: [
          { npc: "Angela", goal: "让他相信包里没什么值得看的，然后放你走。" },
          { npc: "Lux Lynch", goal: "盘查她，问清这么晚了包里装的什么。" },
        ],
      },
      {
        label: "市长：否认那场会面",
        ticks: 3,
        actors: [
          {
            npc: "Patrizio von Samsa",
            goal: "把上个月河边那场会面否认得滴水不漏。",
          },
          {
            npc: "Shandra Hernandez",
            goal: "追问他上个月是不是在河边和某个人见过面，盯着他的反应。",
          },
        ],
      },
      {
        label: "腐败警察：解释那晚的行踪",
        ticks: 3,
        actors: [
          {
            npc: "Lux Lynch",
            goal: "给出一个查不出破绽的说法，解释11月18号晚上十点到十一点你在哪儿。",
          },
          {
            npc: "Mrs. Barklyite (Lucia Shiny)",
            goal: "拿着排班表逐条追问他那晚十点到十一点的行踪。",
          },
        ],
      },
      {
        label: "钟表匠：假装不认识那只表",
        ticks: 3,
        actors: [
          {
            npc: "Marks White",
            goal: "让他相信你从没见过那只怀表——其实三个月前是你亲手改装的。",
          },
          { npc: "Johnny", goal: "把那只怀表推到他面前，问他见没见过。" },
        ],
        sceneItems: ["watch"],
      },
    ],
  },
];
