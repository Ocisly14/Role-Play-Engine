const normalizeKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const SKILL_DEFINITIONS: Array<{ names: string[]; description: string }> = [
  // Interpersonal & Social Skills
  {
    names: ["Charm"],
    description: "Being likeable, making friends, seduction.",
  },
  {
    names: ["Bluff"],
    description: "Quick deception, misdirection, verbal tricks.",
  },
  {
    names: ["Intimidate"],
    description: "Frightening or coercing others through threats.",
  },
  {
    names: ["Persuade"],
    description: "Convincing others through logical argument.",
  },
  {
    names: ["Psychology"],
    description:
      "Understanding human behavior, detecting lies, treating mental illness.",
  },

  // Knowledge & Academic Skills
  {
    names: ["Accounting"],
    description: "Understanding financial records, detecting embezzlement.",
  },
  {
    names: ["Anthropology"],
    description: "Knowledge of human cultures and societies.",
  },
  {
    names: ["Archaeology"],
    description: "Knowledge of ancient cultures and artifacts.",
  },
  {
    names: ["Art and Craft"],
    description: "Artistic and craft skills.",
  },
  {
    names: ["History"],
    description: "Knowledge of historical events and periods.",
  },
  {
    names: ["Law"],
    description: "Knowledge of legal systems and procedures.",
  },
  {
    names: ["Research"],
    description: "Research in libraries, archives, databases.",
  },
  {
    names: ["Occult"],
    description: "Knowledge of supernatural beliefs, magic, and folklore.",
  },
  {
    names: ["Biology"],
    description: "Scientific knowledge of biology.",
  },
  {
    names: ["Chemistry"],
    description: "Scientific knowledge of chemistry.",
  },
  {
    names: ["Physics"],
    description: "Scientific knowledge of physics.",
  },
  {
    names: ["Appraise"],
    description: "Estimating value of objects and antiques.",
  },

  // Perception & Investigation Skills
  {
    names: ["Listen"],
    description: "Hearing sounds, eavesdropping, detecting noises.",
  },
  {
    names: ["Perception"],
    description: "Finding hidden objects, spotting clues, noticing concealed things.",
  },
  {
    names: ["Track"],
    description: "Following tracks and trails.",
  },

  // Physical & Movement Skills
  {
    names: ["Climb"],
    description: "Scaling walls, climbing obstacles.",
  },
  {
    names: ["Dodge"],
    description: "Avoiding attacks and danger (calculated as DEX/2).",
  },
  {
    names: ["Jump"],
    description: "Leaping over gaps and obstacles.",
  },
  {
    names: ["Swim"],
    description: "Swimming and water activities.",
  },
  {
    names: ["Throw"],
    description: "Throwing objects accurately.",
  },
  {
    names: ["Ride"],
    description: "Riding horses and similar animals.",
  },

  // Stealth & Deception Skills
  {
    names: ["Disguise"],
    description: "Changing appearance to avoid recognition.",
  },
  {
    names: ["Sleight of Hand"],
    description: "Pickpocketing, palming objects, stage magic.",
  },
  {
    names: ["Stealth"],
    description: "Moving silently, hiding, avoiding detection.",
  },

  // Mechanical & Technical Skills
  {
    names: ["Electrical Repair"],
    description: "Repairing electrical devices.",
  },
  {
    names: ["Mechanical Repair"],
    description: "Repairing mechanical devices.",
  },
  {
    names: ["Operate Heavy Machinery"],
    description: "Operating cranes, bulldozers, etc.",
  },
  {
    names: ["Pilot (Aircraft)"],
    description: "Piloting airplanes.",
  },
  {
    names: ["Pilot (Boat)"],
    description: "Piloting boats and ships.",
  },
  {
    names: ["Drive Auto"],
    description: "Driving automobiles.",
  },
  {
    names: ["Navigate"],
    description: "Finding direction, using maps.",
  },

  // Medical & Survival Skills
  {
    names: ["First Aid"],
    description: "Emergency medical treatment.",
  },
  {
    names: ["Medicine"],
    description: "Professional medical knowledge and practice.",
  },
  {
    names: ["Natural World"],
    description: "Knowledge of flora, fauna, and natural phenomena.",
  },
  {
    names: ["Survival (Arctic)"],
    description: "Surviving in arctic environments.",
  },
  {
    names: ["Survival (Desert)"],
    description: "Surviving in desert environments.",
  },
  {
    names: ["Survival (Forest)"],
    description: "Surviving in forest environments.",
  },
  {
    names: ["Psychoanalysis"],
    description: "Professional treatment of mental disorders.",
  },

  // Combat Skills - Fighting
  {
    names: ["Brawling"],
    description: "Hand-to-hand combat, punching, kicking.",
  },
  {
    names: ["Sword"],
    description: "Combat with swords.",
  },
  {
    names: ["Axe"],
    description: "Combat with axes.",
  },
  {
    names: ["Whip"],
    description: "Combat with whips.",
  },

  // Combat Skills - Firearms
  {
    names: ["Pistol"],
    description: "Using pistols and revolvers.",
  },
  {
    names: ["Rifle"],
    description: "Using rifles and shotguns.",
  },
  {
    names: ["Submachine Gun"],
    description: "Using submachine guns.",
  },
  {
    names: ["Bow"],
    description: "Using bows and crossbows.",
  },

  // Criminal & Subterfuge Skills
  {
    names: ["Locksmith"],
    description: "Picking locks and understanding security.",
  },
  {
    names: ["Criminology"],
    description: "Understanding criminal behavior and investigation.",
  },
  {
    names: ["Forgery"],
    description: "Creating fake documents and signatures.",
  },

  // Communication & Language Skills
  {
    names: ["Language (Own)"],
    description: "Native language (EDU×5).",
  },
  {
    names: ["Language (Other)"],
    description: "Foreign language.",
  },

  // Financial & Status Skill
  {
    names: ["Social Status"],
    description: "Wealth and social standing.",
  },

  // Forbidden Lore (Mythos knowledge)
  {
    names: ["Forbidden Lore"],
    description: "Knowledge of forbidden truths (reduces max Sanity).",
  },
];

