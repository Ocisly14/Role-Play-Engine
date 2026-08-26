/**
 * The game's skill model intentionally uses broad ability domains. Specific
 * approaches, tools, weapon types, and environmental constraints are judged
 * from the action description by the Engine rather than being separate stats.
 */
export const SKILL_CATALOG = [
  {
    name: "Social",
    base: 15,
    description:
      "Influence, deceive, intimidate, negotiate with, or read people.",
  },
  {
    name: "Knowledge & Craft",
    base: 5,
    description:
      "Humanities, law, finance, appraisal, art, and practical craft knowledge.",
  },
  {
    name: "Science & Nature",
    base: 1,
    description:
      "Natural history and scientific reasoning, including biology, chemistry, and physics.",
  },
  {
    name: "Investigation",
    base: 20,
    description:
      "Notice, listen for, research, follow, and connect evidence or clues.",
  },
  {
    name: "Athletics",
    base: 20,
    description:
      "Climb, jump, run, throw, ride, and perform other non-swimming physical feats.",
  },
  {
    name: "Swimming",
    base: 20,
    description: "Swim, dive, stay afloat, and act effectively in water.",
  },
  {
    name: "Stealth & Security",
    base: 10,
    description:
      "Hide, sneak, disguise, pick locks, palm objects, and forge documents.",
  },
  {
    name: "Repair & Engineering",
    base: 10,
    description:
      "Diagnose, repair, improvise, and operate technical or mechanical equipment.",
  },
  {
    name: "Land Vehicle Operation",
    base: 20,
    description: "Drive cars, motorcycles, trucks, and heavy land machinery.",
  },
  {
    name: "Watercraft Operation",
    base: 1,
    description: "Pilot, navigate, and handle boats and other watercraft.",
  },
  {
    name: "Aircraft Operation",
    base: 1,
    description: "Pilot and safely operate aircraft.",
  },
  {
    name: "Survival & Navigation",
    base: 10,
    description:
      "Find a route, endure hostile terrain, and secure necessities outdoors.",
  },
  {
    name: "Medicine & Psychology",
    base: 5,
    description:
      "Provide first aid, diagnose or treat illness, and understand or treat the mind.",
  },
  {
    name: "Melee Combat",
    base: 20,
    description: "Fight unarmed or with hand-held melee weapons.",
  },
  {
    name: "Ranged Combat",
    base: 15,
    description: "Use firearms, bows, crossbows, and thrown combat weapons.",
  },
  {
    name: "Languages",
    base: 0,
    description:
      "Read, write, speak, translate, or interpret languages and specialized registers.",
  },
  {
    name: "Occult",
    base: 0,
    description:
      "Recognize folklore, supernatural practices, and forbidden or Mythos knowledge.",
  },
] as const;

export type CanonicalSkillName = (typeof SKILL_CATALOG)[number]["name"];

/** Maps pre-consolidation character data to the new broad skill names. */
export const LEGACY_SKILL_TO_CANONICAL: Readonly<
  Record<string, CanonicalSkillName>
> = {
  Charm: "Social",
  Bluff: "Social",
  Intimidate: "Social",
  Persuade: "Social",
  Psychology: "Social",
  "Social Status": "Social",
  Accounting: "Knowledge & Craft",
  Anthropology: "Knowledge & Craft",
  Archaeology: "Knowledge & Craft",
  "Art and Craft": "Knowledge & Craft",
  History: "Knowledge & Craft",
  Law: "Knowledge & Craft",
  Appraise: "Knowledge & Craft",
  Criminology: "Knowledge & Craft",
  Biology: "Science & Nature",
  Chemistry: "Science & Nature",
  Physics: "Science & Nature",
  "Natural World": "Science & Nature",
  Listen: "Investigation",
  Perception: "Investigation",
  Track: "Investigation",
  Research: "Investigation",
  Climb: "Athletics",
  Jump: "Athletics",
  Throw: "Athletics",
  Ride: "Athletics",
  Dodge: "Athletics",
  Swim: "Swimming",
  Disguise: "Stealth & Security",
  "Sleight of Hand": "Stealth & Security",
  Stealth: "Stealth & Security",
  Locksmith: "Stealth & Security",
  Forgery: "Stealth & Security",
  "Electrical Repair": "Repair & Engineering",
  "Mechanical Repair": "Repair & Engineering",
  "Operate Heavy Machinery": "Land Vehicle Operation",
  "Drive Auto": "Land Vehicle Operation",
  "Pilot (Boat)": "Watercraft Operation",
  "Pilot (Aircraft)": "Aircraft Operation",
  Navigate: "Survival & Navigation",
  "Survival (Arctic)": "Survival & Navigation",
  "Survival (Desert)": "Survival & Navigation",
  "Survival (Forest)": "Survival & Navigation",
  "First Aid": "Medicine & Psychology",
  Medicine: "Medicine & Psychology",
  Psychoanalysis: "Medicine & Psychology",
  Brawling: "Melee Combat",
  Brawl: "Melee Combat",
  Sword: "Melee Combat",
  Axe: "Melee Combat",
  Whip: "Melee Combat",
  Pistol: "Ranged Combat",
  Handgun: "Ranged Combat",
  Rifle: "Ranged Combat",
  Shotgun: "Ranged Combat",
  "Submachine Gun": "Ranged Combat",
  Bow: "Ranged Combat",
  "Language (Own)": "Languages",
  "Language (Other)": "Languages",
  Occult: "Occult",
  "Forbidden Lore": "Occult",
};

export function canonicalSkillName(name: string): string {
  if (LEGACY_SKILL_TO_CANONICAL[name]) return LEGACY_SKILL_TO_CANONICAL[name];
  const matchingLegacyName = Object.keys(LEGACY_SKILL_TO_CANONICAL).find(
    (legacyName) => legacyName.toLowerCase() === name.toLowerCase()
  );
  return matchingLegacyName
    ? LEGACY_SKILL_TO_CANONICAL[matchingLegacyName]
    : name;
}
