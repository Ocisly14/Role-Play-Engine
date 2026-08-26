/** Broad ability domains. The game engine determines specific approaches from context. */
export type SkillEntry = {
  name: string;
  base: string;
  category: string;
};

export const SKILLS: SkillEntry[] = [
  { name: "Social", base: "15%", category: "Social" },
  { name: "Knowledge & Craft", base: "5%", category: "Knowledge" },
  { name: "Science & Nature", base: "1%", category: "Knowledge" },
  { name: "Investigation", base: "20%", category: "Investigation" },
  { name: "Athletics", base: "20%", category: "Physical" },
  { name: "Swimming", base: "20%", category: "Physical" },
  { name: "Stealth & Security", base: "10%", category: "Investigation" },
  { name: "Repair & Engineering", base: "10%", category: "Technical" },
  { name: "Land Vehicle Operation", base: "20%", category: "Vehicle" },
  { name: "Watercraft Operation", base: "1%", category: "Vehicle" },
  { name: "Aircraft Operation", base: "1%", category: "Vehicle" },
  { name: "Survival & Navigation", base: "10%", category: "Physical" },
  { name: "Medicine & Psychology", base: "5%", category: "Knowledge" },
  { name: "Melee Combat", base: "20%", category: "Combat" },
  { name: "Ranged Combat", base: "15%", category: "Combat" },
  { name: "Languages", base: "0%", category: "Language" },
  { name: "Occult", base: "0%", category: "Knowledge" },
];

/** Used when opening a character created before skills were consolidated. */
export const LEGACY_SKILL_GROUPS: Record<string, string[]> = {
  Social: [
    "Charm",
    "Bluff",
    "Intimidate",
    "Persuade",
    "Psychology",
    "Social Status",
  ],
  "Knowledge & Craft": [
    "Accounting",
    "Anthropology",
    "Archaeology",
    "Art and Craft",
    "History",
    "Law",
    "Appraise",
    "Criminology",
  ],
  "Science & Nature": ["Biology", "Chemistry", "Physics", "Natural World"],
  Investigation: ["Listen", "Perception", "Track", "Research"],
  Athletics: ["Climb", "Dodge", "Jump", "Throw", "Ride"],
  Swimming: ["Swim"],
  "Stealth & Security": [
    "Disguise",
    "Sleight of Hand",
    "Stealth",
    "Locksmith",
    "Forgery",
  ],
  "Repair & Engineering": ["Electrical Repair", "Mechanical Repair"],
  "Land Vehicle Operation": ["Drive Auto", "Operate Heavy Machinery"],
  "Watercraft Operation": ["Pilot (Boat)"],
  "Aircraft Operation": ["Pilot (Aircraft)"],
  "Survival & Navigation": [
    "Navigate",
    "Survival (Arctic)",
    "Survival (Desert)",
    "Survival (Forest)",
  ],
  "Medicine & Psychology": ["First Aid", "Medicine", "Psychoanalysis"],
  "Melee Combat": ["Brawling", "Sword", "Axe", "Whip"],
  "Ranged Combat": ["Pistol", "Rifle", "Submachine Gun", "Bow"],
  Languages: ["Language (Own)", "Language (Other)"],
  Occult: ["Occult", "Forbidden Lore"],
};

export const getSkillsByCategory = (category: string): SkillEntry[] =>
  SKILLS.filter((skill) => skill.category === category);

export const getSkillCategories = (): string[] =>
  Array.from(new Set(SKILLS.map((skill) => skill.category)));