const SKILL_DEFINITIONS_ZH: Array<{ names: string[]; description: string }> = [
  // 社交
  { names: ["魅惑"], description: "讨人喜欢、结交朋友、诱惑。"},
  { names: ["欺骗"], description: "快速欺骗、误导、话术。"},
  { names: ["恐吓"], description: "通过威胁或恐吓胁迫他人。"},
  { names: ["说服"], description: "用逻辑论证说服他人。"},
  { names: ["心理学"], description: "理解人类行为、识破谎言、精神病理。"},

  // 学术与知识
  { names: ["会计"], description: "理解财务记录、发现挪用。"},
  { names: ["人类学"], description: "人类文化与社会的知识。"},
  { names: ["考古学"], description: "古代文化与遗物知识。"},
  { names: ["艺术与手工"], description: "艺术与手工技能。"},
  { names: ["历史"], description: "历史事件与时期知识。"},
  { names: ["法律"], description: "法律体系与程序知识。"},
  { names: ["检索"], description: "在图书馆、档案、数据库中检索。"},
  { names: ["神秘学"], description: "超自然信仰、魔法与民俗知识。"},
  { names: ["生物学"], description: "生物学知识。"},
  { names: ["化学"], description: "化学知识。"},
  { names: ["物理学"], description: "物理学知识。"},
  { names: ["鉴定"], description: "物品与古董估价。"},

  // 侦察与调查
  { names: ["聆听"], description: "听觉、偷听、察觉声响。"},
  { names: ["侦察"], description: "发现隐藏物、线索与细节。"},
  { names: ["追踪"], description: "追踪足迹与踪迹。"},

  // 身体与移动
  { names: ["攀爬"], description: "攀爬墙壁或障碍。"},
  { names: ["闪避"], description: "闪避攻击与危险（DEX/2）。"},
  { names: ["跳跃"], description: "跳越空隙与障碍。"},
  { names: ["游泳"], description: "游泳与水上活动。"},
  { names: ["投掷"], description: "投掷物体的准确度。"},
  { names: ["骑术"], description: "骑乘马及类似动物。"},

  // 潜行与骗术
  { names: ["乔装"], description: "改变外观以避免识别。"},
  { names: ["巧手"], description: "扒窃、藏匿、戏法。"},
  { names: ["潜行"], description: "潜行、隐匿、避免被发现。"},

  // 机械与技术
  { names: ["电气维修"], description: "维修电气设备。"},
  { names: ["机械维修"], description: "维修机械装置。"},
  { names: ["重型机械操作"], description: "操作起重机、推土机等。"},
  { names: ["飞机驾驶"], description: "驾驶飞机。"},
  { names: ["船只驾驶"], description: "驾驶船只。"},
  { names: ["汽车驾驶"], description: "驾驶汽车。"},
  { names: ["导航"], description: "定位与导航，使用地图。"},

  // 医疗与生存
  { names: ["急救"], description: "紧急医疗处理。"},
  { names: ["医学"], description: "专业医学知识与实践。"},
  { names: ["自然学"], description: "动植物与自然现象知识。"},
  { names: ["生存（极地）"], description: "极地环境生存。"},
  { names: ["生存（沙漠）"], description: "沙漠环境生存。"},
  { names: ["生存（森林）"], description: "森林环境生存。"},
  { names: ["精神分析"], description: "精神分析与治疗。"},

  // 战斗
  { names: ["格斗"], description: "徒手格斗、拳打脚踢。"},
  { names: ["剑术"], description: "使用剑类武器。"},
  { names: ["斧术"], description: "使用斧类武器。"},
  { names: ["鞭术"], description: "使用鞭类武器。"},
  { names: ["手枪"], description: "使用手枪与左轮。"},
  { names: ["步枪"], description: "使用步枪与霰弹枪。"},
  { names: ["冲锋枪"], description: "使用冲锋枪。"},
  { names: ["弓"], description: "使用弓与弩。"},

  // 犯罪与伪造
  { names: ["开锁"], description: "开锁与安全结构知识。"},
  { names: ["犯罪学"], description: "犯罪学与侦查知识。"},
  { names: ["伪造"], description: "伪造文件与签名。"},

  // 语言
  { names: ["母语"], description: "母语（EDU×5）。"},
  { names: ["外语"], description: "外语。"},

  // 财务与地位
  { names: ["社会地位"], description: "财富与社会地位。"},

  // 禁忌学识
  { names: ["禁忌知识"], description: "禁忌真相知识（降低最大理智）。"},
];

