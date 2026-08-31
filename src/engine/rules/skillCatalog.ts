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

  // ── Names observed in module content (data/Mods/**/*.json) ──
  "Fast Talk": "Social",
  Bargain: "Social",
  Diplomacy: "Social",
  "Credit Rating": "Social",
  Gambling: "Social",
  "Library Use": "Investigation",
  "Spot Hidden": "Investigation",
  "Appraise Prey": "Investigation",
  Religion: "Knowledge & Craft",
  Bartending: "Knowledge & Craft",
  Cryptography: "Knowledge & Craft",
  Hide: "Stealth & Security",
  "Computer Use": "Repair & Engineering",
  Electronics: "Repair & Engineering",
  Pharmacy: "Medicine & Psychology",
  Grapple: "Melee Combat",
  Bite: "Melee Combat",
  "Claw Attack": "Melee Combat",
  Crush: "Melee Combat",
  "Head Butt": "Melee Combat",
  "Web Projection": "Ranged Combat",
  Latin: "Languages",
  "Cthulhu Mythos": "Occult",

  // Bare stems for the parenthetical-specialty rule in canonicalSkillName:
  // "Fighting (Claw)", "Firearms (Rifle)", "Craft (Distilling)" and any
  // future specialty resolve through these without a new entry each.
  Fighting: "Melee Combat",
  Firearms: "Ranged Combat",
  Craft: "Knowledge & Craft",
  "Art/Craft": "Knowledge & Craft",
  Language: "Languages",
  Survival: "Survival & Navigation",
  Pilot: "Aircraft Operation",
};

export function canonicalSkillName(name: string): string {
  const direct = lookupLegacy(name);
  if (direct) return direct;

  // Specialties are written as "Stem (Specialty)" — "Fighting (Claw)",
  // "Firearms (Rifle)", "Craft (Distilling)". The specialty is exactly the
  // detail the Engine now judges from the action description, so the stem
  // decides the domain and new specialties need no new entries.
  const stem = name.match(/^([^(]+?)\s*\(/)?.[1];
  if (stem) {
    const viaStem = lookupLegacy(stem);
    if (viaStem) return viaStem;
    const canonical = SKILL_CATALOG.find(
      (s) => s.name.toLowerCase() === stem.toLowerCase()
    );
    if (canonical) return canonical.name;
  }

  return name.trim();
}

function lookupLegacy(name: string): string | undefined {
  const trimmed = name.trim();
  if (LEGACY_SKILL_TO_CANONICAL[trimmed]) {
    return LEGACY_SKILL_TO_CANONICAL[trimmed];
  }
  const matchingLegacyName = Object.keys(LEGACY_SKILL_TO_CANONICAL).find(
    (legacyName) => legacyName.toLowerCase() === trimmed.toLowerCase()
  );
  return matchingLegacyName
    ? LEGACY_SKILL_TO_CANONICAL[matchingLegacyName]
    : undefined;
}

/**
 * Fold a pre-consolidation skill map onto the broad domains, keeping the
 * HIGHEST value among the specialties that merged into each domain — a
 * character who trained Locksmith to 70 and Stealth to 40 is a 70 at
 * Stealth & Security, not an average of the two.
 *
 * Returns the consolidated map plus any names that resolved to nothing in
 * the catalog, so a migration can report them instead of dropping them.
 */
export function consolidateSkills(skills: Record<string, number>): {
  consolidated: Record<string, number>;
  unmapped: string[];
} {
  const catalogNames = new Set<string>(SKILL_CATALOG.map((s) => s.name));
  const consolidated: Record<string, number> = {};
  const unmapped: string[] = [];

  for (const [rawName, value] of Object.entries(skills)) {
    if (typeof value !== "number" || Number.isNaN(value)) continue;
    const canonical = canonicalSkillName(rawName);
    if (!catalogNames.has(canonical)) {
      unmapped.push(rawName);
      continue;
    }
    const current = consolidated[canonical];
    consolidated[canonical] =
      current === undefined ? value : Math.max(current, value);
  }

  // Stable catalog order so rewritten files diff cleanly.
  const ordered: Record<string, number> = {};
  for (const skill of SKILL_CATALOG) {
    if (consolidated[skill.name] !== undefined) {
      ordered[skill.name] = consolidated[skill.name];
    }
  }
  return { consolidated: ordered, unmapped };
}
