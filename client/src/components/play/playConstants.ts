// Hard-coded mirror of src/engine/rules/skillCatalog.ts — the `id` is the
// catalog name the backend expects as `skillId`. Do NOT import server code.
export const SKILL_DOMAINS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "Knowledge & Craft", label: "学识与手艺" },
  { id: "Science & Nature", label: "科学与自然" },
  { id: "Investigation", label: "调查" },
  { id: "Athletics", label: "运动" },
  { id: "Swimming", label: "游泳" },
  { id: "Stealth & Security", label: "潜行与开锁" },
  { id: "Repair & Engineering", label: "修理与工程" },
  { id: "Land Vehicle Operation", label: "陆上驾驶" },
  { id: "Watercraft Operation", label: "驾船" },
  { id: "Aircraft Operation", label: "驾驶飞行器" },
  { id: "Survival & Navigation", label: "生存与导航" },
  { id: "Medicine", label: "医学" },
  { id: "Melee Combat", label: "格斗" },
  { id: "Ranged Combat", label: "射击" },
  { id: "Languages", label: "语言" },
  { id: "Occult", label: "神秘学" },
];

/** Where a new Grayhaven player may start (scene / road ids). */
export const START_RESIDENCES: ReadonlyArray<{ id: string; label: string }> = [
  { id: "SCN_motel", label: "汽车旅馆前院" },
  { id: "SCN_main_north", label: "主街北口" },
  { id: "ROAD_old_coast_road", label: "旧海岸公路" },
];

export const ATTRIBUTE_KEYS = [
  "STR",
  "CON",
  "DEX",
  "APP",
  "POW",
  "SIZ",
  "INT",
  "EDU",
] as const;

export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

export const ATTRIBUTE_LABELS: Record<AttributeKey, string> = {
  STR: "力量",
  CON: "体质",
  DEX: "敏捷",
  APP: "外貌",
  POW: "意志",
  SIZ: "体型",
  INT: "智力",
  EDU: "教育",
};

/** Format an ISO gameDateTime as "YYYY-MM-DD HH:mm" (no timezone shift). */
export function formatGameTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

/** Only the clock part, "HH:mm". */
export function formatClock(iso: string | undefined | null): string {
  if (!iso) return "";
  const m = /T(\d{2}:\d{2})/.exec(iso);
  return m ? m[1] : iso;
}

export type LabelLookup = (id: string) => string | undefined;
