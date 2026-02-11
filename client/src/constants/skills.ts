/**
 * Call of Cthulhu 7th Edition - Standard Skills List
 * Base values and categories for all available skills
 */

export type SkillEntry = {
  name: string;
  base: string;
  category: string;
};

export const SKILLS: SkillEntry[] = [
  // Interpersonal & Social Skills
  { name: "Charm", base: "15%", category: "Social" },
  { name: "Bluff", base: "5%", category: "Social" },
  { name: "Intimidate", base: "15%", category: "Social" },
  { name: "Persuade", base: "10%", category: "Social" },
  { name: "Psychology", base: "10%", category: "Social" },

  // Knowledge & Academic Skills
  { name: "Accounting", base: "5%", category: "Knowledge" },
  { name: "Anthropology", base: "1%", category: "Knowledge" },
  { name: "Archaeology", base: "1%", category: "Knowledge" },
  { name: "Art and Craft", base: "5%", category: "Knowledge" },
  { name: "History", base: "5%", category: "Knowledge" },
  { name: "Law", base: "5%", category: "Knowledge" },
  { name: "Research", base: "20%", category: "Knowledge" },
  { name: "Occult", base: "5%", category: "Knowledge" },
  { name: "Biology", base: "1%", category: "Knowledge" },
  { name: "Chemistry", base: "1%", category: "Knowledge" },
  { name: "Physics", base: "1%", category: "Knowledge" },

  // Perception & Investigation Skills
  { name: "Listen", base: "20%", category: "Investigation" },
  { name: "Perception", base: "25%", category: "Investigation" },
  { name: "Track", base: "10%", category: "Investigation" },

  // Physical & Movement Skills
  { name: "Climb", base: "20%", category: "Physical" },
  { name: "Dodge", base: "0%", category: "Physical" },
  { name: "Jump", base: "20%", category: "Physical" },
  { name: "Swim", base: "20%", category: "Physical" },
  { name: "Throw", base: "20%", category: "Physical" },

  // Stealth & Deception Skills
  { name: "Disguise", base: "5%", category: "Stealth" },
  { name: "Sleight of Hand", base: "10%", category: "Stealth" },
  { name: "Stealth", base: "20%", category: "Stealth" },

  // Mechanical & Technical Skills
  { name: "Electrical Repair", base: "10%", category: "Technical" },
  { name: "Mechanical Repair", base: "10%", category: "Technical" },
  { name: "Operate Heavy Machinery", base: "1%", category: "Technical" },
  { name: "Pilot (Aircraft)", base: "1%", category: "Technical" },
  { name: "Pilot (Boat)", base: "1%", category: "Technical" },
  { name: "Drive Auto", base: "20%", category: "Technical" },

  // Medical & Survival Skills
  { name: "First Aid", base: "30%", category: "Medical" },
  { name: "Medicine", base: "1%", category: "Medical" },
  { name: "Natural World", base: "10%", category: "Medical" },
  { name: "Survival (Arctic)", base: "10%", category: "Medical" },
  { name: "Survival (Desert)", base: "10%", category: "Medical" },
  { name: "Survival (Forest)", base: "10%", category: "Medical" },

  // Combat Skills - Fighting
  { name: "Brawling", base: "25%", category: "Combat" },
  { name: "Sword", base: "20%", category: "Combat" },
  { name: "Axe", base: "15%", category: "Combat" },
  { name: "Whip", base: "5%", category: "Combat" },

  // Combat Skills - Firearms
  { name: "Pistol", base: "20%", category: "Combat" },
  { name: "Rifle", base: "25%", category: "Combat" },
  { name: "Submachine Gun", base: "15%", category: "Combat" },
  { name: "Bow", base: "15%", category: "Combat" },

  // Criminal & Subterfuge Skills
  { name: "Locksmith", base: "1%", category: "Criminal" },
  { name: "Criminology", base: "1%", category: "Criminal" },
  { name: "Forgery", base: "1%", category: "Criminal" },

  // Communication & Language Skills
  { name: "Language (Own)", base: "0%", category: "Language" },
  { name: "Language (Other)", base: "1%", category: "Language" },

  // Financial & Status Skill
  { name: "Social Status", base: "0%", category: "Status" },

  // Forbidden Lore (Mythos knowledge)
  { name: "Forbidden Lore", base: "0%", category: "Mythos" },

  // Additional Common Skills
  { name: "Appraise", base: "5%", category: "Knowledge" },
  { name: "Navigate", base: "10%", category: "Technical" },
  { name: "Psychoanalysis", base: "1%", category: "Medical" },
  { name: "Ride", base: "5%", category: "Physical" },
];

/**
 * Get skills by category
 */
export const getSkillsByCategory = (category: string): SkillEntry[] => {
  return SKILLS.filter((skill) => skill.category === category);
};

/**
 * Get all unique categories
 */
export const getSkillCategories = (): string[] => {
  return Array.from(new Set(SKILLS.map((skill) => skill.category)));
};
