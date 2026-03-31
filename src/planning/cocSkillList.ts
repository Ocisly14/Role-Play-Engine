/**
 * CoC 7th Edition skill list — extracted from client/server/skills/skillDescriptions.ts.
 * Used in planning prompts so the LLM picks valid skill names.
 */

export const COC_SKILLS: ReadonlyArray<{
  name: string;
  base: number;
  desc: string;
}> = [
  {
    name: "Charm",
    base: 15,
    desc: "Being likeable, making friends, seduction",
  },
  {
    name: "Bluff",
    base: 5,
    desc: "Quick deception, misdirection, verbal tricks",
  },
  {
    name: "Intimidate",
    base: 15,
    desc: "Frightening or coercing others through threats",
  },
  {
    name: "Persuade",
    base: 10,
    desc: "Convincing others through logical argument",
  },
  {
    name: "Psychology",
    base: 10,
    desc: "Understanding human behavior, detecting lies",
  },
  {
    name: "Accounting",
    base: 5,
    desc: "Understanding financial records, detecting embezzlement",
  },
  {
    name: "Anthropology",
    base: 1,
    desc: "Knowledge of human cultures and societies",
  },
  {
    name: "Archaeology",
    base: 1,
    desc: "Knowledge of ancient cultures and artifacts",
  },
  { name: "Art and Craft", base: 5, desc: "Artistic and craft skills" },
  {
    name: "History",
    base: 5,
    desc: "Knowledge of historical events and periods",
  },
  { name: "Law", base: 5, desc: "Knowledge of legal systems and procedures" },
  {
    name: "Research",
    base: 20,
    desc: "Research in libraries, archives, databases",
  },
  {
    name: "Occult",
    base: 5,
    desc: "Knowledge of supernatural beliefs, magic, folklore",
  },
  { name: "Biology", base: 1, desc: "Scientific knowledge of biology" },
  { name: "Chemistry", base: 1, desc: "Scientific knowledge of chemistry" },
  { name: "Physics", base: 1, desc: "Scientific knowledge of physics" },
  {
    name: "Appraise",
    base: 5,
    desc: "Estimating value of objects and antiques",
  },
  {
    name: "Listen",
    base: 20,
    desc: "Hearing sounds, eavesdropping, detecting noises",
  },
  {
    name: "Perception",
    base: 25,
    desc: "Finding hidden objects, spotting clues",
  },
  { name: "Track", base: 10, desc: "Following tracks and trails" },
  { name: "Climb", base: 20, desc: "Scaling walls, climbing obstacles" },
  {
    name: "Dodge",
    base: 0,
    desc: "Avoiding attacks and danger (base = DEX/2)",
  },
  { name: "Jump", base: 20, desc: "Leaping over gaps and obstacles" },
  { name: "Swim", base: 20, desc: "Swimming and water activities" },
  { name: "Throw", base: 20, desc: "Throwing objects accurately" },
  { name: "Ride", base: 5, desc: "Riding horses and similar animals" },
  {
    name: "Disguise",
    base: 5,
    desc: "Changing appearance to avoid recognition",
  },
  { name: "Sleight of Hand", base: 10, desc: "Pickpocketing, palming objects" },
  {
    name: "Stealth",
    base: 20,
    desc: "Moving silently, hiding, avoiding detection",
  },
  { name: "Electrical Repair", base: 10, desc: "Repairing electrical devices" },
  { name: "Mechanical Repair", base: 10, desc: "Repairing mechanical devices" },
  {
    name: "Operate Heavy Machinery",
    base: 1,
    desc: "Operating cranes, bulldozers, etc.",
  },
  { name: "Pilot (Aircraft)", base: 1, desc: "Piloting airplanes" },
  { name: "Pilot (Boat)", base: 1, desc: "Piloting boats and ships" },
  { name: "Drive Auto", base: 20, desc: "Driving automobiles" },
  { name: "Navigate", base: 10, desc: "Finding direction, using maps" },
  { name: "First Aid", base: 30, desc: "Emergency medical treatment" },
  {
    name: "Medicine",
    base: 1,
    desc: "Professional medical knowledge and practice",
  },
  {
    name: "Natural World",
    base: 10,
    desc: "Knowledge of flora, fauna, natural phenomena",
  },
  {
    name: "Survival (Arctic)",
    base: 10,
    desc: "Surviving in arctic environments",
  },
  {
    name: "Survival (Desert)",
    base: 10,
    desc: "Surviving in desert environments",
  },
  {
    name: "Survival (Forest)",
    base: 10,
    desc: "Surviving in forest environments",
  },
  {
    name: "Psychoanalysis",
    base: 1,
    desc: "Professional treatment of mental disorders",
  },
  {
    name: "Brawling",
    base: 25,
    desc: "Hand-to-hand combat, punching, kicking",
  },
  { name: "Sword", base: 5, desc: "Combat with swords" },
  { name: "Axe", base: 5, desc: "Combat with axes" },
  { name: "Whip", base: 5, desc: "Combat with whips" },
  { name: "Pistol", base: 20, desc: "Using pistols and revolvers" },
  { name: "Rifle", base: 25, desc: "Using rifles and shotguns" },
  { name: "Submachine Gun", base: 15, desc: "Using submachine guns" },
  { name: "Bow", base: 15, desc: "Using bows and crossbows" },
  {
    name: "Locksmith",
    base: 1,
    desc: "Picking locks and understanding security",
  },
  {
    name: "Criminology",
    base: 1,
    desc: "Understanding criminal behavior and investigation",
  },
  { name: "Forgery", base: 5, desc: "Creating fake documents and signatures" },
  { name: "Language (Own)", base: 0, desc: "Native language (base = EDU×5)" },
  { name: "Language (Other)", base: 1, desc: "Foreign language" },
  { name: "Social Status", base: 0, desc: "Wealth and social standing" },
  { name: "Forbidden Lore", base: 0, desc: "Knowledge of forbidden truths" },
];

/** Base value lookup: skill name → default value for untrained characters */
export const COC_SKILL_BASE_VALUES = new Map<string, number>(
  COC_SKILLS.map((s) => [s.name, s.base])
);

/** Formatted skill list for prompt injection: "Charm (likeable, seduction), Bluff (deception), ..." */
export const COC_SKILL_LIST_PROMPT = COC_SKILLS.map(
  (s) => `${s.name} (${s.desc})`
).join(", ");