const DESCRIPTION_MAP = new Map<string, string>();
const DESCRIPTION_MAP_ZH = new Map<string, string>();
const SKILL_NAME_ZH: Record<string, string> = {
  "Charm": "魅惑",
  "Bluff": "欺骗",
  "Intimidate": "恐吓",
  "Persuade": "说服",
  "Psychology": "心理学",
  "Accounting": "会计",
  "Anthropology": "人类学",
  "Archaeology": "考古学",
  "Art and Craft": "艺术与手工",
  "History": "历史",
  "Law": "法律",
  "Research": "检索",
  "Occult": "神秘学",
  "Biology": "生物学",
  "Chemistry": "化学",
  "Physics": "物理学",
  "Appraise": "鉴定",
  "Listen": "聆听",
  "Perception": "侦察",
  "Track": "追踪",
  "Climb": "攀爬",
  "Dodge": "闪避",
  "Jump": "跳跃",
  "Swim": "游泳",
  "Throw": "投掷",
  "Ride": "骑术",
  "Disguise": "乔装",
  "Sleight of Hand": "巧手",
  "Stealth": "潜行",
  "Electrical Repair": "电气维修",
  "Mechanical Repair": "机械维修",
  "Operate Heavy Machinery": "重型机械操作",
  "Pilot (Aircraft)": "飞机驾驶",
  "Pilot (Boat)": "船只驾驶",
  "Drive Auto": "汽车驾驶",
  "Navigate": "导航",
  "First Aid": "急救",
  "Medicine": "医学",
  "Natural World": "自然学",
  "Survival (Arctic)": "生存（极地）",
  "Survival (Desert)": "生存（沙漠）",
  "Survival (Forest)": "生存（森林）",
  "Psychoanalysis": "精神分析",
  "Brawling": "格斗",
  "Sword": "剑术",
  "Axe": "斧术",
  "Whip": "鞭术",
  "Pistol": "手枪",
  "Rifle": "步枪",
  "Submachine Gun": "冲锋枪",
  "Bow": "弓",
  "Locksmith": "开锁",
  "Criminology": "犯罪学",
  "Forgery": "伪造",
  "Language (Own)": "母语",
  "Language (Other)": "外语",
  "Social Status": "社会地位",
  "Forbidden Lore": "禁忌知识",
};

for (const entry of SKILL_DEFINITIONS) {
  for (const name of entry.names) {
    DESCRIPTION_MAP.set(normalizeKey(name), entry.description);
  }
}
for (const entry of SKILL_DEFINITIONS_ZH) {
  for (const name of entry.names) {
    DESCRIPTION_MAP_ZH.set(normalizeKey(name), entry.description);
  }
}

export const getSkillDescription = (skillName: string): string => {
  const normalized = normalizeKey(skillName);
  return DESCRIPTION_MAP.get(normalized) ?? skillName;
};

export const getSkillDescriptionZh = (skillName: string): string => {
  const mappedName = SKILL_NAME_ZH[skillName] ?? skillName;
  const normalized = normalizeKey(mappedName);
  return DESCRIPTION_MAP_ZH.get(normalized) ?? mappedName;
};

export const getSkillNameZh = (skillName: string): string =>
  SKILL_NAME_ZH[skillName] ?? skillName;
