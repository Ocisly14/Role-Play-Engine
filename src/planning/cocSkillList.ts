/** Broad skill domains shared by planning, deterministic rolls, and the UI. */
import { SKILL_CATALOG } from "../engine/rules/skillCatalog.js";

export const COC_SKILLS: ReadonlyArray<{
  name: string;
  base: number;
  desc: string;
}> = SKILL_CATALOG.map((skill) => ({
  name: skill.name,
  base: skill.base,
  desc: skill.description,
}));

/** Base value lookup: skill name → default value for untrained characters. */
export const COC_SKILL_BASE_VALUES = new Map<string, number>(
  COC_SKILLS.map((skill) => [skill.name, skill.base])
);

export const COC_SKILL_LIST_PROMPT = COC_SKILLS.map(
  (skill) => `${skill.name} (${skill.desc})`
).join(", ");
