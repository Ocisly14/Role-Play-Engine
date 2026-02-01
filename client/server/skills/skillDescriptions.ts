const normalizeKey = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const SKILL_DEFINITIONS: Array<{ names: string[]; description: string }> = [
  // Interpersonal & Social Skills
  {
    names: ["Charm"],
    description: "Being likeable, making friends, seduction.",
  },
  {
    names: ["Bluff", "Fast Talk"],
    description: "Quick deception, misdirection, verbal tricks.",
  },
  {
    names: ["Intimidate"],
    description: "Frightening or coercing others through threats.",
  },
  {
    names: ["Persuade", "Persuasion"],
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
    names: ["Art and Craft", "Art/Craft", "Art", "Craft"],
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
    names: ["Research", "Library Use", "Library"],
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
    names: ["Science"],
    description: "Scientific knowledge in a specific field.",
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
    names: ["Perception", "Spot Hidden"],
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
    names: ["Stealth", "Sneak", "Hide"],
    description: "Moving silently, hiding, avoiding detection.",
  },

  // Mechanical & Technical Skills
  {
    names: ["Electrical Repair"],
    description: "Repairing electrical devices.",
  },
  {
    names: ["Mechanical Repair", "Mechanics", "Repair"],
    description: "Repairing mechanical devices.",
  },
  {
    names: ["Operate Heavy Machinery"],
    description: "Operating cranes, bulldozers, etc.",
  },
  {
    names: ["Pilot (Aircraft)", "Pilot"],
    description: "Piloting airplanes.",
  },
  {
    names: ["Pilot (Boat)"],
    description: "Piloting boats and ships.",
  },
  {
    names: ["Drive Auto", "Drive"],
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
    names: ["Survival"],
    description: "Surviving in harsh environments.",
  },
  {
    names: ["Psychoanalysis"],
    description: "Professional treatment of mental disorders.",
  },

  // Combat Skills - Fighting
  {
    names: ["Brawling", "Brawl"],
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
    names: ["Pistol", "Handgun", "Firearms"],
    description: "Using pistols and revolvers.",
  },
  {
    names: ["Rifle", "Shotgun"],
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
    names: ["Locksmith", "Lock Pick"],
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
    names: ["Social Status", "Credit Rating"],
    description: "Wealth and social standing.",
  },

  // Forbidden Lore (Mythos knowledge)
  {
    names: ["Forbidden Lore"],
    description: "Knowledge of forbidden truths (reduces max Sanity).",
  },
];

const DESCRIPTION_MAP = new Map<string, string>();

for (const entry of SKILL_DEFINITIONS) {
  for (const name of entry.names) {
    DESCRIPTION_MAP.set(normalizeKey(name), entry.description);
  }
}

export const getSkillDescription = (skillName: string): string => {
  const normalized = normalizeKey(skillName);
  return DESCRIPTION_MAP.get(normalized) ?? skillName;
};
