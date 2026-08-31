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

/**
 * Resolve a name to the catalog's exact spelling, case-insensitively.
 * Returns undefined for anything that is not one of the 17 domains — there
 * is no legacy-name fallback: pre-consolidation skill names ("Locksmith",
 * "Spot Hidden", …) are authoring errors, rejected at intake and inert in
 * penalty maps, not silently folded.
 */
export function catalogSkillName(name: string): CanonicalSkillName | undefined {
  const needle = name.trim().toLowerCase();
  return SKILL_CATALOG.find((s) => s.name.toLowerCase() === needle)?.name;
}

/** Base value for an untrained character, by canonical domain name. */
export const SKILL_BASE_VALUES: ReadonlyMap<CanonicalSkillName, number> =
  new Map(SKILL_CATALOG.map((s) => [s.name, s.base]));
